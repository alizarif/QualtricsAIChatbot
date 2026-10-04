// Tiny DOM toolkit: hyperscript helper, toasts, modal dialogs, clipboard.
// All text goes through textContent, never innerHTML, so researcher- or
// participant-supplied strings cannot inject markup.

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  let value;
  let hasValue = false;
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') { value = v; hasValue = true; }
    else if (k === 'html') el.innerHTML = v; // only ever fed by renderMarkdown()
    else if (['checked', 'disabled', 'selected', 'readOnly', 'required', 'hidden', 'open'].includes(k)) el[k] = Boolean(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  if (hasValue) el.value = value;
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

export const $ = (sel, root = document) => root.querySelector(sel);

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

export function mount(el, ...children) { clear(el); append(el, children); return el; }

// ---- icons (inline SVG, stroke = currentColor) -----------------------------

const ICONS = {
  plus: 'M12 5v14M5 12h14',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3',
  up: 'M6 15l6-6 6 6',
  down: 'M6 9l6 6 6-6',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  play: 'M7 4l13 8-13 8z',
  download: 'M12 4v11M7 11l5 5 5-5M5 20h14',
  back: 'M15 6l-6 6 6 6',
  check: 'M5 12l5 5 9-10',
  dup: 'M8 8h11v11H8zM5 16V5h11',
  info: 'M12 8h.01M11 12h1v5h1M12 3a9 9 0 100 18 9 9 0 000-18z',
  warn: 'M12 4l9 16H3zM12 10v4M12 17h.01',
  x: 'M6 6l12 12M18 6L6 18',
  users: 'M16 19v-1a4 4 0 00-4-4H7a4 4 0 00-4 4v1M9.5 10a3 3 0 100-6 3 3 0 000 6M21 19v-1a4 4 0 00-3-3.9M16 4.1a3 3 0 010 5.8',
  text: 'M5 6h14M5 12h14M5 18h9',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  clock: 'M12 7v5l3 2M12 3a9 9 0 100 18 9 9 0 000-18z',
  bolt: 'M13 3L5 14h6l-1 7 8-11h-6z',
  flask: 'M9 3h6M10 3v6l-5 9a2 2 0 002 3h10a2 2 0 002-3l-5-9V3',
  link: 'M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3A4 4 0 0010.9 18.7l1-1',
  logout: 'M15 4h3a2 2 0 012 2v12a2 2 0 01-2 2h-3M10 16l4-4-4-4M14 12H4',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
};

export function icon(name, size = 18) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', ICONS[name] ?? ICONS.info);
  svg.appendChild(path);
  return svg;
}

// ---- toasts ----------------------------------------------------------------

let toastHost;
export function toast(message, kind = 'info', ms = 3500) {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(toastHost);
  }
  const t = h('div', { class: `toast toast-${kind}` }, message);
  toastHost.appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 250); }, ms);
}

// ---- modal -----------------------------------------------------------------

/** Returns a promise resolved with the value passed to close(value). */
export function modal({ title, body, actions = [], wide = false }) {
  return new Promise((resolve) => {
    const previous = document.activeElement;
    const close = (v) => { overlay.remove(); document.removeEventListener('keydown', onKey); previous?.focus?.(); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') close(undefined); };
    const dialog = h('div', { class: `modal${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'modal-head' }, h('h2', null, title), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => close(undefined) }, icon('x'))),
      h('div', { class: 'modal-body' }, typeof body === 'function' ? body(close) : body),
      actions.length ? h('div', { class: 'modal-foot' }, actions.map((a) => h('button', {
        class: `btn ${a.primary ? 'btn-primary' : a.danger ? 'btn-danger' : ''}`,
        onclick: () => (a.onClick ? a.onClick(close) : close(a.value)),
      }, a.label))) : null);
    const overlay = h('div', { class: 'overlay', onmousedown: (e) => { if (e.target === overlay) close(undefined); } }, dialog);
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey);
    (dialog.querySelector('[autofocus], input, textarea, select, .btn-primary') ?? dialog.querySelector('button'))?.focus();
  });
}

export async function confirmDialog(title, message, { confirmLabel = 'Confirm', danger = false } = {}) {
  const ok = await modal({
    title,
    body: h('p', null, message),
    actions: [{ label: 'Cancel', value: false }, { label: confirmLabel, value: true, danger, primary: !danger }],
  });
  return ok === true;
}

// ---- misc ------------------------------------------------------------------

export async function copyText(text, label = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { value: text, style: { position: 'fixed', opacity: '0' } });
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
  }
  toast(label, 'success', 1800);
}

export function relTime(ts) {
  if (!ts) return '–';
  const s = Math.max(0, Math.round((Date.now() - (typeof ts === 'number' ? ts : Date.parse(ts))) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(typeof ts === 'number' ? ts : Date.parse(ts)).toLocaleDateString();
}

export function debounce(fn, ms) {
  let t;
  const wrapped = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  wrapped.flush = (...a) => { clearTimeout(t); fn(...a); };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}
