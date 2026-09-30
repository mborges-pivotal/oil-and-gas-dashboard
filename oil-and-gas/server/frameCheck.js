/**
 * GET /api/frame-check?url=<article url>  →  { embeddable: true | false | null }
 *
 * The News popup viewer shows articles in an <iframe>, but many sites
 * forbid being framed (X-Frame-Options / CSP frame-ancestors) and a
 * browser gives the page no way to detect that — the frame just shows an
 * error. So the server fetches the URL's response headers and reports
 * whether framing is allowed; the client falls back to "open in a new
 * tab" when it isn't. null = couldn't tell (the client then just tries).
 *
 * This fetches caller-supplied URLs, so to avoid becoming an SSRF probe
 * into the host's private network it only connects to public IPs — the
 * hostname is resolved first, every address checked, and the connection
 * pinned to the checked address (no DNS-rebinding window). Only a boolean
 * is ever returned, never the response itself. Results are cached per
 * origin, since framing policy is effectively site-wide.
 */

const http = require('http');
const https = require('https');
const dns = require('dns').promises;
const net = require('net');

const TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 3;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 1000;
const cache = new Map(); // origin -> { embeddable, expiresAt }

const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
]) blocked.addSubnet(addr, prefix, 'ipv6');

function isPublicAddress(address, family) {
  // IPv4-mapped IPv6 (::ffff:10.0.0.1) — check the embedded IPv4 address
  const mapped = family === 6 && /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return !blocked.check(mapped[1], 'ipv4');
  return !blocked.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

async function resolvePublic(hostname) {
  const host = hostname.replace(/^\[|\]$/g, ''); // strip IPv6 literal brackets
  const addresses = net.isIP(host)
    ? [{ address: host, family: net.isIP(host) }]
    : await dns.lookup(host, { all: true });
  if (!addresses.length || !addresses.every((a) => isPublicAddress(a.address, a.family))) {
    throw new Error('Refusing non-public address');
  }
  // IPv4 first: many hosts (and local networks) have no working IPv6 route
  return addresses.sort((a, b) => a.family - b.family);
}

// Only response headers are needed — the request is aborted as soon as
// they arrive, so the body is never downloaded.
async function fetchHeaders(url, redirectsLeft = MAX_REDIRECTS) {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Unsupported protocol');
  const targets = await resolvePublic(url.hostname);
  const client = url.protocol === 'https:' ? https : http;

  const res = await new Promise((resolve, reject) => {
    const req = client.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' },
      // Pin the connection to the addresses we just validated (Node tries
      // them in turn when given the list)
      lookup: (_host, opts, cb) => (opts?.all
        ? cb(null, targets)
        : cb(null, targets[0].address, targets[0].family)),
      timeout: TIMEOUT_MS,
    }, (response) => {
      resolve(response);
      req.destroy();
    });
    req.on('timeout', () => req.destroy(new Error('Timed out')));
    req.on('error', reject);
  });

  if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
    if (redirectsLeft === 0) throw new Error('Too many redirects');
    return fetchHeaders(new URL(res.headers.location, url), redirectsLeft - 1);
  }
  return { status: res.statusCode, headers: res.headers };
}

// false if the headers forbid framing by another site. frame-ancestors
// (CSP) takes precedence over X-Frame-Options in browsers that support it.
function allowsFraming(headers) {
  const csp = [].concat(headers['content-security-policy'] ?? []).join(';');
  const fa = /(?:^|;)\s*frame-ancestors\s+([^;]*)/i.exec(csp);
  if (fa) return /(^|\s)\*(\s|$)/.test(fa[1].trim());
  const xfo = String(headers['x-frame-options'] ?? '').toLowerCase();
  return !/deny|sameorigin|allow-from/.test(xfo);
}

async function checkEmbeddable(rawUrl) {
  const url = new URL(rawUrl);
  const cached = cache.get(url.origin);
  if (cached && cached.expiresAt > Date.now()) return cached.embeddable;

  let embeddable = null;
  try {
    const { status, headers } = await fetchHeaders(url);
    // An explicit "no framing" header counts even on an error/bot-challenge
    // page (e.g. Reuters' 401 carries its site-wide frame-ancestors), but a
    // missing header there proves nothing about the real article page.
    const allowed = allowsFraming(headers);
    if (!allowed) embeddable = false;
    else if (status < 400) embeddable = true;
  } catch {
    // unknown — leave null so the client just tries the frame
  }

  if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(url.origin, { embeddable, expiresAt: Date.now() + CACHE_TTL_MS });
  return embeddable;
}

async function handleFrameCheck(req, res, reqUrl) {
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  let target;
  try {
    target = new URL(reqUrl.searchParams.get('url'));
    if (target.protocol !== 'https:' && target.protocol !== 'http:') throw new Error();
  } catch {
    send(400, { error: 'Invalid or missing url parameter' });
    return;
  }
  send(200, { embeddable: await checkEmbeddable(target.href) });
}

module.exports = { handleFrameCheck };
