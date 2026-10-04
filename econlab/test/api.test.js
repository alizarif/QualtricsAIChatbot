import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';

async function boot(opts = {}) {
  const store = new Store(null);
  const app = createApp({ store, ...opts });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'X-Requested-With': 'econlab', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') ?? '';
    const data = type.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data, headers: res.headers };
  };
  return { store, app, server, base, call, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

test('researcher API: create from example, session, play through, export', async () => {
  const t = await boot();
  try {
    let r = await t.call('GET', '/api/examples');
    assert.ok(r.data.examples.length >= 8);

    r = await t.call('POST', '/api/experiments', { example: 'public-goods' });
    assert.equal(r.status, 200);
    const exp = r.data.experiment;
    assert.equal(r.data.issues.length, 0);

    r = await t.call('POST', `/api/experiments/${exp.id}/sessions`, { numParticipants: 6 });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /multiple of 4/);

    r = await t.call('POST', `/api/experiments/${exp.id}/sessions`, { numParticipants: 4, name: 'Pilot', seed: 5 });
    assert.equal(r.status, 200);
    const sess = r.data.session;
    assert.equal(sess.numParticipants, 4);
    assert.equal(sess.status, 'waiting');
    const codes = sess.participants.map((p) => p.code);

    // participant opens the link before the session starts -> lobby
    r = await t.call('GET', `/api/play/${codes[0]}?PROLIFIC_PID=abc123`);
    assert.equal(r.data.status, 'lobby');

    // SSE: an update is pushed to a waiting participant when the session starts
    const events = [];
    const ctrl = new AbortController();
    const sse = await fetch(`${t.base}/api/play/${codes[0]}/events`, { signal: ctrl.signal });
    assert.equal(sse.status, 200);
    (async () => {
      const dec = new TextDecoder();
      try { for await (const chunk of sse.body) events.push(dec.decode(chunk)); } catch { /* aborted */ }
    })();

    r = await t.call('POST', `/api/sessions/${sess.id}/start`, {});
    assert.equal(r.data.session.status, 'running');
    await new Promise((res) => setTimeout(res, 100));
    assert.ok(events.join('').includes('event: update'), 'participant stream received an update');

    for (const c of codes) await t.call('GET', `/api/play/${c}`);
    r = await t.call('GET', `/api/sessions/${sess.id}`);
    assert.equal(r.data.session.participants[0].label, 'abc123', 'PROLIFIC_PID became the label');
    assert.equal(r.data.session.counts.joined, 4);

    const play = async (code, values) => {
      const v = (await t.call('GET', `/api/play/${code}`)).data;
      return t.call('POST', `/api/play/${code}/submit`, { values, key: v.key });
    };
    for (const c of codes) assert.equal((await play(c, {})).status, 200); // instructions
    let bad = await play(codes[0], { contribution: 99 });
    assert.equal(bad.status, 422);
    assert.match(bad.data.errors.contribution, /between 0 and 20/);
    for (const [i, c] of codes.entries()) {
      const x = await play(c, { contribution: [20, 0, 10, 10][i] });
      assert.equal(x.status, 200, JSON.stringify(x.data));
    }
    r = await t.call('GET', `/api/play/${codes[1]}`);
    assert.equal(r.data.status, 'active');
    assert.match(r.data.stage.body, /\*\*36\*\*/);

    // stale submit
    const stale = await t.call('POST', `/api/play/${codes[1]}/submit`, { values: {}, key: '1:0' });
    assert.equal(stale.status, 409);
    assert.ok(stale.data.view);

    r = await t.call('GET', `/api/sessions/${sess.id}/export/data.csv`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-disposition'), /attachment/);
    const lines = r.data.trim().split('\r\n');
    assert.equal(lines.length, 5);
    assert.match(lines[0], /contribution/);
    r = await t.call('GET', `/api/sessions/${sess.id}/export/payments.csv`);
    assert.match(r.data, /total_payment/);
    r = await t.call('GET', `/api/sessions/${sess.id}/export/session.json`);
    assert.equal(r.data.format, 'econlab-session');
    r = await t.call('GET', `/api/sessions/${sess.id}/data`);
    assert.equal(r.data.data.rows.length, 4);

    // researcher forces everybody through
    r = await t.call('POST', `/api/sessions/${sess.id}/participants/1/advance`, {});
    assert.equal(r.status, 200);

    r = await t.call('DELETE', `/api/sessions/${sess.id}`);
    assert.equal(r.status, 200);
    r = await t.call('GET', `/api/play/${codes[0]}`);
    assert.equal(r.status, 404);
    ctrl.abort();
  } finally { await t.close(); }
});

test('open join link assigns seats until full', async () => {
  const t = await boot();
  try {
    const exp = (await t.call('POST', '/api/experiments', { example: 'dictator' })).data.experiment;
    const sess = (await t.call('POST', `/api/experiments/${exp.id}/sessions`, { numParticipants: 2, startMode: 'immediate' })).data.session;
    let r = await t.call('GET', `/api/join/${sess.code}`);
    assert.equal(r.data.full, false);
    const a = await t.call('POST', `/api/join/${sess.code}`, { params: { label: 'p-a' } });
    const b = await t.call('POST', `/api/join/${sess.code}`, { params: {} });
    assert.notEqual(a.data.code, b.data.code);
    r = await t.call('POST', `/api/join/${sess.code}`, { params: {} });
    assert.equal(r.status, 409);
    r = await t.call('GET', `/api/join/nope`);
    assert.equal(r.status, 404);
    r = await t.call('GET', `/api/play/${a.data.code}`);
    assert.equal(r.data.status, 'active');
  } finally { await t.close(); }
});

test('admin password protects researcher routes but not participants', async () => {
  const t = await boot({ adminPassword: 'correct horse' });
  try {
    let r = await t.call('GET', '/api/auth');
    assert.deepEqual(r.data, { required: true, authenticated: false });
    r = await t.call('GET', '/api/experiments');
    assert.equal(r.status, 401);
    r = await t.call('POST', '/api/login', { password: 'wrong' });
    assert.equal(r.status, 401);
    r = await t.call('POST', '/api/login', { password: 'correct horse' });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('set-cookie'), /HttpOnly/);
    r = await t.call('GET', '/api/experiments');
    assert.equal(r.status, 200);
    const exp = (await t.call('POST', '/api/experiments', { example: 'survey' })).data.experiment;
    const sess = (await t.call('POST', `/api/experiments/${exp.id}/sessions`, { numParticipants: 1, startMode: 'immediate' })).data.session;
    // participant has no cookie and still gets in
    const anon = await fetch(`${t.base}/api/play/${sess.participants[0].code}`);
    assert.equal(anon.status, 200);
    const noCookie = await fetch(`${t.base}/api/sessions/${sess.id}/export/data.csv`);
    assert.equal(noCookie.status, 401);
    await t.call('POST', '/api/logout', {});
  } finally { await t.close(); }
});

test('brute force protection on login', async () => {
  const t = await boot({ adminPassword: 'pw' });
  try {
    let last;
    for (let i = 0; i < 10; i++) last = await t.call('POST', '/api/login', { password: 'nope' });
    assert.equal(last.status, 429);
    const good = await t.call('POST', '/api/login', { password: 'pw' });
    assert.equal(good.status, 429, 'locked out even with the right password');
  } finally { await t.close(); }
});

test('CSRF guard, content type and body limits', async () => {
  const t = await boot();
  try {
    const noHeader = await fetch(`${t.base}/api/experiments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(noHeader.status, 403);
    const form = await fetch(`${t.base}/api/experiments`, { method: 'POST', headers: { 'X-Requested-With': 'econlab', 'Content-Type': 'text/plain' }, body: '{"a":1}' });
    assert.equal(form.status, 415);
    const big = await fetch(`${t.base}/api/experiments`, { method: 'POST', headers: { 'X-Requested-With': 'econlab', 'Content-Type': 'application/json' }, body: JSON.stringify({ experiment: { stages: [], pad: 'x'.repeat(4_000_000) } }) }).catch(() => ({ status: 413 }));
    assert.equal(big.status, 413);
    const notJson = await t.call('POST', '/api/experiments', { experiment: { name: 'x' } });
    assert.equal(notJson.status, 400);
  } finally { await t.close(); }
});

test('experiment editing: normalisation, issues, duplicate, delete', async () => {
  const t = await boot();
  try {
    let r = await t.call('POST', '/api/experiments', {});
    const exp = r.data.experiment;
    exp.name = '  My study  ';
    exp.design.groupSize = 3;
    exp.design.roles = ['A', 'B'];
    exp.stages.push({ type: 'decision', fields: [{ name: 'x', type: 'integer', max: 'const.oops +' }], compute: [{ scope: 'group', name: 'g', expr: '1' }] });
    r = await t.call('PUT', `/api/experiments/${exp.id}`, exp);
    assert.equal(r.data.experiment.name, 'My study');
    const errs = r.data.issues.filter((i) => i.level === 'error').map((i) => i.message).join('|');
    assert.match(errs, /one role per group member/);
    assert.match(errs, /Expression ended unexpectedly|Unexpected/);
    assert.match(errs, /Only wait pages can set group variables/);
    r = await t.call('POST', `/api/experiments/${exp.id}/sessions`, { numParticipants: 3 });
    assert.equal(r.status, 400);
    assert.ok(r.data.issues.length);
    r = await t.call('POST', `/api/experiments/${exp.id}/duplicate`, {});
    assert.equal(r.data.experiment.name, 'My study (copy)');
    assert.notEqual(r.data.experiment.id, exp.id);
    r = await t.call('GET', '/api/experiments');
    assert.equal(r.data.experiments.length, 2);
    r = await t.call('DELETE', `/api/experiments/${exp.id}`);
    r = await t.call('GET', `/api/experiments/${exp.id}`);
    assert.equal(r.status, 404);
  } finally { await t.close(); }
});

test('import accepts exported files and wrapped files', async () => {
  const t = await boot();
  try {
    const a = (await t.call('POST', '/api/experiments', { example: 'trust' })).data.experiment;
    const exported = (await t.call('GET', `/api/experiments/${a.id}`)).data.experiment;
    const r = await t.call('POST', '/api/experiments', { experiment: exported, name: 'Imported' });
    assert.equal(r.data.experiment.name, 'Imported');
    assert.notEqual(r.data.experiment.id, a.id);
    assert.equal(r.data.experiment.stages.length, a.stages.length);
    const bad = await t.call('POST', '/api/experiments', { experiment: { hello: 1 } });
    assert.equal(bad.status, 400);
  } finally { await t.close(); }
});

test('static files: shared modules served, traversal refused, security headers set', async () => {
  const t = await boot();
  try {
    let res = await fetch(`${t.base}/shared/expr.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /javascript/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    for (const bad of ['/shared/../server/app.js', '/shared/%2e%2e/server/app.js', '/%2e%2e/package.json', '/js/../../package.json', '/server/app.js', '/data/db.json']) {
      res = await fetch(`${t.base}${bad}`);
      assert.equal(res.status, 404, bad);
    }
    res = await fetch(`${t.base}/play/xyz`);
    assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
    assert.ok(!res.headers.get('content-security-policy').includes('frame-ancestors'), 'participant pages can be embedded (e.g. in Qualtrics)');
    res = await fetch(`${t.base}/`);
    assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  } finally { await t.close(); }
});

test('persistence: sessions survive a restart', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'econlab-'));
  const s1 = new Store(dir);
  const app1 = createApp({ store: s1 });
  const server = http.createServer(app1.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'X-Requested-With': 'econlab', 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
  const exp = (await post('/api/experiments', { example: 'dictator' })).experiment;
  const { session } = await post(`/api/experiments/${exp.id}/sessions`, { numParticipants: 2, startMode: 'immediate', seed: 3 });
  const code = session.participants[0].code;
  await fetch(`${base}/api/play/${session.participants[0].code}`);
  s1.flush();
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));

  const s2 = new Store(dir);
  const found = s2.findParticipant(code);
  assert.ok(found, 'participant code is indexed after reload');
  assert.equal(found.session.seed, 3);
  assert.equal(found.participant.joined, true);
  assert.ok(Object.keys(s2.db.experiments).length === 1);
  // the reloaded session is still playable (runtime helpers re-attached)
  const app2 = createApp({ store: s2 });
  const server2 = http.createServer(app2.handler);
  await new Promise((r) => server2.listen(0, '127.0.0.1', r));
  const view = await fetch(`http://127.0.0.1:${server2.address().port}/api/play/${code}`).then((r) => r.json());
  assert.ok(['active', 'waiting'].includes(view.status));
  await new Promise((r) => { server2.closeAllConnections?.(); server2.close(r); });
  fs.rmSync(dir, { recursive: true, force: true });
});
