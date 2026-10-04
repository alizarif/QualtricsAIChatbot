// A deliberately small Markdown renderer for instructions text.
// Safety model: escape everything first, then add only our own tags. URLs are
// restricted to http(s), mailto and same-site paths, so no javascript: links.

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const SAFE_URL = /^(https?:\/\/|mailto:|\/(?!\/))[^\s]*$/i;

function inline(s, chips) {
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, url) => (SAFE_URL.test(url.replace(/&amp;/g, '&')) ? `<img src="${url}" alt="${alt}" loading="lazy">` : m));
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, url) => (SAFE_URL.test(url.replace(/&amp;/g, '&')) ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>` : m));
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^\w])_([^_\s][^_]*?)_(?!\w)/g, '$1<em>$2</em>');
  return s;
}

const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const splitRow = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

/** Returns an HTML string. With chips:true, {{ expr }} placeholders are shown as pills (editor preview). */
export function renderMarkdown(src, { chips = false } = {}) {
  const exprs = [];
  let text = String(src ?? '');
  if (chips) text = text.replace(/\{\{([\s\S]*?)\}\}/g, (m, e) => { exprs.push(e.trim()); return `${exprs.length - 1}`; });
  const lines = esc(text).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  let list = null;
  const flushPara = () => { if (para.length) { out.push(`<p>${para.map((l) => inline(l, chips)).join('<br>')}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.type}>${list.items.map((i) => `<li>${inline(i, chips)}</li>`).join('')}</${list.type}>`); list = null; } };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith('```')) {
      flushPara(); flushList();
      const code = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) code.push(lines[i++]);
      out.push(`<pre><code>${code.join('\n')}</code></pre>`);
      continue;
    }
    if (!line.trim()) { flushPara(); flushList(); continue; }
    let m;
    if ((m = /^(#{1,4})\s+(.*)$/.exec(line))) {
      flushPara(); flushList();
      const level = Math.min(m[1].length + 1, 5);
      out.push(`<h${level}>${inline(m[2], chips)}</h${level}>`);
    } else if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flushPara(); flushList(); out.push('<hr>');
    } else if (line.trim().startsWith('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flushPara(); flushList();
      const head = splitRow(line);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith('|')) { rows.push(splitRow(lines[i])); i++; }
      i--;
      out.push(`<table class="md-table"><thead><tr>${head.map((c) => `<th>${inline(c, chips)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c, chips)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
    } else if ((m = /^\s*[-*+]\s+(.*)$/.exec(line))) {
      flushPara();
      if (!list || list.type !== 'ul') { flushList(); list = { type: 'ul', items: [] }; }
      list.items.push(m[1]);
    } else if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) {
      flushPara();
      if (!list || list.type !== 'ol') { flushList(); list = { type: 'ol', items: [] }; }
      list.items.push(m[1]);
    } else if ((m = /^&gt;\s?(.*)$/.exec(line))) {
      flushPara(); flushList();
      out.push(`<blockquote>${inline(m[1], chips)}</blockquote>`);
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara(); flushList();
  let html = out.join('\n');
  if (chips) html = html.replace(/(\d+)/g, (m, i) => `<span class="chip">${esc(exprs[Number(i)])}</span>`);
  return html;
}
