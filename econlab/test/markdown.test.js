import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../public/js/markdown.js';

// Participant-supplied text can reach the page through {{ }} values, so the
// renderer must never emit markup it did not create itself.

test('raw HTML is escaped', () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)> <script>alert(2)</script>');
  assert.ok(!/<img|<script/i.test(html));
  assert.match(html, /&lt;img/);
});

test('only safe link schemes become links', () => {
  assert.match(renderMarkdown('[a](https://example.org/x?y=1&z=2)'), /<a href="https:\/\/example.org\/x\?y=1&amp;z=2"/);
  assert.match(renderMarkdown('[a](/local/path)'), /<a href="\/local\/path"/);
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'vbscript:x', '//evil.example/x']) {
    assert.ok(!/<a /.test(renderMarkdown(`[a](${bad})`)), bad);
  }
});

test('quotes cannot break out of attributes', () => {
  const html = renderMarkdown('[a](https://x.y/"onmouseover="alert(1))  ![i](https://x.y/"onerror="alert(2))');
  assert.ok(!/ onmouseover=|\sonerror=/.test(html.replace(/&quot;/g, '')) || !/"\s*on\w+=/.test(html));
  assert.ok(!/<[^>]*\s(onmouseover|onerror)=/.test(html));
});

test('blocks: headings, lists, tables, code, hr', () => {
  const html = renderMarkdown('## T\n\n- a\n- b\n\n1. x\n2. y\n\n| h1 | h2 |\n|---|---|\n| **1** | 2 |\n\n```\n<b>raw</b>\n```\n\n---');
  assert.match(html, /<h3>T<\/h3>/);
  assert.match(html, /<ul><li>a<\/li><li>b<\/li><\/ul>/);
  assert.match(html, /<ol><li>x<\/li><li>y<\/li><\/ol>/);
  assert.match(html, /<th>h1<\/th>/);
  assert.match(html, /<td><strong>1<\/strong><\/td>/);
  assert.match(html, /<pre><code>&lt;b&gt;raw&lt;\/b&gt;<\/code><\/pre>/);
  assert.match(html, /<hr>/);
});

test('editor preview shows {{ }} placeholders as chips, escaped', () => {
  const html = renderMarkdown('You earned {{ player.payoff }} and {{ "<b>" }}', { chips: true });
  assert.match(html, /<span class="chip">player.payoff<\/span>/);
  assert.ok(!html.includes('<b>'));
});
