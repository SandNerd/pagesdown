import test from 'node:test';
import assert from 'node:assert/strict';
import { browseAndSelect } from '../src/cli.js';

// Helper that provides a fake prompts implementation with predetermined responses
function makePromptsWithSelectSequence(seq) {
  let i = 0;
  return {
    select: async ({ options }) => seq[i++],
    confirm: async () => true,
    spinner: () => ({ start: () => {}, stop: () => {}, message: () => {} }),
    log: { info: () => {}, warn: () => {} },
  };
}

test('browseAndSelect toggles a top-level page then finishes', async () => {
  const notion = {
    getTopLevelPages: async () => [
      { id: 'p1', type: 'page', title: 'Page One', hasChildren: false },
      { id: 'db1', type: 'database', title: 'DB One', hasChildren: false },
    ],
  };

  const prompts = makePromptsWithSelectSequence(['p1', 'ACTION_FINISH']);

  const selected = await browseAndSelect(notion, {}, prompts);
  assert.equal(Array.isArray(selected), true);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].id, 'p1');
});
