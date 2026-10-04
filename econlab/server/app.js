// The web application: REST API, server-sent events and static files.

import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createRouter, readJson, parseCookies, sendJson, sendText, serveStatic, openSse, HttpError,
} from './http.js';
import {
  createSession, startSession, forceAdvance, participantView, submitStage, markJoined, claimSeat,
  sessionSummary, listSessionRow, takeTouched, tick, randomCode, EngineError,
} from './engine.js';
import { dataTable, timesTable, paymentsTable, toCsv } from './exporter.js';
import { exampleList, getExample, blankExperiment } from './examples.js';
import { normalizeExperiment, validateExperiment } from '../shared/experiment.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const SHARED = path.join(ROOT, 'shared');

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

export function createApp({ store, adminPassword = '', trustProxy = false }) {
  const router = createRouter();
  const adminTokens = new Map();
  const loginFails = new Map();
  const playerStreams = new Map(); // participant code -> Set<sse>
  const adminStreams = new Map(); // session id -> Set<sse>
  const adminTimers = new Map();
  const authRequired = Boolean(adminPassword);

  // ---- helpers -----------------------------------------------------------

  const clientIp = (req) => (trustProxy && req.headers['x-forwarded-for']
    ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : req.socket.remoteAddress ?? '?');

  const isAdmin = (req) => {
    if (!authRequired) return true;
    const exp = adminTokens.get(parseCookies(req).econlab_admin);
    return Boolean(exp && exp > Date.now());
  };

  function notifyAdmin(sessionId) {
    if (adminTimers.has(sessionId)) return;
    const t = setTimeout(() => {
      adminTimers.delete(sessionId);
      for (const s of adminStreams.get(sessionId) ?? []) s.send('update');
    }, 200);
    t.unref?.();
    adminTimers.set(sessionId, t);
  }

  /** Call after anything that may have changed a session. */
  function afterMutation(session) {
    for (const id of takeTouched(session)) {
      const p = session.participants[id - 1];
      for (const s of playerStreams.get(p.code) ?? []) s.send('update');
    }
    notifyAdmin(session.id);
    store.dirty();
  }

  const getExperiment = (id) => {
    const e = store.db.experiments[id];
    if (!e) throw new HttpError(404, 'Experiment not found');
    return e;
  };
  const getSession = (id) => {
    const s = store.db.sessions[id];
    if (!s) throw new HttpError(404, 'Session not found');
    return s;
  };

  const wrapEngine = (fn) => {
    try { return fn(); } catch (e) {
      if (e instanceof EngineError) throw new HttpError(e.status, e.message, e.issues ? { issues: e.issues } : undefined);
      throw e;
    }
  };

  const add = (method, pattern, handler, opts) => router.add(method, pattern, handler, opts);
  const admin = { admin: true };

  // ---- auth --------------------------------------------------------------

  add('GET', '/api/auth', ({ req }) => ({ required: authRequired, authenticated: isAdmin(req) }));

  add('POST', '/api/login', async ({ req, res }) => {
    const ip = clientIp(req);
    const f = loginFails.get(ip);
    if (f && f.count >= 8 && f.until > Date.now()) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
    const { password } = await readJson(req, 10_000);
    if (!authRequired) return { ok: true };
    if (!crypto.timingSafeEqual(sha(password ?? ''), sha(adminPassword))) {
      const cur = f && f.until > Date.now() ? f : { count: 0, until: Date.now() + 5 * 60 * 1000 };
      cur.count++;
      loginFails.set(ip, cur);
      throw new HttpError(401, 'Wrong password');
    }
    loginFails.delete(ip);
    const token = crypto.randomBytes(24).toString('base64url');
    adminTokens.set(token, Date.now() + 24 * 3600 * 1000);
    for (const [k, v] of adminTokens) if (v < Date.now()) adminTokens.delete(k);
    const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `econlab_admin=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400${secure}`);
    return { ok: true };
  });

  add('POST', '/api/logout', ({ req, res }) => {
    adminTokens.delete(parseCookies(req).econlab_admin);
    res.setHeader('Set-Cookie', 'econlab_admin=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    return { ok: true };
  });

  add('GET', '/api/health', () => ({ ok: true }));

  // ---- experiments -------------------------------------------------------

  const experimentRow = (e) => ({
    id: e.id,
    name: e.name,
    description: e.description,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    rounds: e.design.rounds,
    groupSize: e.design.groupSize,
    numStages: e.stages.length,
    numSessions: Object.values(store.db.sessions).filter((s) => s.experimentId === e.id).length,
  });

  add('GET', '/api/examples', () => ({ examples: exampleList() }), admin);

  add('GET', '/api/experiments', () => ({
    experiments: Object.values(store.db.experiments)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(experimentRow),
  }), admin);

  add('POST', '/api/experiments', async ({ req }) => {
    const body = await readJson(req, 3_000_000);
    let raw;
    if (body.example) {
      raw = getExample(body.example);
      if (!raw) throw new HttpError(404, 'Unknown example');
    } else if (body.experiment) {
      raw = body.experiment.experiment && !body.experiment.stages ? body.experiment.experiment : body.experiment;
      if (typeof raw !== 'object' || raw === null || !Array.isArray(raw.stages)) throw new HttpError(400, 'This does not look like an EconLab experiment file (no "stages").');
    } else raw = blankExperiment();
    const now = new Date().toISOString();
    const exp = normalizeExperiment({ ...raw, id: undefined, createdAt: now, updatedAt: now }, now);
    if (typeof body.name === 'string' && body.name.trim()) exp.name = body.name.trim().slice(0, 120);
    store.db.experiments[exp.id] = exp;
    store.dirty();
    return { experiment: exp, issues: validateExperiment(exp) };
  }, admin);

  add('GET', '/api/experiments/:id', ({ params }) => {
    const exp = getExperiment(params.id);
    return { experiment: exp, issues: validateExperiment(exp) };
  }, admin);

  add('PUT', '/api/experiments/:id', async ({ req, params }) => {
    const old = getExperiment(params.id);
    const body = await readJson(req, 3_000_000);
    const exp = normalizeExperiment({ ...body, id: old.id, createdAt: old.createdAt }, old.createdAt);
    exp.updatedAt = new Date().toISOString();
    store.db.experiments[exp.id] = exp;
    store.dirty();
    return { experiment: exp, issues: validateExperiment(exp) };
  }, admin);

  add('DELETE', '/api/experiments/:id', ({ params }) => {
    getExperiment(params.id);
    delete store.db.experiments[params.id];
    store.dirty();
    return { ok: true };
  }, admin);

  add('POST', '/api/experiments/:id/duplicate', ({ params }) => {
    const old = getExperiment(params.id);
    const now = new Date().toISOString();
    const exp = normalizeExperiment({ ...structuredClone(old), id: undefined, name: `${old.name} (copy)`, createdAt: now, updatedAt: now }, now);
    store.db.experiments[exp.id] = exp;
    store.dirty();
    return { experiment: exp };
  }, admin);

  // ---- sessions (researcher) --------------------------------------------

  add('POST', '/api/experiments/:id/sessions', async ({ req, params }) => {
    const exp = getExperiment(params.id);
    const body = await readJson(req, 10_000);
    let code;
    do { code = randomCode(6); } while (store.sessionCodeIndex.has(code));
    const session = wrapEngine(() => createSession(exp, {
      numParticipants: body.numParticipants,
      name: body.name,
      startMode: body.startMode,
      bots: body.bots,
      seed: body.seed,
      code,
      codeExists: (c) => store.hasParticipantCode(c),
    }));
    store.db.sessions[session.id] = session;
    store.indexSession(session);
    afterMutation(session);
    return { session: sessionSummary(session), issues: validateExperiment(session.exp).filter((i) => i.level === 'warning') };
  }, admin);

  add('GET', '/api/sessions', ({ query }) => ({
    sessions: Object.values(store.db.sessions)
      .filter((s) => !query.experimentId || s.experimentId === query.experimentId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(listSessionRow),
  }), admin);

  add('GET', '/api/sessions/:id', ({ params }) => ({ session: sessionSummary(getSession(params.id)) }), admin);

  add('DELETE', '/api/sessions/:id', ({ params }) => {
    const s = getSession(params.id);
    store.unindexSession(s);
    delete store.db.sessions[s.id];
    for (const p of s.participants) for (const stream of playerStreams.get(p.code) ?? []) stream.send('gone');
    store.dirty();
    return { ok: true };
  }, admin);

  add('POST', '/api/sessions/:id/start', ({ params }) => {
    const s = getSession(params.id);
    startSession(s);
    afterMutation(s);
    return { session: sessionSummary(s) };
  }, admin);

  add('POST', '/api/sessions/:id/settings', async ({ req, params }) => {
    const s = getSession(params.id);
    const body = await readJson(req, 10_000);
    if (typeof body.openJoin === 'boolean') s.openJoin = body.openJoin;
    if (typeof body.name === 'string' && body.name.trim()) s.name = body.name.trim().slice(0, 120);
    store.dirty();
    return { ok: true };
  }, admin);

  add('POST', '/api/sessions/:id/participants/:pid/advance', ({ params }) => {
    const s = getSession(params.id);
    const p = s.participants[Number(params.pid) - 1];
    if (!p) throw new HttpError(404, 'Participant not found');
    wrapEngine(() => forceAdvance(s, p));
    afterMutation(s);
    return { session: sessionSummary(s) };
  }, admin);

  add('GET', '/api/sessions/:id/data', ({ params }) => {
    const s = getSession(params.id);
    return {
      data: dataTable(s),
      payments: paymentsTable(s),
      exp: { design: s.exp.design, stages: s.exp.stages.map((st) => ({ id: st.id, title: st.title, type: st.type })) },
    };
  }, admin);

  add('GET', '/api/sessions/:id/export/:file', ({ res, params }) => {
    const s = getSession(params.id);
    const name = params.file;
    const send = (type, body) => sendText(res, 200, body, type, { 'Content-Disposition': `attachment; filename="${s.code}_${name}"` });
    if (name === 'data.csv') return send('text/csv; charset=utf-8', toCsv(dataTable(s)));
    if (name === 'times.csv') return send('text/csv; charset=utf-8', toCsv(timesTable(s)));
    if (name === 'payments.csv') return send('text/csv; charset=utf-8', toCsv(paymentsTable(s)));
    if (name === 'session.json') {
      const { participants, ...meta } = sessionSummary(s);
      return send('application/json; charset=utf-8', JSON.stringify({
        format: 'econlab-session', version: 1, session: meta, participants, experiment: s.exp,
        data: dataTable(s), times: timesTable(s), payments: paymentsTable(s),
        groupVariables: s.groupVars, sessionVariables: s.vars,
      }, null, 2));
    }
    throw new HttpError(404, 'Unknown export');
  }, admin);

  add('GET', '/api/sessions/:id/events', ({ req, res, params }) => {
    const s = getSession(params.id);
    const sse = openSse(req, res);
    const set = adminStreams.get(s.id) ?? new Set();
    adminStreams.set(s.id, set);
    set.add(sse);
    sse.onClose(() => set.delete(sse));
    sse.send('hello');
  }, admin);

  // ---- participants ------------------------------------------------------

  const labelFrom = (q) => q.label ?? q.participant_label ?? q.PROLIFIC_PID ?? q.workerId ?? q.ResponseID ?? q.PID;

  add('GET', '/api/join/:scode', ({ params }) => {
    const s = store.findSessionByCode(params.scode);
    if (!s) throw new HttpError(404, 'This session link is not valid.');
    const free = s.participants.filter((p) => !p.joined && !p.isBot).length;
    return { name: s.exp.name, open: s.openJoin !== false, full: free === 0, status: s.status };
  });

  add('POST', '/api/join/:scode', async ({ req, params }) => {
    const s = store.findSessionByCode(params.scode);
    if (!s) throw new HttpError(404, 'This session link is not valid.');
    if (s.openJoin === false) throw new HttpError(403, 'This session is not accepting new participants.');
    const body = await readJson(req, 20_000);
    const q = body.params && typeof body.params === 'object' ? body.params : {};
    const p = wrapEngine(() => claimSeat(s, { label: labelFrom(q), params: q }));
    afterMutation(s);
    return { code: p.code };
  });

  const playerOf = (code) => {
    const hit = store.findParticipant(code);
    if (!hit) throw new HttpError(404, 'This participant link is not valid.');
    return hit;
  };

  add('GET', '/api/play/:code', ({ params, query }) => {
    const { session, participant } = playerOf(params.code);
    const now = Date.now();
    markJoined(session, participant, { label: labelFrom(query), params: query }, now);
    if (session._touched.size) afterMutation(session);
    return participantView(session, participant, now);
  });

  add('POST', '/api/play/:code/submit', async ({ req, res, params }) => {
    const { session, participant } = playerOf(params.code);
    const body = await readJson(req, 100_000);
    const result = submitStage(session, participant, body.values ?? {}, { stageKey: body.key });
    if (result.ok) {
      afterMutation(session);
      return { ok: true, view: participantView(session, participant) };
    }
    const payload = { ok: false, error: result.error, errors: result.errors, formErrors: result.formErrors };
    if (result.stale) payload.view = participantView(session, participant);
    return sendJson(res, result.status ?? 400, payload);
  });

  add('GET', '/api/play/:code/events', ({ req, res, params }) => {
    const { participant } = playerOf(params.code);
    const sse = openSse(req, res);
    const set = playerStreams.get(participant.code) ?? new Set();
    playerStreams.set(participant.code, set);
    set.add(sse);
    sse.onClose(() => { set.delete(sse); if (!set.size) playerStreams.delete(participant.code); });
    sse.send('hello');
  });

  // ---- request dispatch --------------------------------------------------

  const securityHeaders = (res, isPlay) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'${isPlay ? '' : "; frame-ancestors 'none'"}`,
    );
  };

  async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    const isPlayPage = /^\/(play|join)\//.test(pathname);
    securityHeaders(res, isPlayPage);

    try {
      if (pathname.startsWith('/api/')) {
        const { route, params, pathMatched } = router.match(method, pathname);
        if (!route) throw new HttpError(pathMatched ? 405 : 404, pathMatched ? 'Method not allowed' : 'Not found');
        if (method !== 'GET' && req.headers['x-requested-with'] !== 'econlab') throw new HttpError(403, 'Missing X-Requested-With header');
        if (route.opts.admin && !isAdmin(req)) throw new HttpError(401, 'Please sign in');
        const query = Object.fromEntries(url.searchParams);
        const out = await route.handler({ req, res, params, query, url });
        if (!res.headersSent && !res.writableEnded) sendJson(res, 200, out ?? { ok: true });
        return;
      }
      if (method !== 'GET') throw new HttpError(405, 'Method not allowed');
      let served;
      if (pathname === '/' || pathname === '/index.html') served = serveStatic(res, PUBLIC, 'index.html');
      else if (isPlayPage) served = serveStatic(res, PUBLIC, 'play.html');
      else if (pathname.startsWith('/shared/')) served = serveStatic(res, SHARED, pathname.slice(8));
      else served = serveStatic(res, PUBLIC, pathname);
      if (!served) throw new HttpError(404, 'Not found');
      return;
    } catch (e) {
      if (res.headersSent) { res.end(); return; }
      if (e instanceof HttpError) {
        if (pathname.startsWith('/api/')) sendJson(res, e.status, { error: e.message, ...(e.extra ?? {}) });
        else sendText(res, e.status, e.status === 404 ? 'Page not found' : e.message);
        return;
      }
      console.error(e);
      sendJson(res, 500, { error: 'Internal server error' });
    }
  }

  /** Enforce page timeouts for running sessions. */
  function tickAll(now = Date.now()) {
    for (const s of Object.values(store.db.sessions)) {
      if (s.status !== 'running') continue;
      if (tick(s, now)) afterMutation(s);
    }
  }

  return { handler, tickAll, afterMutation };
}
