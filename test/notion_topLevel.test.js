import test from 'node:test';
import assert from 'node:assert/strict';
import { NotionClient } from '../src/notion.js';

test('getTopLevelPages filters nested pages and includes databases', async () => {
  const client = new NotionClient('x');
  client._minInterval = 0;

  const allItems = [
    { id: 'p1', object: 'page', parent: { type: 'workspace' }, has_children: true },
    { id: 'p2', object: 'page', parent: { page_id: 'p1' } },
    { id: 'p3', object: 'page', parent: { type: 'block_id', block_id: 'b1' } },
    { id: 'db1', object: 'database', parent: { type: 'workspace' } },
  ];

  // stub search to return allItems
  client.client.search = async (opts) => ({ results: allItems, has_more: false });

  // stub blocks.retrieve so b1 -> owner page p1 (in results)
  client.client.blocks = {
    retrieve: async ({ block_id }) => {
      if (block_id === 'b1') return { parent: { page_id: 'p1' } };
      return { parent: { type: 'workspace' } };
    },
  };

  // stub db/page retrieve for parent checks
  client.client.databases = { retrieve: async ({ database_id }) => ({ id: database_id, parent: { type: 'workspace' } }) };
  client.client.pages = { retrieve: async ({ page_id }) => ({ id: page_id, parent: { type: 'workspace' } }) };

  const top = await client.getTopLevelPages();
  // Should include p1 and db1 only
  const ids = top.map((t) => t.id).sort();
  assert.deepEqual(ids, ['db1', 'p1']);
});
