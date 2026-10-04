// Researcher-UI end-to-end test (optional): npm i -D playwright && npx playwright install chromium && npm run e2e
let chromium;
try { ({ chromium } = await import('playwright')); } catch { console.log('Skipping e2e: playwright is not installed.'); process.exit(0); }
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'el-'));
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3100 + Math.floor(Math.random() * 800);
const srv = spawn('node', ['server/index.js'], { cwd: ROOT, env: { ...process.env, PORT, DATA_DIR: dir, ADMIN_PASSWORD: 'hunter2-hunter2' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => srv.stdout.on('data', (d) => String(d).includes('running') && r()));
const base = `http://127.0.0.1:${PORT}`;
const errs = []; let fails = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL', m); if (!c) { fails++; process.exitCode = 1; } };
let browser;
try {
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, acceptDownloads: true });
  const pg = await ctx.newPage();
  pg.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
  pg.on('console', (m) => m.type() === 'error' && !/401|Failed to load resource/.test(m.text()) && errs.push('CONSOLE ' + m.text()));

  console.log('login screen');
  await pg.goto(base);
  await pg.waitForSelector('input[type=password]');
  await pg.fill('input[type=password]', 'wrong');
  await pg.click('button:has-text("Sign in")');
  await pg.waitForSelector('text=Wrong password');
  ok(true, 'wrong password rejected');
  await pg.fill('input[type=password]', 'hunter2-hunter2');
  await pg.click('button:has-text("Sign in")');
  await pg.waitForSelector('text=Start from an example');
  ok(true, 'signed in');

  console.log('blank experiment: add every question type');
  await pg.click('button:has-text("New experiment")');
  await pg.waitForSelector('.name-input');
  await pg.fill('.name-input', 'Coverage study');
  // add a decision page
  await pg.click('button:has-text("Add stage")');
  await pg.click('.menu button:has-text("Decision page")');
  await pg.waitForSelector('.field-card');
  for (const label of ['Decimal number', 'Slider', 'Multiple choice', 'Likert scale', 'Checkbox', 'Short text', 'Long text']) {
    await pg.click('button:has-text("Add question")');
    await pg.click(`.menu button:has-text("${label}")`);
  }
  ok(await pg.locator('.field-card').count() === 8, '8 question cards');
  // type a label into the first and check auto-naming
  await pg.locator('.field-card textarea').first().fill('How much do you give?');
  const name0 = await pg.locator('.field-card').first().locator('input.expr').first().inputValue();
  ok(name0 === 'how_much_do_you_give', 'name auto-derived from label: ' + name0);
  // choice options editor
  const choiceCard = pg.locator('.field-card:has(.opt-row)').first();
  await choiceCard.locator('button:has-text("Add option")').click();
  ok(await choiceCard.locator('.opt-row').count() === 3, 'option added');
  await choiceCard.locator('.opt-row input').nth(0).fill('10');
  // change type of a field
  await pg.locator('.field-card select').first().selectOption('likert');
  await pg.waitForTimeout(200);

  console.log('stage operations');
  await pg.click('button:has-text("Add stage")'); await pg.click('.menu button:has-text("Wait & compute")');
  await pg.click('button:has-text("Add stage")'); await pg.click('.menu button:has-text("Results page")');
  ok(await pg.locator('.stage-item').count() === 4, '4 stages');
  await pg.locator('.stage-item').nth(2).click();
  await pg.click('button[aria-label="Move stage up"]');
  await pg.waitForTimeout(150);
  ok((await pg.locator('.stage-item .t').nth(1).textContent()).includes('Please wait'), 'stage moved up');
  await pg.click('button[aria-label="Duplicate stage"]');
  ok(await pg.locator('.stage-item').count() === 5, 'stage duplicated');
  await pg.click('button[aria-label="Delete stage"]');
  await pg.click('.modal button:has-text("Delete")');
  ok(await pg.locator('.stage-item').count() === 4, 'stage deleted');

  console.log('insert variable menu');
  await pg.locator('.stage-item').nth(3).click();
  await pg.click('button:has-text("Insert {{ value }}")');
  await pg.click('.menu button:has-text("player.payoff")');
  const body = await pg.locator('textarea').first().inputValue();
  ok(body.includes('{{ player.payoff }}'), 'variable inserted at cursor');

  console.log('design tab: roles, constants, treatments');
  await pg.click('.tab:has-text("Design")');
  await pg.fill('input[placeholder="e.g. Proposer, Responder"]', 'Buyer, Seller');
  await pg.locator('.card:has-text("Constants") button:has-text("Add")').click();
  await pg.locator('.card:has-text("Constants") .kv-row input').nth(0).fill('price');
  await pg.locator('.card:has-text("Constants") .kv-row input').nth(1).fill('12.5');
  await pg.click('button:has-text("Add treatment")');
  await pg.locator('.sub-card button:has-text("Add")').first().click();
  await pg.locator('.sub-card .kv-row input').nth(0).fill('price');
  await pg.locator('.sub-card .kv-row input').nth(1).fill('20');
  await pg.waitForFunction(() => document.querySelector('.save-state')?.textContent.includes('Saved'));
  const saved = await ctx.request.get(`${base}/api/experiments`, { headers: {} });
  const list = (await saved.json()).experiments;
  const id = list[0].id;
  const exp = (await (await ctx.request.get(`${base}/api/experiments/${id}`)).json()).experiment;
  ok(exp.name === 'Coverage study', 'name persisted');
  ok(exp.design.constants.price === 12.5, 'numeric constant persisted as number');
  ok(JSON.stringify(exp.design.roles) === '["Buyer","Seller"]', 'roles persisted');
  ok(exp.design.treatments.length === 1 && exp.design.treatments[0].constants.price === 20, 'treatment override persisted');
  const dec = exp.stages.find((x) => x.type === 'decision');
  const types = dec.fields.map((f) => f.type);
  ok(['number', 'slider', 'choice', 'likert', 'checkbox', 'text', 'textarea'].every((t) => types.includes(t)), 'all field types persisted: ' + types.join(','));
  ok(dec.fields.find((f) => f.type === 'choice').options.some((o) => o.value === 10), 'option value stored as number');

  console.log('JSON tab apply + download');
  await pg.click('.tab:has-text("JSON")');
  const ta = pg.locator('textarea.json');
  const parsed = JSON.parse(await ta.inputValue());
  parsed.name = 'Renamed via JSON';
  await ta.fill(JSON.stringify(parsed));
  await pg.click('button:has-text("Apply changes")');
  await pg.waitForSelector('text=Applied');
  ok((await pg.inputValue('.name-input')) === 'Renamed via JSON', 'JSON apply updates the name box');
  await ta.fill('{ not json');
  await pg.click('button:has-text("Apply changes")');
  await pg.waitForSelector('.alert.danger');
  ok(true, 'invalid JSON shows an error instead of crashing');
  const [dl] = await Promise.all([pg.waitForEvent('download'), pg.click('button:has-text("Download")')]);
  ok(dl.suggestedFilename().endsWith('.econlab.json'), 'download filename ' + dl.suggestedFilename());

  console.log('import JSON from the dashboard');
  await pg.goto(base + '/#/');
  await pg.waitForSelector('.exp-card');
  const file = path.join(dir, 'imp.json');
  fs.writeFileSync(file, JSON.stringify({ ...parsed, name: 'Imported one' }));
  await pg.setInputFiles('input[type=file]', file);
  await pg.waitForSelector('.name-input');
  ok((await pg.inputValue('.name-input')) === 'Imported one', 'imported experiment opened');

  console.log('session creation validation + manual flow in UI');
  await pg.goto(base + '/#/');
  await pg.click('.example-card:has-text("Dictator game") button');
  await pg.waitForSelector('.name-input');
  await pg.click('.tab:has-text("Sessions")');
  await pg.fill('input[type=number]', '3');
  await pg.click('button:has-text("Create session")');
  await pg.waitForSelector('.alert.danger:has-text("multiple of 2")');
  ok(true, 'bad participant count explained');
  await pg.fill('input[type=number]', '2');
  await pg.click('button:has-text("Create session")');
  await pg.waitForSelector('button:has-text("Start session")');
  await pg.click('button:has-text("Start session")');
  await pg.waitForSelector('.modal:has-text("Start without everyone?")');
  ok(true, 'warns before starting a group session when nobody has joined');
  await pg.click('.modal button:has-text("Start session")');
  await pg.waitForSelector('.badge:has-text("Running")');
  ok(true, 'session started from the UI');
  await pg.waitForSelector('.status-dot');
  await pg.locator('table.data tbody tr').first().locator('a[title^="Open as"]').count();

  console.log('sign out');
  await pg.click('button:has-text("Sign out")');
  await pg.waitForSelector('input[type=password]');
  ok(true, 'signed out');
  console.log(errs.length ? errs : 'no browser errors');
  if (errs.length) process.exitCode = 1;
} finally { await browser?.close(); srv.kill(); }
