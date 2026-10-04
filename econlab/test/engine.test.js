import test from 'node:test';
import assert from 'node:assert/strict';
import { EXAMPLES, getExample } from '../server/examples.js';
import { normalizeExperiment, validateExperiment } from '../shared/experiment.js';
import {
  createSession, startSession, submitStage, participantView, forceAdvance, tick, paymentOf,
  claimSeat, markJoined, sessionSummary, EngineError,
} from '../server/engine.js';
import { dataTable, toCsv, paymentsTable, timesTable } from '../server/exporter.js';

const pgg = (over = {}) => {
  const e = getExample('public-goods');
  e.design.rounds = over.rounds ?? 2;
  if (over.payment) Object.assign(e.design.payment, over.payment);
  return e;
};

const humans = (s) => s.participants.filter((p) => !p.isBot);
const open = (s) => humans(s).forEach((p) => markJoined(s, p));

/** Submit one decision page for every participant in the list. */
function submitAll(s, values) {
  s.participants.forEach((p, i) => {
    const v = typeof values === 'function' ? values(p, i) : values;
    const res = submitStage(s, p, v);
    assert.ok(res.ok, `participant ${p.id}: ${JSON.stringify(res)}`);
  });
}

test('public goods: payoffs, synchronisation and round barrier', () => {
  const s = createSession(pgg(), { numParticipants: 4, seed: 1 });
  assert.equal(s.status, 'waiting');
  assert.equal(participantView(s, s.participants[0]).status, 'lobby');

  startSession(s);
  // group of 4 cannot begin until everybody has opened their link
  assert.equal(participantView(s, s.participants[0]).status, 'waiting');
  assert.match(participantView(s, s.participants[0]).message, /arrive/);
  markJoined(s, s.participants[0]);
  markJoined(s, s.participants[1]);
  markJoined(s, s.participants[2]);
  assert.equal(participantView(s, s.participants[0]).status, 'waiting');
  assert.equal(participantView(s, s.participants[0]).arrived, 3);
  markJoined(s, s.participants[3]);

  // round 1: instructions page (info) first
  for (const p of s.participants) {
    const v = participantView(s, p);
    assert.equal(v.status, 'active');
    assert.equal(v.stage.title, 'Instructions');
    assert.ok(submitStage(s, p, {}).ok);
  }
  const contributions = [20, 0, 10, 10];
  const order = [1, 0, 3, 2];
  for (const i of order) {
    const p = s.participants[i];
    const v = participantView(s, p);
    assert.equal(v.stage.title, 'Your contribution');
    assert.equal(v.stage.fields[0].max, 20);
    assert.ok(submitStage(s, p, { contribution: contributions[i] }).ok);
    if (i !== order[3]) assert.equal(participantView(s, p).status, 'waiting');
  }
  // total 40, share 16 -> payoffs 16, 36, 26, 26
  const pay = s.participants.map((p) => p.rounds[1].vars.payoff);
  assert.deepEqual(pay, [16, 36, 26, 26]);
  assert.equal(s.groupVars['1:0'].total, 40);
  assert.equal(s.groupVars['1:0'].share, 16);
  assert.match(participantView(s, s.participants[1]).stage.body, /\*\*36\*\*/);

  // continue: results page, then round 2 (no instructions page)
  for (const p of s.participants) assert.ok(submitStage(s, p, {}).ok);
  for (const p of s.participants) {
    const v = participantView(s, p);
    assert.equal(v.round, 2);
    assert.equal(v.stage.title, 'Your contribution');
  }
  submitAll(s, { contribution: 20 });
  assert.equal(s.participants[0].rounds[2].vars.payoff, 32);
  submitAll(s, {});
  assert.ok(s.participants.every((p) => p.done));
  assert.equal(s.status, 'finished');

  const view = participantView(s, s.participants[0]);
  assert.equal(view.status, 'done');
  // 16 + 32 = 48 points * $0.05 = $2.40 + $5 fee
  assert.equal(view.payment.total, '$7.40');
  assert.equal(paymentOf(s, s.participants[0]).total, 7.4);
});

test('input validation, bounds and stale submissions', () => {
  const s = createSession(pgg({ rounds: 1 }), { numParticipants: 4, seed: 2 });
  startSession(s); open(s);
  submitAll(s, {}); // instructions
  const p = s.participants[0];
  const key = participantView(s, p).key;
  let r = submitStage(s, p, { contribution: 21 });
  assert.equal(r.ok, false);
  assert.match(r.errors.contribution, /between 0 and 20/);
  r = submitStage(s, p, { contribution: 3.5 });
  assert.match(r.errors.contribution, /whole number/);
  r = submitStage(s, p, { contribution: '' });
  assert.match(r.errors.contribution, /enter a value/);
  r = submitStage(s, p, { contribution: 'abc' });
  assert.match(r.errors.contribution, /number/);
  r = submitStage(s, p, { contribution: '7' }, { stageKey: '9:9' });
  assert.equal(r.stale, true);
  r = submitStage(s, p, { contribution: '7' }, { stageKey: key });
  assert.ok(r.ok);
  assert.equal(p.rounds[1].vars.contribution, 7);
  // double submit is rejected, not applied twice
  r = submitStage(s, p, { contribution: 1 });
  assert.equal(r.ok, false);
  assert.equal(p.rounds[1].vars.contribution, 7);
});

test('custom checks block submission with a message', () => {
  const e = getExample('dictator');
  e.stages[1].checks = [{ expr: 'player.give != 3', message: 'Three is unlucky.' }];
  const s = createSession(e, { numParticipants: 2, seed: 3 });
  startSession(s); open(s);
  submitAll(s, {});
  const dictator = s.participants.find((p) => participantView(s, p).role === 'Dictator');
  const r = submitStage(s, dictator, { give: 3 });
  assert.deepEqual(r.formErrors, ['Three is unlucky.']);
  assert.equal(dictator.rounds[1].vars.give, undefined, 'rejected values are not stored');
  assert.ok(submitStage(s, dictator, { give: 4 }).ok);
});

test('roles, showIf and sequential wait pages (ultimatum)', () => {
  const s = createSession(getExample('ultimatum'), { numParticipants: 2, seed: 5 });
  startSession(s); open(s);
  submitAll(s, {}); // instructions
  const [a, b] = s.participants;
  const prop = participantView(s, a).role === 'Proposer' ? a : b;
  const resp = prop === a ? b : a;
  assert.equal(participantView(s, prop).stage.title, 'Make a proposal');
  assert.equal(participantView(s, resp).status, 'waiting');
  assert.ok(submitStage(s, prop, { offer: 30 }).ok);
  const rv = participantView(s, resp);
  assert.equal(rv.stage.title, 'Respond to the offer');
  assert.match(rv.stage.body, /offers you \*\*30\*\*/);
  assert.equal(participantView(s, prop).status, 'waiting');
  assert.ok(submitStage(s, resp, { response: 'accept' }).ok);
  assert.equal(prop.rounds[1].vars.payoff, 70);
  assert.equal(resp.rounds[1].vars.payoff, 30);
  assert.equal(s.groupVars['1:0'].accepted, true);
});

test('roles rotate and random matching reshuffles groups (one player per role)', () => {
  const s = createSession(getExample('ultimatum'), { numParticipants: 8, seed: 11 });
  const roleAt = (p, r) => s.exp.design.roles[p.slots[r - 1].i - 1];
  for (let r = 1; r < 5; r++) {
    for (const p of s.participants) assert.notEqual(roleAt(p, r), roleAt(p, r + 1), 'roles alternate');
  }
  let changed = 0;
  for (let r = 1; r <= 5; r++) {
    assert.equal(new Set(s.groups[r - 1].flat()).size, 8, 'everybody is in exactly one group');
    for (const g of s.groups[r - 1]) {
      assert.equal(g.length, 2);
      const roles = g.map((id) => roleAt(s.participants[id - 1], r)).sort();
      assert.deepEqual(roles, ['Proposer', 'Responder'], 'each pair has exactly one of each role');
    }
    if (r > 1) changed += s.groups[r - 1].filter((g) => !s.groups[0].some((h) => h.every((id) => g.includes(id)))).length;
  }
  assert.ok(changed > 0, 'random matching produced new pairs');
});

test('without rotation each participant keeps their role under random matching', () => {
  const e = getExample('ultimatum');
  e.design.rotateRoles = false;
  const s = createSession(e, { numParticipants: 8, seed: 21 });
  for (const p of s.participants) assert.equal(new Set(p.slots.map((x) => x.i)).size, 1);
  const partners = new Set();
  for (let r = 1; r <= 5; r++) {
    const me = s.participants[0];
    partners.add(s.groups[r - 1][me.slots[r - 1].g].find((id) => id !== me.id));
  }
  assert.ok(partners.size > 1, 'meets different partners over the rounds');
});

test('treatments are balanced and override constants', () => {
  const s = createSession(getExample('trust'), { numParticipants: 8, seed: 7 });
  const count = {};
  for (const p of s.participants) count[p.treatment] = (count[p.treatment] ?? 0) + 1;
  assert.deepEqual(count, { 'Multiplier 3': 4, 'Multiplier 2': 4 });
  // partners share a treatment
  for (const g of s.groups[0]) assert.equal(new Set(g.map((id) => s.participants[id - 1].treatment)).size, 1);

  startSession(s); open(s);
  submitAll(s, {});
  for (const p of s.participants) {
    const v = participantView(s, p);
    if (v.status === 'active' && v.stage.title === 'How much do you send?') assert.ok(submitStage(s, p, { sent: 10 }).ok);
  }
  const receiver = s.participants.find((p) => participantView(s, p).stage?.title === 'How much do you return?');
  const mult = receiver.treatment === 'Multiplier 3' ? 3 : 2;
  assert.equal(participantView(s, receiver).stage.fields[0].max, 10 * mult);
});

test('timeouts auto-submit defaults and flag the data', () => {
  const e = pgg({ rounds: 1 });
  e.stages[1].timeoutSeconds = 30;
  e.stages[1].fields[0].default = 5;
  const t0 = 1_000_000;
  const s = createSession(e, { numParticipants: 4, seed: 4, now: t0 });
  startSession(s, t0);
  for (const p of s.participants) markJoined(s, p, {}, t0);
  for (const p of s.participants) submitStage(s, p, {}, { now: t0 });
  assert.equal(tick(s, t0 + 20_000), false);
  s.participants[0].stageStartedAt = t0; // everybody started at t0
  const v = participantView(s, s.participants[0]);
  assert.equal(v.timeout.seconds, 30);
  assert.equal(tick(s, t0 + 40_000), true);
  assert.ok(s.participants.every((p) => p.rounds[1].vars.contribution === 5));
  assert.ok(s.participants.every((p) => p.rounds[1].auto.length === 1));
  const rows = dataTable(s).rows;
  assert.equal(rows[0].auto_filled_stages, s.exp.stages[1].id);
});

test('researcher can force a stuck participant forward', () => {
  const s = createSession(pgg({ rounds: 1 }), { numParticipants: 4, seed: 6 });
  startSession(s);
  open(s);
  submitAll(s, {});
  for (const p of s.participants.slice(0, 3)) assert.ok(submitStage(s, p, { contribution: 10 }).ok);
  assert.equal(participantView(s, s.participants[0]).status, 'waiting');
  forceAdvance(s, s.participants[0]); // pushes the straggler through with defaults
  assert.equal(s.participants[3].rounds[1].vars.contribution, 0);
  assert.equal(participantView(s, s.participants[0]).stage.title, 'Round results');
  assert.equal(s.participants[0].rounds[1].vars.payoff, 20 - 10 + 0.4 * 30);
  assert.equal(s.participants[3].rounds[1].auto.length, 1);
});

test('force-advancing an absent group-mate at the round barrier', () => {
  const s = createSession(pgg({ rounds: 1 }), { numParticipants: 4, seed: 8 });
  startSession(s);
  markJoined(s, s.participants[0]);
  assert.equal(participantView(s, s.participants[0]).status, 'waiting');
  forceAdvance(s, s.participants[0]);
  assert.equal(participantView(s, s.participants[0]).status, 'active');
});

test('open-join links hand out seats once and never to bots', () => {
  const s = createSession(getExample('dictator'), { numParticipants: 4, bots: 2, seed: 9 });
  const a = claimSeat(s, { label: 'Ann', params: { PROLIFIC_PID: 'x1' } });
  const b = claimSeat(s, {});
  assert.notEqual(a.id, b.id);
  assert.equal(a.label, 'Ann');
  assert.equal(a.params.PROLIFIC_PID, 'x1');
  assert.ok(!a.isBot && !b.isBot);
  assert.throws(() => claimSeat(s, {}), /full/);
});

test('bots play whole sessions; human seat plays alongside bots', () => {
  const s = createSession(getExample('prisoners-dilemma'), { numParticipants: 4, bots: 3, seed: 10 });
  startSession(s);
  const me = s.participants[0];
  markJoined(s, me);
  // my partner is a bot; the other pair are bots too
  let guard = 0;
  while (!me.done && guard++ < 100) {
    const v = participantView(s, me);
    if (v.status !== 'active') break;
    const vals = v.stage.type === 'decision' ? { action: 'C' } : {};
    assert.ok(submitStage(s, me, vals).ok);
  }
  assert.ok(me.done, 'human finished');
  assert.equal(s.errors.length, 0);
  assert.equal(s.status, 'finished');
});

test('all bundled examples validate and run to completion with bots', () => {
  for (const ex of EXAMPLES) {
    const exp = normalizeExperiment(ex.experiment);
    assert.deepEqual(validateExperiment(exp), [], ex.key);
    const N = exp.design.groupSize * Math.max(2, exp.design.treatments.length) * 2;
    const s = createSession(exp, { numParticipants: N, bots: N, seed: 123, startMode: 'immediate' });
    assert.equal(s.status, 'finished', ex.key);
    assert.equal(s.errors.length, 0, `${ex.key}: ${JSON.stringify(s.errors)}`);
    const { rows } = dataTable(s);
    assert.equal(rows.length, N * exp.design.rounds, ex.key);
  }
});

test('same seed reproduces the same session', () => {
  const run = () => {
    const s = createSession(getExample('beauty-contest'), { numParticipants: 8, bots: 8, seed: 99, startMode: 'immediate' });
    return s.participants.map((p) => [p.treatment, p.slots, p.rounds[3].vars.guess, p.rounds[3].vars.payoff]);
  };
  assert.deepEqual(run(), run());
});

test('payment modes', () => {
  const mk = (mode) => {
    const s = createSession(pgg({ rounds: 3, payment: { mode, exchangeRate: 1, participationFee: 0 } }), { numParticipants: 4, bots: 4, seed: 12, startMode: 'immediate' });
    const p = s.participants[0];
    const pts = [1, 2, 3].map((r) => p.rounds[r].vars.payoff);
    return { s, p, pts };
  };
  let { s, p, pts } = mk('all');
  assert.equal(paymentOf(s, p).points, pts[0] + pts[1] + pts[2]);
  ({ s, p, pts } = mk('last_round'));
  assert.equal(paymentOf(s, p).points, pts[2]);
  ({ s, p, pts } = mk('random_round'));
  assert.equal(paymentOf(s, p).points, pts[p.paidRound - 1]);
  assert.ok(p.paidRound >= 1 && p.paidRound <= 3);
});

test('expression errors are logged for the researcher, not thrown at participants', () => {
  const e = getExample('dictator');
  e.stages[2].compute[0].expr = 'player.nonexistent + 1';
  e.stages[3].body = 'Oops {{ 1 / 0 }}';
  const s = createSession(e, { numParticipants: 2, bots: 2, seed: 1, startMode: 'immediate' });
  assert.equal(s.status, 'finished');
  assert.ok(s.errors.length >= 1);
  assert.ok(s.errors.some((x) => /empty \(null\)|null/.test(x.message)));
});

test('session creation rejects bad input with helpful messages', () => {
  assert.throws(() => createSession(getExample('public-goods'), { numParticipants: 6 }), /multiple of 4/);
  assert.throws(() => createSession(getExample('public-goods'), { numParticipants: 0 }), EngineError);
  const bad = getExample('public-goods');
  bad.stages[1].fields[0].max = 'const.endowmnt +';
  assert.throws(() => createSession(bad, { numParticipants: 4 }), /error/);
});

test('exports: csv quoting, formula neutralisation, columns', () => {
  const s = createSession(getExample('survey'), { numParticipants: 2, seed: 3 });
  startSession(s); open(s);
  submitAll(s, { consent: true });
  submitAll(s, (p, i) => ({ age: 30 + i, gender: 'f', trust: 4, patience: 5, comments: i ? '=HYPERLINK("http://x")' : 'He said "hi", twice' }));
  const csv = toCsv(dataTable(s));
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^session,participant_code,.*consent,age,gender,trust,patience,comments,payoff/);
  assert.match(csv, /"He said ""hi"", twice"/);
  assert.match(csv, /'=HYPERLINK/);
  assert.match(lines[1], /,1,30,f,4,5,/); // consent exported as 1
  const pays = toCsv(paymentsTable(s));
  assert.match(pays, /total_payment/);
  assert.ok(timesTable(s).rows.length >= 4);
});

test('summary lists progress for the monitor', () => {
  const s = createSession(pgg({ rounds: 1 }), { numParticipants: 4, seed: 2 });
  startSession(s); markJoined(s, s.participants[0]);
  const sum = sessionSummary(s);
  assert.equal(sum.counts.joined, 1);
  assert.equal(sum.participants[0].state, 'waiting');
  assert.equal(sum.participants[0].stageTitle, 'Round start');
});

test('session-wide wait: session variables and group variables computed in one pass', () => {
  const exp = {
    name: 'Market', design: { groupSize: 2, rounds: 1, payment: { mode: 'all', exchangeRate: 1, participationFee: 0 } },
    stages: [
      { type: 'decision', title: 'Bid', fields: [{ name: 'bid', type: 'integer', min: 0, max: 100 }] },
      {
        type: 'wait', title: 'Clearing', waitFor: 'all',
        compute: [
          { scope: 'session', name: 'avg_bid', expr: 'mean(all_players.bid)' },
          { scope: 'group', name: 'high', expr: 'max(group.players.bid)' },
          { scope: 'player', name: 'payoff', expr: 'if(player.bid >= group.high, 10, 0) + session.avg_bid' },
        ],
      },
    ],
  };
  const s = createSession(exp, { numParticipants: 4, seed: 1 });
  startSession(s); open(s);
  const bids = [10, 20, 30, 40];
  // three of four submit: nobody (not even the finished pair) is released
  for (const i of [0, 1, 2]) assert.ok(submitStage(s, s.participants[i], { bid: bids[i] }).ok);
  assert.ok(s.participants.every((p) => !p.done), 'session-wide wait holds everyone');
  assert.deepEqual(s.vars, {});
  assert.ok(submitStage(s, s.participants[3], { bid: 40 }).ok);
  assert.ok(s.participants.every((p) => p.done));
  assert.equal(s.vars.avg_bid, 25);
  const bidOf = (p) => p.rounds[1].vars.bid;
  for (const p of s.participants) {
    const mates = s.groups[0].find((g) => g.includes(p.id)).map((id) => s.participants[id - 1]);
    const high = Math.max(...mates.map(bidOf));
    assert.equal(p.rounds[1].vars.payoff, (bidOf(p) >= high ? 10 : 0) + 25);
  }
  assert.equal(dataTable(s).rows[0].session_avg_bid, 25);
});

test('individual experiments: wait pages release immediately and showIf skips pages', () => {
  const exp = {
    name: 'Solo', design: { groupSize: 1, rounds: 2, payment: { mode: 'all', exchangeRate: 1, participationFee: 0 } },
    stages: [
      { type: 'info', title: 'Intro', showIf: 'round == 1' },
      { type: 'decision', title: 'Guess', fields: [{ name: 'g', type: 'integer', min: 0, max: 9 }] },
      { type: 'wait', title: 'Compute', compute: [{ scope: 'player', name: 'payoff', expr: 'player.g * 2 + round' }] },
    ],
  };
  const s = createSession(exp, { numParticipants: 2, seed: 2, startMode: 'immediate' });
  const p = s.participants[0];
  markJoined(s, p);
  assert.equal(participantView(s, p).stage.title, 'Intro');
  submitStage(s, p, {});
  submitStage(s, p, { g: 3 });
  // the wait page passed straight through, and round 2 has no Intro
  assert.equal(p.rounds[1].vars.payoff, 7);
  const v = participantView(s, p);
  assert.equal(v.round, 2);
  assert.equal(v.stage.title, 'Guess');
  submitStage(s, p, { g: 9 });
  assert.ok(p.done);
  assert.equal(p.rounds[2].vars.payoff, 20);
});

test('treatment pools never mix under random matching', () => {
  const e = getExample('beauty-contest');
  e.design.treatments = [{ name: 'A', constants: { prize: 100 } }, { name: 'B', constants: { prize: 200 } }];
  const s = createSession(e, { numParticipants: 16, seed: 31 });
  for (let r = 1; r <= 3; r++) {
    for (const g of s.groups[r - 1]) {
      assert.equal(new Set(g.map((id) => s.participants[id - 1].treatment)).size, 1, `round ${r} group is single-treatment`);
    }
  }
  const counts = { A: 0, B: 0 };
  s.participants.forEach((p) => counts[p.treatment]++);
  assert.deepEqual(counts, { A: 8, B: 8 });
});

test('page times are recorded including wait pages', () => {
  const s = createSession(pgg({ rounds: 1 }), { numParticipants: 4, bots: 4, seed: 3, startMode: 'immediate' });
  const rows = timesTable(s).rows;
  const titles = new Set(rows.map((r) => r.stage_title));
  assert.ok(titles.has('Your contribution') && titles.has('Please wait'));
  assert.ok(rows.every((r) => r.started_at && r.finished_at));
});

test('negative and decimal inputs: numbers accept commas and respect min/max', () => {
  const e = getExample('beauty-contest');
  e.design.treatments = [];
  const s = createSession(e, { numParticipants: 4, seed: 5 });
  startSession(s); open(s);
  submitAll(s, {});
  const p = s.participants[0];
  assert.match(submitStage(s, p, { guess: -1 }).errors.guess, /between 0 and 100/);
  assert.ok(submitStage(s, p, { guess: '33,5' }).ok);
  assert.equal(p.rounds[1].vars.guess, 33.5);
});
