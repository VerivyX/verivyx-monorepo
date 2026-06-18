import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { sanitizeHtml } from '../src/sanitize';

// Node parser using linkedom — injectable so sanitizeHtml stays pure
function parse(html: string): Document {
  return parseHTML(
    `<!doctype html><html><body>${html}</body></html>`
  ).document as unknown as Document;
}

test('removes onerror from img', () => {
  const out = sanitizeHtml('<img src="x" onerror="alert(1)">', parse);
  assert.ok(!out.includes('onerror'), `onerror still present: ${out}`);
});

test('removes onload from svg', () => {
  const out = sanitizeHtml('<svg onload="alert(1)"></svg>', parse);
  assert.ok(!out.includes('onload'), `onload still present: ${out}`);
});

test('removes javascript: href from anchor', () => {
  const out = sanitizeHtml('<a href="javascript:alert(1)">x</a>', parse);
  assert.ok(!out.includes('javascript:'), `javascript: still present: ${out}`);
});

test('removes script element entirely', () => {
  const out = sanitizeHtml('<script>alert(1)</script>', parse);
  assert.ok(!out.includes('<script'), `<script still present: ${out}`);
});

test('removes iframe element entirely', () => {
  const out = sanitizeHtml('<iframe src="evil"></iframe>', parse);
  assert.ok(!out.includes('<iframe'), `<iframe still present: ${out}`);
});

test('removes data:text/html href from anchor', () => {
  const out = sanitizeHtml('<a href="data:text/html;base64,xxx">x</a>', parse);
  assert.ok(!out.includes('data:text/html'), `data:text/html still present: ${out}`);
  // href attribute should be gone entirely
  assert.ok(!out.match(/href\s*=/), `href attr still present: ${out}`);
});

test('preserves safe article markup including data:image src', () => {
  const safe =
    '<p class="a"><strong>hi</strong> <a href="https://ok.com">l</a> ' +
    '<img src="data:image/png;base64,xx"></p>';
  const out = sanitizeHtml(safe, parse);
  assert.ok(out.includes('<strong>'), `<strong> missing: ${out}`);
  assert.ok(out.includes('https://ok.com'), `href missing: ${out}`);
  assert.ok(out.includes('data:image/png'), `data:image/png missing: ${out}`);
});
