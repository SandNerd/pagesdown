import test from 'node:test';
import assert from 'node:assert/strict';
import { markdownToNotionBlocks } from '../src/parser.js';

test('markdownToNotionBlocks converts headings', () => {
  const md = '# H1\n## H2\n### H3';
  const blocks = markdownToNotionBlocks(md);
  
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].type, 'heading_1');
  assert.equal(blocks[0].heading_1.rich_text[0].text.content, 'H1');
  assert.equal(blocks[1].type, 'heading_2');
  assert.equal(blocks[1].heading_2.rich_text[0].text.content, 'H2');
  assert.equal(blocks[2].type, 'heading_3');
  assert.equal(blocks[2].heading_3.rich_text[0].text.content, 'H3');
});

test('markdownToNotionBlocks converts lists', () => {
  const md = '- Item 1\n* Item 2\n1. First\n2. Second';
  const blocks = markdownToNotionBlocks(md);
  
  assert.equal(blocks.length, 4);
  assert.equal(blocks[0].type, 'bulleted_list_item');
  assert.equal(blocks[0].bulleted_list_item.rich_text[0].text.content, 'Item 1');
  assert.equal(blocks[1].type, 'bulleted_list_item');
  assert.equal(blocks[1].bulleted_list_item.rich_text[0].text.content, 'Item 2');
  assert.equal(blocks[2].type, 'numbered_list_item');
  assert.equal(blocks[2].numbered_list_item.rich_text[0].text.content, 'First');
  assert.equal(blocks[3].type, 'numbered_list_item');
  assert.equal(blocks[3].numbered_list_item.rich_text[0].text.content, 'Second');
});

test('markdownToNotionBlocks converts code blocks', () => {
  const md = '```javascript\nconst x = 5;\n```';
  const blocks = markdownToNotionBlocks(md);
  
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'code');
  assert.equal(blocks[0].code.language, 'javascript');
  assert.equal(blocks[0].code.rich_text[0].text.content, 'const x = 5;');
});

test('markdownToNotionBlocks converts dividers', () => {
  const blocks = markdownToNotionBlocks('---');

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'divider');
  assert.deepEqual(blocks[0].divider, {});
});

test('markdownToNotionBlocks converts markdown tables', () => {
  const md = '| Name | Age |\n| --- | --- |\n| Ada | 37 |\n| Bob | 41 |';
  const blocks = markdownToNotionBlocks(md);

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'table');
  assert.equal(blocks[0].table.table_width, 2);
  assert.equal(blocks[0].table.has_column_header, true);
  assert.equal(blocks[0].table.has_row_header, false);
  assert.equal(blocks[0].table.children.length, 3);
  assert.equal(blocks[0].table.children[0].table_row.cells[0][0].text.content, 'Name');
  assert.equal(blocks[0].table.children[0].table_row.cells[1][0].text.content, 'Age');
  assert.equal(blocks[0].table.children[1].table_row.cells[0][0].text.content, 'Ada');
  assert.equal(blocks[0].table.children[1].table_row.cells[1][0].text.content, '37');
});

test('markdownToNotionBlocks wraps script files as a single code block', () => {
  const md = '#!/usr/bin/env node\nconst x = 5;\n';
  const blocks = markdownToNotionBlocks(md, 'script.js');

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'code');
  assert.equal(blocks[0].code.language, 'javascript');
  assert.equal(blocks[0].code.rich_text[0].text.content, md);
});

test('markdownToNotionBlocks converts paragraphs', () => {
  const md = 'Regular text\nMore text';
  const blocks = markdownToNotionBlocks(md);
  
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, 'paragraph');
  assert.equal(blocks[0].paragraph.rich_text[0].text.content, 'Regular text');
  assert.equal(blocks[1].type, 'paragraph');
  assert.equal(blocks[1].paragraph.rich_text[0].text.content, 'More text');
});

test('markdownToNotionBlocks handles empty input', () => {
  const blocks = markdownToNotionBlocks('');
  assert.equal(blocks.length, 0);
});

test('markdownToNotionBlocks handles null input', () => {
  const blocks = markdownToNotionBlocks(null);
  assert.equal(blocks.length, 0);
});

test('markdownToNotionBlocks skips empty lines', () => {
  const md = 'Line 1\n\n\nLine 2';
  const blocks = markdownToNotionBlocks(md);
  
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].paragraph.rich_text[0].text.content, 'Line 1');
  assert.equal(blocks[1].paragraph.rich_text[0].text.content, 'Line 2');
});

test('markdownToNotionBlocks handles inline markdown', () => {
  const md = 'Hello **Bold** and `code` with [link](https://example.com)';
  const blocks = markdownToNotionBlocks(md);

  assert.equal(blocks.length, 1);
  const richText = blocks[0].paragraph.rich_text;
  assert.equal(richText.length, 6);

  assert.equal(richText[0].text.content, 'Hello ');

  assert.equal(richText[1].text.content, 'Bold');
  assert.equal(richText[1].annotations.bold, true);

  assert.equal(richText[2].text.content, ' and ');

  assert.equal(richText[3].text.content, 'code');
  assert.equal(richText[3].annotations.code, true);

  assert.equal(richText[4].text.content, ' with ');

  assert.equal(richText[5].text.content, 'link');
  assert.equal(richText[5].text.link.url, 'https://example.com');
});

test('markdownToNotionBlocks handles checklists', () => {
  const md = '- [ ] Unchecked\n- [x] Checked\n* [x] Star checked';
  const blocks = markdownToNotionBlocks(md);

  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].type, 'to_do');
  assert.equal(blocks[0].to_do.checked, false);
  assert.equal(blocks[0].to_do.rich_text[0].text.content, 'Unchecked');

  assert.equal(blocks[1].type, 'to_do');
  assert.equal(blocks[1].to_do.checked, true);
  assert.equal(blocks[1].to_do.rich_text[0].text.content, 'Checked');

  assert.equal(blocks[2].type, 'to_do');
  assert.equal(blocks[2].to_do.checked, true);
  assert.equal(blocks[2].to_do.rich_text[0].text.content, 'Star checked');
});

test('markdownToNotionBlocks skips layout noise', () => {
  const md = '<aside>\nInfo\n</aside>\n---|';
  const blocks = markdownToNotionBlocks(md);

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].paragraph.rich_text[0].text.content, 'Info');
});
