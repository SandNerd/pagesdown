import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { executeSyncMode } from '../src/sync.js';

function createNoopPrompts() {
  return {
    spinner: () => ({ start: () => {}, stop: () => {}, message: () => {} }),
    log: {
      info: () => {},
      warn: () => {},
      error: () => {},
      success: () => {},
    },
  };
}

test('disabled targets are ignored during sync', async () => {
  const originalCwd = process.cwd();
  const dir = await mkdtemp(path.join(tmpdir(), 'pagesdown-disabled-test-'));
  try {
    process.chdir(dir);

    const pageIdDisabled = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const pageIdEnabled = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

    const manifest = {
      targets: [
        { source: `https://www.notion.so/${pageIdDisabled}`, outDir: '.', filename: 'disabled.md', disabled: true },
        { source: `https://www.notion.so/${pageIdEnabled}`, outDir: '.', filename: 'enabled.md' },
      ],
    };

    const called = [];
    class MockNotion {
      async validateToken() {}
      async getPage(id) {
        called.push(id);
        return { id, last_edited_time: '2026-01-01T00:00:00.000Z' };
      }
    }

    const result = await executeSyncMode(manifest, 'fake-token', { debug: false }, { notionClass: MockNotion, prompts: createNoopPrompts(), downloadPages: async () => ({ writtenFiles: [] }), loadStateLedger: () => ({ byNotionId: {}, byPath: {} }), saveStateLedger: async () => {} });

    // MockNotion.getPage should be called only for the enabled target
    assert.deepEqual(called, [pageIdEnabled], 'Only enabled target should be fetched');
    assert.equal(result.failedTargets.length, 0, 'should have no failures');
    assert.ok(result.completedTargets.length >= 1, 'should have completed at least the enabled target');
  } finally {
    process.chdir(originalCwd);
    await rm(dir, { recursive: true, force: true });
  }
});
