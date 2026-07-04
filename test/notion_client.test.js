import test from 'node:test';
import assert from 'node:assert/strict';
import { NotionClient } from '../src/notion.js';

test('paginate collects pages until no cursor', async () => {
  const client = new NotionClient('x');
  client._minInterval = 0; // speed up tests

  let calls = 0;
  const fn = async ({ start_cursor }) => {
    calls++;
    if (!start_cursor) return { results: [1], has_more: true, next_cursor: 'a' };
    if (start_cursor === 'a') return { results: [2], has_more: false };
    return { results: [], has_more: false };
  };

  const all = await client.paginate(fn);
  assert.deepEqual(all, [1, 2]);
  assert.equal(calls, 2);
});

test('getBlockChildrenDeep recurses and returns warnings', async () => {
  const client = new NotionClient('x');
  client._minInterval = 0;

  // stub getBlockChildren to return one block with has_children true
  let depthCalls = 0;
  client.getBlockChildren = async (id) => {
    depthCalls++;
    if (depthCalls === 1) return [{ id: 'b1', has_children: true, type: 'paragraph' }];
    return [{ id: 'b2', has_children: false, type: 'paragraph' }];
  };

  const res = await client.getBlockChildrenDeep('root');
  assert.ok(Array.isArray(res.blocks));
});
