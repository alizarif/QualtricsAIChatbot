// Minimal HTTP toolkit: router, JSON bodies, cookies, static files, SSE.

import fs from 'node:fs';
import path from 'node:path';

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

export function createRouter() {
  const routes = [];
  const compile = (pattern) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:[A-Za-z_]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; })}/?$`);
    return { re, keys };
  };
  return {
    add(method, pattern, handler, opts = {}) { routes.push({ method, ...compile(pattern), handler, opts }); },
    match(method, pathname) {
      let pathMatched = false;
      for (const r of routes) {
        const m = r.re.exec(pathname);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== method) continue;
        const params = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        return { route: r, params };
      }
      return { route: null, pathMatched };
    },
  };
}

export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Request body is too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function readJson(req, limit = 1_000_000) {
  const ct = req.headers['content-type'] ?? '';
  const text = await readBody(req, limit);
  if (!text) return {};
  if (!ct.includes('application/json')) throw new HttpError(415, 'Send JSON with Content-Type: application/json');
  try { return JSON.parse(text); } catch { throw new HttpError(400, 'Invalid JSON'); }
}

export function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sendJson(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(data);
}

export function sendText(res, status, text, type = 'text/plain; charset=utf-8', headers = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store', ...headers });
  res.end(text);
}

export function serveStatic(res, root, rel, extraHeaders = {}) {
  const clean = path.normalize(decodeURIComponent(rel)).replace(/^([/\\])+/, '');
  const file = path.join(root, clean);
  if (file !== root && !file.startsWith(root + path.sep)) return false;
  let stat;
  try { stat = fs.statSync(file); } catch { return false; }
  if (!stat.isFile()) return false;
  const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Cache-Control': 'no-cache', ...extraHeaders });
  fs.createReadStream(file).pipe(res);
  return true;
}

/** Server-sent events. Returns {send(event,data), onClose(fn)}. */
export function openSse(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  const beat = setInterval(() => res.write(': ping\n\n'), 25000);
  beat.unref?.();
  const closers = [];
  const close = () => { clearInterval(beat); closers.forEach((f) => f()); };
  req.on('close', close);
  return {
    send(event, data = {}) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); },
    onClose(fn) { closers.push(fn); },
  };
}
