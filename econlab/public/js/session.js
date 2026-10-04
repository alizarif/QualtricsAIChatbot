// Session page: live monitor, data, payments and problems.

import {
  h, mount, icon, toast, confirmDialog, copyText, relTime, debounce,
} from './dom.js';
import { get, post, del } from './api.js';
import { badge, menuButton } from './ui.js';

const COLORS = ['#3f55d1', '#d9730d', '#0f7a56', '#b8338f', '#6b7280', '#0891b2'];

const statusBadge = (st) => badge(st === 'waiting' ? 'Not started' : st === 'running' ? 'Running' : 'Finished', st === 'finished' ? 'success' : st === 'running' ? 'primary' : 'warn');

export async function renderSession(host, id, initialTab, navigate) {
  const S = {
    s: (await get(`/api/sessions/${id}`)).session,
    tab: ['monitor', 'data', 'payments', 'problems'].includes(initialTab) ? initialTab : 'monitor',
    data: null, dataVersion: 0, statVar: null, statBy: 'treatment',
  };
  const origin = location.origin;
  const linkOf = (p) => `${origin}/play/${p.code}`;
  const joinLink = () => `${origin}/join/${S.s.code}`;

  const headEl = h('div');
  const statsEl = h('div');
  const shareEl = h('div');
  const tabsEl = h('div', { class: 'tabs', role: 'tablist' });
  const content = h('div');

  // ---- data flow -------------------------------------------------------------
  let events = null;
  let pollTimer = null;
  let ageTimer = null;
  let destroyed = false;
  const refresh = async () => {
    if (destroyed) return;
    try {
      S.s = (await get(`/api/sessions/${id}`)).session;
      paintTop();
      if (S.tab === 'monitor') paintMonitor();
      if (S.tab === 'problems') drawTab();
      if (S.tab === 'data' || S.tab === 'payments') reloadData();
    } catch (e) { if (e.status === 404) navigate('#/'); }
  };
  const refreshSoon = debounce(refresh, 150);
  const reloadData = debounce(async () => {
    try { S.data = await get(`/api/sessions/${id}/data`); if (S.tab === 'data' || S.tab === 'payments') drawTab(); } catch { /* ignore */ }
  }, 800);
  if ('EventSource' in window) {
    events = new EventSource(`/api/sessions/${id}/events`);
    events.addEventListener('update', refreshSoon);
  }
  pollTimer = setInterval(refresh, 6000);
  ageTimer = setInterval(() => { if (S.tab === 'monitor') paintMonitor(); }, 10000);

  // ---- header / stats / share --------------------------------------------------
  const exportItems = [
    { title: 'Download' },
    { label: 'Data (CSV)', hint: 'one row per participant and round', icon: 'download', onClick: () => { location.href = `/api/sessions/${id}/export/data.csv`; } },
    { label: 'Payments (CSV)', hint: 'points, earnings and fee per participant', icon: 'download', onClick: () => { location.href = `/api/sessions/${id}/export/payments.csv`; } },
    { label: 'Page times (CSV)', hint: 'time spent on every page', icon: 'download', onClick: () => { location.href = `/api/sessions/${id}/export/times.csv`; } },
    { label: 'Everything (JSON)', hint: 'complete archive including the design', icon: 'download', onClick: () => { location.href = `/api/sessions/${id}/export/session.json`; } },
  ];

  async function start() {
    const c = S.s.counts;
    if (S.s.groupSize > 1 && c.joined < S.s.numParticipants) {
      const ok = await confirmDialog('Start without everyone?', `Only ${c.joined} of ${S.s.numParticipants} participants have opened their link. Groups cannot begin until all of their members have arrived. Start anyway?`, { confirmLabel: 'Start session' });
      if (!ok) return;
    }
    try { S.s = (await post(`/api/sessions/${id}/start`)).session; paintTop(); drawTab(); } catch (e) { toast(e.message, 'danger'); }
  }

  function paintTop() {
    const s = S.s;
    mount(headEl, 
      h('div', { class: 'page-head' },
        h('div', { class: 'grow' },
          h('a', { class: 'btn btn-ghost btn-sm', href: `#/experiments/${s.experimentId}`, style: { marginLeft: '-10px' } }, icon('back', 16), s.experimentName),
          h('div', { class: 'row', style: { marginTop: '4px' } }, h('h1', null, s.name), statusBadge(s.status), s.errors.length ? badge(`${s.errors.length} problem${s.errors.length > 1 ? 's' : ''}`, 'danger') : null),
          h('p', { class: 'muted', style: { margin: '4px 0 0' } },
            `${s.numParticipants} participants · ${s.groupSize === 1 ? 'individual' : `groups of ${s.groupSize}`} · ${s.rounds} round${s.rounds > 1 ? 's' : ''}${s.treatments.length ? ` · ${s.treatments.length} treatments` : ''} · seed ${s.seed}`)),
        h('div', { class: 'row tight' },
          !s.started ? h('button', { class: 'btn btn-primary btn-lg', type: 'button', onclick: start }, icon('play', 16), 'Start session') : null,
          menuButton('Export', exportItems, { iconName: 'download' }),
          menuButton('', [{ label: 'Delete session…', icon: 'trash', danger: true, onClick: async () => {
            if (await confirmDialog('Delete this session?', 'All its data is permanently removed. Download it first if you need it.', { confirmLabel: 'Delete', danger: true })) { await del(`/api/sessions/${id}`); navigate(`#/experiments/${s.experimentId}/sessions`); }
          } }], { cls: 'icon-btn', iconName: 'more' }))));
    const c = s.counts;
    const pct = (c.done / s.numParticipants) * 100;
    mount(statsEl, 
      h('div', { class: 'stat-grid' },
        stat(c.joined, `of ${s.numParticipants} joined`), stat(c.active, 'answering now'), stat(c.waiting, 'waiting'), stat(c.done, 'finished')),
      h('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': Math.round(pct), 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': 'Session progress', style: { marginBottom: '20px' } }, h('div', { style: { width: `${pct}%` } })));
    mount(shareEl, paintShare());
  }

  const stat = (n, l) => h('div', { class: 'stat' }, h('div', { class: 'n' }, String(n)), h('div', { class: 'l' }, l));

  function paintShare() {
    const s = S.s;
    const csv = () => `participant,code,link\n${s.participants.map((p) => `${p.id},${p.code},${linkOf(p)}`).join('\n')}\n`;
    return h('div', { class: 'card', style: { marginBottom: '20px' } },
      h('div', { class: 'card-head' }, h('h3', null, 'Invite participants'),
        h('div', { class: 'row tight right' },
          h('button', { class: 'btn btn-sm', type: 'button', onclick: () => copyText(s.participants.map((p) => linkOf(p)).join('\n'), 'All links copied') }, icon('copy', 14), 'Copy all personal links'),
          h('button', { class: 'btn btn-sm', type: 'button', onclick: () => {
            const a = h('a', { href: URL.createObjectURL(new Blob([csv()], { type: 'text/csv' })), download: `${s.code}_links.csv` });
            document.body.appendChild(a); a.click(); a.remove();
          } }, icon('download', 14), 'Links CSV'))),
      h('div', { class: 'grid cols-2' },
        h('div', null,
          h('div', { class: 'small', style: { fontWeight: 600, marginBottom: '6px' } }, 'One shared link (online studies)'),
          h('div', { class: 'link-box' }, h('code', null, joinLink()),
            h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Copy join link', onclick: () => copyText(joinLink()) }, icon('copy', 16))),
          h('label', { class: 'check', style: { marginTop: '8px' } },
            h('input', { type: 'checkbox', checked: s.openJoin, onchange: async (e) => { await post(`/api/sessions/${id}/settings`, { openJoin: e.target.checked }); S.s.openJoin = e.target.checked; } }),
            h('span', { class: 'small' }, 'Accept new participants through this link'))),
        h('div', { class: 'small muted' },
          'Each person who opens the shared link takes the next free seat. For a lab, use the personal links in the table below, one per computer. Extra link parameters such as ',
          h('code', null, '?PROLIFIC_PID=…'), ' or ', h('code', null, '?label=…'), ' are saved as the participant’s ID.')));
  }

  // ---- tabs ------------------------------------------------------------------------
  function paintTabs() {
    mount(tabsEl, ...[['monitor', 'Monitor'], ['data', 'Data'], ['payments', 'Payments'], ['problems', 'Problems']].map(([k, l]) =>
      h('button', { class: 'tab', role: 'tab', 'aria-selected': S.tab === k, onclick: () => setTab(k) }, l, k === 'problems' && S.s.errors.length ? badge(String(S.s.errors.length), 'danger') : null)));
  }
  function setTab(t) {
    S.tab = t;
    history.replaceState(null, '', `#/sessions/${id}/${t}`);
    paintTabs();
    if ((t === 'data' || t === 'payments') && !S.data) { mount(content, h('p', { class: 'muted' }, 'Loading…')); reloadData.flush(); return; }
    drawTab();
  }
  function drawTab() {
    paintTabs();
    if (S.tab === 'monitor') { mount(content, monitorHost); paintMonitor(); } else if (S.tab === 'data') mount(content, renderData());
    else if (S.tab === 'payments') mount(content, renderPayments());
    else mount(content, renderProblems());
  }

  // ---- monitor ---------------------------------------------------------------------
  const monitorHost = h('div');
  function paintMonitor() {
    const s = S.s;
    const rows = s.participants.map((p) => {
      let status;
      if (!p.joined) status = h('span', null, h('span', { class: 'status-dot' }), 'Not joined');
      else if (p.done) status = h('span', null, h('span', { class: 'status-dot done' }), 'Finished');
      else if (p.state === 'waiting') status = h('span', null, h('span', { class: 'status-dot waiting' }), 'Waiting', p.waitSince ? h('span', { class: 'muted' }, ` ${relTime(p.waitSince)}`) : null);
      else status = h('span', null, h('span', { class: 'status-dot active' }), 'Active');
      const stale = p.joined && !p.done && !p.isBot && p.lastSeen && Date.now() - p.lastSeen > 90000;
      return h('tr', null,
        h('td', { class: 'num' }, String(p.id)),
        h('td', null, h('span', { class: 'row tight', style: { flexWrap: 'nowrap' } },
          h('code', null, p.code),
          h('button', { class: 'icon-btn', type: 'button', title: 'Copy personal link', 'aria-label': `Copy link for participant ${p.id}`, onclick: () => copyText(linkOf(p)) }, icon('copy', 14)),
          h('a', { class: 'icon-btn', href: `/play/${p.code}`, target: '_blank', rel: 'noopener', title: 'Open as this participant', 'aria-label': `Open participant ${p.id}` }, icon('link', 14)))),
        h('td', null, p.label || h('span', { class: 'muted' }, '–'), p.isBot ? h('span', null, ' ', badge('bot')) : null),
        s.treatments.length ? h('td', null, p.treatment ?? '') : null,
        s.groupSize > 1 ? h('td', null, `G${p.group}`) : null,
        h('td', null, p.role || h('span', { class: 'muted' }, '–')),
        h('td', null, status),
        h('td', null, p.done ? '' : `${s.rounds > 1 ? `R${p.round}/${s.rounds} · ` : ''}${p.stageTitle}`),
        h('td', { class: 'num' }, String(p.points)),
        h('td', { class: stale ? '' : 'muted' }, stale ? h('span', { class: 'badge warn' }, relTime(p.lastSeen)) : relTime(p.lastSeen)),
        h('td', null, s.started && !p.done ? h('button', { class: 'btn btn-sm', type: 'button', title: 'Submit default values for this participant and move on (for dropouts)', onclick: async () => {
          if (!(await confirmDialog(`Advance participant ${p.id}?`, 'The current page is submitted with default values (flagged as auto-filled in the data) and the participant moves on. Use this when someone has dropped out and is holding up the group.', { confirmLabel: 'Advance' }))) return;
          try { S.s = (await post(`/api/sessions/${id}/participants/${p.id}/advance`)).session; paintTop(); paintMonitor(); } catch (e) { toast(e.message, 'danger'); }
        } }, 'Advance') : null));
    });
    mount(monitorHost, 
      !s.started ? h('div', { class: 'alert', style: { marginBottom: '14px' } }, icon('info', 16), h('div', null, 'The session has not started. Participants who open their link see a waiting room until you press ', h('strong', null, 'Start session'), '.')) : null,
      h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', null, h('tr', null,
          h('th', { class: 'num' }, '#'), h('th', null, 'Personal link'), h('th', null, 'ID / label'),
          s.treatments.length ? h('th', null, 'Treatment') : null, s.groupSize > 1 ? h('th', null, 'Group') : null,
          h('th', null, 'Role'), h('th', null, 'Status'), h('th', null, 'Position'), h('th', { class: 'num' }, 'Points'), h('th', null, 'Last seen'), h('th', null, ''))),
        h('tbody', null, rows))));
  }

  // ---- data ---------------------------------------------------------------------------
  const NON_ANALYSIS = new Set(['session', 'participant_code', 'participant_id', 'label', 'treatment', 'is_bot', 'round', 'group', 'id_in_group', 'role', 'round_is_paid', 'auto_filled_stages']);

  function numericColumns(data) {
    return data.columns.filter((c) => !NON_ANALYSIS.has(c) && data.rows.some((r) => typeof r[c] === 'number'));
  }

  const quantile = (xs, q) => {
    const s = [...xs].sort((a, b) => a - b);
    if (!s.length) return NaN;
    const pos = (s.length - 1) * q; const lo = Math.floor(pos);
    return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (pos - lo);
  };
  const stats = (xs) => {
    const n = xs.length;
    const mean = xs.reduce((a, b) => a + b, 0) / n;
    const sd = n > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : NaN;
    return { n, mean, sd, min: Math.min(...xs), median: quantile(xs, 0.5), max: Math.max(...xs) };
  };
  const fmt = (x) => (Number.isFinite(x) ? String(Math.round(x * 1000) / 1000) : '–');

  function renderData() {
    const { data, exp } = S.data;
    const cols = numericColumns(data);
    if (!S.statVar || !cols.includes(S.statVar)) S.statVar = cols.includes('payoff') ? 'payoff' : cols[0];
    const hasTreat = exp.design.treatments.length > 0;
    const multiRound = exp.design.rounds > 1;
    const summaryHost = h('div');
    const draw = () => {
      const v = S.statVar;
      const rows = data.rows.filter((r) => typeof r[v] === 'number');
      const groups = new Map();
      for (const r of rows) {
        const key = S.statBy === 'treatment' ? (r.treatment || 'All') : S.statBy === 'round' ? `Round ${r.round}` : S.statBy === 'role' ? (r.role || 'All') : 'All';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r[v]);
      }
      const ordered = [...groups.entries()];
      if (S.statBy === 'round') ordered.sort((a, b) => Number(a[0].slice(6)) - Number(b[0].slice(6)));
      mount(summaryHost, 
        rows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
          h('thead', null, h('tr', null, [S.statBy === 'none' ? 'Sample' : S.statBy[0].toUpperCase() + S.statBy.slice(1), 'N', 'Mean', 'SD', 'Min', 'Median', 'Max'].map((x, i) => h('th', { class: i ? 'num' : '' }, x)))),
          h('tbody', null, ordered.map(([k, xs]) => { const st = stats(xs); return h('tr', null, h('td', null, k), [st.n, st.mean, st.sd, st.min, st.median, st.max].map((x, i) => h('td', { class: 'num' }, i === 0 ? String(x) : fmt(x)))); })))) : h('p', { class: 'muted' }, 'No numeric data yet.'),
        rows.length ? chart(v, rows, multiRound) : null);
    };
    const varSel = h('select', { 'aria-label': 'Variable', onchange: (e) => { S.statVar = e.target.value; draw(); } }, cols.map((c) => h('option', { value: c, selected: c === S.statVar }, c)));
    const bySel = h('select', { 'aria-label': 'Group by', onchange: (e) => { S.statBy = e.target.value; draw(); } },
      [['none', 'All together'], ...(hasTreat ? [['treatment', 'By treatment']] : []), ...(multiRound ? [['round', 'By round']] : []), ...(exp.design.roles.length ? [['role', 'By role']] : [])]
        .map(([v, l]) => h('option', { value: v, selected: v === S.statBy }, l)));
    if (!Array.from(bySel.options).some((o) => o.value === S.statBy)) { S.statBy = 'none'; bySel.value = 'none'; }
    draw();
    const MAXROWS = 300;
    return h('div', { class: 'stack' },
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h3', null, 'Summary'),
          h('div', { class: 'row tight right' }, varSel, bySel)),
        summaryHost),
      h('div', null,
        h('div', { class: 'row', style: { marginBottom: '8px' } }, h('h3', { style: { margin: 0 } }, 'Raw data'), h('span', { class: 'muted small' }, `${data.rows.length} rows`),
          h('a', { class: 'btn btn-sm right', href: `/api/sessions/${id}/export/data.csv` }, icon('download', 14), 'CSV')),
        data.rows.length ? h('div', { class: 'table-wrap', style: { maxHeight: '520px' } }, h('table', { class: 'data' },
          h('thead', null, h('tr', null, data.columns.map((c) => h('th', null, c)))),
          h('tbody', null, data.rows.slice(0, MAXROWS).map((r) => h('tr', null, data.columns.map((c) => h('td', { class: typeof r[c] === 'number' ? 'num' : '' }, r[c] === '' || r[c] === undefined ? '' : String(r[c]))))))))
          : h('div', { class: 'card empty' }, h('p', null, 'No data yet. Rows appear as participants progress.')),
        data.rows.length > MAXROWS ? h('p', { class: 'muted small' }, `Showing the first ${MAXROWS} rows. Download the CSV for everything.`) : null));
  }

  /** Round axis limits outward to "nice" numbers: 0, 5, 10 … instead of 10.992, 18.996 … */
  function niceScale(lo, hi, count = 5) {
    const span = hi - lo || Math.abs(hi) || 1;
    const raw = span / (count - 1);
    const mag = 10 ** Math.floor(Math.log10(raw));
    const norm = raw / mag;
    const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
    const min = Math.floor(lo / step + 1e-9) * step;
    const max = Math.ceil(hi / step - 1e-9) * step;
    const ticks = [];
    for (let v = min; v <= max + step / 1e6; v += step) ticks.push(Number(v.toPrecision(12)));
    return { min, max: max === min ? min + step : max, ticks };
  }

  function chart(v, rows, multiRound) {
    const W = 720; const H = 300; const m = { l: 54, r: 16, t: 14, b: 46 };
    const iw = W - m.l - m.r; const ih = H - m.t - m.b;
    const svgNS = 'http://www.w3.org/2000/svg';
    const el = (tag, attrs, ...kids) => { const e = document.createElementNS(svgNS, tag); for (const [k, val] of Object.entries(attrs ?? {})) e.setAttribute(k, val); kids.forEach((k) => e.append(k)); return e; };
    const txt = (t, attrs) => { const e = el('text', attrs); e.textContent = t; return e; };
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': multiRound ? `Mean of ${v} by round` : `Distribution of ${v}` });
    const legend = h('div', { class: 'legend' });
    const grid = (scale, yOf) => {
      for (const t of scale.ticks) {
        svg.append(el('line', { x1: m.l, x2: W - m.r, y1: yOf(t), y2: yOf(t), class: 'grid' }), txt(fmt(t), { x: m.l - 8, y: yOf(t) + 4, 'text-anchor': 'end' }));
      }
      svg.append(el('line', { x1: m.l, x2: m.l, y1: m.t, y2: m.t + ih, class: 'axis' }), el('line', { x1: m.l, x2: W - m.r, y1: m.t + ih, y2: m.t + ih, class: 'axis' }));
    };

    if (multiRound) {
      const byTreat = new Map();
      for (const r of rows) {
        const k = r.treatment || 'All';
        if (!byTreat.has(k)) byTreat.set(k, new Map());
        const mm = byTreat.get(k);
        if (!mm.has(r.round)) mm.set(r.round, []);
        mm.get(r.round).push(r[v]);
      }
      const means = [...byTreat.entries()].map(([name, byRound]) => [name, [...byRound.entries()].sort((a, b) => a[0] - b[0]).map(([r, xs]) => [r, xs.reduce((a, b) => a + b, 0) / xs.length])]);
      const allMeans = means.flatMap(([, pts]) => pts.map((p) => p[1]));
      const scale = niceScale(Math.min(...allMeans), Math.max(...allMeans));
      const y = (val) => m.t + ih - ((val - scale.min) / (scale.max - scale.min)) * ih;
      grid(scale, y);
      const rounds = [...new Set(rows.map((r) => r.round))].sort((a, b) => a - b);
      const x = (r) => m.l + 12 + (rounds.length === 1 ? (iw - 24) / 2 : ((r - rounds[0]) / (rounds[rounds.length - 1] - rounds[0])) * (iw - 24));
      const step = Math.ceil(rounds.length / 12);
      rounds.forEach((r, i) => { if (i % step === 0) svg.append(txt(String(r), { x: x(r), y: m.t + ih + 18, 'text-anchor': 'middle' })); });
      svg.append(txt('Round', { x: m.l + iw / 2, y: H - 6, 'text-anchor': 'middle' }));
      means.forEach(([name, pts], i) => {
        const color = COLORS[i % COLORS.length];
        const xy = pts.map(([r, mean]) => [x(r), y(mean)]);
        svg.append(el('polyline', { points: xy.map((p) => p.join(',')).join(' '), fill: 'none', stroke: color, 'stroke-width': 2.5, 'stroke-linejoin': 'round' }),
          ...xy.map((p, k) => el('circle', { cx: p[0], cy: p[1], r: 3.5, fill: color }, el('title', {}, document.createTextNode(`${name}, round ${pts[k][0]}: ${fmt(pts[k][1])}`)))));
        legend.append(h('span', null, h('i', { style: { background: color } }), `${name} (mean ${v})`));
      });
    } else {
      const ys = rows.map((r) => r[v]);
      const distinct = [...new Set(ys)].sort((a, b) => a - b);
      const dmin = Math.min(...ys); const dmax = Math.max(...ys);
      let bins;
      if (distinct.length <= 16 && ys.every(Number.isInteger)) bins = distinct.map((d) => ({ label: String(d), n: ys.filter((q) => q === d).length }));
      else {
        const k = Math.min(20, Math.max(5, Math.ceil(Math.log2(ys.length) + 1)));
        const w = (dmax - dmin || 1) / k;
        bins = Array.from({ length: k }, (_, i) => ({ label: fmt(dmin + i * w), n: 0 }));
        for (const q of ys) bins[Math.min(k - 1, Math.floor((q - dmin) / w))].n++;
      }
      const scale = niceScale(0, Math.max(...bins.map((b) => b.n)));
      const y = (val) => m.t + ih - (val / scale.max) * ih;
      grid(scale, y);
      const bw = iw / bins.length;
      const tstep = Math.ceil(bins.length / 12);
      bins.forEach((b, i) => {
        svg.append(el('rect', { x: m.l + i * bw + 2, y: y(b.n), width: Math.max(1, bw - 4), height: m.t + ih - y(b.n), rx: 3, fill: COLORS[0] }, el('title', {}, document.createTextNode(`${b.label}: ${b.n}`))));
        if (i % tstep === 0) svg.append(txt(b.label, { x: m.l + i * bw + bw / 2, y: m.t + ih + 18, 'text-anchor': 'middle' }));
      });
      svg.append(txt(v, { x: m.l + iw / 2, y: H - 6, 'text-anchor': 'middle' }));
      legend.append(h('span', null, `Number of rows by ${v}`));
    }
    return h('div', { style: { marginTop: '16px', maxWidth: '780px' } }, svg, legend);
  }

  // ---- payments -----------------------------------------------------------------------
  function renderPayments() {
    const { payments, exp } = S.data;
    const pay = exp.design.payment;
    const total = payments.rows.reduce((a, r) => a + r.total_payment, 0);
    const unfinished = payments.rows.filter((r) => !r.finished && !r.is_bot).length;
    const money = (x) => (pay.currencySymbol.length <= 1 ? `${pay.currencySymbol}${x.toFixed(2)}` : `${x.toFixed(2)} ${pay.currencySymbol}`);
    return h('div', { class: 'stack' },
      h('div', { class: 'row' },
        h('div', { class: 'grow' }, h('h3', { style: { margin: 0 } }, 'Payments'),
          h('p', { class: 'muted small', style: { margin: '2px 0 0' } }, `${pay.mode === 'all' ? 'Sum of all rounds' : pay.mode === 'random_round' ? 'One random round per participant' : 'Last round only'} · 1 ${pay.pointsName} = ${money(pay.exchangeRate)} · fee ${money(pay.participationFee)}`)),
        h('a', { class: 'btn', href: `/api/sessions/${id}/export/payments.csv` }, icon('download', 16), 'Download CSV')),
      unfinished ? h('div', { class: 'alert warn' }, icon('warn', 16), `${unfinished} participant${unfinished > 1 ? 's have' : ' has'} not finished. Their amounts below are provisional.`) : null,
      h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', null, h('tr', null, ['#', 'Code', 'ID / label', exp.design.treatments.length ? 'Treatment' : null, 'Finished', 'Points', 'Earnings', 'Fee', 'Total'].filter(Boolean).map((x, i) => h('th', { class: i >= 5 ? 'num' : '' }, x)))),
        h('tbody', null, payments.rows.map((r) => h('tr', null,
          h('td', { class: 'num' }, String(r.participant_id)), h('td', null, h('code', null, r.participant_code)),
          h('td', null, r.label || '–', r.is_bot ? h('span', null, ' ', badge('bot')) : null),
          exp.design.treatments.length ? h('td', null, r.treatment) : null,
          h('td', null, r.finished ? badge('yes', 'success') : badge('no')),
          h('td', { class: 'num' }, String(r.points)), h('td', { class: 'num' }, money(r.earnings)), h('td', { class: 'num' }, money(r.participation_fee)), h('td', { class: 'num', style: { fontWeight: 700 } }, money(r.total_payment))))),
        h('tfoot', null, h('tr', null, h('td', { colspan: exp.design.treatments.length ? 8 : 7, style: { textAlign: 'right', fontWeight: 600 } }, 'Total to pay out'), h('td', { class: 'num', style: { fontWeight: 700 } }, money(total)))))));
  }

  // ---- problems ----------------------------------------------------------------------------
  function renderProblems() {
    const errs = S.s.errors;
    return errs.length
      ? h('div', { class: 'stack' },
        h('div', { class: 'alert warn' }, icon('warn', 16), 'These formula errors happened while running the session. Participants kept going with empty values, but the data may be incomplete. Fix the formula in the experiment and run a new session.'),
        h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
          h('thead', null, h('tr', null, ['Where', 'Problem', 'Times', 'Last'].map((x) => h('th', null, x)))),
          h('tbody', null, errs.map((e) => h('tr', null, h('td', { class: 'wrap' }, e.where), h('td', { class: 'wrap' }, e.message), h('td', { class: 'num' }, String(e.count)), h('td', null, relTime(e.last))))))))
      : h('div', { class: 'card empty' }, icon('check', 28), h('h3', null, 'No problems'), h('p', null, 'No formula errors have occurred in this session.'));
  }

  // ---- mount --------------------------------------------------------------------------------
  mount(host, h('div', { class: 'page' }, headEl, statsEl, shareEl, tabsEl, content));
  paintTop();
  if (S.tab === 'data' || S.tab === 'payments') { paintTabs(); mount(content, h('p', { class: 'muted' }, 'Loading…')); reloadData.flush(); } else drawTab();
  return {
    destroy() {
      destroyed = true;
      events?.close();
      clearInterval(pollTimer);
      clearInterval(ageTimer);
    },
  };
}
