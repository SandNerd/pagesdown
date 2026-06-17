import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import fs from 'node:fs';
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

test('executeSyncMode: polymorphic filter matches absolute path', async () => {
  const originalCwd = process.cwd();
  const dir = fs.realpathSync(await mkdtemp(path.join(tmpdir(), 'pagesdown-path-filter-test-')));
  try {
    process.chdir(dir);

    const pageId1 = '11111111111111111111111111111111';
    const pageId2 = '22222222222222222222222222222222';
    
    // Create dummy files so realpath works
    await writeFile(path.join(dir, 'target1.md'), '');
    await writeFile(path.join(dir, 'target-2.md'), '');

    const target1Path = fs.realpathSync(path.join(dir, 'target1.md'));
    const target2Path = fs.realpathSync(path.join(dir, 'target-2.md'));

    const manifest = {
      targets: [
        { source: pageId1, path: './target1.md' },
        { source: pageId2, path: '.', name: 'Target 2' }
      ]
    };

    class MockNotion {
      async validateToken() {}
      async getPage(id) {
        const name = id === pageId1 ? 'Target 1' : 'Target 2';
        return { id, last_edited_time: '2025-01-01T00:00:00.000Z', properties: { title: { type: 'title', title: [{ text: { content: name } }] } } };
      }
    }

    const mockDownload = async (items) => {
      const written = items.map(item => path.resolve(dir, item.filename || 'target-2.md'));
      return { writtenFiles: written, totalPages: items.length, totalAssets: 0, errors: [] };
    };

    // 1. Filter by absolute path of Target 1
    const result1 = await executeSyncMode(
      manifest, 
      'fake-token', 
      { syncFilter: target1Path }, 
      { notionClass: MockNotion, downloadPages: mockDownload, prompts: createNoopPrompts(), loadStateLedger: () => ({ byNotionId: {}, byPath: {} }) }
    );

    assert.equal(result1.completedTargets.length, 1, 'Should match Target 1 by path');
    assert.equal(extractNotionId(result1.completedTargets[0].target.source), pageId1);

    // 2. Filter by absolute path of Target 2
    const result2 = await executeSyncMode(
      manifest, 
      'fake-token', 
      { syncFilter: target2Path }, 
      { notionClass: MockNotion, downloadPages: mockDownload, prompts: createNoopPrompts(), loadStateLedger: () => ({ byNotionId: {}, byPath: {} }) }
    );

    assert.equal(result2.completedTargets.length, 1, 'Should match Target 2 by path');
    assert.equal(extractNotionId(result2.completedTargets[0].target.source), pageId2);

  } finally {
    process.chdir(originalCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('executeSyncMode: directory filter matches all targets in a directory', async () => {
  const originalCwd = process.cwd();
  const dir = fs.realpathSync(await mkdtemp(path.join(tmpdir(), 'pagesdown-path-filter-dir-test-')));
  try {
    process.chdir(dir);

    const pageId1 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const pageId2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    
    // Create dummy files so realpath works
    await writeFile(path.join(dir, 'a.md'), '');
    await writeFile(path.join(dir, 'b.md'), '');

    const manifest = {
      targets: [
        { source: pageId1, path: './a.md' },
        { source: pageId2, path: './b.md' }
      ]
    };

    class MockNotion {
      async validateToken() {}
      async getPage(id) {
        const name = id === pageId1 ? 'A' : 'B';
        return { id, last_edited_time: '2025-01-01T00:00:00.000Z', properties: { title: { type: 'title', title: [{ text: { content: name } }] } } };
      }
    }

    const mockDownload = async (items) => {
      const written = items.map(item => path.resolve(dir, item.filename || 'b.md'));
      return { writtenFiles: written, totalPages: items.length, totalAssets: 0, errors: [] };
    };

    const result = await executeSyncMode(
      manifest,
      'fake-token',
      { syncFilter: dir },
      { notionClass: MockNotion, downloadPages: mockDownload, prompts: createNoopPrompts(), loadStateLedger: () => ({ byNotionId: {}, byPath: {} }) }
    );

    assert.equal(result.completedTargets.length, 2, 'Should match both targets by directory filter');
    const matched = result.completedTargets.map((ct) => extractNotionId(ct.target.source)).sort();
    assert.deepEqual(matched, [pageId1, pageId2].sort());

  } finally {
    process.chdir(originalCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('executeSyncMode: prefix filter matches filenames and names', async () => {
  const originalCwd = process.cwd();
  const dir = fs.realpathSync(await mkdtemp(path.join(tmpdir(), 'pagesdown-prefix-filter-test-')));
  try {
    process.chdir(dir);

    const pageId1 = '33333333333333333333333333333333';
    const pageId2 = '44444444444444444444444444444444';
    // Create dummy files so realpath works
    await writeFile(path.join(dir, 'target1.md'), '');
    await writeFile(path.join(dir, 'target-2.md'), '');

    const manifest = {
      targets: [
        { source: pageId1, path: './target1.md', name: 'target-one' },
        { source: pageId2, path: './target-2.md', name: 'target-two' }
      ]
    };

    class MockNotion {
      async validateToken() {}
      async getPage(id) {
        const name = id === pageId1 ? 'Target One' : 'Target Two';
        return { id, last_edited_time: '2025-01-01T00:00:00.000Z', properties: { title: { type: 'title', title: [{ text: { content: name } }] } } };
      }
    }

    const mockDownload = async (items) => {
      const written = items.map(item => path.resolve(dir, item.filename || 'target-2.md'));
      return { writtenFiles: written, totalPages: items.length, totalAssets: 0, errors: [] };
    };

    // Filter by prefix 'target' should match both target1.md and target-2.md
    const result = await executeSyncMode(
      manifest,
      'fake-token',
      { syncFilter: 'target' },
      { notionClass: MockNotion, downloadPages: mockDownload, prompts: createNoopPrompts(), loadStateLedger: () => ({ byNotionId: {}, byPath: {} }) }
    );

    assert.equal(result.completedTargets.length, 2, 'Should match both targets by prefix filter');
    const matched = result.completedTargets.map((ct) => extractNotionId(ct.target.source)).sort();
    assert.deepEqual(matched, [pageId1, pageId2].sort());

  } finally {
    process.chdir(originalCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

function extractNotionId(input) {
  if (!input || typeof input !== 'string') return input;
  const re = /([a-f0-9]{8}-?[a-f0-9]{4}-?[a-f0-9]{4}-?[a-f0-9]{4}-?[a-f0-9]{12})|([a-f0-9]{32})/i;
  const m = input.match(re);
  if (!m) return input;
  return (m[1] || m[2] || '').replace(/-/g, '');
}
