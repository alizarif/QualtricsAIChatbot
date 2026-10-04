// Researcher app: routing, login and the experiments dashboard.

import {
  h, mount, icon, toast, confirmDialog, relTime,
} from './dom.js';
import { get, post, del, setUnauthorizedHandler } from './api.js';
import { badge, menuButton } from './ui.js';
import { renderEditor } from './editor.js';
import { renderSession } from './session.js';
import { renderDocs } from './docs.js';

const root = document.getElementById('app');
const state = { auth: { required: false, authenticated: true }, view: null };

export function navigate(hash) {
  if (location.hash === hash) route(); else location.hash = hash;
}

// ---- layout ------------------------------------------------------------------

function layout(active) {
  const main = h('div', { id: 'view' });
  mount(root,
    h('header', { class: 'topbar' },
      h('a', { class: 'brand', href: '#/' }, h('span', { class: 'brand-mark' }, icon('flask', 18)), 'EconLab'),
      h('nav', { class: 'nav', 'aria-label': 'Main' },
        h('a', { href: '#/', 'aria-current': active === 'home' ? 'page' : undefined }, 'Experiments'),
        h('a', { href: '#/docs', 'aria-current': active === 'docs' ? 'page' : undefined }, 'Docs')),
      state.auth.required ? h('button', { class: 'btn btn-ghost btn-sm right', type: 'button', onclick: async () => { await post('/api/logout'); showLogin(); } }, icon('logout', 16), 'Sign out') : null),
    main);
  return main;
}

function showLogin(message) {
  state.view?.destroy?.();
  state.view = null;
  const pw = h('input', { type: 'password', autocomplete: 'current-password', 'aria-label': 'Admin password', autofocus: true });
  const err = h('div', { class: 'field-error', role: 'alert' }, message ?? '');
  mount(root, h('div', { class: 'login' },
    h('div', { class: 'card' },
      h('div', { class: 'row', style: { marginBottom: '12px' } }, h('span', { class: 'brand-mark' }, icon('flask', 18)), h('h2', { style: { margin: 0 } }, 'EconLab')),
      h('p', { class: 'muted' }, 'Sign in to design and run experiments.'),
      h('form', {
        class: 'stack',
        onsubmit: async (e) => {
          e.preventDefault();
          try { await post('/api/login', { password: pw.value }); state.auth.authenticated = true; route(); } catch (x) { err.textContent = x.message; pw.select(); }
        },
      }, h('label', { class: 'field' }, 'Password', pw), err, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Sign in')))));
}

// ---- dashboard ---------------------------------------------------------------

async function dashboard(host) {
  mount(host, h('div', { class: 'page' }, h('p', { class: 'muted' }, 'Loading…')));
  const [{ experiments }, { sessions }, { examples }] = await Promise.all([get('/api/experiments'), get('/api/sessions'), get('/api/examples')]);

  const create = async (body) => {
    try {
      const res = await post('/api/experiments', body);
      navigate(`#/experiments/${res.experiment.id}`);
    } catch (e) { toast(e.message, 'danger', 6000); }
  };
  const fileInput = h('input', {
    type: 'file', accept: '.json,application/json', class: 'hidden',
    onchange: async () => {
      const f = fileInput.files[0];
      if (!f) return;
      try { await create({ experiment: JSON.parse(await f.text()) }); } catch (e) { toast(`Could not read that file: ${e.message}`, 'danger', 6000); }
      fileInput.value = '';
    },
  });

  const expCard = (e) => h('div', { class: 'card exp-card' },
    h('h3', null, h('a', { href: `#/experiments/${e.id}`, style: { color: 'inherit', textDecoration: 'none' } }, e.name)),
    e.description ? h('p', null, e.description) : h('p', { class: 'muted' }, 'No description'),
    h('div', { class: 'meta' },
      badge(e.groupSize === 1 ? 'Individual' : `${e.groupSize} per group`), badge(`${e.rounds} round${e.rounds > 1 ? 's' : ''}`), badge(`${e.numStages} stages`),
      e.numSessions ? badge(`${e.numSessions} session${e.numSessions > 1 ? 's' : ''}`, 'primary') : null),
    h('div', { class: 'actions' },
      h('a', { class: 'btn btn-primary btn-sm', href: `#/experiments/${e.id}` }, icon('edit', 14), 'Edit'),
      h('a', { class: 'btn btn-sm', href: `#/experiments/${e.id}/sessions` }, icon('play', 14), 'Run'),
      h('span', { class: 'muted small right' }, relTime(e.updatedAt)),
      menuButton('', [
        { label: 'Duplicate', icon: 'dup', onClick: async () => { const r = await post(`/api/experiments/${e.id}/duplicate`); toast('Duplicated'); navigate(`#/experiments/${r.experiment.id}`); } },
        { label: 'Delete…', icon: 'trash', danger: true, onClick: async () => { if (await confirmDialog('Delete experiment?', `“${e.name}” will be removed. Existing sessions keep their data.`, { confirmLabel: 'Delete', danger: true })) { await del(`/api/experiments/${e.id}`); dashboard(host); } } },
      ], { cls: 'icon-btn', iconName: 'more' })));

  const exampleCard = (x) => h('div', { class: 'card example-card' },
    h('h3', null, x.name), h('p', null, x.summary),
    h('div', { class: 'row tight' }, x.tags.map((t) => badge(t))),
    h('button', { class: 'btn btn-sm', type: 'button', style: { alignSelf: 'flex-start', marginTop: 'auto' }, onclick: () => create({ example: x.key }) }, icon('plus', 14), 'Use this example'));

  mount(host, h('div', { class: 'page' },
    h('div', { class: 'page-head' },
      h('div', { class: 'grow' }, h('h1', null, 'Experiments'), h('p', { class: 'muted', style: { margin: 0 } }, 'Design an experiment, share links with participants, watch it run, export the data.')),
      h('div', { class: 'row tight' },
        h('button', { class: 'btn', type: 'button', onclick: () => fileInput.click() }, icon('download', 16), 'Import JSON'),
        h('button', { class: 'btn btn-primary', type: 'button', onclick: () => create({}) }, icon('plus', 16), 'New experiment'),
        fileInput)),
    experiments.length
      ? h('div', { class: 'grid cards' }, experiments.map(expCard))
      : h('div', { class: 'card empty' }, h('h3', null, 'Welcome to EconLab'),
        h('p', null, 'Create an experiment from scratch, or start from one of the classic designs below and adapt it.'),
        h('div', { class: 'row', style: { justifyContent: 'center' } },
          h('button', { class: 'btn btn-primary', type: 'button', onclick: () => create({}) }, icon('plus', 16), 'New experiment'),
          h('a', { class: 'btn', href: '#/docs' }, 'Read the docs'))),
    h('h2', { style: { margin: '36px 0 12px' } }, 'Start from an example'),
    h('div', { class: 'grid cards' }, examples.map(exampleCard)),
    sessions.length ? h('div', null,
      h('h2', { style: { margin: '36px 0 12px' } }, 'Recent sessions'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', null, h('tr', null, ['Session', 'Experiment', 'Status', 'Participants', 'Created'].map((x) => h('th', null, x)))),
        h('tbody', null, sessions.slice(0, 8).map((s) => h('tr', null,
          h('td', null, h('a', { href: `#/sessions/${s.id}` }, s.name), s.errors ? h('span', null, ' ', badge(`${s.errors} problem${s.errors > 1 ? 's' : ''}`, 'danger')) : null),
          h('td', null, s.experimentName),
          h('td', null, badge(s.status, s.status === 'finished' ? 'success' : s.status === 'running' ? 'primary' : '')),
          h('td', null, `${s.joined} joined · ${s.done}/${s.numParticipants} finished`),
          h('td', null, relTime(s.createdAt)))))))) : null));
}

// ---- router ---------------------------------------------------------------------

async function route() {
  if (state.auth.required && !state.auth.authenticated) { showLogin(); return; }
  const hash = location.hash || '#/';
  await state.view?.destroy?.();
  state.view = null;
  let m;
  try {
    if ((m = /^#\/experiments\/([\w-]+)(?:\/(\w+))?$/.exec(hash))) {
      const host = layout('home');
      state.view = await renderEditor(host, m[1], m[2], navigate);
    } else if ((m = /^#\/sessions\/([\w-]+)(?:\/(\w+))?$/.exec(hash))) {
      const host = layout('home');
      state.view = await renderSession(host, m[1], m[2], navigate);
    } else if (/^#\/docs/.test(hash)) {
      const host = layout('docs');
      state.view = await renderDocs(host);
    } else {
      const host = layout('home');
      state.view = await dashboard(host);
    }
  } catch (e) {
    if (e.status === 401) return;
    const host = layout('home');
    mount(host, h('div', { class: 'page' }, h('div', { class: 'card empty' }, h('h3', null, e.status === 404 ? 'Not found' : 'Something went wrong'), h('p', null, e.message), h('a', { class: 'btn', href: '#/' }, 'Back to experiments'))));
  }
  if (!/#\/docs\//.test(hash)) window.scrollTo(0, 0);
}

setUnauthorizedHandler(() => { state.auth.authenticated = false; showLogin('Your session expired. Please sign in again.'); });
window.addEventListener('hashchange', route);
(async () => {
  try { state.auth = await get('/api/auth'); } catch { /* server down: show errors via route */ }
  route();
})();
