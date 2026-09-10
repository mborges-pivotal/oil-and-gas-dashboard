/**
 * Local CORS proxy for third-party APIs that don't send CORS headers.
 *
 * - query1/query2.finance.yahoo.com never send Access-Control-Allow-Origin,
 *   so browser fetches to Yahoo Finance always fail CORS.
 * - www.sec.gov/files/company_tickers.json (ticker → CIK lookup) also never
 *   sends CORS headers, unlike data.sec.gov (used for the actual filings),
 *   which does.
 *
 * Public CORS-bypass proxies (allorigins.win, corsproxy.io, ...) are
 * unreliable and are also often blocked by corporate network filtering
 * (they're categorized as "proxy/anonymizer" sites).
 *
 * This script runs a tiny local relay instead: the browser calls
 * http://localhost:8787/proxy?url=<target url>, which fetches the target
 * server-side (plain outbound HTTPS, no CORS involved) and returns the
 * result with permissive CORS headers.
 *
 * Only hosts in ALLOWED_HOSTS are relayed, to avoid this being an open relay.
 *
 * Run alongside the static server:
 *   node local-proxy.js
 *   npx serve .
 */

const http = require('http');
const https = require('https');

const PORT = process.env.PROXY_PORT || 8787;
const ALLOWED_HOSTS = new Set([
  'query1.finance.yahoo.com',
  'query2.finance.yahoo.com',
  'www.sec.gov',
  'investors.nov.com',
]);

// SEC's Fair Access policy (sec.gov/os/webmaster-faq#developers) requires a
// real identifying User-Agent ("App Name contact@domain.com") on automated
// requests — a generic browser-style UA gets a 403 "Request Rate Threshold
// Exceeded" page regardless of actual request volume. Override via env var
// with your own contact info if you hit this.
const SEC_USER_AGENT = process.env.SEC_CONTACT || 'Oil-Gas-Dashboard-Local-Dev contact@example.com';

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const reqUrl = new URL(req.url, `http://localhost:${PORT}`);
  if (reqUrl.pathname !== '/proxy') {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }

  const target = reqUrl.searchParams.get('url');
  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Invalid or missing url parameter');
    return;
  }

  if (targetUrl.protocol !== 'https:' || !ALLOWED_HOSTS.has(targetUrl.hostname)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Host not allowed');
    return;
  }

  const userAgent = targetUrl.hostname === 'www.sec.gov' ? SEC_USER_AGENT : 'Mozilla/5.0';
  https.get(targetUrl, { headers: { 'User-Agent': userAgent } }, (upstream) => {
    res.writeHead(upstream.statusCode, { 'Content-Type': upstream.headers['content-type'] ?? 'application/json' });
    upstream.pipe(res);
  }).on('error', (err) => {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end(`Upstream fetch failed: ${err.message}`);
  });
});

server.listen(PORT, () => {
  console.log(`Local Yahoo Finance proxy listening at http://localhost:${PORT}`);
});
