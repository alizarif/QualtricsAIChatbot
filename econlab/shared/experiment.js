// Experiment definition: normalisation (turn anything into a safe, well-formed
// object) and validation (explain what is wrong in researcher-friendly terms).
// Shared by the server and the browser editor.

import { parse, analyze, templateParts, FUNCTIONS, ExprError } from './expr.js';

export const NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
export const STAGE_TYPES = ['info', 'decision', 'wait'];
export const FIELD_TYPES = ['integer', 'number', 'slider', 'text', 'textarea', 'choice', 'checkbox', 'likert'];
export const PAYMENT_MODES = ['all', 'random_round', 'last_round'];
export const MATCHINGS = ['fixed', 'random'];

// Names that the engine provides itself and that researchers cannot reuse.
export const RESERVED_PLAYER = ['id_in_group', 'role', 'round', 'participant', 'treatment', 'label', 'id'];
export const RESERVED_GROUP = ['players', 'size', 'id'];
export const PLAYER_BUILTINS = ['id_in_group', 'role', 'round', 'payoff', 'participant', 'treatment', 'label', 'id'];
export const GROUP_BUILTINS = ['players', 'size', 'id'];
export const SCOPE_ROOTS = [
  'player', 'group', 'others', 'roles', 'const', 'session', 'prev', 'history', 'participant',
  'round', 'num_rounds', 'treatment', 'all_players',
];

export const LIMITS = {
  stages: 200, fields: 60, checks: 30, compute: 60, options: 60, treatments: 20,
  constants: 100, text: 20000, name: 120, groupSize: 200, rounds: 300,
};

const rid = (prefix) => `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
const str = (v, max = LIMITS.text) => (typeof v === 'string' ? v.slice(0, max) : v == null ? '' : String(v).slice(0, max));
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

function num(v, fallback, { min = -Infinity, max = Infinity, int = false } = {}) {
  let n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) n = fallback;
  if (int) n = Math.round(n);
  return Math.min(max, Math.max(min, n));
}

/** number | expression string | null */
function numOrExpr(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '') return null;
    if (/^-?(\d+\.?\d*|\.\d+)$/.test(t)) return Number(t);
    return t.slice(0, 500);
  }
  return null;
}

export function normalizeField(raw) {
  const f = isObj(raw) ? raw : {};
  const type = FIELD_TYPES.includes(f.type) ? f.type : 'integer';
  const out = {
    name: str(f.name, 60).trim(),
    type,
    label: str(f.label, 2000),
    help: str(f.help, 2000),
    required: f.required === false ? false : true,
    default: null,
    min: null,
    max: null,
    step: null,
    suffix: str(f.suffix, 40),
    options: [],
    layout: f.layout === 'dropdown' ? 'dropdown' : 'radio',
    minLabel: str(f.minLabel, 200),
    maxLabel: str(f.maxLabel, 200),
  };
  if (['integer', 'number', 'slider', 'likert'].includes(type)) {
    out.min = numOrExpr(f.min);
    out.max = numOrExpr(f.max);
    out.default = numOrExpr(f.default);
    const step = numOrExpr(f.step);
    out.step = typeof step === 'number' && step > 0 ? step : null;
    if (type === 'likert') {
      if (out.min === null) out.min = 1;
      if (out.max === null) out.max = 5;
    }
  } else if (type === 'checkbox') {
    out.default = f.default === true || f.default === 'true';
  } else if (type === 'choice') {
    out.options = (Array.isArray(f.options) ? f.options : []).slice(0, LIMITS.options).map((o) => {
      if (isObj(o)) {
        const v = typeof o.value === 'number' || typeof o.value === 'boolean' ? o.value : str(o.value, 200);
        return { value: v, label: str(o.label ?? o.value, 500) };
      }
      const v = typeof o === 'number' ? o : str(o, 200);
      return { value: v, label: str(o, 500) };
    });
    out.default = f.default === undefined || f.default === null || f.default === '' ? null : f.default;
  } else {
    out.default = f.default === undefined || f.default === null ? '' : str(f.default, 2000);
  }
  return out;
}

export function normalizeRow(raw, defaultScope = 'player') {
  const r = isObj(raw) ? raw : {};
  return {
    scope: ['player', 'group', 'session'].includes(r.scope) ? r.scope : defaultScope,
    name: str(r.name, 60).trim(),
    expr: str(r.expr, 4000),
  };
}

export function normalizeStage(raw) {
  const s = isObj(raw) ? raw : {};
  const type = STAGE_TYPES.includes(s.type) ? s.type : 'info';
  return {
    id: typeof s.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(s.id) ? s.id : rid('st'),
    type,
    title: str(s.title, 300),
    body: str(s.body),
    showIf: str(s.showIf, 2000).trim(),
    timeoutSeconds: num(s.timeoutSeconds, 0, { min: 0, max: 86400, int: true }),
    buttonLabel: str(s.buttonLabel, 60),
    waitFor: s.waitFor === 'all' ? 'all' : 'group',
    fields: type === 'decision' ? (Array.isArray(s.fields) ? s.fields : []).slice(0, LIMITS.fields).map(normalizeField) : [],
    checks: type === 'decision'
      ? (Array.isArray(s.checks) ? s.checks : []).slice(0, LIMITS.checks).map((c) => ({
        expr: str(isObj(c) ? c.expr : '', 2000),
        message: str(isObj(c) ? c.message : '', 500),
      }))
      : [],
    compute: (Array.isArray(s.compute) ? s.compute : []).slice(0, LIMITS.compute).map((r) => normalizeRow(r)),
  };
}

function normalizeConstants(raw) {
  const out = {};
  if (!isObj(raw)) return out;
  for (const [k, v] of Object.entries(raw).slice(0, LIMITS.constants)) {
    if (!NAME_RE.test(k)) continue;
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') out[k] = v.slice(0, 2000);
  }
  return out;
}

export function normalizeExperiment(raw, now = new Date().toISOString()) {
  const e = isObj(raw) ? raw : {};
  const d = isObj(e.design) ? e.design : {};
  const p = isObj(d.payment) ? d.payment : {};
  const groupSize = num(d.groupSize, 1, { min: 1, max: LIMITS.groupSize, int: true });
  const seen = new Set();
  const stages = (Array.isArray(e.stages) ? e.stages : []).slice(0, LIMITS.stages).map(normalizeStage).map((s) => {
    while (seen.has(s.id)) s.id = rid('st');
    seen.add(s.id);
    return s;
  });
  return {
    id: typeof e.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(e.id) ? e.id : `exp_${Math.random().toString(36).slice(2, 10)}`,
    name: str(e.name, LIMITS.name).trim() || 'Untitled experiment',
    description: str(e.description, 4000),
    createdAt: typeof e.createdAt === 'string' ? e.createdAt : now,
    updatedAt: typeof e.updatedAt === 'string' ? e.updatedAt : now,
    design: {
      groupSize,
      rounds: num(d.rounds, 1, { min: 1, max: LIMITS.rounds, int: true }),
      matching: MATCHINGS.includes(d.matching) ? d.matching : 'fixed',
      rotateRoles: d.rotateRoles === true,
      roles: (Array.isArray(d.roles) ? d.roles : []).slice(0, LIMITS.groupSize).map((r) => str(r, 60).trim()).filter(Boolean),
      constants: normalizeConstants(d.constants),
      treatments: (Array.isArray(d.treatments) ? d.treatments : []).slice(0, LIMITS.treatments).map((t, i) => ({
        name: str(isObj(t) ? t.name : '', 60).trim() || `Treatment ${i + 1}`,
        constants: normalizeConstants(isObj(t) ? t.constants : {}),
      })),
      payment: {
        mode: PAYMENT_MODES.includes(p.mode) ? p.mode : 'all',
        exchangeRate: num(p.exchangeRate, 0.1, { min: 0, max: 1e6 }),
        pointsName: str(p.pointsName, 30).trim() || 'points',
        currencySymbol: str(p.currencySymbol, 10).trim() || '$',
        participationFee: num(p.participationFee, 0, { min: 0, max: 1e6 }),
      },
      lobbyMessage: str(d.lobbyMessage, 2000),
      finalMessage: str(d.finalMessage),
      completionUrl: /^https?:\/\//i.test(str(d.completionUrl, 2000).trim()) ? str(d.completionUrl, 2000).trim() : '',
    },
    stages,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** All variable names the design makes available, in stage order. */
export function collectNames(exp) {
  const playerFields = []; // {name, stageIndex}
  const playerComputed = [];
  const groupComputed = [];
  const sessionComputed = new Set();
  exp.stages.forEach((s, si) => {
    s.fields.forEach((f) => { if (f.name) playerFields.push({ name: f.name, si }); });
    s.compute.forEach((r) => {
      if (!r.name) return;
      if (r.scope === 'player') playerComputed.push({ name: r.name, si });
      else if (r.scope === 'group') groupComputed.push({ name: r.name, si });
      else sessionComputed.add(r.name);
    });
  });
  const constants = new Set(Object.keys(exp.design.constants));
  exp.design.treatments.forEach((t) => Object.keys(t.constants).forEach((k) => constants.add(k)));
  return { playerFields, playerComputed, groupComputed, sessionComputed, constants };
}

/**
 * Returns [{level:'error'|'warning', where, message}].
 * Errors prevent a session from being created; warnings are advice.
 */
export function validateExperiment(exp) {
  const issues = [];
  const seenIssue = new Set();
  const add = (level, where, message) => {
    const key = `${level}|${where}|${message}`;
    if (!seenIssue.has(key)) { seenIssue.add(key); issues.push({ level, where, message }); }
  };
  const err = (where, message) => add('error', where, message);
  const warn = (where, message) => add('warning', where, message);
  const d = exp.design;

  if (!exp.stages.length) err('stages', 'Add at least one stage.');

  // --- design -------------------------------------------------------------
  if (d.roles.length) {
    if (d.roles.length !== d.groupSize) err('design.roles', `Define exactly one role per group member: ${d.groupSize} players per group but ${d.roles.length} role(s).`);
    const seenRole = new Set();
    d.roles.forEach((r) => {
      if (!NAME_RE.test(r)) err('design.roles', `Role "${r}" must start with a letter and contain only letters, digits and underscores.`);
      if (seenRole.has(r)) err('design.roles', `Role "${r}" is listed twice.`);
      seenRole.add(r);
    });
  }
  const tnames = new Set();
  d.treatments.forEach((t, i) => {
    if (tnames.has(t.name)) err(`design.treatments[${i}]`, `Treatment name "${t.name}" is used twice.`);
    tnames.add(t.name);
  });
  if (d.groupSize === 1 && d.matching === 'random') warn('design.matching', 'Random re-matching has no effect with 1 player per group.');
  if (d.groupSize === 1 && d.rotateRoles) warn('design.rotateRoles', 'Role rotation has no effect with 1 player per group.');
  if (d.rotateRoles && !d.roles.length) warn('design.rotateRoles', 'Role rotation only matters when roles are defined.');
  if (d.payment.mode === 'random_round' && d.rounds === 1) warn('design.payment', 'Paying a random round has no effect with a single round.');

  const names = collectNames(exp);

  const checkExpr = (where, src, { allowEmpty = true, availableFields = null, availableGroup = null, session = false } = {}) => {
    if (typeof src !== 'string' || !src.trim()) {
      if (!allowEmpty) err(where, 'This expression is empty.');
      return;
    }
    let ast;
    try { ast = parse(src); } catch (e) {
      if (e instanceof ExprError) { err(where, e.message); return; }
      throw e;
    }
    const { refs, calls, roots } = analyze(ast);
    for (const fn of calls) {
      if (fn !== 'if' && !Object.hasOwn(FUNCTIONS, fn)) err(where, `Unknown function ${fn}(). See the Docs page for the list of functions.`);
    }
    for (const root of roots) {
      if (!SCOPE_ROOTS.includes(root)) warn(where, `Unknown name "${root}". Use player.${root}, const.${root} or a built-in such as round.`);
    }
    for (const { root, path } of refs) {
      let playerName = null; // a per-player variable being read, if any
      if (['player', 'prev', 'history', 'others', 'all_players'].includes(root)) {
        playerName = path[0] ?? null;
      } else if (root === 'group') {
        const first = path[0];
        if (first === 'players') playerName = path[1] ?? null;
        else if (first && !GROUP_BUILTINS.includes(first)) {
          if (!names.groupComputed.some((g) => g.name === first)) warn(where, `group.${first} is never set by any stage.`);
          else if (availableGroup && !availableGroup.has(first)) warn(where, `group.${first} is used before the stage that computes it.`);
        }
      } else if (root === 'roles') {
        const role = path[0];
        if (role && !d.roles.length) warn(where, 'roles.* needs roles to be defined under Design → Roles.');
        else if (role && !d.roles.includes(role)) warn(where, `Role "${role}" is not defined under Design → Roles.`);
        playerName = path[1] ?? null;
      } else if (root === 'const') {
        if (path[0] && !names.constants.has(path[0])) warn(where, `const.${path[0]} is not defined. Add it under Design → Constants.`);
      } else if (root === 'session') {
        if (path[0] && !names.sessionComputed.has(path[0])) warn(where, `session.${path[0]} is never set by any stage.`);
      }
      if (playerName && !PLAYER_BUILTINS.includes(playerName)) {
        const known = names.playerFields.some((f) => f.name === playerName) || names.playerComputed.some((c) => c.name === playerName);
        if (!known) warn(where, `${root}.${playerName} is not a field or computed variable in this experiment.`);
        else if (root === 'player' && availableFields && !availableFields.has(playerName)) {
          warn(where, `player.${playerName} is used before it has been collected or computed (it only exists in later stages of the round).`);
        }
      }
    }
  };

  const checkTemplate = (where, text, opts) => {
    if (typeof text !== 'string' || !text.includes('{{')) return;
    if ((text.match(/\{\{/g) || []).length !== (text.match(/\}\}/g) || []).length) err(where, 'Unbalanced {{ }} in text.');
    for (const part of templateParts(text)) if (part.expr !== undefined) checkExpr(where, part.expr, { allowEmpty: false, ...opts });
  };

  // --- stages -------------------------------------------------------------
  const fieldOwner = new Map();
  const seenFields = new Set(); // names collected before the current stage
  const seenComputed = new Set();
  const seenGroup = new Set();
  const available = () => new Set([...seenFields, ...seenComputed]);

  exp.stages.forEach((s, si) => {
    const at = (suffix = '') => `stages[${si}]${suffix}`;
    const label = s.title || `Stage ${si + 1}`;
    const before = available();
    checkExpr(at('.showIf'), s.showIf, { availableFields: before, availableGroup: seenGroup });
    checkTemplate(at('.title'), s.title, { availableFields: before, availableGroup: seenGroup });
    checkTemplate(at('.body'), s.body, { availableFields: before, availableGroup: seenGroup });

    if (s.type === 'wait' && s.showIf) warn(at('.showIf'), `"${label}": wait pages are always shown to everyone in the group, so the condition is ignored.`);
    if (s.type === 'wait' && d.groupSize === 1 && s.waitFor === 'group') warn(at(), `"${label}": waiting for the group has no effect with 1 player per group.`);

    const ownFields = new Set();
    s.fields.forEach((f, fi) => {
      const fw = (k = '') => at(`.fields[${fi}]${k}`);
      if (!f.name) err(fw('.name'), 'Field needs a name.');
      else if (!NAME_RE.test(f.name)) err(fw('.name'), `Field name "${f.name}" must start with a letter and contain only letters, digits and underscores.`);
      else if (RESERVED_PLAYER.includes(f.name) || f.name === 'payoff') err(fw('.name'), `"${f.name}" is reserved by the system. Choose another field name.`);
      else if (fieldOwner.has(f.name)) err(fw('.name'), `Field name "${f.name}" is already used in stage ${fieldOwner.get(f.name) + 1}. Each field needs a unique name.`);
      else fieldOwner.set(f.name, si);
      ownFields.add(f.name);
      if (!f.label) warn(fw('.label'), `Field "${f.name || fi + 1}" has no label, so participants will not see a question.`);
      checkTemplate(fw('.label'), f.label, { availableFields: before, availableGroup: seenGroup });
      checkTemplate(fw('.help'), f.help, { availableFields: before, availableGroup: seenGroup });
      for (const k of ['min', 'max', 'default']) {
        if (typeof f[k] === 'string') checkExpr(fw(`.${k}`), f[k], { availableFields: before, availableGroup: seenGroup });
      }
      if (typeof f.min === 'number' && typeof f.max === 'number' && f.min > f.max) err(fw('.max'), `Minimum (${f.min}) is larger than maximum (${f.max}).`);
      if (f.type === 'choice') {
        if (f.options.length < 2) err(fw('.options'), 'A choice needs at least two options.');
        const vals = new Set();
        f.options.forEach((o) => {
          const key = String(o.value);
          if (vals.has(key)) err(fw('.options'), `Option value "${key}" appears twice.`);
          vals.add(key);
          if (o.value === '') err(fw('.options'), 'Option values cannot be empty.');
        });
      }
    });

    s.checks.forEach((c, ci) => {
      const ownAvail = new Set([...before, ...ownFields]);
      checkExpr(at(`.checks[${ci}].expr`), c.expr, { allowEmpty: false, availableFields: ownAvail, availableGroup: seenGroup });
      if (!c.message) warn(at(`.checks[${ci}].message`), 'This check has no message to show participants.');
    });

    const after = new Set([...before, ...ownFields]);
    s.compute.forEach((r, ri) => {
      const rw = (k = '') => at(`.compute[${ri}]${k}`);
      if (!r.name) err(rw('.name'), 'Give the variable a name.');
      else if (!NAME_RE.test(r.name)) err(rw('.name'), `Variable name "${r.name}" must start with a letter and contain only letters, digits and underscores.`);
      else if (r.scope === 'player' && RESERVED_PLAYER.includes(r.name)) err(rw('.name'), `"${r.name}" is reserved by the system.`);
      else if (r.scope === 'group' && RESERVED_GROUP.includes(r.name)) err(rw('.name'), `"${r.name}" is reserved by the system.`);
      else if (r.scope === 'player' && fieldOwner.has(r.name)) warn(rw('.name'), `player.${r.name} is also a form field; the computed value will overwrite what the participant entered.`);
      if (s.type !== 'wait' && r.scope !== 'player') err(rw('.scope'), `Only wait pages can set ${r.scope} variables. Use a wait stage, or set a player variable here.`);
      if (s.type === 'wait' && r.scope === 'session' && s.waitFor !== 'all') err(rw('.scope'), 'Session variables can only be set on wait pages that wait for everyone in the session.');
      checkExpr(rw('.expr'), r.expr, { allowEmpty: false, availableFields: after, availableGroup: seenGroup });
      if (r.name) {
        if (r.scope === 'player') { seenComputed.add(r.name); after.add(r.name); }
        if (r.scope === 'group') seenGroup.add(r.name);
      }
    });
    s.fields.forEach((f) => { if (f.name) seenFields.add(f.name); });
    if (s.type === 'decision' && !s.fields.length) warn(at(), `"${label}" is a decision page without any fields.`);
  });

  const interactive = d.groupSize > 1 || exp.stages.some((s) => s.type === 'wait');
  if (interactive && !exp.stages.some((s) => s.compute.some((r) => r.name === 'payoff'))) {
    warn('stages', 'No stage sets player.payoff, so every participant will earn 0. Add a compute row such as "player.payoff = …".');
  }
  checkTemplate('design.finalMessage', d.finalMessage, { availableFields: null });
  checkTemplate('design.lobbyMessage', d.lobbyMessage, { availableFields: null });

  return issues;
}

/** Variables the editor can offer in an "insert variable" menu. */
export function variableCatalog(exp) {
  const out = [];
  const add = (expr, kind, hint = '') => { if (!out.some((o) => o.expr === expr)) out.push({ expr, kind, hint }); };
  const n = collectNames(exp);
  PLAYER_BUILTINS.forEach((b) => add(`player.${b}`, 'player'));
  n.playerFields.forEach((f) => add(`player.${f.name}`, 'field'));
  n.playerComputed.forEach((f) => add(`player.${f.name}`, 'computed'));
  n.groupComputed.forEach((g) => add(`group.${g.name}`, 'group'));
  add('group.players', 'group', 'list of all players in the group');
  add('others', 'group', 'list of the other players in the group');
  exp.design.roles.forEach((r) => add(`roles.${r}`, 'role', `the player with role ${r}`));
  n.constants.forEach((c) => add(`const.${c}`, 'constant'));
  n.sessionComputed.forEach((c) => add(`session.${c}`, 'session'));
  ['round', 'num_rounds', 'treatment'].forEach((b) => add(b, 'built-in'));
  add('prev.payoff', 'history', 'payoff in the previous round');
  return out;
}

// ---------------------------------------------------------------------------
// Money / points formatting (shared so the editor, server and exports agree)
// ---------------------------------------------------------------------------

export function formatMoney(payment, amount) {
  const sym = payment.currencySymbol || '$';
  const v = (Math.round(amount * 100 + (amount >= 0 ? 1e-9 : -1e-9)) / 100).toFixed(2);
  return sym.length <= 1 ? `${sym}${v}` : `${v} ${sym}`;
}

export function formatPoints(payment, pts) {
  const v = Number((Math.round(pts * 1e6) / 1e6).toPrecision(12));
  return `${v} ${payment.pointsName || 'points'}`;
}

/** "1 point = $0.10" */
export function formatRate(payment) {
  let v = String(Number(payment.exchangeRate.toFixed(6)));
  if (!v.includes('.')) v += '.00';
  else if (v.split('.')[1].length < 2) v += '0';
  const sym = payment.currencySymbol || '$';
  const money = sym.length <= 1 ? `${sym}${v}` : `${v} ${sym}`;
  const name = payment.pointsName || 'points';
  const singular = /s$/i.test(name) && name.length > 3 ? name.slice(0, -1) : name;
  return `1 ${singular} = ${money}`;
}
