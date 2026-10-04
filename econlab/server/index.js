#!/usr/bin/env node
// EconLab server entry point.
//   PORT            (default 3000)
//   HOST            (default 127.0.0.1; use 0.0.0.0 to serve a lab network)
//   DATA_DIR        (default ./data)
//   ADMIN_PASSWORD  protects the researcher interface (required unless HOST is local)
//   TRUST_PROXY=1   use X-Forwarded-For for rate limiting behind a reverse proxy

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { createApp } from './app.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '127.0.0.1';
const DATA_DIR = path.resolve(process.env.DATA_DIR ?? path.join(ROOT, 'data'));
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? '';
const isLocal = ['127.0.0.1', 'localhost', '::1'].includes(HOST);

if (!ADMIN_PASSWORD && !isLocal && process.env.ALLOW_OPEN_ADMIN !== '1') {
  console.error(`
Refusing to start: the server would listen on ${HOST} without an admin password,
so anyone on the network could create experiments and download data.

  Set a password:   ADMIN_PASSWORD='something-long' HOST=${HOST} node server/index.js
  (or, to accept the risk: ALLOW_OPEN_ADMIN=1)
`);
  process.exit(1);
}

const store = new Store(DATA_DIR);
const app = createApp({ store, adminPassword: ADMIN_PASSWORD, trustProxy: process.env.TRUST_PROXY === '1' });
const server = http.createServer(app.handler);
server.requestTimeout = 30_000;
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`\nPort ${PORT} is already in use. Stop the other program or choose another port:  PORT=3001 node server/index.js\n`);
  else console.error(e);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`\nEconLab is running  →  http://${shown}:${PORT}`);
  console.log(`Data directory      →  ${DATA_DIR}`);
  console.log(ADMIN_PASSWORD ? 'Admin password      →  required' : 'Admin password      →  NOT SET (open access; fine for local use only)');
});

const timer = setInterval(() => app.tickAll(), 1000);
timer.unref();

const shutdown = () => { store.flush(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
