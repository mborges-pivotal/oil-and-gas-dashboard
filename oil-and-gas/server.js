/**
 * Unified server for the Oil & Gas Dashboard: serves the static SPA and
 * relays the third-party APIs that don't send CORS headers (Yahoo Finance,
 * www.sec.gov) from the SAME origin/port.
 *
 * This replaces running the static server (`npx serve .`) and the CORS
 * relay (local-proxy.js) as two separate processes/ports — needed for
 * hosts like Railway that expose exactly one port per service, and it
 * keeps local dev and production on identical, single-origin behavior.
 *
 * Local dev: node server.js (or ./run.sh)  -> http://localhost:3000
 * Railway:   sets PORT itself; this reads it.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const ALLOWED_HOSTS = new Set([
  'query1.finance.yahoo.com',
  'query2.finance.yahoo.com',
  'www.sec.gov',
  // RSS feed hosts whose bot protection blocks rss2json/allorigins but
  // allows ordinary requests — see services/rss.js's local-proxy fallback.
  'investors.nov.com',
]);

// SEC's Fair Access policy (sec.gov/os/webmaster-faq#developers) requires a
// real identifying User-Agent ("App Name contact@domain.com") on automated
// requests — a generic browser-style UA gets a 403 "Request Rate Threshold
// Exceeded" page regardless of actual request volume. Override via env var
// with your own contact info if you hit this.
const SEC_USER_AGENT = process.env.SEC_CONTACT || 'Oil-Gas-Dashboard contact@example.com';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function handleProxy(req, res, reqUrl) {
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
  https
    .get(targetUrl, { headers: { 'User-Agent': userAgent } }, (upstream) => {
      res.writeHead(upstream.statusCode, { 'Content-Type': upstream.headers['content-type'] ?? 'application/json' });
      upstream.pipe(res);
    })
    .on('error', (err) => {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end(`Upstream fetch failed: ${err.message}`);
    });
}

function handleStatic(req, res, reqUrl) {
  const requestedPath = reqUrl.pathname === '/' ? '/index.html' : reqUrl.pathname;
  const filePath = path.join(ROOT, path.normalize(decodeURIComponent(requestedPath)));

  // Prevent path traversal outside the app directory
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, `http://localhost:${PORT}`);

  if (reqUrl.pathname === '/proxy') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    handleProxy(req, res, reqUrl);
    return;
  }

  handleStatic(req, res, reqUrl);
});

server.listen(PORT, () => {
  console.log(`Oil & Gas Dashboard listening on http://localhost:${PORT}`);
});
