// Turn a session into analysis-ready tables (CSV / JSON).
// Booleans are exported as 1/0 so Stata, R and pandas read them as numbers.

import { paymentOf } from './engine.js';

const FIXED = ['session', 'participant_code', 'participant_id', 'label', 'treatment', 'is_bot', 'round', 'group', 'id_in_group', 'role'];

function cell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

export function dataTable(session) {
  const exp = session.exp;
  const d = exp.design;
  const fieldCols = [];
  const playerCols = [];
  const groupCols = [];
  const sessionCols = [];
  const add = (arr, name) => { if (!arr.includes(name)) arr.push(name); };
  for (const s of exp.stages) {
    s.fields.forEach((f) => add(fieldCols, f.name));
    s.compute.forEach((r) => add(r.scope === 'player' ? playerCols : r.scope === 'group' ? groupCols : sessionCols, r.name));
  }
  const playerOnly = playerCols.filter((c) => c !== 'payoff' && !fieldCols.includes(c));
  const columns = [
    ...FIXED, ...fieldCols, ...playerOnly, 'payoff',
    ...groupCols.map((c) => `group_${c}`), ...sessionCols.map((c) => `session_${c}`),
    'round_is_paid', 'auto_filled_stages',
  ];
  const R = d.rounds;
  const rows = [];
  for (const p of session.participants) {
    const reached = p.done ? R : Math.min(R, p.pos.r);
    for (let r = 1; r <= reached; r++) {
      const rd = p.rounds[r] ?? { vars: {}, auto: [] };
      const slot = p.slots[r - 1];
      const row = {
        session: session.code,
        participant_code: p.code,
        participant_id: p.id,
        label: p.label,
        treatment: p.treatment ?? '',
        is_bot: p.isBot ? 1 : 0,
        round: r,
        group: slot.g + 1,
        id_in_group: slot.i,
        role: d.roles[slot.i - 1] ?? '',
      };
      for (const c of [...fieldCols, ...playerOnly]) row[c] = cell(rd.vars[c]);
      row.payoff = cell(rd.vars.payoff ?? 0);
      const gv = session.groupVars[`${r}:${slot.g}`] ?? {};
      for (const c of groupCols) row[`group_${c}`] = cell(gv[c]);
      for (const c of sessionCols) row[`session_${c}`] = cell(session.vars[c]);
      row.round_is_paid = d.payment.mode === 'all' ? 1
        : d.payment.mode === 'last_round' ? (r === R ? 1 : 0)
          : (p.paidRound === r ? 1 : 0);
      row.auto_filled_stages = (rd.auto ?? []).join(' ');
      rows.push(row);
    }
  }
  return { columns, rows };
}

export function timesTable(session) {
  const columns = ['session', 'participant_code', 'participant_id', 'round', 'stage_number', 'stage_id', 'stage_title', 'started_at', 'finished_at', 'seconds', 'auto_filled'];
  const rows = [];
  for (const p of session.participants) {
    for (const [r, rd] of Object.entries(p.rounds)) {
      session.exp.stages.forEach((s, si) => {
        const t = rd.times?.[s.id];
        if (!t) return;
        rows.push({
          session: session.code,
          participant_code: p.code,
          participant_id: p.id,
          round: Number(r),
          stage_number: si + 1,
          stage_id: s.id,
          stage_title: s.title,
          started_at: t.start ? new Date(t.start).toISOString() : '',
          finished_at: t.end ? new Date(t.end).toISOString() : '',
          seconds: t.start && t.end ? Math.round((t.end - t.start) / 10) / 100 : '',
          auto_filled: t.auto ? 1 : 0,
        });
      });
    }
  }
  rows.sort((a, b) => a.participant_id - b.participant_id || a.round - b.round || a.stage_number - b.stage_number);
  return { columns, rows };
}

export function paymentsTable(session) {
  const pay = session.exp.design.payment;
  const columns = ['participant_code', 'participant_id', 'label', 'treatment', 'finished', 'is_bot', 'points', 'paid_round', 'exchange_rate', 'earnings', 'participation_fee', 'total_payment', 'currency'];
  const rows = session.participants.map((p) => {
    const x = paymentOf(session, p);
    return {
      participant_code: p.code,
      participant_id: p.id,
      label: p.label,
      treatment: p.treatment ?? '',
      finished: p.done ? 1 : 0,
      is_bot: p.isBot ? 1 : 0,
      points: x.points,
      paid_round: x.paidRound ?? '',
      exchange_rate: pay.exchangeRate,
      earnings: x.earnings,
      participation_fee: x.fee,
      total_payment: x.total,
      currency: pay.currencySymbol,
    };
  });
  return { columns, rows };
}

// A spreadsheet treats a cell starting with = + - @ as a formula. Participant
// free text is untrusted, so neutralise it (numbers are left untouched).
function csvCell(v) {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'number' ? String(v) : String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv({ columns, rows }) {
  const lines = [columns.map(csvCell).join(',')];
  for (const row of rows) lines.push(columns.map((c) => csvCell(row[c])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}
