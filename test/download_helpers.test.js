import test from 'node:test';
import assert from 'node:assert/strict';
import {
  splitBlocksAtBoundaries,
  hasExternalImages,
  normalizeSpacing,
  escapeTableCell,
  notionRichTextToPlain,
  pagePropertyToText,
  convertToCSV,
} from '../src/download.js';

test('splitBlocksAtBoundaries splits child pages and dbs', () => {
  const blocks = [
    { type: 'paragraph', text: [{ plain_text: 'x' }] },
    { type: 'child_page', id: 'p1', child_page: { title: 'Child' } },
    { type: 'paragraph', text: [{ plain_text: 'after' }] },
    { type: 'child_database', id: 'd1', child_database: { title: 'DB' } },
  ];

  const { markdownParts, childEntries } = splitBlocksAtBoundaries(blocks);
  assert.ok(Array.isArray(markdownParts));
  assert.ok(Array.isArray(childEntries));
  assert.equal(childEntries.length, 2);
});

test('hasExternalImages detects external URLs', () => {
  const md = 'Hello ![alt](https://example.com/img.png)';
  assert.equal(hasExternalImages(md), true);
  assert.equal(hasExternalImages('no images here'), false);
});

test('normalizeSpacing collapses multiple blank lines', () => {
  const m = 'a\n\n\n\n b';
  assert.equal(normalizeSpacing(m).includes('\n\n'), true);
});

test('escapeTableCell handles pipes and newlines', () => {
  const out = escapeTableCell('a|b\nc');
  assert.equal(out.includes('\\|'), true);
});

test('notionRichTextToPlain joins plain_text', () => {
  const arr = [{ plain_text: 'Hello' }, { plain_text: ' World' }];
  assert.equal(notionRichTextToPlain(arr), 'Hello World');
});

test('pagePropertyToText formats various property types', () => {
  assert.equal(pagePropertyToText({ type: 'number', number: 5 }), '5');
  assert.equal(pagePropertyToText({ type: 'checkbox', checkbox: true }), 'true');
  assert.equal(pagePropertyToText({ type: 'select', select: { name: 'Opt' } }), 'Opt');
  assert.equal(pagePropertyToText({ type: 'multi_select', multi_select: [{ name: 'A' }, { name: 'B' }] }), 'A, B');
  assert.equal(pagePropertyToText({ type: 'people', people: [{ name: 'Sahal' }, { id: 'user-2' }] }), 'Sahal, user-2');
  assert.equal(pagePropertyToText({ type: 'created_time', created_time: '2026-05-28T12:34:56.000Z' }), '2026-05-28T12:34:56.000Z');
});

test('convertToCSV escapes commas and resolves relation titles via notion.getPage', async () => {
  const rows = [
    {
      id: 'r1',
      properties: {
        name: { type: 'title', title: [{ plain_text: 'Alpha, Beta' }] },
        rel: { type: 'relation', relation: [{ id: 'p1' }] },
      },
    },
  ];

  const ordered = [['name', { name: 'Name' }], ['rel', { name: 'Related' }]];

  const notion = {
    getPage: async (id) => ({ id, properties: { Name: { type: 'title', title: [{ plain_text: 'Rel Title' }] } } }),
  };

  const csv = await convertToCSV(rows, ordered, notion);
  // Header + row + CRLF
  assert.ok(csv.startsWith('Name,Related\r\n'));
  assert.ok(csv.includes('"Alpha, Beta",Rel Title\r\n'));
});
