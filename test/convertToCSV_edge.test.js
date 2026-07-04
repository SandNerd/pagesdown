import test from 'node:test';
import assert from 'node:assert/strict';

import { convertToCSV } from '../src/download.js';

test('convertToCSV falls back to relation id when notion.getPage fails', async () => {
  const notion = {
    getPage: async () => {
      throw new Error('Not found');
    },
  };

  const rows = [
    {
      properties: {
        Status: { type: 'relation', relation: [{ id: 'rel-1' }] },
      },
    },
  ];

  const orderedProperties = [
    ['Status', { name: 'Status' }],
  ];

  const csv = await convertToCSV(rows, orderedProperties, notion);
  const lines = csv.split('\r\n');

  // header + 1 data row + trailing empty line due to final \r\n
  assert.equal(lines[0], 'Status');
  assert.equal(lines[1], 'rel-1');
});

test('convertToCSV escapes quotes and newlines as RFC4180', async () => {
  const notion = {
    getPage: async () => ({
      id: 'dummy',
      properties: {},
    }),
  };

  const rows = [
    {
      properties: {
        Name: {
          type: 'title',
          title: [{ plain_text: 'Hello "World"\nNew' }],
        },
      },
    },
  ];

  const orderedProperties = [
    ['Name', { name: 'Name' }],
  ];

  const csv = await convertToCSV(rows, orderedProperties, notion);

  // Output example:
  // Name\r\n"Hello ""World""\nNew"\r\n
  assert.ok(csv.startsWith('Name\r\n'));
  assert.ok(csv.endsWith('\r\n'));

  const dataRow = csv.slice('Name\r\n'.length, csv.length - '\r\n'.length);

  // Contains quotes and newline => must be quoted, and internal quotes doubled.
  assert.equal(dataRow, '"Hello ""World""\nNew"');
});
