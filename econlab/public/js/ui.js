// Form widgets used by the researcher app. Inputs are bound directly to plain
// objects: typing mutates the object and calls onChange(); nothing re-renders
// while typing, so focus and cursor position are never lost.

import { h, icon, mount } from './dom.js';
import { check, FUNCTIONS } from '/shared/expr.js';

export const badge = (text, kind = '') => h('span', { class: `badge ${kind}` }, text);

export function labeled(label, control, hint, extra = {}) {
  return h('label', { class: 'field', ...extra }, label, control, hint ? h('span', { class: 'hint' }, hint) : null);
}

export function textInput(obj, key, { onChange, placeholder, type = 'text', maxlength, mono, ...rest } = {}) {
  return h('input', {
    type, value: obj[key] ?? '', placeholder, maxlength, class: mono ? 'expr' : undefined, ...rest,
    oninput: (e) => { obj[key] = e.target.value; onChange?.(e.target.value); },
  });
}

export function numberInput(obj, key, { onChange, min, max, step, int, placeholder, nullable } = {}) {
  return h('input', {
    type: 'number', value: obj[key] ?? '', min, max, step: step ?? (int ? 1 : 'any'), placeholder,
    oninput: (e) => {
      const raw = e.target.value;
      if (raw === '') { obj[key] = nullable ? null : 0; } else {
        const n = Number(raw);
        if (Number.isFinite(n)) obj[key] = n;
      }
      onChange?.(obj[key]);
    },
  });
}

export function textArea(obj, key, { onChange, rows = 4, placeholder, mono, className = '' } = {}) {
  return h('textarea', {
    rows, placeholder, class: `${mono ? 'expr ' : ''}${className}`.trim() || undefined,
    oninput: (e) => { obj[key] = e.target.value; onChange?.(e.target.value); },
  }, obj[key] ?? '');
}

export function selectInput(obj, key, options, { onChange } = {}) {
  return h('select', { value: obj[key], onchange: (e) => { obj[key] = e.target.value; onChange?.(e.target.value); } },
    options.map((o) => h('option', { value: o.value, selected: String(o.value) === String(obj[key]) }, o.label)));
}

export function checkbox(obj, key, label, { onChange, hint } = {}) {
  return h('label', { class: 'check' },
    h('input', { type: 'checkbox', checked: Boolean(obj[key]), onchange: (e) => { obj[key] = e.target.checked; onChange?.(e.target.checked); } }),
    h('span', null, label, hint ? h('span', { class: 'hint', style: { display: 'block', fontWeight: 400 } }, hint) : null));
}

// ---- popovers ----------------------------------------------------------------

let openMenu = null;
function closeMenu() {
  if (!openMenu) return;
  openMenu.el.remove();
  document.removeEventListener('mousedown', openMenu.onDoc, true);
  document.removeEventListener('keydown', openMenu.onKey, true);
  openMenu = null;
}

/** Show a floating menu below `anchor`. build(close) returns the menu's children. */
export function popover(anchor, build, { align = 'left' } = {}) {
  closeMenu();
  const el = h('div', { class: 'menu', role: 'menu' });
  const close = () => closeMenu();
  el.append(...[].concat(build(close)).filter(Boolean));
  document.body.appendChild(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  let left = align === 'right' ? r.right - w : r.left;
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
  let top = r.bottom + 6 + window.scrollY;
  if (r.bottom + el.offsetHeight + 12 > window.innerHeight && r.top > el.offsetHeight + 12) top = r.top - el.offsetHeight - 6 + window.scrollY;
  el.style.left = `${left + window.scrollX}px`;
  el.style.top = `${top}px`;
  const onDoc = (e) => { if (!el.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) closeMenu(); };
  const onKey = (e) => { if (e.key === 'Escape') { closeMenu(); anchor.focus?.(); } };
  document.addEventListener('mousedown', onDoc, true);
  document.addEventListener('keydown', onKey, true);
  openMenu = { el, onDoc, onKey };
  el.querySelector('button, a')?.focus();
  return close;
}

export function menuButton(label, items, { cls = 'btn', align = 'right', iconName } = {}) {
  const btn = h('button', { class: cls, type: 'button', 'aria-haspopup': 'menu' }, iconName ? icon(iconName, 16) : null, label);
  btn.addEventListener('click', () => popover(btn, (close) => items.map((it) => {
    if (it.title) return h('div', { class: 'menu-title' }, it.title);
    if (it.separator) return h('hr', { style: { margin: '4px 0' } });
    return h('button', { type: 'button', class: it.danger ? 'danger' : undefined, onclick: () => { close(); it.onClick(); } },
      it.icon ? icon(it.icon, 16) : null, h('span', null, it.label, it.hint ? h('small', null, it.hint) : null));
  }), { align }));
  return btn;
}

// ---- expression input with live validation and insert menu -------------------

export function insertAtCursor(el, text, { cursorOffset } = {}) {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  el.value = el.value.slice(0, start) + text + el.value.slice(end);
  const pos = start + (cursorOffset ?? text.length);
  el.focus();
  el.setSelectionRange(pos, pos);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

const KIND_LABEL = {
  field: 'Answers from participants', computed: 'Computed variables', group: 'Group', role: 'Roles', constant: 'Constants',
  session: 'Session', 'built-in': 'Built-in', player: 'Player', history: 'Earlier rounds',
};
const KIND_ORDER = ['field', 'computed', 'constant', 'group', 'role', 'player', 'built-in', 'history', 'session'];

/** Menu listing variables (from getCatalog()) and functions; onPick(text, cursorOffset). */
export function showInsertMenu(anchor, getCatalog, onPick, { template = false } = {}) {
  popover(anchor, (close) => {
    const catalog = getCatalog();
    const items = [];
    const wrap = (s) => (template ? `{{ ${s} }}` : s);
    for (const kind of KIND_ORDER) {
      const group = catalog.filter((c) => c.kind === kind);
      if (!group.length) continue;
      items.push(h('div', { class: 'menu-title' }, KIND_LABEL[kind] ?? kind));
      for (const c of group) {
        items.push(h('button', { type: 'button', onclick: () => { close(); onPick(wrap(c.expr)); } },
          h('span', { class: 'mono' }, c.expr), c.hint ? h('small', null, c.hint) : null));
      }
    }
    items.push(h('div', { class: 'menu-title' }, 'Functions'));
    const fnList = [['if', 'if(condition, then, else)'], ...Object.entries(FUNCTIONS).map(([n, f]) => [n, f[2]])];
    for (const [name, doc] of fnList) {
      items.push(h('button', { type: 'button', onclick: () => {
        close();
        const text = wrap(`${name}()`);
        onPick(text, text.length - (template ? 4 : 1));
      } }, h('span', null, h('span', { class: 'mono' }, `${name}()`), h('small', null, doc.replace(/^[^—]*— ?/, '')))));
    }
    return items;
  });
}

/**
 * Single-line expression editor. Validates syntax as you type and offers an
 * "insert variable" menu. Returns the wrapper element.
 */
export function exprInput(obj, key, { onChange, placeholder, getCatalog, allowEmpty = true, multiline = false } = {}) {
  const input = multiline
    ? h('textarea', { class: 'expr', rows: 2, placeholder, spellcheck: 'false' }, obj[key] ?? '')
    : h('input', { class: 'expr', type: 'text', value: obj[key] ?? '', placeholder, spellcheck: 'false', autocomplete: 'off' });
  const msg = h('div', { class: 'field-error hidden', role: 'alert' });
  const validate = () => {
    const v = input.value;
    let problem = null;
    if (!v.trim()) problem = allowEmpty ? null : { message: 'This cannot be empty' };
    else problem = check(v);
    input.classList.toggle('invalid', Boolean(problem));
    msg.classList.toggle('hidden', !problem);
    msg.textContent = problem ? problem.message : '';
  };
  input.addEventListener('input', () => { obj[key] = input.value; validate(); onChange?.(input.value); });
  validate();
  const insertBtn = getCatalog ? h('button', {
    class: 'icon-btn fx', type: 'button', title: 'Insert variable or function', 'aria-label': 'Insert variable or function',
    onclick: () => showInsertMenu(insertBtn, getCatalog, (text, off) => insertAtCursor(input, text, { cursorOffset: off })),
  }, h('span', { style: { fontFamily: 'var(--mono)', fontWeight: 700 } }, 'ƒ')) : null;
  return h('div', null, h('div', { class: 'row tight', style: { flexWrap: 'nowrap' } }, h('div', { class: 'grow' }, input), insertBtn), msg);
}

/** Key/value table for constants and treatment overrides. */
export function kvEditor(getObj, setObj, { keyPlaceholder = 'name', valuePlaceholder = 'value', onChange } = {}) {
  const parseValue = (s) => {
    const t = s.trim();
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (t !== '' && Number.isFinite(Number(t))) return Number(t);
    return s;
  };
  let rows = Object.entries(getObj()).map(([k, v]) => [k, String(v)]);
  const host = h('div');
  const commit = () => {
    const out = {};
    for (const [k, v] of rows) if (k.trim()) out[k.trim()] = parseValue(v);
    setObj(out);
    onChange?.();
  };
  const draw = () => {
    mount(host, 
      ...rows.map((row, i) => h('div', { class: 'kv-row' },
        h('input', { class: 'expr', value: row[0], placeholder: keyPlaceholder, 'aria-label': 'Name', oninput: (e) => { row[0] = e.target.value; commit(); } }),
        h('input', { value: row[1], placeholder: valuePlaceholder, 'aria-label': 'Value', oninput: (e) => { row[1] = e.target.value; commit(); } }),
        h('button', { class: 'icon-btn danger', type: 'button', 'aria-label': 'Remove', onclick: () => { rows.splice(i, 1); commit(); draw(); } }, icon('trash', 16)))),
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { rows.push(['', '']); draw(); host.querySelector('.kv-row:last-of-type input')?.focus(); } }, icon('plus', 14), 'Add'));
  };
  draw();
  return host;
}
