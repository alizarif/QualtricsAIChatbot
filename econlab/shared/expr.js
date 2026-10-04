// A small, safe expression language used for payoffs, bounds, conditions and
// text templates. It is deliberately NOT JavaScript: there is no eval, no
// assignment, no loops and no access to prototypes, so an experiment design
// (which may be imported from anyone) can never run arbitrary code.
//
// The same file is loaded by the server (to run sessions) and by the browser
// (to validate formulas while the researcher types).

export class ExprError extends Error {
  constructor(message, pos) {
    super(message);
    this.name = 'ExprError';
    this.pos = pos;
  }
}

const MAX_SOURCE = 4000;
const MAX_DEPTH = 100;
const MAX_STEPS = 200000;
const MAX_LIST = 20000;
const MAX_STRING = 20000;

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

const WORD_OPS = { and: '&&', or: '||', not: '!', in: 'in' };
const LITERALS = {
  true: true, True: true, false: false, False: false, null: null, None: null,
};
const OPS2 = ['**', '//', '==', '!=', '<>', '<=', '>=', '&&', '||'];
const OPS1 = '+-*/%^<>!?:,()[].';

function tokenize(src) {
  if (src.length > MAX_SOURCE) throw new ExprError('Expression is too long', 0);
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }

    if ((c >= '0' && c <= '9') || (c === '.' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
      const re = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
      re.lastIndex = i;
      const m = re.exec(src);
      tokens.push({ type: 'num', value: Number(m[0]), pos: i });
      i += m[0].length;
      continue;
    }

    if (c === '"' || c === "'") {
      let j = i + 1;
      let out = '';
      let closed = false;
      while (j < src.length) {
        const d = src[j];
        if (d === '\\') {
          const e = src[j + 1];
          out += e === 'n' ? '\n' : e === 't' ? '\t' : (e ?? '');
          j += 2;
          continue;
        }
        if (d === c) { closed = true; j++; break; }
        out += d;
        j++;
      }
      if (!closed) throw new ExprError('Text in quotes is not closed', i);
      tokens.push({ type: 'str', value: out, pos: i });
      i = j;
      continue;
    }

    if (/[A-Za-z_]/.test(c)) {
      const re = /[A-Za-z_][A-Za-z0-9_]*/y;
      re.lastIndex = i;
      const m = re.exec(src);
      const word = m[0];
      if (Object.hasOwn(WORD_OPS, word)) tokens.push({ type: 'op', value: WORD_OPS[word], pos: i, word });
      else tokens.push({ type: 'id', value: word, pos: i });
      i += word.length;
      continue;
    }

    const two = src.slice(i, i + 2);
    if (OPS2.includes(two)) {
      tokens.push({ type: 'op', value: two === '<>' ? '!=' : two === '**' ? '^' : two, pos: i });
      i += 2;
      continue;
    }
    if (c === '=') throw new ExprError("Use '==' to compare values (a single '=' is not allowed here)", i);
    if (OPS1.includes(c)) {
      tokens.push({ type: 'op', value: c, pos: i });
      i++;
      continue;
    }
    throw new ExprError(`Unexpected character '${c}'`, i);
  }
  tokens.push({ type: 'eof', pos: src.length });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser (recursive descent) -> AST
// ---------------------------------------------------------------------------

class Parser {
  constructor(src) {
    this.src = src;
    this.tokens = tokenize(src);
    this.i = 0;
    this.depth = 0;
  }
  peek() { return this.tokens[this.i]; }
  next() { return this.tokens[this.i++]; }
  isOp(v) { const t = this.peek(); return t.type === 'op' && t.value === v; }
  accept(v) { if (this.isOp(v)) { this.i++; return true; } return false; }
  expect(v) {
    if (!this.accept(v)) {
      const t = this.peek();
      throw new ExprError(`Expected '${v}' but found ${describe(t)}`, t.pos);
    }
  }
  enter() { if (++this.depth > MAX_DEPTH) throw new ExprError('Expression is nested too deeply', this.peek().pos); }
  leave() { this.depth--; }

  parse() {
    if (this.peek().type === 'eof') throw new ExprError('Expression is empty', 0);
    const node = this.ternary();
    const t = this.peek();
    if (t.type !== 'eof') throw new ExprError(`Unexpected ${describe(t)}`, t.pos);
    return node;
  }
  ternary() {
    this.enter();
    const c = this.or();
    let node = c;
    if (this.accept('?')) {
      const a = this.ternary();
      this.expect(':');
      const b = this.ternary();
      node = { t: 'cond', c, a, b };
    }
    this.leave();
    return node;
  }
  or() {
    let l = this.and();
    while (this.accept('||')) l = { t: 'or', l, r: this.and() };
    return l;
  }
  and() {
    let l = this.not();
    while (this.accept('&&')) l = { t: 'and', l, r: this.not() };
    return l;
  }
  not() {
    if (this.accept('!')) { this.enter(); const arg = this.not(); this.leave(); return { t: 'not', arg }; }
    return this.comparison();
  }
  comparison() {
    let l = this.additive();
    for (;;) {
      const t = this.peek();
      if (t.type === 'op' && ['==', '!=', '<', '<=', '>', '>=', 'in'].includes(t.value)) {
        this.i++;
        l = { t: 'bin', op: t.value, l, r: this.additive(), pos: t.pos };
      } else if (t.type === 'op' && t.value === '!' && t.word === 'not' && this.tokens[this.i + 1]?.value === 'in') {
        this.i += 2;
        l = { t: 'not', arg: { t: 'bin', op: 'in', l, r: this.additive(), pos: t.pos } };
      } else return l;
    }
  }
  additive() {
    let l = this.multiplicative();
    for (;;) {
      const t = this.peek();
      if (t.type === 'op' && (t.value === '+' || t.value === '-')) {
        this.i++;
        l = { t: 'bin', op: t.value, l, r: this.multiplicative(), pos: t.pos };
      } else return l;
    }
  }
  multiplicative() {
    let l = this.unary();
    for (;;) {
      const t = this.peek();
      if (t.type === 'op' && ['*', '/', '//', '%'].includes(t.value)) {
        this.i++;
        l = { t: 'bin', op: t.value, l, r: this.unary(), pos: t.pos };
      } else return l;
    }
  }
  unary() {
    const t = this.peek();
    if (t.type === 'op' && (t.value === '-' || t.value === '+')) {
      this.i++;
      this.enter();
      const arg = this.unary();
      this.leave();
      return { t: 'neg', sign: t.value, arg, pos: t.pos };
    }
    return this.power();
  }
  power() {
    const base = this.postfix();
    const t = this.peek();
    if (t.type === 'op' && t.value === '^') {
      this.i++;
      this.enter();
      const exp = this.unary(); // right associative, allows 2^-1
      this.leave();
      return { t: 'bin', op: '^', l: base, r: exp, pos: t.pos };
    }
    return base;
  }
  postfix() {
    let node = this.primary();
    for (;;) {
      if (this.accept('.')) {
        const t = this.next();
        if (t.type !== 'id') throw new ExprError(`Expected a name after '.' but found ${describe(t)}`, t.pos);
        node = { t: 'member', obj: node, prop: t.value, pos: t.pos };
      } else if (this.isOp('[')) {
        const pos = this.next().pos;
        this.enter();
        const index = this.ternary();
        this.leave();
        this.expect(']');
        node = { t: 'index', obj: node, index, pos };
      } else if (this.isOp('(')) {
        const pos = this.peek().pos;
        if (node.t !== 'id') throw new ExprError('Only built-in functions can be called, e.g. sum(...)', pos);
        this.i++;
        const args = [];
        if (!this.isOp(')')) {
          do { args.push(this.ternary()); } while (this.accept(','));
        }
        this.expect(')');
        node = { t: 'call', fn: node.name, args, pos: node.pos };
      } else return node;
    }
  }
  primary() {
    const t = this.next();
    switch (t.type) {
      case 'num': return { t: 'num', v: t.value };
      case 'str': return { t: 'str', v: t.value };
      case 'id':
        if (Object.hasOwn(LITERALS, t.value)) return { t: 'lit', v: LITERALS[t.value] };
        return { t: 'id', name: t.value, pos: t.pos };
      case 'op':
        if (t.value === '(') {
          this.enter();
          const e = this.ternary();
          this.leave();
          this.expect(')');
          return e;
        }
        if (t.value === '[') {
          const items = [];
          if (!this.isOp(']')) {
            do { items.push(this.ternary()); } while (this.accept(','));
          }
          this.expect(']');
          return { t: 'list', items };
        }
        throw new ExprError(`Unexpected ${describe(t)}`, t.pos);
      default:
        throw new ExprError('Expression ended unexpectedly', t.pos);
    }
  }
}

function describe(t) {
  if (t.type === 'eof') return 'end of expression';
  if (t.type === 'str') return `text "${t.value}"`;
  if (t.type === 'num') return `number ${t.value}`;
  return `'${t.word ?? t.value}'`;
}

const parseCache = new Map();

export function parse(src) {
  if (typeof src !== 'string') throw new ExprError('Expression must be text', 0);
  const hit = parseCache.get(src);
  if (hit) return hit;
  const ast = new Parser(src).parse();
  if (parseCache.size > 5000) parseCache.clear();
  parseCache.set(src, ast);
  return ast;
}

/** Returns null when the expression parses, otherwise {message, pos}. */
export function check(src) {
  try { parse(src); return null; } catch (e) {
    if (e instanceof ExprError) return { message: e.message, pos: e.pos };
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

/** Remove binary floating point noise (0.1+0.2 -> 0.3). */
export function cleanNum(x) {
  if (typeof x !== 'number' || !Number.isFinite(x)) return x;
  const r = Number(x.toPrecision(12));
  return r === 0 ? 0 : r;
}

// Shift the decimal point without binary floating point error (handles 1e-7 too).
function shift(x, d) {
  const [m, e = '0'] = String(x).split('e');
  return Number(`${m}e${Number(e) + d}`);
}

export function roundTo(x, d = 0) {
  if (!Number.isFinite(x)) return x;
  d = Math.max(0, Math.min(20, Math.trunc(d) || 0));
  const r = shift(Math.round(shift(Math.abs(x), d)), -d);
  return x < 0 ? -r || 0 : r;
}

export function toDisplay(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return String(v);
    const r = roundTo(v, 6);
    return String(r === 0 ? 0 : r);
  }
  if (Array.isArray(v)) return v.map(toDisplay).join(', ');
  if (typeof v === 'object') return '[object]';
  return String(v);
}

function typeName(v) {
  if (v === null || v === undefined) return 'empty (null)';
  if (Array.isArray(v)) return 'a list';
  return typeof v === 'number' ? 'a number' : typeof v === 'string' ? 'text' : typeof v === 'boolean' ? 'true/false' : typeof v;
}

export function toBool(v) {
  if (typeof v === 'boolean') return v;
  if (v === null || v === undefined) return false;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

export function valuesEqual(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => valuesEqual(x, b[i]));
  }
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  return (a ?? null) === (b ?? null);
}

function num(v, what, pos) {
  if (typeof v !== 'number') throw new ExprError(`${what} needs a number but got ${typeName(v)}`, pos);
  return v;
}

function finite(x, pos) {
  if (!Number.isFinite(x)) throw new ExprError('The result is not a finite number', pos);
  return x;
}

// ---------------------------------------------------------------------------
// Built-in functions
// ---------------------------------------------------------------------------

function flatNumbers(args, fname) {
  const out = [];
  const push = (v) => {
    if (Array.isArray(v)) { v.forEach(push); return; }
    if (typeof v !== 'number') throw new ExprError(`${fname}() needs numbers but got ${typeName(v)}`);
    out.push(v);
  };
  args.forEach(push);
  return out;
}

function listArg(v, fname) {
  if (!Array.isArray(v)) throw new ExprError(`${fname}() needs a list but got ${typeName(v)}`);
  return v;
}

const sd = (xs, sample) => {
  if (xs.length < (sample ? 2 : 1)) throw new ExprError('Not enough values to compute a standard deviation');
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - (sample ? 1 : 0)));
};

/** name -> [minArgs, maxArgs, doc, impl(ctx, ...args)] ; impl receives evaluated args */
export const FUNCTIONS = {
  sum: [1, Infinity, 'sum(list) — total of numbers', (c, ...a) => flatNumbers(a, 'sum').reduce((x, y) => x + y, 0)],
  mean: [1, Infinity, 'mean(list) — average', (c, ...a) => { const x = flatNumbers(a, 'mean'); if (!x.length) throw new ExprError('mean() of an empty list'); return x.reduce((p, q) => p + q, 0) / x.length; }],
  median: [1, Infinity, 'median(list)', (c, ...a) => { const x = flatNumbers(a, 'median').sort((p, q) => p - q); if (!x.length) throw new ExprError('median() of an empty list'); const m = x.length >> 1; return x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2; }],
  min: [1, Infinity, 'min(list) or min(a, b, …)', (c, ...a) => { const x = flatNumbers(a, 'min'); if (!x.length) throw new ExprError('min() of an empty list'); return Math.min(...x); }],
  max: [1, Infinity, 'max(list) or max(a, b, …)', (c, ...a) => { const x = flatNumbers(a, 'max'); if (!x.length) throw new ExprError('max() of an empty list'); return Math.max(...x); }],
  sd: [1, Infinity, 'sd(list) — sample standard deviation', (c, ...a) => sd(flatNumbers(a, 'sd'), true)],
  count: [1, 2, 'count(list) or count(list, value) — how many items (equal to value)', (c, l, v) => { listArg(l, 'count'); return v === undefined ? l.length : l.filter((x) => valuesEqual(x, v)).length; }],
  len: [1, 1, 'len(list or text) — length', (c, l) => { if (typeof l === 'string' || Array.isArray(l)) return l.length; throw new ExprError(`len() needs a list or text but got ${typeName(l)}`); }],
  abs: [1, 1, 'abs(x)', (c, x) => Math.abs(num(x, 'abs()'))],
  sign: [1, 1, 'sign(x) — -1, 0 or 1', (c, x) => Math.sign(num(x, 'sign()'))],
  round: [1, 2, 'round(x, decimals=0) — rounds half away from zero', (c, x, d = 0) => roundTo(num(x, 'round()'), num(d, 'round()'))],
  floor: [1, 1, 'floor(x)', (c, x) => Math.floor(num(x, 'floor()'))],
  ceil: [1, 1, 'ceil(x)', (c, x) => Math.ceil(num(x, 'ceil()'))],
  sqrt: [1, 1, 'sqrt(x)', (c, x) => { if (num(x, 'sqrt()') < 0) throw new ExprError('sqrt() of a negative number'); return Math.sqrt(x); }],
  exp: [1, 1, 'exp(x)', (c, x) => finite(Math.exp(num(x, 'exp()')))],
  log: [1, 2, 'log(x) natural log, or log(x, base)', (c, x, b) => { num(x, 'log()'); if (x <= 0) throw new ExprError('log() needs a positive number'); return b === undefined ? Math.log(x) : Math.log(x) / Math.log(num(b, 'log()')); }],
  pow: [2, 2, 'pow(x, y) — same as x ^ y', (c, x, y) => finite(num(x, 'pow()') ** num(y, 'pow()'))],
  clip: [3, 3, 'clip(x, low, high) — limit x to a range', (c, x, lo, hi) => Math.min(Math.max(num(x, 'clip()'), num(lo, 'clip()')), num(hi, 'clip()'))],
  rank: [2, 2, 'rank(x, list) — 1 + how many values in list are larger than x (ties share a rank)', (c, x, l) => 1 + flatNumbers([l], 'rank').filter((v) => v > num(x, 'rank()')).length],
  any: [1, Infinity, 'any(list of true/false)', (c, ...a) => a.flat().some(toBool)],
  all: [1, Infinity, 'all(list of true/false)', (c, ...a) => a.flat().every(toBool)],
  unique: [1, 1, 'unique(list)', (c, l) => listArg(l, 'unique').filter((v, i, arr) => arr.findIndex((w) => valuesEqual(v, w)) === i)],
  sort: [1, 2, 'sort(list) or sort(list, "desc")', (c, l, dir) => { const x = [...listArg(l, 'sort')]; x.sort((p, q) => (p < q ? -1 : p > q ? 1 : 0)); return dir === 'desc' ? x.reverse() : x; }],
  str: [1, 1, 'str(x) — convert to text', (c, x) => toDisplay(x)],
  number: [1, 1, 'number(x) — convert text to a number', (c, x) => { const n = typeof x === 'number' ? x : Number(String(x).trim()); if (x === null || x === '' || !Number.isFinite(n)) throw new ExprError(`number() cannot convert ${typeName(x)}`); return n; }],
  fmt: [1, 2, 'fmt(x, decimals=2) — number as text with fixed decimals', (c, x, d = 2) => roundTo(num(x, 'fmt()'), d).toFixed(Math.max(0, Math.min(20, Math.trunc(d))))],
  pct: [1, 2, 'pct(x, decimals=0) — 0.25 -> "25%"', (c, x, d = 0) => `${roundTo(num(x, 'pct()') * 100, d).toFixed(Math.max(0, Math.min(20, Math.trunc(d))))}%`],
  isnull: [1, 1, 'isnull(x) — true if x is empty', (c, x) => x === null || x === undefined],
  coalesce: [2, 2, 'coalesce(x, fallback) — fallback when x is empty', (c, x, y) => (x === null || x === undefined ? y : x)],
  random: [0, 0, 'random() — uniform number in [0, 1)', (c) => c.rng()],
  randint: [2, 2, 'randint(a, b) — random whole number from a to b (inclusive)', (c, a, b) => { num(a, 'randint()'); num(b, 'randint()'); if (b < a) throw new ExprError('randint(a, b) needs a <= b'); return a + Math.floor(c.rng() * (Math.floor(b) - Math.ceil(a) + 1)) ; }],
  unif: [2, 2, 'unif(a, b) — uniform random number between a and b', (c, a, b) => num(a, 'unif()') + c.rng() * (num(b, 'unif()') - a)],
  normal: [2, 2, 'normal(mean, sd) — normal random number', (c, m, s) => { const u = 1 - c.rng(); const v = c.rng(); return num(m, 'normal()') + num(s, 'normal()') * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }],
  bernoulli: [1, 1, 'bernoulli(p) — true with probability p', (c, p) => c.rng() < num(p, 'bernoulli()')],
  choice: [1, 1, 'choice(list) — random item', (c, l) => { listArg(l, 'choice'); if (!l.length) throw new ExprError('choice() of an empty list'); return l[Math.floor(c.rng() * l.length)]; }],
  shuffle: [1, 1, 'shuffle(list) — random order', (c, l) => { const x = [...listArg(l, 'shuffle')]; for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(c.rng() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; } return x; }],
  money: [1, 1, 'money(points) — points converted to currency text, e.g. "$1.50"', (c, x) => (c.money ? c.money(num(x, 'money()')) : String(x))],
  points: [1, 1, 'points(x) — number with the points label, e.g. "12 points"', (c, x) => (c.points ? c.points(num(x, 'points()')) : String(x))],
};

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

export function evaluate(ast, scope = {}, options = {}) {
  const ctx = {
    steps: 0,
    scope,
    rng: options.rng ?? Math.random,
    money: options.money,
    points: options.points,
  };
  return ev(ast, ctx);
}

/** Parse + evaluate in one call. */
export function run(src, scope, options) {
  return evaluate(parse(src), scope, options);
}

function lookup(obj, prop, pos) {
  if (obj === null || obj === undefined) {
    throw new ExprError(`Cannot read '${prop}' because the value before it is empty (null)`, pos);
  }
  if (Array.isArray(obj)) {
    if (prop === 'length') return obj.length;
    return obj.map((el) => lookup(el, prop, pos));
  }
  if (typeof obj !== 'object') throw new ExprError(`Cannot read '${prop}' of ${typeName(obj)}`, pos);
  if (FORBIDDEN.has(prop)) throw new ExprError(`'${prop}' is not allowed`, pos);
  return Object.hasOwn(obj, prop) ? obj[prop] : null;
}

function ev(n, ctx) {
  if (++ctx.steps > MAX_STEPS) throw new ExprError('Expression is too expensive to evaluate');
  switch (n.t) {
    case 'num': case 'str': case 'lit': return n.v;
    case 'list': {
      if (n.items.length > MAX_LIST) throw new ExprError('List is too long');
      return n.items.map((x) => ev(x, ctx));
    }
    case 'id': {
      if (Object.hasOwn(ctx.scope, n.name)) return ctx.scope[n.name];
      throw new ExprError(`Unknown name '${n.name}'`, n.pos);
    }
    case 'member': return lookup(ev(n.obj, ctx), n.prop, n.pos);
    case 'index': {
      const o = ev(n.obj, ctx);
      const k = ev(n.index, ctx);
      if (Array.isArray(o) || typeof o === 'string') {
        const idx = num(k, 'An index', n.pos);
        const j = idx < 0 ? o.length + idx : idx;
        if (!Number.isInteger(j) || j < 0 || j >= o.length) throw new ExprError(`Index ${idx} is out of range (length ${o.length})`, n.pos);
        return o[j];
      }
      if (typeof k !== 'string') throw new ExprError('Use text such as x["name"] to read a named value', n.pos);
      return lookup(o, k, n.pos);
    }
    case 'cond': return toBool(ev(n.c, ctx)) ? ev(n.a, ctx) : ev(n.b, ctx);
    case 'and': return toBool(ev(n.l, ctx)) && toBool(ev(n.r, ctx));
    case 'or': return toBool(ev(n.l, ctx)) || toBool(ev(n.r, ctx));
    case 'not': return !toBool(ev(n.arg, ctx));
    case 'neg': {
      const v = num(ev(n.arg, ctx), `Unary '${n.sign}'`, n.pos);
      return n.sign === '-' ? -v : v;
    }
    case 'bin': return binary(n, ctx);
    case 'call': return call(n, ctx);
    default: throw new ExprError('Unsupported expression');
  }
}

function binary(n, ctx) {
  const a = ev(n.l, ctx);
  const b = ev(n.r, ctx);
  const op = n.op;
  switch (op) {
    case '+':
      if (typeof a === 'number' && typeof b === 'number') return a + b;
      if (typeof a === 'string' || typeof b === 'string') {
        const s = toDisplay(a) + toDisplay(b);
        if (s.length > MAX_STRING) throw new ExprError('Text is too long', n.pos);
        return s;
      }
      if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
      throw new ExprError(`Cannot add ${typeName(a)} and ${typeName(b)}`, n.pos);
    case '-': return num(a, "'-'", n.pos) - num(b, "'-'", n.pos);
    case '*': return num(a, "'*'", n.pos) * num(b, "'*'", n.pos);
    case '/': {
      num(a, "'/'", n.pos); num(b, "'/'", n.pos);
      if (b === 0) throw new ExprError('Division by zero', n.pos);
      return a / b;
    }
    case '//': {
      num(a, "'//'", n.pos); num(b, "'//'", n.pos);
      if (b === 0) throw new ExprError('Division by zero', n.pos);
      return Math.floor(a / b);
    }
    case '%': {
      num(a, "'%'", n.pos); num(b, "'%'", n.pos);
      if (b === 0) throw new ExprError('Division by zero', n.pos);
      return ((a % b) + b) % b;
    }
    case '^': return finite(num(a, "'^'", n.pos) ** num(b, "'^'", n.pos), n.pos);
    case '==': return valuesEqual(a, b);
    case '!=': return !valuesEqual(a, b);
    case '<': case '<=': case '>': case '>=': {
      const bothNum = typeof a === 'number' && typeof b === 'number';
      const bothStr = typeof a === 'string' && typeof b === 'string';
      if (!bothNum && !bothStr) throw new ExprError(`Cannot compare ${typeName(a)} with ${typeName(b)}`, n.pos);
      return op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b;
    }
    case 'in':
      if (Array.isArray(b)) return b.some((x) => valuesEqual(x, a));
      if (typeof b === 'string' && typeof a === 'string') return b.includes(a);
      throw new ExprError("'in' needs a list or text on the right", n.pos);
    default: throw new ExprError(`Unknown operator ${op}`, n.pos);
  }
}

function call(n, ctx) {
  if (n.fn === 'if') {
    if (n.args.length !== 3) throw new ExprError('if(condition, then, else) needs 3 arguments', n.pos);
    return toBool(ev(n.args[0], ctx)) ? ev(n.args[1], ctx) : ev(n.args[2], ctx);
  }
  if (!Object.hasOwn(FUNCTIONS, n.fn)) throw new ExprError(`Unknown function '${n.fn}'`, n.pos);
  const [min, max, , impl] = FUNCTIONS[n.fn];
  if (n.args.length < min || n.args.length > max) {
    throw new ExprError(`${n.fn}() takes ${min === max ? min : max === Infinity ? `at least ${min}` : `${min}–${max}`} argument(s) but got ${n.args.length}`, n.pos);
  }
  const args = n.args.map((a) => ev(a, ctx));
  try {
    const out = impl(ctx, ...args);
    if (Array.isArray(out) && out.length > MAX_LIST) throw new ExprError('List is too long');
    return out;
  } catch (e) {
    if (e instanceof ExprError && e.pos === undefined) e.pos = n.pos;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Static analysis (used by the editor to catch typos before a session runs)
// ---------------------------------------------------------------------------

/**
 * Collect what an expression refers to.
 * refs: [{root:'player', path:['contribution']}], calls: Set of function names.
 */
export function analyze(ast) {
  const refs = [];
  const calls = new Set();
  const roots = new Set();
  const chain = (n) => {
    const path = [];
    let cur = n;
    while (cur.t === 'member') { path.unshift(cur.prop); cur = cur.obj; }
    if (cur.t === 'id') return { root: cur.name, path };
    return null;
  };
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.t === 'member' || n.t === 'id') {
      const c = chain(n);
      if (c) { refs.push(c); roots.add(c.root); return; }
      if (n.t === 'member') { walk(n.obj); return; }
    }
    if (n.t === 'call') { calls.add(n.fn); n.args.forEach(walk); return; }
    for (const k of ['l', 'r', 'arg', 'c', 'a', 'b', 'obj', 'index']) if (n[k]) walk(n[k]);
    if (n.items) n.items.forEach(walk);
  };
  walk(ast);
  return { refs, calls, roots };
}

// ---------------------------------------------------------------------------
// Text templates: "You earned {{ player.payoff }} points"
// ---------------------------------------------------------------------------

export function templateParts(text) {
  const parts = [];
  const re = /\{\{([\s\S]*?)\}\}/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index) });
    parts.push({ expr: m[1].trim(), raw: m[0], index: m.index });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

/**
 * Replace every {{ expr }} using evalFn(src) -> value. Errors never throw:
 * the placeholder becomes "⚠" and the error is reported through onError.
 */
export function interpolate(text, evalFn, onError) {
  if (typeof text !== 'string' || !text.includes('{{')) return text ?? '';
  return templateParts(text).map((p) => {
    if (p.text !== undefined) return p.text;
    try { return toDisplay(evalFn(p.expr)); } catch (e) {
      if (onError) onError(e, p.expr);
      return '⚠';
    }
  }).join('');
}
