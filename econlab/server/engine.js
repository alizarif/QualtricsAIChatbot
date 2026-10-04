// The session engine: everything that happens after a researcher presses
// "Run" lives here. It is a plain-data state machine – a session is a JSON
// object and every function mutates it synchronously, which makes it trivially
// testable and means a server restart loses nothing.
//
// Positions
//   Each participant has a cursor pos = {r, s}: round r (1-based) and stage
//   index s. s === -1 is the implicit "round barrier": in group experiments
//   everybody in a group must reach the start of a round together, so players
//   can never read data of group-mates who are still in the previous round.
//
// States
//   pending  – cursor moved, not yet settled (transient)
//   active   – looking at an info/decision page, owes the server an answer
//   waiting  – parked at a barrier or wait page until the whole set arrives
//   done     – finished all rounds

import crypto from 'node:crypto';
import {
  parse, evaluate, interpolate, cleanNum, toDisplay, toBool, roundTo, ExprError,
} from '../shared/expr.js';
import {
  normalizeExperiment, validateExperiment, formatMoney, formatPoints, formatRate,
} from '../shared/experiment.js';
import { seedState, rngFromState, shuffled } from './rng.js';

export class EngineError extends Error {
  constructor(message, { status = 400, issues } = {}) {
    super(message);
    this.name = 'EngineError';
    this.status = status;
    this.issues = issues;
  }
}

const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export function randomCode(n) {
  const bytes = crypto.randomBytes(n * 2);
  let out = '';
  for (let i = 0; out.length < n; i++) {
    const b = bytes[i % bytes.length];
    if (b < 248) out += CODE_ALPHABET[b % 31]; // 248 = 31*8, no modulo bias
    if (i > n * 40) throw new Error('entropy');
  }
  return out;
}

export const MAX_PARTICIPANTS = 1000;
const TIMEOUT_GRACE_MS = 1500;

// ---------------------------------------------------------------------------
// Session creation
// ---------------------------------------------------------------------------

export function createSession(experiment, opts = {}) {
  const exp = normalizeExperiment(experiment);
  const issues = validateExperiment(exp);
  const errors = issues.filter((i) => i.level === 'error');
  if (errors.length) {
    throw new EngineError(`The experiment has ${errors.length} error(s): ${errors[0].message}`, { issues });
  }
  const d = exp.design;
  const G = d.groupSize;
  const N = Math.round(Number(opts.numParticipants));
  if (!Number.isFinite(N) || N < 1 || N > MAX_PARTICIPANTS) throw new EngineError(`Number of participants must be between 1 and ${MAX_PARTICIPANTS}.`);
  if (N % G !== 0) throw new EngineError(`With ${G} players per group the number of participants must be a multiple of ${G} (you entered ${N}).`);
  const bots = Math.max(0, Math.min(N, Math.round(Number(opts.bots) || 0)));
  const now = opts.now ?? Date.now();
  const seed = Number.isFinite(Number(opts.seed)) && opts.seed !== '' && opts.seed != null
    ? Number(opts.seed) >>> 0 : crypto.randomInt(0, 2 ** 31);
  const state = seedState(seed);
  const rng = rngFromState(state);

  const codeTaken = opts.codeExists ?? (() => false);
  const used = new Set();
  const newCode = () => {
    for (let i = 0; i < 50; i++) {
      const c = randomCode(8);
      if (!used.has(c) && !codeTaken(c)) { used.add(c); return c; }
    }
    throw new Error('Could not generate a unique participant code');
  };

  const ids = Array.from({ length: N }, (_, i) => i + 1);
  const T = d.treatments.length || 1;
  const blocks = [];
  const order = shuffled(ids, rng);
  for (let i = 0; i < N; i += G) blocks.push(order.slice(i, i + G));
  const blockTreat = [];
  for (let b = 0; b < blocks.length; b += T) {
    const perm = shuffled([...Array(T).keys()], rng);
    for (let k = 0; k < T && b + k < blocks.length; k++) blockTreat[b + k] = perm[k];
  }
  const pools = Array.from({ length: T }, () => []);
  blocks.forEach((blk, b) => pools[blockTreat[b]].push(...blk));

  const chunk = (arr) => { const out = []; for (let i = 0; i < arr.length; i += G) out.push(arr.slice(i, i + G)); return out; };
  // A participant's role (id_in_group) is the position they get in round 1; it
  // stays the same every round, or shifts by one each round if rotateRoles is on.
  const base = new Map(); // participant id -> round-1 id_in_group (1-based)
  const roundOne = pools.flatMap(chunk);
  roundOne.forEach((g) => g.forEach((id, k) => base.set(id, k + 1)));
  const idIn = (id, r) => (d.rotateRoles ? ((base.get(id) - 1 + (r - 1)) % G) + 1 : base.get(id));

  const groups = [roundOne];
  const slotIds = [new Map(roundOne.flatMap((g) => g.map((id) => [id, base.get(id)])))];
  for (let r = 2; r <= d.rounds; r++) {
    let roundGroups;
    if (d.matching === 'fixed' || G === 1) {
      roundGroups = roundOne.map((g) => [...g]);
    } else {
      // random re-matching within each treatment pool: one participant per id in every group
      roundGroups = pools.flatMap((pool) => {
        const buckets = Array.from({ length: G }, () => []);
        for (const id of pool) buckets[idIn(id, r) - 1].push(id);
        buckets.forEach((b, i) => { buckets[i] = shuffled(b, rng); });
        return Array.from({ length: pool.length / G }, (_, j) => buckets.map((b) => b[j]));
      });
    }
    groups.push(roundGroups);
    slotIds.push(new Map(roundGroups.flatMap((g) => g.map((id) => [id, idIn(id, r)]))));
  }

  const participants = ids.map((id) => ({
    id,
    code: newCode(),
    label: '',
    params: {},
    treatment: null,
    isBot: false,
    joined: false,
    joinedAt: null,
    lastSeen: null,
    pos: { r: 1, s: G > 1 ? -1 : 0 },
    state: 'pending',
    waitSince: null,
    stageStartedAt: null,
    rounds: {},
    slots: [],
    paidRound: d.payment.mode === 'random_round' ? 1 + Math.floor(rng() * d.rounds) : null,
    done: false,
    finishedAt: null,
  }));
  blocks.forEach((blk, b) => {
    if (d.treatments.length) blk.forEach((id) => { participants[id - 1].treatment = d.treatments[blockTreat[b]].name; });
  });
  groups.forEach((roundGroups, ri) => {
    roundGroups.forEach((g, gi) => {
      g.forEach((id) => { participants[id - 1].slots[ri] = { g: gi, i: slotIds[ri].get(id) }; });
    });
  });
  // Bots are the last participants so a researcher can sit at the first seats.
  for (let k = 0; k < bots; k++) {
    const p = participants[N - 1 - k];
    p.isBot = true;
    p.joined = true;
    p.joinedAt = now;
    p.label = `bot-${p.id}`;
  }

  const session = {
    id: opts.id ?? `ses_${crypto.randomBytes(5).toString('hex')}`,
    code: opts.code ?? randomCode(6),
    name: String(opts.name ?? '').slice(0, 120) || exp.name,
    experimentId: exp.id,
    createdAt: new Date(now).toISOString(),
    startMode: opts.startMode === 'immediate' ? 'immediate' : 'manual',
    started: false,
    startedAt: null,
    status: 'waiting', // waiting | running | finished
    finishedAt: null,
    seed,
    rng: state,
    exp,
    numParticipants: N,
    participants,
    groups,
    groupVars: {},
    vars: {},
    errors: [],
  };
  attachRuntime(session);
  for (const p of participants) enqueue(session, p);
  processQueue(session, now);
  if (session.startMode === 'immediate') startSession(session, now);
  return session;
}

/** Non-persisted helpers; call after loading a session from disk too. */
export function attachRuntime(session) {
  Object.defineProperty(session, '_rng', { value: rngFromState(session.rng), enumerable: false, writable: true, configurable: true });
  Object.defineProperty(session, '_queue', { value: [], enumerable: false, writable: true, configurable: true });
  Object.defineProperty(session, '_touched', { value: new Set(), enumerable: false, writable: true, configurable: true });
  Object.defineProperty(session, '_processing', { value: false, enumerable: false, writable: true, configurable: true });
  Object.defineProperty(session, '_constCache', { value: new Map(), enumerable: false, writable: true, configurable: true });
  return session;
}

export function startSession(session, now = Date.now()) {
  if (session.started) return;
  session.started = true;
  session.startedAt = new Date(now).toISOString();
  session.status = 'running';
  for (const p of session.participants) {
    if (p.state === 'active' && p.joined && !p.stageStartedAt) p.stageStartedAt = now;
    enqueue(session, p);
    touch(session, p);
  }
  processQueue(session, now);
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

const hasBarrier = (session) => session.exp.design.groupSize > 1;
const numRounds = (session) => session.exp.design.rounds;

function nextPos(session, pos) {
  if (pos.s + 1 < session.exp.stages.length) return { r: pos.r, s: pos.s + 1 };
  return { r: pos.r + 1, s: hasBarrier(session) ? -1 : 0 };
}

const posLess = (a, b) => a.r < b.r || (a.r === b.r && a.s < b.s);
const posKey = (pos) => `${pos.r}:${pos.s}`;
const roundData = (p, r) => (p.rounds[r] ??= { vars: {}, times: {}, auto: [] });

function membersOf(session, r, g) {
  return session.groups[r - 1][g]
    .map((id) => session.participants[id - 1])
    .sort((a, b) => a.slots[r - 1].i - b.slots[r - 1].i);
}

function groupOf(session, p, r) {
  return membersOf(session, r, p.slots[r - 1].g);
}

const roleOf = (session, p, r) => session.exp.design.roles[p.slots[r - 1].i - 1] ?? '';

function touch(session, p) { session._touched.add(p.id); }
export function takeTouched(session) {
  const ids = [...session._touched];
  session._touched.clear();
  return ids;
}

function logError(session, where, message, p) {
  const prior = session.errors.find((e) => e.where === where && e.message === message);
  if (prior) { prior.count++; prior.last = new Date().toISOString(); return; }
  if (session.errors.length >= 100) return;
  session.errors.push({ where, message, participant: p?.id ?? null, count: 1, last: new Date().toISOString() });
}

// ---------------------------------------------------------------------------
// Expression scope
// ---------------------------------------------------------------------------

function nullObject(src) {
  const o = Object.create(null);
  if (src) Object.assign(o, src);
  return o;
}

function constantsFor(session, treatment) {
  const key = treatment ?? '';
  let c = session._constCache.get(key);
  if (!c) {
    const d = session.exp.design;
    const t = d.treatments.find((x) => x.name === treatment);
    c = nullObject({ ...d.constants, ...(t ? t.constants : {}) });
    session._constCache.set(key, c);
  }
  return c;
}

function playerObject(session, p, r) {
  const o = nullObject(roundData(p, r).vars);
  o.id_in_group = p.slots[r - 1].i;
  o.role = roleOf(session, p, r);
  o.round = r;
  o.participant = p.id;
  o.treatment = p.treatment ?? '';
  o.label = p.label;
  o.id = p.id;
  if (!Object.hasOwn(o, 'payoff')) o.payoff = 0;
  return o;
}

function totalPoints(session, p, upTo) {
  let sum = 0;
  for (let r = 1; r <= upTo; r++) {
    const v = p.rounds[r]?.vars.payoff;
    if (typeof v === 'number') sum += v;
  }
  return cleanNum(sum);
}

function buildScope(session, p, r) {
  const scope = Object.create(null);
  const lazy = (name, fn) => {
    let cached; let done = false;
    Object.defineProperty(scope, name, {
      enumerable: true,
      get() { if (!done) { cached = fn(); done = true; } return cached; },
    });
  };
  scope.round = r;
  scope.num_rounds = numRounds(session);
  scope.treatment = p.treatment ?? '';
  scope.const = constantsFor(session, p.treatment);
  lazy('session', () => nullObject(session.vars));
  lazy('player', () => playerObject(session, p, r));
  lazy('group', () => {
    const g = p.slots[r - 1].g;
    const o = nullObject(session.groupVars[`${r}:${g}`]);
    o.id = g + 1;
    o.size = session.exp.design.groupSize;
    o.players = membersOf(session, r, g).map((q) => playerObject(session, q, r));
    return o;
  });
  lazy('others', () => groupOf(session, p, r).filter((q) => q !== p).map((q) => playerObject(session, q, r)));
  lazy('roles', () => {
    const o = nullObject();
    for (const q of groupOf(session, p, r)) { const role = roleOf(session, q, r); if (role) o[role] = playerObject(session, q, r); }
    return o;
  });
  lazy('prev', () => (r > 1 ? playerObject(session, p, r - 1) : nullObject()));
  lazy('history', () => {
    const o = nullObject();
    for (let rr = 1; rr < r; rr++) {
      const po = playerObject(session, p, rr);
      for (const k of Object.keys(po)) (o[k] ??= []).push(po[k]);
    }
    return o;
  });
  lazy('participant', () => nullObject({ id: p.id, label: p.label, treatment: p.treatment ?? '', payoff: totalPoints(session, p, r) }));
  lazy('all_players', () => session.participants.map((q) => playerObject(session, q, r)));
  return scope;
}

function sessionScope(session, r) {
  const scope = Object.create(null);
  scope.round = r;
  scope.num_rounds = numRounds(session);
  scope.const = constantsFor(session, null);
  scope.session = nullObject(session.vars);
  scope.all_players = session.participants.map((q) => playerObject(session, q, r));
  return scope;
}

function evalOptions(session) {
  const pay = session.exp.design.payment;
  return {
    rng: session._rng,
    money: (pts) => formatMoney(pay, pts * pay.exchangeRate),
    points: (pts) => formatPoints(pay, pts),
  };
}

/** Evaluate, logging (not throwing) on error. Returns {ok, value}. */
function safeEval(session, src, scope, where, p) {
  try {
    return { ok: true, value: evaluate(parse(src), scope, evalOptions(session)) };
  } catch (e) {
    if (!(e instanceof ExprError)) throw e;
    logError(session, where, `${e.message} — in “${String(src).slice(0, 120)}”`, p);
    return { ok: false, value: null, error: e.message };
  }
}

function render(session, p, r, text, where) {
  if (typeof text !== 'string' || !text.includes('{{')) return text ?? '';
  const scope = buildScope(session, p, r);
  return interpolate(text, (src) => evaluate(parse(src), scope, evalOptions(session)), (e, src) => {
    logError(session, where, `${e.message} — in “{{ ${src.slice(0, 100)} }}”`, p);
  });
}

function storable(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? cleanNum(v) : null;
  if (typeof v === 'boolean' || typeof v === 'string' || v === null) return v;
  return undefined;
}

function assign(session, row, target, value, p, r) {
  const v = storable(value);
  if (v === undefined) {
    logError(session, `${row.scope}.${row.name}`, 'A variable can only hold a number, text or true/false (not a list).', p);
    return;
  }
  if (row.scope === 'player') roundData(target, r).vars[row.name] = v;
  else if (row.scope === 'group') {
    const key = `${r}:${p.slots[r - 1].g}`;
    (session.groupVars[key] ??= {})[row.name] = v;
  } else session.vars[row.name] = v;
}

// ---------------------------------------------------------------------------
// Compute rows
// ---------------------------------------------------------------------------

function runPlayerRows(session, stage, p, r) {
  for (const row of stage.compute) {
    if (row.scope !== 'player') continue;
    const res = safeEval(session, row.expr, buildScope(session, p, r), `${stage.title || 'stage'} → player.${row.name}`, p);
    assign(session, row, p, res.value, p, r);
  }
}

/** Runs when the last member of a wait set arrives. Rows execute top-to-bottom. */
function runWaitRows(session, stage, r, set) {
  if (!stage.compute.length) return;
  const gidx = [...new Set(set.map((q) => q.slots[r - 1].g))];
  for (const row of stage.compute) {
    const where = `${stage.title || 'wait page'} → ${row.scope}.${row.name}`;
    if (row.scope === 'session') {
      const res = safeEval(session, row.expr, sessionScope(session, r), where, null);
      assign(session, row, null, res.value, set[0], r);
    } else if (row.scope === 'group') {
      for (const g of gidx) {
        const first = membersOf(session, r, g)[0];
        const res = safeEval(session, row.expr, buildScope(session, first, r), where, first);
        assign(session, row, null, res.value, first, r);
      }
    } else {
      for (const g of gidx) {
        const members = membersOf(session, r, g);
        // two-phase so that a row cannot read values assigned earlier in the same row
        const vals = members.map((m) => safeEval(session, row.expr, buildScope(session, m, r), where, m).value);
        members.forEach((m, k) => assign(session, row, m, vals[k], m, r));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

function enqueue(session, p) { if (!p.done) session._queue.push(p); }

function stageAt(session, pos) {
  if (pos.s === -1) return { type: 'barrier', id: `barrier_${pos.r}`, title: 'Waiting for the group' };
  return session.exp.stages[pos.s];
}

function waitSetOf(session, p) {
  const { r, s } = p.pos;
  if (s === -1 || session.exp.stages[s].waitFor !== 'all') return groupOf(session, p, r);
  return session.participants;
}

export function processQueue(session, now = Date.now()) {
  if (session._processing) return;
  session._processing = true;
  try {
    for (;;) {
      while (session._queue.length) settle(session, session._queue.shift(), now);
      if (!runBots(session, now)) break;
    }
  } finally {
    session._processing = false;
  }
  if (!session.finishedAt && session.participants.every((q) => q.done)) {
    session.finishedAt = new Date(now).toISOString();
    session.status = 'finished';
  }
}

function settle(session, p, now) {
  for (let guard = 0; guard < 100000; guard++) {
    if (p.done || p.state === 'active') return;
    if (p.pos.r > numRounds(session)) { finish(session, p, now); return; }
    const stage = stageAt(session, p.pos);
    if (stage.type === 'barrier' || stage.type === 'wait') {
      const key = posKey(p.pos);
      if (p.state !== 'waiting' || p.waitKey !== key) {
        p.state = 'waiting';
        p.waitSince = now;
        p.waitKey = key;
        const set = waitSetOf(session, p);
        if (set.length <= 60) set.forEach((q) => touch(session, q)); else touch(session, p);
      }
      trySync(session, p, now);
      return;
    }
    if (stage.showIf) {
      const res = safeEval(session, stage.showIf, buildScope(session, p, p.pos.r), `${stage.title || 'stage'} → show only if`, p);
      if (res.ok && !res.value) { p.pos = nextPos(session, p.pos); continue; }
    }
    p.state = 'active';
    p.stageStartedAt = p.joined && session.started ? now : null;
    touch(session, p);
    return;
  }
  throw new Error('settle did not terminate');
}

function trySync(session, p, now) {
  const { r, s } = p.pos;
  const barrier = s === -1;
  const set = waitSetOf(session, p);
  for (const q of set) {
    if (q.pos.r !== r || q.pos.s !== s || q.state !== 'waiting') return false;
    if (barrier && (!q.joined || !session.started)) return false;
  }
  if (!barrier) {
    const stage = session.exp.stages[s];
    runWaitRows(session, stage, r, set);
    for (const q of set) {
      roundData(q, r).times[stage.id] = { start: q.waitSince, end: now, auto: false };
    }
  }
  for (const q of set) {
    q.pos = nextPos(session, q.pos);
    q.state = 'pending';
    enqueue(session, q);
    touch(session, q);
  }
  return true;
}

function finish(session, p, now) {
  p.done = true;
  p.state = 'done';
  p.finishedAt = new Date(now).toISOString();
  touch(session, p);
}

// ---------------------------------------------------------------------------
// Joining
// ---------------------------------------------------------------------------

export function markJoined(session, p, { label, params } = {}, now = Date.now()) {
  p.lastSeen = now;
  if (params && typeof params === 'object') {
    const clean = {};
    for (const [k, v] of Object.entries(params).slice(0, 20)) clean[String(k).slice(0, 60)] = String(v).slice(0, 200);
    p.params = { ...p.params, ...clean };
  }
  if (typeof label === 'string' && label.trim()) p.label = label.trim().slice(0, 100);
  if (!p.joined) {
    p.joined = true;
    p.joinedAt = now;
    if (p.state === 'active' && session.started && !p.stageStartedAt) p.stageStartedAt = now;
    touch(session, p);
    enqueue(session, p);
    processQueue(session, now);
  }
}

/** Open-join link: hand out the next seat nobody has taken. */
export function claimSeat(session, info = {}, now = Date.now()) {
  const p = session.participants.find((q) => !q.joined && !q.isBot);
  if (!p) throw new EngineError('This session is full.', { status: 409 });
  markJoined(session, p, info, now);
  return p;
}

// ---------------------------------------------------------------------------
// Submitting a page
// ---------------------------------------------------------------------------

function evalBound(session, v, scope, where, p) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim()) {
    const res = safeEval(session, v, scope, where, p);
    return res.ok && typeof res.value === 'number' ? res.value : null;
  }
  return null;
}

function fieldBounds(session, f, scope, stage, p) {
  const where = `${stage.title || 'decision'} → ${f.name}`;
  return {
    min: evalBound(session, f.min, scope, `${where} (min)`, p),
    max: evalBound(session, f.max, scope, `${where} (max)`, p),
  };
}

function defaultFor(session, f, scope, stage, p) {
  const { min, max } = fieldBounds(session, f, scope, stage, p);
  const clamp = (x) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, x));
  switch (f.type) {
    case 'integer': case 'number': case 'slider': case 'likert': {
      let v = evalBound(session, f.default, scope, `${stage.title || 'decision'} → ${f.name} (default)`, p);
      if (v === null) v = min ?? 0;
      v = clamp(v);
      return f.type === 'integer' || f.type === 'likert' ? Math.round(v) : v;
    }
    case 'choice': {
      const d = f.default;
      const hit = f.options.find((o) => String(o.value) === String(d));
      return (hit ?? f.options[0])?.value ?? null;
    }
    case 'checkbox': return f.default === true;
    default: return typeof f.default === 'string' ? f.default : '';
  }
}

function parseField(session, f, raw, scope, stage, p) {
  const empty = raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '');
  if (f.type === 'checkbox') {
    const v = raw === true || raw === 'true' || raw === 1 || raw === 'on';
    if (f.required && !v) return { error: 'Please tick this box to continue.' };
    return { value: v };
  }
  if (empty) {
    if (f.required) return { error: f.type === 'choice' ? 'Please choose an option.' : 'Please enter a value.' };
    return { value: null };
  }
  switch (f.type) {
    case 'integer': case 'number': case 'slider': case 'likert': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim().replace(',', '.'));
      if (!Number.isFinite(n)) return { error: 'Please enter a number.' };
      if ((f.type === 'integer' || f.type === 'likert') && !Number.isInteger(n)) return { error: 'Please enter a whole number.' };
      const { min, max } = fieldBounds(session, f, scope, stage, p);
      if (min !== null && max !== null && (n < min || n > max)) return { error: `Please enter a number between ${toDisplay(min)} and ${toDisplay(max)}.` };
      if (min !== null && n < min) return { error: `The number must be at least ${toDisplay(min)}.` };
      if (max !== null && n > max) return { error: `The number must be at most ${toDisplay(max)}.` };
      if (f.type === 'slider' && f.step && min !== null) {
        const k = (n - min) / f.step;
        if (Math.abs(k - Math.round(k)) > 1e-6) return { error: `The value must be a multiple of ${toDisplay(f.step)} above ${toDisplay(min)}.` };
      }
      return { value: cleanNum(n) };
    }
    case 'choice': {
      const hit = f.options.find((o) => String(o.value) === String(raw));
      if (!hit) return { error: 'Please choose one of the options.' };
      return { value: hit.value };
    }
    default: {
      const s = String(raw).trim();
      if (s.length > 5000) return { error: 'Please keep your answer under 5000 characters.' };
      return { value: s };
    }
  }
}

export const stageKeyOf = (p) => posKey(p.pos);

export function submitStage(session, p, rawValues = {}, { auto = false, stageKey, now = Date.now() } = {}) {
  if (!session.started) return { ok: false, status: 409, error: 'The session has not started yet.' };
  if (p.state !== 'active') return { ok: false, status: 409, error: 'There is nothing to submit right now.', stale: true };
  if (stageKey && stageKey !== posKey(p.pos)) return { ok: false, status: 409, error: 'This page is out of date.', stale: true };
  const stage = session.exp.stages[p.pos.s];
  const r = p.pos.r;
  const rd = roundData(p, r);
  const errors = {};
  let values = {};

  if (stage.type === 'decision') {
    const scope = buildScope(session, p, r);
    for (const f of stage.fields) {
      if (auto) { values[f.name] = defaultFor(session, f, scope, stage, p); continue; }
      const res = parseField(session, f, rawValues?.[f.name], scope, stage, p);
      if (res.error) errors[f.name] = res.error; else values[f.name] = res.value;
    }
    if (Object.keys(errors).length) return { ok: false, status: 422, errors };
  }

  const before = { ...rd.vars };
  Object.assign(rd.vars, values);

  if (stage.type === 'decision' && !auto && stage.checks.length) {
    const scope = buildScope(session, p, r);
    const messages = [];
    for (const c of stage.checks) {
      const res = safeEval(session, c.expr, scope, `${stage.title || 'decision'} → check`, p);
      if (res.ok && !toBool(res.value)) messages.push(c.message || 'Your answer is not valid.');
    }
    if (messages.length) {
      rd.vars = before;
      return { ok: false, status: 422, formErrors: messages };
    }
  }

  rd.times[stage.id] = { start: p.stageStartedAt ?? now, end: now, auto };
  if (auto && !rd.auto.includes(stage.id)) rd.auto.push(stage.id);
  runPlayerRows(session, stage, p, r);

  p.pos = nextPos(session, p.pos);
  p.state = 'pending';
  p.stageStartedAt = null;
  touch(session, p);
  enqueue(session, p);
  processQueue(session, now);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Researcher tools: force a stuck participant forward
// ---------------------------------------------------------------------------

function pushTo(session, q, target, now) {
  for (let guard = 0; guard < 5000; guard++) {
    if (q.done) return;
    if (!posLess(q.pos, target)) {
      // at the target: an absent participant counts as arrived at a barrier
      if (q.pos.r === target.r && q.pos.s === target.s && target.s === -1 && !q.joined) {
        q.joined = true; q.joinedAt = now;
        enqueue(session, q); processQueue(session, now);
      }
      return;
    }
    stepForce(session, q, now);
  }
}

function stepForce(session, q, now) {
  if (q.state === 'active') {
    if (!q.joined) { q.joined = true; q.joinedAt = now; }
    submitStage(session, q, {}, { auto: true, now });
  } else if (q.state === 'waiting') {
    const pos = { ...q.pos };
    for (const m of waitSetOf(session, q)) pushTo(session, m, pos, now);
  } else {
    enqueue(session, q);
    processQueue(session, now);
  }
}

/** Moves one participant forward by one step, filling defaults for anyone holding them up. */
export function forceAdvance(session, p, now = Date.now()) {
  if (!session.started) throw new EngineError('Start the session first.', { status: 409 });
  if (p.done) return;
  const before = posKey(p.pos) + p.state;
  stepForce(session, p, now);
  if (posKey(p.pos) + p.state === before && !p.done) throw new EngineError('Could not advance this participant.', { status: 409 });
}

/** Called about once a second: enforce page timeouts. Returns true if anything changed. */
export function tick(session, now = Date.now()) {
  if (!session.started || session.status === 'finished') return false;
  let changed = false;
  for (const p of session.participants) {
    if (p.state !== 'active' || !p.joined || !p.stageStartedAt) continue;
    const stage = session.exp.stages[p.pos.s];
    if (!stage?.timeoutSeconds) continue;
    if (now > p.stageStartedAt + stage.timeoutSeconds * 1000 + TIMEOUT_GRACE_MS) {
      submitStage(session, p, {}, { auto: true, now });
      changed = true;
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Bots
// ---------------------------------------------------------------------------

function botValues(session, p, stage) {
  const rng = session._rng;
  const scope = buildScope(session, p, p.pos.r);
  const out = {};
  for (const f of stage.fields) {
    const { min, max } = fieldBounds(session, f, scope, stage, p);
    switch (f.type) {
      case 'integer': case 'likert': {
        const lo = Math.ceil(min ?? (typeof f.default === 'number' ? f.default : 0));
        const hi = Math.floor(max ?? lo + 100);
        out[f.name] = hi >= lo ? lo + Math.floor(rng() * (hi - lo + 1)) : lo;
        break;
      }
      case 'number': case 'slider': {
        const lo = min ?? 0; const hi = max ?? lo + 100;
        if (f.type === 'slider' && f.step) {
          const k = Math.floor((hi - lo) / f.step);
          out[f.name] = cleanNum(lo + f.step * Math.floor(rng() * (k + 1)));
        } else out[f.name] = cleanNum(hi >= lo ? lo + rng() * (hi - lo) : lo);
        break;
      }
      case 'choice': out[f.name] = f.options.length ? f.options[Math.floor(rng() * f.options.length)].value : null; break;
      case 'checkbox': out[f.name] = f.required ? true : rng() < 0.5; break;
      default: out[f.name] = 'bot response';
    }
  }
  return out;
}

function runBots(session, now) {
  if (!session.started) return false;
  let acted = false;
  for (let guard = 0; guard < 500000; guard++) {
    const bot = session.participants.find((q) => q.isBot && q.state === 'active');
    if (!bot) break;
    const stage = session.exp.stages[bot.pos.s];
    let res = { ok: false };
    for (let attempt = 0; attempt < 12 && !res.ok; attempt++) {
      res = submitStageInner(session, bot, stage.type === 'decision' ? botValues(session, bot, stage) : {}, now);
    }
    if (!res.ok) submitStageInner(session, bot, {}, now, true);
    acted = true;
  }
  return acted;
}

// runBots is invoked from within processQueue (which already holds the
// _processing lock), so nested submits must only enqueue, not re-enter.
function submitStageInner(session, p, values, now, auto = false) {
  return submitStage(session, p, values, { auto, now });
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

export function paymentOf(session, p) {
  const pay = session.exp.design.payment;
  const R = numRounds(session);
  const done = Math.min(R, p.done ? R : p.pos.r);
  let points;
  if (pay.mode === 'random_round') points = p.rounds[p.paidRound]?.vars.payoff ?? 0;
  else if (pay.mode === 'last_round') points = p.rounds[R]?.vars.payoff ?? 0;
  else points = totalPoints(session, p, done);
  points = cleanNum(Number(points) || 0);
  const earnings = roundTo(points * pay.exchangeRate, 2);
  const fee = pay.participationFee;
  return {
    points,
    earnings,
    fee,
    total: roundTo(earnings + fee, 2),
    paidRound: p.paidRound,
    finished: p.done,
  };
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function fieldView(session, f, scope, stage, p, r) {
  const where = `${stage.title || 'decision'} → ${f.name}`;
  const text = (t) => render(session, p, r, t, where);
  const { min, max } = fieldBounds(session, f, scope, stage, p);
  return {
    name: f.name,
    type: f.type,
    label: text(f.label),
    help: text(f.help),
    required: f.required,
    min,
    max,
    step: f.step,
    suffix: f.suffix,
    layout: f.layout,
    minLabel: f.minLabel,
    maxLabel: f.maxLabel,
    options: f.options.map((o) => ({ value: o.value, label: text(o.label) })),
    default: defaultFor(session, f, scope, stage, p),
  };
}

export function participantView(session, p, now = Date.now()) {
  const exp = session.exp;
  const d = exp.design;
  const base = {
    experiment: exp.name,
    participant: { id: p.id, code: p.code, label: p.label },
    rounds: d.rounds,
    now,
  };
  if (!session.started) {
    return { ...base, status: 'lobby', message: render(session, p, 1, d.lobbyMessage, 'lobby message') };
  }
  if (p.state === 'done') {
    const pay = paymentOf(session, p);
    const R = d.rounds;
    const perRound = [];
    if (R <= 40) for (let r = 1; r <= R; r++) perRound.push({ round: r, points: cleanNum(Number(p.rounds[r]?.vars.payoff) || 0) });
    return {
      ...base,
      status: 'done',
      message: render(session, p, R, d.finalMessage, 'final message'),
      completionUrl: d.completionUrl,
      payment: {
        mode: d.payment.mode,
        paidRound: pay.paidRound,
        points: formatPoints(d.payment, pay.points),
        pointsValue: pay.points,
        rate: formatRate(d.payment),
        earnings: formatMoney(d.payment, pay.earnings),
        fee: pay.fee ? formatMoney(d.payment, pay.fee) : null,
        total: formatMoney(d.payment, pay.total),
        perRound,
        showRate: d.payment.exchangeRate > 0,
      },
    };
  }
  const r = Math.min(p.pos.r, d.rounds);
  const header = { ...base, round: r, role: roleOf(session, p, r) || null, group: p.slots[r - 1].g + 1 };
  if (p.state === 'waiting' || p.state === 'pending') {
    const barrier = p.pos.s === -1;
    const stage = barrier ? null : exp.stages[p.pos.s];
    const set = waitSetOf(session, p);
    const arrived = set.filter((q) => q.state === 'waiting' && q.pos.r === p.pos.r && q.pos.s === p.pos.s && (!barrier || q.joined)).length;
    return {
      ...header,
      status: 'waiting',
      key: posKey(p.pos),
      title: barrier ? 'Please wait' : render(session, p, r, stage.title, 'wait title') || 'Please wait',
      message: barrier
        ? (p.pos.r === 1 ? 'Waiting for the other participants in your group to arrive…' : 'Waiting for the other participants in your group to finish the previous round…')
        : render(session, p, r, stage.body, `${stage.title || 'wait page'} → text`) || 'Waiting for the other participants…',
      arrived: set.length <= 200 ? arrived : null,
      total: set.length <= 200 ? set.length : null,
    };
  }
  const stage = exp.stages[p.pos.s];
  const scope = buildScope(session, p, r);
  const where = stage.title || 'page';
  const view = {
    ...header,
    status: 'active',
    key: posKey(p.pos),
    stage: {
      id: stage.id,
      type: stage.type,
      title: render(session, p, r, stage.title, `${where} → title`),
      body: render(session, p, r, stage.body, `${where} → text`),
      buttonLabel: stage.buttonLabel || (stage.type === 'decision' ? 'Submit' : 'Continue'),
      fields: stage.fields.map((f) => fieldView(session, f, scope, stage, p, r)),
    },
  };
  if (stage.timeoutSeconds) {
    view.timeout = {
      seconds: stage.timeoutSeconds,
      deadline: p.stageStartedAt ? p.stageStartedAt + stage.timeoutSeconds * 1000 : null,
    };
  }
  return view;
}

export function sessionSummary(session) {
  const exp = session.exp;
  const R = numRounds(session);
  const counts = { joined: 0, active: 0, waiting: 0, done: 0 };
  const rows = session.participants.map((p) => {
    if (p.joined) counts.joined++;
    if (p.state === 'active') counts.active++;
    if (p.state === 'waiting') counts.waiting++;
    if (p.done) counts.done++;
    const r = Math.min(p.pos.r, R);
    let stageTitle = '';
    if (p.done) stageTitle = 'Finished';
    else if (p.pos.s === -1) stageTitle = 'Round start';
    else stageTitle = exp.stages[p.pos.s]?.title || `Stage ${p.pos.s + 1}`;
    return {
      id: p.id,
      code: p.code,
      label: p.label,
      treatment: p.treatment,
      isBot: p.isBot,
      joined: p.joined,
      lastSeen: p.lastSeen,
      state: p.state,
      round: r,
      stage: p.done ? null : p.pos.s,
      stageTitle,
      group: p.slots[r - 1].g + 1,
      role: roleOf(session, p, r),
      points: totalPoints(session, p, Math.min(R, p.done ? R : p.pos.r)),
      done: p.done,
      waitSince: p.state === 'waiting' ? p.waitSince : null,
    };
  });
  return {
    id: session.id,
    code: session.code,
    name: session.name,
    experimentId: session.experimentId,
    experimentName: exp.name,
    createdAt: session.createdAt,
    startedAt: session.startedAt,
    finishedAt: session.finishedAt,
    status: session.status,
    started: session.started,
    startMode: session.startMode,
    openJoin: session.openJoin !== false,
    seed: session.seed,
    numParticipants: session.numParticipants,
    groupSize: exp.design.groupSize,
    rounds: R,
    numStages: exp.stages.length,
    treatments: exp.design.treatments.map((t) => t.name),
    payment: exp.design.payment,
    counts,
    participants: rows,
    errors: session.errors,
  };
}

export function listSessionRow(session) {
  return {
    id: session.id,
    code: session.code,
    name: session.name,
    experimentId: session.experimentId,
    experimentName: session.exp.name,
    createdAt: session.createdAt,
    status: session.status,
    numParticipants: session.numParticipants,
    done: session.participants.filter((p) => p.done).length,
    joined: session.participants.filter((p) => p.joined).length,
    errors: session.errors.length,
  };
}
