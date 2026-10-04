// Experiment editor: Stages, Design, Sessions and JSON tabs with autosave.

import {
  h, mount, icon, toast, confirmDialog, modal, debounce,
} from './dom.js';
import { get, put, post, del } from './api.js';
import { renderMarkdown } from './markdown.js';
import {
  badge, labeled, textInput, numberInput, textArea, selectInput, checkbox, exprInput, kvEditor, menuButton,
  showInsertMenu, insertAtCursor,
} from './ui.js';
import {
  normalizeExperiment, normalizeStage, normalizeField, validateExperiment, variableCatalog, formatRate,
} from '/shared/experiment.js';

const STAGE_LABEL = { info: 'Information', decision: 'Decision', wait: 'Wait & compute' };
const STAGE_ICON = { info: 'text', decision: 'edit', wait: 'clock' };
const FIELD_TYPES = [
  { value: 'integer', label: 'Whole number', hint: 'e.g. points to contribute' },
  { value: 'number', label: 'Decimal number', hint: 'e.g. a price or guess' },
  { value: 'slider', label: 'Slider', hint: 'drag to choose a value' },
  { value: 'choice', label: 'Multiple choice', hint: 'radio buttons or dropdown' },
  { value: 'likert', label: 'Likert scale', hint: 'agree / disagree rating' },
  { value: 'checkbox', label: 'Checkbox', hint: 'tick to agree / yes-no' },
  { value: 'text', label: 'Short text', hint: 'one line' },
  { value: 'textarea', label: 'Long text', hint: 'several lines' },
];
const typeLabel = (t) => FIELD_TYPES.find((x) => x.value === t)?.label ?? t;

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^[0-9_]+/, '').slice(0, 24);

export async function renderEditor(host, id, initialTab, navigate) {
  const { experiment } = await get(`/api/experiments/${id}`);
  const S = {
    exp: experiment, tab: ['stages', 'design', 'sessions', 'json'].includes(initialTab) ? initialTab : 'stages',
    sel: 0, issues: [], status: 'saved', saveError: '',
  };
  const catalog = () => variableCatalog(normalizeExperiment(S.exp));
  // generated variable names follow the question text until the researcher edits them
  const autoNames = new WeakMap();

  // ---- save & validate ------------------------------------------------------
  const saveState = h('span', { class: 'save-state', role: 'status' });
  const paintSave = () => {
    saveState.className = `save-state ${S.status === 'saved' ? '' : S.status === 'error' ? 'error' : 'saving'}`;
    mount(saveState, 
      S.status === 'saved' ? icon('check', 14) : null,
      S.status === 'saved' ? 'Saved' : S.status === 'error' ? `Not saved: ${S.saveError}` : 'Saving…',
    );
  };
  const doSave = async () => {
    S.status = 'saving'; paintSave();
    try {
      const res = await put(`/api/experiments/${S.exp.id}`, S.exp);
      S.exp.updatedAt = res.experiment.updatedAt;
      S.status = 'saved';
    } catch (e) { S.status = 'error'; S.saveError = e.message; }
    paintSave();
  };
  const scheduleSave = debounce(doSave, 700);
  const flushSave = async () => { if (S.status !== 'saved') { scheduleSave.cancel(); await doSave(); } };
  const countByLevel = (level) => S.issues.filter((i) => i.level === level).length;
  const tabButtons = {};
  const issuePanelHost = h('div');
  const revalidate = () => {
    S.issues = validateExperiment(normalizeExperiment(S.exp));
    paintTabs();
    paintStageList();
    paintIssuePanel();
  };
  const changed = () => { S.status = 'dirty'; paintSave(); revalidate(); scheduleSave(); };
  const onBeforeUnload = (e) => { if (S.status !== 'saved') { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', onBeforeUnload);

  // ---- header ---------------------------------------------------------------
  const nameInput = h('input', {
    class: 'name-input', value: S.exp.name, 'aria-label': 'Experiment name', maxlength: 120,
    oninput: (e) => { S.exp.name = e.target.value; changed(); },
  });
  const defaultN = () => {
    const d = S.exp.design;
    const base = d.groupSize * Math.max(1, d.treatments.length);
    return d.groupSize === 1 && d.treatments.length <= 1 ? 10 : base * 2;
  };
  const quickTest = async () => {
    await flushSave();
    try {
      const n = defaultN();
      const res = await post(`/api/experiments/${S.exp.id}/sessions`, { numParticipants: n, bots: n, startMode: 'immediate', name: `Test run ${new Date().toLocaleTimeString()}` });
      toast('Test session finished – inspect the data.', 'success');
      navigate(`#/sessions/${res.session.id}/data`);
    } catch (e) { toast(e.message, 'danger', 6000); setTab('stages'); }
  };
  const headerEl = h('div', { class: 'editor-head' },
    h('a', { class: 'btn btn-ghost btn-sm', href: '#/' }, icon('back', 16), 'Experiments'),
    nameInput,
    saveState,
    h('div', { class: 'row tight right' },
      h('button', { class: 'btn', type: 'button', onclick: quickTest, title: 'Runs a complete session with simulated participants (bots)' }, icon('bolt', 16), 'Quick test with bots'),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => setTab('sessions') }, icon('play', 16), 'Run session'),
      menuButton('', [
        { label: 'Duplicate', icon: 'dup', onClick: async () => { await flushSave(); const r = await post(`/api/experiments/${S.exp.id}/duplicate`); navigate(`#/experiments/${r.experiment.id}`); } },
        { label: 'Download JSON', icon: 'download', onClick: downloadJson },
        { separator: true },
        { label: 'Delete experiment…', icon: 'trash', danger: true, onClick: async () => {
          if (await confirmDialog('Delete experiment?', 'The design is removed. Sessions already run from it keep their data.', { confirmLabel: 'Delete', danger: true })) {
            scheduleSave.cancel(); S.status = 'saved';
            await del(`/api/experiments/${S.exp.id}`);
            navigate('#/');
          }
        } },
      ], { cls: 'icon-btn', iconName: 'more' })));

  function downloadJson() {
    const blob = new Blob([JSON.stringify(S.exp, null, 2)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `${slug(S.exp.name) || 'experiment'}.econlab.json` });
    document.body.appendChild(a); a.click(); a.remove();
  }

  // ---- tabs -----------------------------------------------------------------
  const tabsEl = h('div', { class: 'tabs', role: 'tablist' });
  const content = h('div');
  const TABS = [['stages', 'Stages'], ['design', 'Design'], ['sessions', 'Sessions'], ['json', 'JSON']];
  function paintTabs() {
    const errs = countByLevel('error');
    const warns = countByLevel('warning');
    mount(tabsEl, ...TABS.map(([key, label]) => {
      const b = h('button', { class: 'tab', role: 'tab', 'aria-selected': S.tab === key, onclick: () => setTab(key) },
        label,
        key === 'stages' && errs ? badge(`${errs} error${errs > 1 ? 's' : ''}`, 'danger') : key === 'stages' && warns ? badge(`${warns}`, 'warn') : null);
      tabButtons[key] = b;
      return b;
    }));
  }
  function setTab(tab) {
    S.tab = tab;
    history.replaceState(null, '', `#/experiments/${S.exp.id}/${tab}`);
    paintTabs();
    drawTab();
  }
  function drawTab() {
    if (S.tab === 'stages') mount(content, renderStagesTab());
    else if (S.tab === 'design') mount(content, renderDesignTab());
    else if (S.tab === 'sessions') { const el = h('div'); mount(content, el); renderSessionsTab(el); } else mount(content, renderJsonTab());
  }

  // ---- issues ----------------------------------------------------------------
  function paintIssuePanel() {
    const errs = S.issues.filter((i) => i.level === 'error');
    const warns = S.issues.filter((i) => i.level === 'warning');
    if (!S.issues.length) { mount(issuePanelHost); return; }
    const jump = (where) => {
      const m = /^stages\[(\d+)\]/.exec(where);
      if (m) { S.sel = Number(m[1]); if (S.tab !== 'stages') setTab('stages'); else { paintStageList(); paintStageEditor(); } } else if (where.startsWith('design')) setTab('design');
    };
    mount(issuePanelHost, h('details', { class: 'card flat', style: { marginBottom: '16px' }, open: errs.length > 0 },
      h('summary', { style: { cursor: 'pointer', fontWeight: 600 } },
        errs.length ? `${errs.length} problem${errs.length > 1 ? 's' : ''} to fix before you can run a session` : 'No blocking problems',
        warns.length ? ` · ${warns.length} suggestion${warns.length > 1 ? 's' : ''}` : ''),
      h('div', { style: { marginTop: '8px' } }, S.issues.map((i) => h('div', { class: `issue ${i.level}` },
        icon(i.level === 'error' ? 'warn' : 'info', 16),
        h('div', null, i.message, ' ', h('a', { href: '#', class: 'where', onclick: (e) => { e.preventDefault(); jump(i.where); } }, i.where)))))));
  }

  // ===========================================================================
  // STAGES TAB
  // ===========================================================================
  const stageListHost = h('div', { class: 'stage-list' });
  const stageEditorHost = h('div');

  function stageIssues(i) { return S.issues.filter((x) => x.where.startsWith(`stages[${i}]`)); }

  function paintStageList() {
    const d = S.exp.design;
    mount(stageListHost, 
      d.rounds > 1 ? h('div', { class: 'round-marker' }, `↻ these stages repeat in each of ${d.rounds} rounds`) : null,
      ...S.exp.stages.map((s, i) => {
        const errs = stageIssues(i).filter((x) => x.level === 'error').length;
        return h('button', { class: `stage-item${errs ? ' has-error' : ''}`, type: 'button', 'aria-current': S.sel === i, onclick: () => { S.sel = i; paintStageList(); paintStageEditor(); } },
          h('span', { class: 'stage-num' }, String(i + 1)),
          h('span', { class: 'grow' },
            h('div', { class: 't' }, s.title || h('span', { class: 'muted' }, 'Untitled')),
            h('div', { class: 's' },
              badge(STAGE_LABEL[s.type], s.type === 'decision' ? 'primary' : s.type === 'wait' ? 'warn' : ''),
              s.type === 'decision' ? badge(`${s.fields.length} question${s.fields.length === 1 ? '' : 's'}`) : null,
              s.compute?.length ? badge(`${s.compute.length} calc`) : null,
              s.showIf ? badge('conditional') : null,
              s.timeoutSeconds ? badge(`${s.timeoutSeconds}s`) : null,
              errs ? badge(`${errs} error${errs > 1 ? 's' : ''}`, 'danger') : null)));
      }),
      menuButton('Add stage', [
        { title: 'What should participants see?' },
        { label: 'Information page', hint: 'Instructions, rules, results', icon: 'text', onClick: () => addStage('info') },
        { label: 'Decision page', hint: 'Questions and inputs', icon: 'edit', onClick: () => addStage('decision') },
        { label: 'Wait & compute', hint: 'Synchronise the group, then calculate payoffs', icon: 'clock', onClick: () => addStage('wait') },
        { label: 'Results page', hint: 'Show earnings of the round', icon: 'check', onClick: () => addStage('results') },
      ], { cls: 'btn btn-primary', align: 'left', iconName: 'plus' }));
  }

  function addStage(kind) {
    const base = {
      info: { type: 'info', title: 'Instructions', body: 'Write your instructions here. You can use **bold**, lists and {{ expressions }} such as round {{ round }}.' },
      decision: {
        type: 'decision', title: 'Your decision', body: '',
        fields: [{ name: uniqueFieldName('decision'), type: 'integer', label: 'Your question here', min: 0 }],
      },
      wait: { type: 'wait', title: 'Please wait', body: 'Waiting for the other participants…', compute: [{ scope: 'player', name: 'payoff', expr: '' }] },
      results: { type: 'info', title: 'Results', body: 'You earned **{{ player.payoff }} points**.' },
    }[kind];
    const stage = normalizeStage({ ...base, id: undefined });
    for (const f of stage.fields) autoNames.set(f, f.name);
    const at = Math.min(S.sel + 1, S.exp.stages.length);
    S.exp.stages.splice(S.exp.stages.length ? at : 0, 0, stage);
    S.sel = S.exp.stages.length ? at : 0;
    changed(); paintStageEditor();
  }

  function uniqueFieldName(base) {
    const used = new Set(S.exp.stages.flatMap((s) => s.fields.map((f) => f.name)));
    let n = base; let i = 2;
    while (used.has(n)) n = `${base}${i++}`;
    return n;
  }

  function moveStage(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= S.exp.stages.length) return;
    [S.exp.stages[i], S.exp.stages[j]] = [S.exp.stages[j], S.exp.stages[i]];
    S.sel = j; changed(); paintStageEditor();
  }

  function dupStage(i) {
    const copy = structuredClone(S.exp.stages[i]);
    copy.id = undefined;
    copy.title = `${copy.title} (copy)`;
    const used = new Set(S.exp.stages.flatMap((s) => s.fields.map((f) => f.name)));
    for (const f of copy.fields) { let n = f.name; let k = 2; while (used.has(n)) n = `${f.name}${k++}`; f.name = n; used.add(n); }
    S.exp.stages.splice(i + 1, 0, normalizeStage(copy));
    S.sel = i + 1; changed(); paintStageEditor();
  }

  async function removeStage(i) {
    const s = S.exp.stages[i];
    if (!(await confirmDialog('Delete this stage?', `“${s.title || 'Untitled'}” and its questions and calculations will be removed.`, { confirmLabel: 'Delete', danger: true }))) return;
    S.exp.stages.splice(i, 1);
    S.sel = Math.max(0, Math.min(S.sel, S.exp.stages.length - 1));
    changed(); paintStageEditor();
  }

  const section = (title, ...children) => h('div', null, h('div', { class: 'section-title' }, title), ...children);

  function paintStageEditor() {
    const i = S.sel;
    const s = S.exp.stages[i];
    if (!s) {
      mount(stageEditorHost, h('div', { class: 'card empty' }, h('h3', null, 'No stages yet'), h('p', null, 'Add a first stage with “Add stage”.')));
      return;
    }
    const bodyArea = textArea(s, 'body', { rows: 9, onChange: changed });
    const insertBtn = h('button', { class: 'btn btn-sm', type: 'button', onclick: () => showInsertMenu(insertBtn, catalog, (t, off) => insertAtCursor(bodyArea, t, { cursorOffset: off }), { template: true }) }, 'Insert {{ value }}');
    const myIssues = stageIssues(i);

    mount(stageEditorHost, h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        badge(`${i + 1}`, 'primary'), badge(STAGE_LABEL[s.type], s.type === 'decision' ? 'primary' : s.type === 'wait' ? 'warn' : ''),
        h('div', { class: 'row tight right' },
          h('button', { class: 'btn btn-sm', type: 'button', onclick: () => previewStage(s) }, 'Preview'),
          h('button', { class: 'icon-btn', type: 'button', title: 'Move up', 'aria-label': 'Move stage up', disabled: i === 0, onclick: () => moveStage(i, -1) }, icon('up', 16)),
          h('button', { class: 'icon-btn', type: 'button', title: 'Move down', 'aria-label': 'Move stage down', disabled: i === S.exp.stages.length - 1, onclick: () => moveStage(i, 1) }, icon('down', 16)),
          h('button', { class: 'icon-btn', type: 'button', title: 'Duplicate', 'aria-label': 'Duplicate stage', onclick: () => dupStage(i) }, icon('dup', 16)),
          h('button', { class: 'icon-btn danger', type: 'button', title: 'Delete', 'aria-label': 'Delete stage', onclick: () => removeStage(i) }, icon('trash', 16)))),

      labeled('Page title', textInput(s, 'title', { onChange: changed, placeholder: 'e.g. Your decision' })),

      section(s.type === 'wait' ? 'Message while waiting' : 'Page text',
        bodyArea,
        h('div', { class: 'row tight', style: { marginTop: '6px' } }, insertBtn,
          h('span', { class: 'hint' }, 'Markdown: **bold**, *italic*, - lists, | tables |. Values: {{ player.payoff }}'))),

      s.type === 'decision' ? section('Questions', fieldsEditor(s)) : null,
      s.type === 'decision' ? section('Answer checks', checksEditor(s)) : null,

      s.type === 'wait' ? section('Waits for',
        selectInput(s, 'waitFor', [
          { value: 'group', label: 'The other members of the group' },
          { value: 'all', label: 'Everyone in the session' },
        ], { onChange: () => { changed(); paintStageEditor(); } }),
        h('p', { class: 'hint', style: { marginTop: '6px' } }, 'Nobody continues until every member of the set has reached this page. The calculations below then run once, so every player’s data from earlier pages is available.')) : null,

      section(s.type === 'wait' ? 'Calculations (run when everyone has arrived)' : 'Calculations (run when the participant continues)', computeEditor(s)),

      section('Display options',
        h('div', { class: 'form-grid' },
          s.type !== 'wait' ? labeled('Show only if (optional)', exprInput(s, 'showIf', { onChange: changed, getCatalog: catalog, placeholder: "e.g. player.role == 'Proposer'" }), 'Leave empty to show to everyone.') : null,
          s.type !== 'wait' ? labeled('Time limit in seconds (0 = none)', numberInput(s, 'timeoutSeconds', { onChange: changed, int: true, min: 0 }), 'When time runs out the page is submitted with default values.') : null,
          s.type !== 'wait' ? labeled('Button label', textInput(s, 'buttonLabel', { onChange: changed, placeholder: s.type === 'decision' ? 'Submit' : 'Continue' })) : null)),

      myIssues.length ? h('div', { style: { marginTop: '18px' } }, myIssues.map((x) => h('div', { class: `issue ${x.level}` }, icon(x.level === 'error' ? 'warn' : 'info', 16), h('div', null, x.message)))) : null));
  }

  function renderStagesTab() {
    paintStageList();
    paintStageEditor();
    return h('div', null, issuePanelHost, h('div', { class: 'stages-layout' }, stageListHost, stageEditorHost));
  }

  // ---- fields editor --------------------------------------------------------
  function fieldsEditor(stage) {
    const host = h('div');
    const draw = () => {
      mount(host, 
        ...stage.fields.map((f, i) => fieldCard(stage, f, i, draw)),
        menuButton('Add question', FIELD_TYPES.map((t) => ({ label: t.label, hint: t.hint, onClick: () => {
          const f = normalizeField({ type: t.value, name: uniqueFieldName(t.value === 'choice' ? 'choice' : t.value === 'checkbox' ? 'agree' : 'answer'), label: '', options: t.value === 'choice' ? [{ value: 1, label: 'Option A' }, { value: 2, label: 'Option B' }] : [], min: ['integer', 'number', 'slider'].includes(t.value) ? 0 : null, max: t.value === 'slider' ? 100 : null });
          autoNames.set(f, f.name);
          stage.fields.push(f); changed(); draw();
        } })), { cls: 'btn btn-sm', align: 'left', iconName: 'plus' }));
    };
    draw();
    return host;
  }

  function fieldCard(stage, f, i, redraw) {
    const labelArea = textArea(f, 'label', { rows: 2, onChange: (v) => {
      if (!f.name || f.name === autoNames.get(f)) {
        const n = slug(v);
        if (n) { f.name = n; autoNames.set(f, n); nameInput.value = n; }
      }
      changed();
    } });
    const nameInput = textInput(f, 'name', { mono: true, onChange: changed, maxlength: 60 });
    const numeric = ['integer', 'number', 'slider', 'likert'].includes(f.type);
    const move = (dir) => { const j = i + dir; if (j < 0 || j >= stage.fields.length) return; [stage.fields[i], stage.fields[j]] = [stage.fields[j], stage.fields[i]]; changed(); redraw(); };
    return h('details', { class: 'sub-card field-card', open: true },
      h('summary', { style: { cursor: 'pointer', display: 'flex', gap: '8px', alignItems: 'center' } },
        h('span', { class: 'mono' }, f.name || '(unnamed)'), badge(typeLabel(f.type)),
        h('span', { class: 'muted small grow', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, f.label),
        h('span', { class: 'row tight', onclick: (e) => e.stopPropagation() },
          h('button', { class: 'icon-btn', type: 'button', disabled: i === 0, 'aria-label': 'Move question up', onclick: (e) => { e.preventDefault(); move(-1); } }, icon('up', 14)),
          h('button', { class: 'icon-btn', type: 'button', disabled: i === stage.fields.length - 1, 'aria-label': 'Move question down', onclick: (e) => { e.preventDefault(); move(1); } }, icon('down', 14)),
          h('button', { class: 'icon-btn danger', type: 'button', 'aria-label': 'Delete question', onclick: (e) => { e.preventDefault(); stage.fields.splice(i, 1); changed(); redraw(); } }, icon('trash', 14)))),
      h('div', { class: 'stack', style: { marginTop: '12px' } },
        labeled('Question shown to participants', labelArea),
        h('div', { class: 'form-grid' },
          labeled('Variable name', nameInput, `Use as player.${f.name || 'name'} in formulas`),
          labeled('Answer type', selectInput(f, 'type', FIELD_TYPES, { onChange: () => { Object.assign(f, normalizeField({ ...f, min: f.type === 'likert' ? 1 : f.min, max: f.type === 'likert' ? 5 : f.max, options: f.options?.length ? f.options : [{ value: 1, label: 'Option A' }, { value: 2, label: 'Option B' }] })); changed(); redraw(); } })),
          numeric && f.type !== 'likert' ? labeled('Minimum', exprInput(f, 'min', { onChange: changed, getCatalog: catalog, placeholder: 'number or formula' })) : null,
          numeric && f.type !== 'likert' ? labeled('Maximum', exprInput(f, 'max', { onChange: changed, getCatalog: catalog, placeholder: 'number or formula, e.g. const.endowment' })) : null,
          f.type === 'likert' ? labeled('Lowest value', numberInput(f, 'min', { onChange: changed, int: true })) : null,
          f.type === 'likert' ? labeled('Highest value', numberInput(f, 'max', { onChange: changed, int: true })) : null,
          f.type === 'likert' || f.type === 'slider' ? labeled('Label for lowest', textInput(f, 'minLabel', { onChange: changed, placeholder: 'e.g. Strongly disagree' })) : null,
          f.type === 'likert' || f.type === 'slider' ? labeled('Label for highest', textInput(f, 'maxLabel', { onChange: changed, placeholder: 'e.g. Strongly agree' })) : null,
          f.type === 'slider' ? labeled('Step', numberInput(f, 'step', { onChange: changed, nullable: true, placeholder: '1' })) : null,
          f.type === 'number' ? labeled('Step (optional)', numberInput(f, 'step', { onChange: changed, nullable: true })) : null,
          ['integer', 'number', 'slider'].includes(f.type) ? labeled('Unit label', textInput(f, 'suffix', { onChange: changed, placeholder: 'e.g. points' })) : null,
          f.type === 'choice' ? labeled('Layout', selectInput(f, 'layout', [{ value: 'radio', label: 'Radio buttons' }, { value: 'dropdown', label: 'Dropdown' }], { onChange: changed })) : null),
        f.type === 'choice' ? optionsEditor(f, redraw) : null,
        h('div', { class: 'form-grid' },
          numeric ? labeled('Default value (used if time runs out)', exprInput(f, 'default', { onChange: changed, getCatalog: catalog, placeholder: 'optional' }), f.type === 'slider' ? 'Also the starting position of the slider.' : 'Not pre-filled for participants.') : null,
          f.type === 'text' || f.type === 'textarea' ? labeled('Default text (used if time runs out)', textInput(f, 'default', { onChange: changed })) : null,
          f.type === 'checkbox' ? checkbox(f, 'default', 'Ticked by default', { onChange: changed }) : null),
        labeled('Help text (optional)', textInput(f, 'help', { onChange: changed })),
        f.type === 'checkbox'
          ? checkbox(f, 'required', 'Must be ticked to continue (e.g. consent)', { onChange: changed })
          : checkbox(f, 'required', 'Answer required', { onChange: changed })));
  }

  function optionsEditor(f, redraw) {
    const host = h('div');
    const parse = (v) => (v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : v);
    const draw = () => {
      mount(host, 
        h('div', { class: 'section-title', style: { marginTop: '4px' } }, 'Options'),
        ...f.options.map((o, i) => h('div', { class: 'opt-row' },
          h('input', { class: 'expr', value: String(o.value), placeholder: 'value', 'aria-label': 'Option value', oninput: (e) => { o.value = parse(e.target.value); changed(); } }),
          h('input', { value: o.label, placeholder: 'label shown to participants', 'aria-label': 'Option label', oninput: (e) => { o.label = e.target.value; changed(); } }),
          h('button', { class: 'icon-btn danger', type: 'button', 'aria-label': 'Remove option', onclick: () => { f.options.splice(i, 1); changed(); draw(); } }, icon('trash', 14)))),
        h('div', { class: 'row tight' },
          h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { f.options.push({ value: f.options.length + 1, label: '' }); changed(); draw(); } }, icon('plus', 14), 'Add option'),
          h('span', { class: 'hint' }, 'Values that look like numbers are stored as numbers, so you can write player.' + (f.name || 'x') + ' == 1.')));
    };
    draw();
    return host;
  }

  function checksEditor(stage) {
    const host = h('div');
    const draw = () => {
      mount(host, 
        stage.checks.length ? null : h('p', { class: 'hint' }, 'Optional rules that must hold before the page is accepted, e.g. a comprehension question or a constraint across fields.'),
        ...stage.checks.map((c, i) => h('div', { class: 'check-row' },
          exprInput(c, 'expr', { onChange: changed, getCatalog: catalog, allowEmpty: false, placeholder: 'e.g. player.offer + player.keep == 100' }),
          h('input', { value: c.message, placeholder: 'Message if the rule is violated', 'aria-label': 'Message', oninput: (e) => { c.message = e.target.value; changed(); } }),
          h('button', { class: 'icon-btn danger', type: 'button', 'aria-label': 'Remove check', onclick: () => { stage.checks.splice(i, 1); changed(); draw(); } }, icon('trash', 14)))),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { stage.checks.push({ expr: '', message: '' }); changed(); draw(); } }, icon('plus', 14), 'Add check'));
    };
    draw();
    return host;
  }

  function computeEditor(stage) {
    const host = h('div');
    const isWait = stage.type === 'wait';
    const scopes = isWait
      ? [{ value: 'player', label: 'player' }, { value: 'group', label: 'group' }, ...(stage.waitFor === 'all' ? [{ value: 'session', label: 'session' }] : [])]
      : [{ value: 'player', label: 'player' }];
    const draw = () => {
      mount(host, 
        stage.compute.length ? null : h('p', { class: 'hint' }, isWait ? 'Add rows to set payoffs and other results, e.g. player.payoff = const.endowment − player.contribution + group.share.' : 'Optional: compute values for this participant when they press the button (e.g. a random draw or an individual payoff).'),
        ...stage.compute.map((r, i) => h('div', { class: 'compute-row' },
          selectInput(r, 'scope', scopes, { onChange: changed }),
          h('input', { class: 'expr', value: r.name, placeholder: 'variable name', 'aria-label': 'Variable name', oninput: (e) => { r.name = e.target.value; changed(); } }),
          h('span', { class: 'eq' }, '='),
          exprInput(r, 'expr', { onChange: changed, getCatalog: catalog, allowEmpty: false, placeholder: 'formula' }),
          h('button', { class: 'icon-btn danger', type: 'button', 'aria-label': 'Remove row', onclick: () => { stage.compute.splice(i, 1); changed(); draw(); } }, icon('trash', 14)))),
        h('div', { class: 'row tight' },
          h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { stage.compute.push({ scope: 'player', name: stage.compute.length ? '' : 'payoff', expr: '' }); changed(); draw(); } }, icon('plus', 14), 'Add row'),
          stage.compute.length ? h('span', { class: 'hint' }, 'Rows run top to bottom; a player row runs once for every player. Set player.payoff to give points.') : null));
    };
    draw();
    return host;
  }

  // ---- participant-style preview ---------------------------------------------
  function previewStage(s) {
    const md = (t) => h('div', { class: 'md', html: renderMarkdown(t, { chips: true }) });
    const ctl = (f) => {
      const hintBounds = (f.min !== null && f.min !== '' && f.min !== undefined) || (f.max !== null && f.max !== '' && f.max !== undefined)
        ? h('div', { class: 'bounds' }, `Between ${f.min ?? '…'} and ${f.max ?? '…'}`) : null;
      switch (f.type) {
        case 'integer': case 'number': return [h('div', { class: 'input-row' }, h('input', { type: 'number', disabled: true }), f.suffix ? h('span', { class: 'suffix' }, f.suffix) : null), hintBounds];
        case 'slider': return [h('div', { class: 'slider-wrap' }, h('input', { type: 'range', disabled: true }), h('span', { class: 'slider-value' }, String(f.default ?? 50)))];
        case 'choice': return f.layout === 'dropdown'
          ? [h('select', { disabled: true }, h('option', null, 'Choose…'))]
          : [h('div', { class: 'choices' }, f.options.map((o) => h('label', { class: 'choice' }, h('input', { type: 'radio', disabled: true }), h('span', null, o.label || String(o.value)))))];
        case 'likert': { const items = []; for (let n = f.min ?? 1; n <= (f.max ?? 5); n++) items.push(h('label', { class: 'choice' }, h('input', { type: 'radio', disabled: true }), String(n))); return [h('div', { class: 'likert' }, items), h('div', { class: 'likert-ends' }, h('span', null, f.minLabel), h('span', null, f.maxLabel))]; }
        case 'checkbox': return [h('label', { class: 'choice' }, h('input', { type: 'checkbox', disabled: true }), h('span', { html: renderMarkdown(f.label, { chips: true }) }))];
        case 'textarea': return [h('textarea', { rows: 3, disabled: true })];
        default: return [h('input', { type: 'text', disabled: true })];
      }
    };
    const card = s.type === 'wait'
      ? h('div', { class: 'play-card center' }, h('div', { class: 'spinner' }), h('h1', null, s.title || 'Please wait'), md(s.body), S.exp.design.groupSize > 1 ? h('span', { class: 'count-pill' }, '2 of 4 ready') : null)
      : h('div', { class: 'play-card' },
        s.title ? h('h1', null, s.title) : null, s.body ? md(s.body) : null,
        s.fields.map((f) => h('div', { class: 'q' }, f.type === 'checkbox' ? null : h('div', { class: 'q-label', html: renderMarkdown(f.label, { chips: true }) }), ctl(f), f.help ? h('div', { class: 'help' }, f.help) : null)),
        h('div', { class: 'submit-row' }, h('button', { class: 'btn btn-primary btn-lg', type: 'button', disabled: true }, s.buttonLabel || (s.type === 'decision' ? 'Submit' : 'Continue')),
          s.timeoutSeconds ? h('span', { class: 'muted small' }, `Time limit: ${s.timeoutSeconds} s`) : null));
    modal({ title: 'Participant preview', wide: true, body: h('div', null, h('p', { class: 'hint' }, 'Values in blue are filled in with real data during a session.'), card), actions: [{ label: 'Close', value: true }] });
  }

  // ===========================================================================
  // DESIGN TAB
  // ===========================================================================
  function renderDesignTab() {
    const d = S.exp.design;
    const roleInput = h('input', {
      value: d.roles.join(', '), placeholder: 'e.g. Proposer, Responder',
      oninput: (e) => { d.roles = e.target.value.split(',').map((x) => x.trim()).filter(Boolean); changed(); },
    });
    const rateLine = h('div', { class: 'hint' });
    const paintRate = () => {
      const p = normalizeExperiment(S.exp).design.payment;
      rateLine.textContent = `${formatRate(p)} · e.g. 100 ${p.pointsName} = ${p.currencySymbol.length <= 1 ? p.currencySymbol : ''}${(100 * p.exchangeRate).toFixed(2)}${p.currencySymbol.length > 1 ? ` ${p.currencySymbol}` : ''}`;
    };
    const designChanged = () => { changed(); paintRate(); };
    paintRate();
    const treatmentsHost = h('div');
    const drawTreatments = () => {
      mount(treatmentsHost, 
        d.treatments.length ? null : h('p', { class: 'hint' }, 'No treatments: everybody plays the same version. Add treatments to randomly assign groups to different parameter values.'),
        ...d.treatments.map((t, i) => h('div', { class: 'sub-card' },
          h('div', { class: 'row' }, h('div', { class: 'grow' }, labeled('Treatment name', textInput(t, 'name', { onChange: changed }))),
            h('button', { class: 'icon-btn danger', type: 'button', 'aria-label': 'Remove treatment', onclick: () => { d.treatments.splice(i, 1); changed(); drawTreatments(); } }, icon('trash', 16))),
          h('div', { class: 'section-title' }, 'Constants that differ in this treatment'),
          kvEditor(() => t.constants, (o) => { t.constants = o; }, { keyPlaceholder: 'constant', valuePlaceholder: 'value in this treatment', onChange: changed }))),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { d.treatments.push({ name: `Treatment ${d.treatments.length + 1}`, constants: {} }); changed(); drawTreatments(); } }, icon('plus', 14), 'Add treatment'));
    };
    drawTreatments();

    return h('div', { class: 'grid cols-2', style: { alignItems: 'start' } },
      h('div', { class: 'stack' },
        h('div', { class: 'card' }, h('h3', null, 'About'),
          h('div', { class: 'stack' },
            labeled('Description (only visible to you)', textArea(S.exp, 'description', { rows: 3, onChange: changed })))),
        h('div', { class: 'card' }, h('h3', null, 'Groups & rounds'),
          h('div', { class: 'form-grid' },
            labeled('Players per group', numberInput(d, 'groupSize', { int: true, min: 1, max: 200, onChange: () => { changed(); paintStageList(); } }), '1 = individual experiment'),
            labeled('Number of rounds', numberInput(d, 'rounds', { int: true, min: 1, max: 300, onChange: () => { changed(); paintStageList(); } })),
            labeled('Matching between rounds', selectInput(d, 'matching', [{ value: 'fixed', label: 'Partners (same group)' }, { value: 'random', label: 'Strangers (new groups)' }], { onChange: changed }))),
          h('div', { class: 'stack', style: { marginTop: '14px' } },
            labeled('Roles (optional)', roleInput, 'One role per group member, in order, separated by commas. In formulas: player.role and roles.Proposer.offer'),
            checkbox(d, 'rotateRoles', 'Rotate roles each round', { onChange: changed, hint: 'Otherwise every participant keeps the same role in all rounds.' }))),
        h('div', { class: 'card' }, h('h3', null, 'Constants'),
          h('p', { class: 'hint' }, 'Named parameters you can use in formulas and text as const.name. Numbers, text or true/false.'),
          kvEditor(() => d.constants, (o) => { d.constants = o; }, { keyPlaceholder: 'name, e.g. endowment', valuePlaceholder: 'value, e.g. 20', onChange: changed })),
        h('div', { class: 'card' }, h('h3', null, 'Treatments'), treatmentsHost)),
      h('div', { class: 'stack' },
        h('div', { class: 'card' }, h('h3', null, 'Payment'),
          h('div', { class: 'form-grid' },
            labeled('Which rounds are paid', selectInput(d.payment, 'mode', [{ value: 'all', label: 'All rounds (sum of points)' }, { value: 'random_round', label: 'One random round' }, { value: 'last_round', label: 'Last round only' }], { onChange: designChanged })),
            labeled('Currency symbol', textInput(d.payment, 'currencySymbol', { onChange: designChanged, maxlength: 10 }), 'e.g. $, €, £ or CHF'),
            labeled('Currency per point', numberInput(d.payment, 'exchangeRate', { step: 0.001, min: 0, onChange: designChanged })),
            labeled('Points are called', textInput(d.payment, 'pointsName', { onChange: designChanged, maxlength: 30 }), 'e.g. points, tokens, ECU'),
            labeled('Participation fee', numberInput(d.payment, 'participationFee', { step: 0.01, min: 0, onChange: designChanged }))),
          h('div', { style: { marginTop: '10px' } }, rateLine)),
        h('div', { class: 'card' }, h('h3', null, 'Messages'),
          h('div', { class: 'stack' },
            labeled('Waiting-room text (before the session starts)', textArea(d, 'lobbyMessage', { rows: 2, onChange: changed })),
            labeled('Final screen text', textArea(d, 'finalMessage', { rows: 3, onChange: changed }), 'Markdown. Shown with the earnings summary.'),
            labeled('Redirect after finishing (optional)', textInput(d, 'completionUrl', { type: 'url', onChange: changed, placeholder: 'https://… e.g. a Qualtrics or Prolific completion link' }), 'Participants see a “Continue” button that opens this address.')))));
  }

  // ===========================================================================
  // SESSIONS TAB
  // ===========================================================================
  async function renderSessionsTab(el) {
    const d = S.exp.design;
    const form = { numParticipants: defaultN(), name: '', startMode: 'manual', bots: 0, seed: '' };
    const errors = countByLevel('error');
    const msg = h('div');
    const create = async (extra = {}) => {
      mount(msg);
      await flushSave();
      try {
        const res = await post(`/api/experiments/${S.exp.id}/sessions`, { ...form, ...extra });
        navigate(`#/sessions/${res.session.id}`);
      } catch (e) {
        mount(msg, h('div', { class: 'alert danger' }, icon('warn', 16), h('div', null, e.message)));
      }
    };
    const startMode = h('div', { class: 'stack' },
      ...[['manual', 'I start it manually', 'Participants wait in a lobby until you press Start. Best for the lab.'],
        ['immediate', 'Start immediately', 'Participants begin as soon as they open their link. Good for online studies.']].map(([v, l, hint]) => h('label', { class: 'check' },
        h('input', { type: 'radio', name: 'startMode', checked: form.startMode === v, onchange: () => { form.startMode = v; } }),
        h('span', null, l, h('span', { class: 'hint', style: { display: 'block', fontWeight: 400 } }, hint)))));
    mount(el, h('div', { class: 'grid cols-2', style: { alignItems: 'start' } },
      h('div', { class: 'card' }, h('h3', null, 'Create a session'),
        errors ? h('div', { class: 'alert danger', style: { marginBottom: '12px' } }, icon('warn', 16), h('div', null, `Fix the ${errors} problem${errors > 1 ? 's' : ''} in the Stages or Design tab before running this experiment.`)) : null,
        h('div', { class: 'stack' },
          labeled('Number of participants', numberInput(form, 'numParticipants', { int: true, min: 1, max: 1000 }),
            `Must be a multiple of ${d.groupSize}${d.treatments.length > 1 ? `; use a multiple of ${d.groupSize * d.treatments.length} for balanced treatments` : ''}.`),
          labeled('Session name (optional)', textInput(form, 'name', { placeholder: 'e.g. Monday 10:00 lab session' })),
          startMode,
          h('details', null, h('summary', { style: { cursor: 'pointer', fontWeight: 600 } }, 'Testing options'),
            h('div', { class: 'stack', style: { marginTop: '10px' } },
              labeled('Simulated participants (bots)', numberInput(form, 'bots', { int: true, min: 0 }), 'Bots take the last seats and play randomly, so you can try a seat yourself with the rest filled in.'),
              labeled('Random seed (optional)', textInput(form, 'seed', { placeholder: 'leave empty for random' }), 'The same seed reproduces the same group assignment and random draws.'))),
          msg,
          h('div', { class: 'row' },
            h('button', { class: 'btn btn-primary', type: 'button', disabled: errors > 0, onclick: () => create() }, icon('play', 16), 'Create session'),
            h('button', { class: 'btn', type: 'button', disabled: errors > 0, onclick: quickTest }, icon('bolt', 16), 'Quick test with bots')))),
      h('div', { class: 'card' }, h('h3', null, 'Sessions of this experiment'), h('div', { id: 'sess-list' }, h('p', { class: 'muted' }, 'Loading…')))));
    try {
      const { sessions } = await get(`/api/sessions?experimentId=${S.exp.id}`);
      const list = el.querySelector('#sess-list');
      if (!list) return;
      mount(list, sessions.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', null, h('tr', null, ['Session', 'Status', 'Done', 'Created'].map((x) => h('th', null, x)))),
        h('tbody', null, sessions.map((s) => h('tr', null,
          h('td', null, h('a', { href: `#/sessions/${s.id}` }, s.name)),
          h('td', null, badge(s.status, s.status === 'finished' ? 'success' : s.status === 'running' ? 'primary' : '')),
          h('td', { class: 'num' }, `${s.done}/${s.numParticipants}`),
          h('td', null, new Date(s.createdAt).toLocaleString())))))) : h('p', { class: 'muted' }, 'No sessions yet.'));
    } catch { /* ignore */ }
  }

  // ===========================================================================
  // JSON TAB
  // ===========================================================================
  function renderJsonTab() {
    const ta = h('textarea', { class: 'json', spellcheck: 'false', 'aria-label': 'Experiment JSON' }, JSON.stringify(S.exp, null, 2));
    const msg = h('div');
    return h('div', { class: 'stack' },
      h('p', { class: 'muted' }, 'The complete definition of this experiment. Edit it directly, keep it in version control, or paste a design shared by a colleague.'),
      ta, msg,
      h('div', { class: 'row' },
        h('button', { class: 'btn btn-primary', type: 'button', onclick: () => {
          try {
            const parsed = JSON.parse(ta.value);
            if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.stages)) throw new Error('Expected an object with a "stages" list.');
            const next = normalizeExperiment({ ...parsed, id: S.exp.id, createdAt: S.exp.createdAt });
            S.exp = next; S.sel = 0;
            nameInput.value = next.name;
            changed();
            ta.value = JSON.stringify(S.exp, null, 2);
            mount(msg, h('div', { class: 'alert success' }, icon('check', 16), 'Applied. The design was normalised and saved.'));
          } catch (e) { mount(msg, h('div', { class: 'alert danger' }, icon('warn', 16), e.message)); }
        } }, 'Apply changes'),
        h('button', { class: 'btn', type: 'button', onclick: downloadJson }, icon('download', 16), 'Download')));
  }

  // ---- mount ------------------------------------------------------------------
  mount(host, h('div', { class: 'page' }, headerEl, tabsEl, content));
  S.issues = validateExperiment(normalizeExperiment(S.exp));
  paintSave(); paintTabs(); drawTab(); paintIssuePanel();
  return {
    async destroy() {
      window.removeEventListener('beforeunload', onBeforeUnload);
      if (S.status === 'dirty') { scheduleSave.cancel(); await doSave(); }
    },
  };
}
