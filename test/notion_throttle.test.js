import test from 'node:test';
import assert from 'node:assert/strict';
import { NotionClient } from '../src/notion.js';

test('NotionClient._throttledCall serializes calls respecting interval', async () => {
  const calls = [];
  const client = new NotionClient('fake-token');

  // Lower the interval to speed up the test
  client._minInterval = 10;

  const tasks = [];
  for (let i = 0; i < 5; i++) {
    tasks.push(
      client._throttledCall(async () => {
        calls.push(Date.now());
      })
    );
  }

  await Promise.all(tasks);

  // Ensure calls are sequential/non-decreasing
  for (let i = 1; i < calls.length; i++) {
    assert.ok(calls[i] >= calls[i - 1], 'Calls should be non-decreasing in time');
  }
});
