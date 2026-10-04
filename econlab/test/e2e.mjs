// Lab scenario: shared join link, manual start, live sync, timeout, reload, mobile layout.
// Browser end-to-end test (optional): npm i -D playwright && npx playwright install chromium && npm run e2e
let chromium;
try { ({ chromium } = await import('playwright')); } catch { console.log('Skipping e2e: playwright is not installed.'); process.exit(0); }
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'el-'));
const PORT = 3100 + Math.floor(Math.random() * 800);
const srv = spawn('node', ['server/index.js'], { cwd: ROOT, env: { ...process.env, PORT, DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => srv.stdout.on('data', (d) => String(d).includes('running') && r()));
const base = `http://127.0.0.1:${PORT}`;
const api = async (m, p, b) => (await fetch(base + p, { method: m, headers: { 'X-Requested-With': 'econlab', 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })).json();
let browser; const errs = [];
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL', m); if (!c) process.exitCode = 1; };
try {
  // experiment: ultimatum-like pair game, 2 rounds, 6 s time limit on the decision page
  const { experiment } = await api('POST', '/api/experiments', { example: 'dictator' });
  experiment.stages[1].timeoutSeconds = 4;
  experiment.stages[1].fields[0].default = 7;
  await fetch(`${base}/api/experiments/${experiment.id}`, { method: 'PUT', headers: { 'X-Requested-With': 'econlab', 'Content-Type': 'application/json' }, body: JSON.stringify(experiment) });
  const { session } = await api('POST', `/api/experiments/${experiment.id}/sessions`, { numParticipants: 2, seed: 4 });
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  const mk = async () => { const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/404|409|422/.test(m.text()) && errs.push(m.text())); return p; };

  console.log('open shared join link in two tabs (separate contexts so each gets its own seat)');
  const ctxB = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  const A = await mk(); const pb = await ctxB.newPage(); pb.on('pageerror', (e) => errs.push(e.message));
  await A.goto(`${base}/join/${session.code}?PROLIFIC_PID=ann`);
  await A.waitForSelector('text=Welcome');
  ok(/\/play\//.test(A.url()), 'join link redirected to personal link: ' + A.url().replace(base, ''));
  await pb.goto(`${base}/join/${session.code}?label=bob`);
  await pb.waitForSelector('text=Welcome');
  let third = await (await fetch(`${base}/join/${session.code}`)).text();
  const full = await api('POST', `/api/join/${session.code}`, { params: {} });
  ok(/full/i.test(full.error ?? ''), 'third arrival is told the session is full');

  console.log('researcher starts the session -> both tabs update live (SSE, no reload)');
  await api('POST', `/api/sessions/${session.id}/start`, {});
  await A.waitForSelector('text=Instructions', { timeout: 5000 });
  await pb.waitForSelector('text=Instructions', { timeout: 5000 });
  ok(true, 'both participants moved to Instructions without reloading');
  await A.click('button:has-text("Continue")'); await pb.click('button:has-text("Continue")');

  console.log('reload mid-session keeps position');
  const roles = await Promise.all([A, pb].map(async (p) => (await p.textContent('.play-header .pill')).includes('Dictator') ? 'D' : 'R'));
  const [dictPage, recvPage] = roles[0] === 'D' ? [A, pb] : [pb, A];
  await dictPage.waitForSelector('text=Your decision');
  await dictPage.reload();
  await dictPage.waitForSelector('text=Your decision');
  ok(await dictPage.locator('.timer').isVisible(), 'countdown timer visible after reload');
  await recvPage.waitForSelector('text=The Dictator is making a decision');

  console.log('dictator idles: server auto-submits the default (7) when the 4 s limit passes');
  await recvPage.waitForSelector('text=Result', { timeout: 12000 });
  const txt = await recvPage.textContent('.play-card');
  ok(/gave\s*7\s*of 10/.test(txt.replace(/\s+/g, ' ')), 'receiver sees default 7 applied: ' + txt.replace(/\s+/g, ' ').slice(0, 80));
  await dictPage.waitForSelector('text=Result');
  await dictPage.click('button:has-text("Continue")'); await recvPage.click('button:has-text("Continue")');
  await dictPage.waitForSelector('text=Thank you');
  const pay = await dictPage.textContent('.earnings');
  console.log('  dictator earnings box:', pay.replace(/\s+/g, ' '));
  ok(/\$6\.50/.test(pay), 'dictator keeps 3 points x $0.5 + $5 fee = $6.50');

  const data = await (await fetch(`${base}/api/sessions/${session.id}/export/data.csv`)).text();
  ok(/auto_filled_stages/.test(data) && /st_/.test(data.split('\r\n')[1] + data.split('\r\n')[2]), 'CSV flags the auto-filled page');
  const sum = (await api('GET', `/api/sessions/${session.id}`)).session;
  ok(sum.participants.some((p) => p.label === 'ann') && sum.participants.some((p) => p.label === 'bob'), 'labels from link parameters stored');

  console.log('mobile + dark mode rendering');
  const m = await browser.newContext({ viewport: { width: 390, height: 780 }, colorScheme: 'dark' });
  const mp = await m.newPage();
  const { session: s2 } = await api('POST', `/api/experiments/${(await api('POST', '/api/experiments', { example: 'survey' })).experiment.id}/sessions`, { numParticipants: 1, startMode: 'immediate' });
  await mp.goto(`${base}/play/${s2.participants[0].code}`);
  await mp.waitForSelector('text=Consent');
  await mp.check('input[type=checkbox]');
  await mp.click('button:has-text("Start")');
  await mp.waitForSelector('text=About you');
  const overflow = await mp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  ok(!overflow, 'no horizontal scroll on a 390px phone');
  console.log(errs.length ? errs : 'no browser errors');
} finally { await browser?.close(); srv.kill(); }
