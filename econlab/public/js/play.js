// Participant interface.
import { h, mount, icon } from './dom.js';
import { renderMarkdown } from './markdown.js';
import { api, ApiError } from './api.js';

const root = document.getElementById('app');
const parts = location.pathname.split('/').filter(Boolean);
const query = Object.fromEntries(new URLSearchParams(location.search));

let code = null;
let view = null;
let signature = '';
let loading = false;
let loadAgain = false;
let events = null;
let pollTimer = null;
let timerTimer = null;
let clockOffset = 0; // server time - client time
let connectionLost = false;
let lastExpiredLoad = 0;
const formState = { key: null, values: {}, errors: {}, formErrors: [], submitting: false };

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function fatal(title, message) {
  stopEverything();
  mount(root, h('main', { class: 'play-main' }, h('div', { class: 'play-card center' }, h('h1', null, title), h('p', { class: 'muted' }, message))));
}

async function boot() {
  if (parts[0] === 'play' && parts[1]) {
    code = parts[1];
  } else if (parts[0] === 'join' && parts[1]) {
    const scode = parts[1];
    const key = `econlab:seat:${scode}`;
    try { code = localStorage.getItem(key); } catch { /* storage blocked */ }
    if (code) {
      try { await api('GET', `/api/play/${encodeURIComponent(code)}`); } catch (e) { if (e.status === 404) code = null; }
    }
    if (!code) {
      try {
        const info = await api('GET', `/api/join/${encodeURIComponent(scode)}`);
        if (info.full) return fatal('This session is full', 'All places have been taken. Please contact the experimenter.');
        if (!info.open) return fatal('This session is closed', 'It is not accepting new participants.');
        const res = await api('POST', `/api/join/${encodeURIComponent(scode)}`, { params: query });
        code = res.code;
        try { localStorage.setItem(key, code); } catch { /* ignore */ }
      } catch (e) {
        return fatal('Cannot join', e.message);
      }
    }
    history.replaceState(null, '', `/play/${code}${location.search}`);
  } else {
    return fatal('Invalid link', 'Please use the link you received from the experimenter.');
  }
  connectEvents();
  await load();
}

// ---------------------------------------------------------------------------
// Data flow: server-sent events with a polling safety net
// ---------------------------------------------------------------------------

function connectEvents() {
  if (!('EventSource' in window)) { schedulePoll(); return; }
  events = new EventSource(`/api/play/${encodeURIComponent(code)}/events`);
  events.addEventListener('update', () => load());
  events.addEventListener('gone', () => fatal('Session ended', 'This session has been removed by the experimenter.'));
  events.addEventListener('open', () => { setConnection(true); });
  events.addEventListener('error', () => { setConnection(false); });
  schedulePoll();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
}

function schedulePoll() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => load(), events && events.readyState === 1 ? 20000 : 4000);
}

function stopEverything() {
  events?.close();
  clearInterval(pollTimer);
  clearInterval(timerTimer);
}

function setConnection(ok) {
  if (ok === !connectionLost) return;
  connectionLost = !ok;
  document.querySelector('.connection-lost')?.remove();
  if (connectionLost) document.body.appendChild(h('div', { class: 'connection-lost', role: 'status' }, 'Connection lost – reconnecting…'));
  schedulePoll();
}

async function load() {
  if (loading) { loadAgain = true; return; }
  loading = true;
  try {
    const qs = location.search;
    const v = await api('GET', `/api/play/${encodeURIComponent(code)}${qs}`);
    clockOffset = v.now - Date.now();
    setConnection(true);
    show(v);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) fatal('Invalid link', 'This participant link is not valid or the session was deleted.');
    else if (e instanceof ApiError && e.status === 0) setConnection(false);
  } finally {
    loading = false;
    if (loadAgain) { loadAgain = false; load(); }
  }
}

function signatureOf(v) {
  return [v.status, v.key, v.round, v.arrived, v.total, v.stage?.title, v.message?.length].join('|');
}

function show(v) {
  view = v;
  const sig = signatureOf(v);
  if (sig === signature) { updateTimer(); return; }
  signature = sig;
  document.title = v.experiment || 'Experiment';
  if (v.status === 'active' && formState.key !== v.key) {
    Object.assign(formState, { key: v.key, values: {}, errors: {}, formErrors: [], submitting: false });
  }
  render();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function header(v) {
  const showRound = v.rounds > 1 && v.round;
  return [
    h('header', { class: 'play-header' },
      h('span', { class: 'exp-name' }, v.experiment),
      h('div', { class: 'pill' },
        v.role ? h('span', { class: 'badge primary' }, `Your role: ${v.role}`) : null,
        showRound ? h('span', { class: 'badge' }, `Round ${v.round} of ${v.rounds}`) : null,
        h('span', { class: 'timer hidden', id: 'timer', role: 'timer' }))),
    showRound ? h('div', { class: 'round-progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': v.rounds, 'aria-valuenow': v.round - 1 },
      h('div', { style: { width: `${((v.round - 1) / v.rounds) * 100}%` } })) : null,
  ];
}

function render() {
  const v = view;
  clearInterval(timerTimer);
  let body;
  if (v.status === 'lobby') body = renderLobby(v);
  else if (v.status === 'waiting') body = renderWaiting(v);
  else if (v.status === 'active') body = renderActive(v);
  else body = renderDone(v);
  mount(root, header(v), h('main', { class: 'play-main', id: 'main' }, body));
  if (v.status === 'active') {
    updateTimer();
    timerTimer = setInterval(updateTimer, 250);
    const first = root.querySelector('input:not([type=hidden]), select, textarea');
    first?.focus({ preventScroll: true });
  }
}

function renderLobby(v) {
  return h('div', { class: 'play-card center' },
    h('div', { class: 'spinner', 'aria-hidden': 'true' }),
    h('h1', null, 'Welcome'),
    h('p', { class: 'muted' }, 'You are connected. The experiment will begin as soon as the experimenter starts the session. Please keep this page open.'),
    v.message ? h('div', { class: 'md', html: renderMarkdown(v.message) }) : null,
    v.participant.label ? h('p', { class: 'small muted' }, `Your ID: ${v.participant.label}`) : null);
}

function renderWaiting(v) {
  return h('div', { class: 'play-card center', 'aria-live': 'polite' },
    h('div', { class: 'spinner', 'aria-hidden': 'true' }),
    h('h1', null, v.title || 'Please wait'),
    v.message ? h('div', { class: 'md', html: renderMarkdown(v.message) }) : null,
    v.total && v.total > 1 ? h('span', { class: 'count-pill' }, `${v.arrived} of ${v.total} ready`) : null);
}

function renderDone(v) {
  const p = v.payment;
  const line = (l, r, cls = '') => h('div', { class: `line ${cls}` }, h('span', null, l), h('span', null, r));
  return h('div', { class: 'play-card' },
    h('h1', null, 'Thank you – you have finished!'),
    v.message ? h('div', { class: 'md', html: renderMarkdown(v.message) }) : null,
    h('div', { class: 'earnings' },
      line(p.mode === 'random_round' ? `Points in round ${p.paidRound} (randomly selected)` : p.mode === 'last_round' ? 'Points in the final round' : 'Total points', p.points),
      p.showRate ? line('Exchange rate', p.rate) : null,
      line('Earnings from the experiment', p.earnings),
      p.fee ? line('Participation fee', p.fee) : null,
      line('Total payment', p.total, 'total')),
    p.perRound.length > 1 ? h('details', null,
      h('summary', { class: 'muted' }, 'Points per round'),
      h('div', { class: 'round-chips' }, p.perRound.map((r) => h('span', { class: `badge${p.mode === 'random_round' && r.round === p.paidRound ? ' primary' : ''}` }, `R${r.round}: ${r.points}`)))) : null,
    v.completionUrl ? h('div', { class: 'submit-row' }, h('a', { class: 'btn btn-primary btn-lg', href: v.completionUrl }, 'Continue')) : null);
}

// ---- decision pages --------------------------------------------------------

function boundsHint(f) {
  const n = (x) => String(Math.round(x * 1e6) / 1e6);
  if (f.min !== null && f.max !== null) return `Enter a number between ${n(f.min)} and ${n(f.max)}.`;
  if (f.min !== null) return `Enter a number of at least ${n(f.min)}.`;
  if (f.max !== null) return `Enter a number of at most ${n(f.max)}.`;
  return '';
}

function fieldControl(f) {
  const id = `f_${f.name}`;
  const errId = `${id}_err`;
  const saved = formState.values[f.name];
  const set = (v) => { formState.values[f.name] = v; };
  let input;
  let get;
  let control;
  const labelEl = h('label', { class: 'q-label', for: id }, f.label, f.required ? null : h('span', { class: 'muted small' }, ' (optional)'));
  let noLabel = false;

  switch (f.type) {
    case 'integer': case 'number': {
      input = h('input', {
        type: 'number', id, name: f.name, inputmode: f.type === 'integer' && (f.min ?? 0) >= 0 ? 'numeric' : 'decimal',
        step: f.type === 'integer' ? 1 : (f.step ?? 'any'), min: f.min ?? undefined, max: f.max ?? undefined,
        value: saved ?? '', 'aria-describedby': errId, autocomplete: 'off',
        oninput: (e) => set(e.target.value),
      });
      get = () => input.value;
      control = [h('div', { class: 'input-row' }, input, f.suffix ? h('span', { class: 'suffix' }, f.suffix) : null), boundsHint(f) ? h('div', { class: 'bounds' }, boundsHint(f)) : null];
      break;
    }
    case 'slider': {
      const min = f.min ?? 0; const max = f.max ?? 100;
      const start = saved ?? Math.min(max, Math.max(min, f.default ?? (min + max) / 2));
      const out = h('output', { class: 'slider-value', for: id }, String(start));
      input = h('input', {
        type: 'range', id, name: f.name, min, max, step: f.step ?? 1, value: start, 'aria-describedby': errId,
        oninput: (e) => { out.textContent = e.target.value; set(e.target.value); },
      });
      set(String(start));
      get = () => input.value;
      control = [h('div', { class: 'slider-wrap' }, h('span', { class: 'muted' }, f.minLabel || String(min)), input, h('span', { class: 'muted' }, f.maxLabel || String(max)), out, f.suffix ? h('span', { class: 'suffix' }, f.suffix) : null)];
      break;
    }
    case 'text':
      input = h('input', { type: 'text', id, name: f.name, value: saved ?? '', maxlength: 5000, 'aria-describedby': errId, oninput: (e) => set(e.target.value), autocomplete: 'off' });
      get = () => input.value;
      control = [input];
      break;
    case 'textarea':
      input = h('textarea', { id, name: f.name, rows: 4, maxlength: 5000, 'aria-describedby': errId, oninput: (e) => set(e.target.value) }, saved ?? '');
      get = () => input.value;
      control = [input];
      break;
    case 'checkbox': {
      noLabel = true;
      input = h('input', { type: 'checkbox', id, name: f.name, checked: saved === true, 'aria-describedby': errId, onchange: (e) => set(e.target.checked) });
      get = () => input.checked;
      control = [h('label', { class: 'choice', for: id }, input, h('span', null, f.label))];
      break;
    }
    case 'choice': {
      if (f.layout === 'dropdown') {
        input = h('select', { id, name: f.name, 'aria-describedby': errId, onchange: (e) => set(e.target.value) },
          h('option', { value: '' }, 'Choose…'),
          f.options.map((o) => h('option', { value: String(o.value), selected: saved !== undefined && String(saved) === String(o.value) }, o.label)));
        get = () => input.value;
        control = [input];
      } else {
        const radios = f.options.map((o, i) => h('label', { class: 'choice' },
          h('input', { type: 'radio', name: f.name, value: String(o.value), id: i === 0 ? id : undefined, checked: saved !== undefined && String(saved) === String(o.value), onchange: () => set(String(o.value)) }),
          h('span', null, o.label)));
        input = radios[0]?.querySelector('input');
        get = () => root.querySelector(`input[name="${CSS.escape(f.name)}"]:checked`)?.value ?? '';
        control = [h('div', { class: 'choices', role: 'radiogroup', 'aria-labelledby': `${id}_lbl` }, radios)];
      }
      break;
    }
    case 'likert': {
      const lo = f.min ?? 1; const hi = f.max ?? 5;
      const items = [];
      for (let n = lo; n <= hi; n++) {
        items.push(h('label', { class: 'choice' },
          h('input', { type: 'radio', name: f.name, value: String(n), checked: saved !== undefined && String(saved) === String(n), onchange: () => set(String(n)) }),
          h('span', null, String(n))));
      }
      input = items[0]?.querySelector('input');
      get = () => root.querySelector(`input[name="${CSS.escape(f.name)}"]:checked`)?.value ?? '';
      control = [h('div', { class: 'likert', role: 'radiogroup', 'aria-labelledby': `${id}_lbl` }, items),
        (f.minLabel || f.maxLabel) ? h('div', { class: 'likert-ends' }, h('span', null, f.minLabel), h('span', null, f.maxLabel)) : null];
      break;
    }
    default:
      get = () => '';
      control = [];
  }

  if (!noLabel) labelEl.id = `${id}_lbl`;
  const err = formState.errors[f.name];
  const wrap = h('div', { class: `q${err ? ' has-error' : ''}` },
    noLabel ? null : labelEl,
    control,
    f.help ? h('div', { class: 'help' }, f.help) : null,
    h('div', { class: 'field-error', id: errId, role: 'alert' }, err ?? ''));
  return { el: wrap, get, name: f.name };
}

function renderActive(v) {
  const s = v.stage;
  const controls = s.fields.map(fieldControl);
  const formErr = h('div', { class: `form-error${formState.formErrors.length ? '' : ' hidden'}`, role: 'alert' }, formState.formErrors.join(' '));
  const btn = h('button', { class: 'btn btn-primary btn-lg', type: 'submit', disabled: formState.submitting }, s.buttonLabel);
  const form = h('form', {
    novalidate: true,
    onsubmit: async (e) => {
      e.preventDefault();
      if (formState.submitting) return;
      const values = {};
      for (const c of controls) values[c.name] = c.get();
      formState.submitting = true;
      btn.disabled = true;
      formState.errors = {};
      formState.formErrors = [];
      try {
        const res = await api('POST', `/api/play/${encodeURIComponent(code)}/submit`, { values, key: v.key });
        clockOffset = res.view.now - Date.now();
        show(res.view);
      } catch (err) {
        formState.submitting = false;
        if (err.status === 422) {
          formState.errors = err.data.errors ?? {};
          formState.formErrors = err.data.formErrors ?? [];
          signature = '';
          render();
          const first = root.querySelector('.q.has-error input, .q.has-error select, .q.has-error textarea') ?? root.querySelector('.form-error:not(.hidden)');
          first?.focus?.();
          first?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
        } else if (err.status === 409 && err.data?.view) {
          show(err.data.view);
        } else {
          btn.disabled = false;
          formErr.textContent = err.message;
          formErr.classList.remove('hidden');
        }
      }
    },
  },
  controls.map((c) => c.el),
  formErr,
  h('div', { class: 'submit-row' }, btn, v.timeout ? h('span', { class: 'muted small' }, `You have ${formatSeconds(v.timeout.seconds)} for this page.`) : null));

  return h('div', { class: 'play-card' },
    s.title ? h('h1', null, s.title) : null,
    s.body ? h('div', { class: 'md', html: renderMarkdown(s.body) }) : null,
    form);
}

const formatSeconds = (s) => (s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} min` : `${s} seconds`);

function updateTimer() {
  const el = document.getElementById('timer');
  if (!el) return;
  const t = view?.status === 'active' ? view.timeout : null;
  if (!t || !t.deadline) { el.classList.add('hidden'); return; }
  const left = Math.max(0, Math.ceil((t.deadline - (Date.now() + clockOffset)) / 1000));
  el.classList.remove('hidden');
  el.classList.toggle('low', left <= 10);
  mount(el, icon('clock', 14), left > 0 ? ` ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : ' Time is up');
  if (left === 0 && Date.now() - lastExpiredLoad > 1000) { lastExpiredLoad = Date.now(); load(); } // the server submits the page for us
}

boot();
