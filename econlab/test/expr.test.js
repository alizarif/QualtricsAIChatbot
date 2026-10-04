import test from 'node:test';
import assert from 'node:assert/strict';
import { run, parse, check, interpolate, roundTo, cleanNum, analyze, ExprError } from '../shared/expr.js';

const scope = {
  player: { c: 10, role: 'A', payoff: 0 },
  group: { players: [{ c: 10 }, { c: 20 }, { c: 30 }], total: 60 },
  const: { e: 20, m: 0.4 },
};

test('arithmetic precedence and associativity', () => {
  assert.equal(run('1 + 2 * 3', {}), 7);
  assert.equal(run('(1 + 2) * 3', {}), 9);
  assert.equal(run('-2^2', {}), -4);
  assert.equal(run('2^3^2', {}), 512);
  assert.equal(run('2^-1', {}), 0.5);
  assert.equal(run('2 ** 3', {}), 8);
  assert.equal(run('10 // 3', {}), 3);
  assert.equal(run('-7 % 3', {}), 2);
  assert.equal(run('0.1 + 0.2 == 0.3', {}), true);
});

test('logic, comparison, ternary and in', () => {
  assert.equal(run("player.role == 'A' ? 'yes' : 'no'", scope), 'yes');
  assert.equal(run('not (1 < 2) or 3 >= 3', {}), true);
  assert.equal(run('1 < 2 and 2 < 3', {}), true);
  assert.equal(run('player.c in [1, 10]', scope), true);
  assert.equal(run("'a' in 'cat'", {}), true);
  assert.equal(run('5 not in [1, 2]', {}), true);
  assert.equal(run('if(true, 1, 1/0)', {}), 1, 'if() is lazy');
  assert.equal(run('false and 1/0', {}), false, 'and short-circuits');
});

test('lists, plucking and aggregate functions', () => {
  assert.equal(run('sum(group.players.c)', scope), 60);
  assert.equal(run('mean(group.players.c)', scope), 20);
  assert.equal(run('median(group.players.c)', scope), 20);
  assert.equal(run('max(group.players.c, 5)', scope), 30);
  assert.equal(run('min(3, 1, 2)', {}), 1);
  assert.equal(run('count(group.players.c, 20)', scope), 1);
  assert.equal(run('len(group.players)', scope), 3);
  assert.equal(run('group.players.c[-1]', scope), 30);
  assert.equal(run('rank(20, group.players.c)', scope), 2);
  assert.equal(run('[16, 24, 32][1]', {}), 24);
  assert.equal(run('round(sd([1, 2, 3, 4]), 3)', {}), 1.291);
  assert.deepEqual(run('sort([3, 1, 2], "desc")', {}), [3, 2, 1]);
});

test('rounding and formatting', () => {
  assert.equal(run('round(2.675, 2)', {}), 2.68);
  assert.equal(run('round(-2.5)', {}), -3);
  assert.equal(run('round(1e-7, 8)', {}), 1e-7);
  assert.equal(run('fmt(3.14159, 2)', {}), '3.14');
  assert.equal(run('pct(0.256, 1)', {}), '25.6%');
  assert.equal(run("'x' + 1.5", {}), 'x1.5');
  assert.equal(cleanNum(0.1 + 0.2), 0.3);
  assert.equal(roundTo(1.005, 2), 1.01);
  assert.ok(Object.is(roundTo(-0.4), 0));
});

test('errors are reported, never thrown as raw exceptions', () => {
  const bad = ['1 +', '1 / 0', 'foo(1)', 'x = 3', '"abc', 'sum("a")', '(1', 'a.b()', '1 2', '1 + null', 'player.zzz.x', 'player.constructor', "player['__proto__']"];
  for (const src of bad) assert.throws(() => run(src, scope), ExprError, src);
  assert.equal(check('1 +').message, 'Expression ended unexpectedly');
  assert.equal(check('1 + 1'), null);
});

test('sandbox: no access to prototypes, globals or code execution', () => {
  assert.throws(() => run('constructor', {}), /Unknown name/);
  assert.throws(() => run('toString', {}), /Unknown name/);
  assert.throws(() => run('process.exit(1)', {}), ExprError);
  assert.throws(() => run('x.constructor.constructor("return 1")()', { x: {} }), ExprError);
  assert.throws(() => run('this', {}), /Unknown name/);
  assert.throws(() => run('"a".length', {}), ExprError);
  const obj = Object.create(null);
  obj.a = 1;
  assert.equal(run('o.a', { o: obj }), 1);
  assert.equal(run('o.missing', { o: obj }), null);
});

test('resource limits', () => {
  assert.throws(() => run('1' + ' + 1'.repeat(2500), {}), /too long/);
  assert.throws(() => run('('.repeat(300) + '1' + ')'.repeat(300), {}), /nested too deeply/);
  assert.throws(() => run('9^9^9^9', {}), /finite/);
});

test('random functions use the supplied generator', () => {
  let n = 0;
  const rng = () => [0.0, 0.5, 0.999][n++ % 3];
  assert.equal(run('randint(1, 6)', {}, { rng }), 1);
  assert.equal(run('randint(1, 6)', {}, { rng }), 4);
  assert.equal(run('randint(1, 6)', {}, { rng }), 6);
  assert.equal(run('bernoulli(0.5)', {}, { rng }), true);
});

test('templates', () => {
  const errors = [];
  const out = interpolate('Total {{ group.total }} / {{ 1/0 }} / {{ fmt(2/3, 3) }}', (s) => run(s, scope), (e) => errors.push(e.message));
  assert.equal(out, 'Total 60 / ⚠ / 0.667');
  assert.deepEqual(errors, ['Division by zero']);
  assert.equal(interpolate('no placeholders', () => 1), 'no placeholders');
  assert.equal(interpolate('{{ 0.1 + 0.2 }}', (s) => run(s, {})), '0.3');
});

test('static analysis finds references', () => {
  const { refs, calls } = analyze(parse('player.c + roles.Proposer.offer * sum(group.players.c) + const.e'));
  assert.deepEqual(refs.map((r) => [r.root, ...r.path].join('.')), ['player.c', 'roles.Proposer.offer', 'group.players.c', 'const.e']);
  assert.ok(calls.has('sum'));
});
