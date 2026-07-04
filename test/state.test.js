import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import crypto from 'node:crypto';
import { loadStateLedger, saveStateLedger, calculateFileHash } from '../src/state.js';

test('state ledger save/load and file hash', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'notiondrive-state-test-'));
  const originalCwd = process.cwd();
  try {
    process.chdir(dir);
    const fname = 'sample.md';
    const content = 'Hello Notion Drive';
    await writeFile(fname, content, 'utf8');

    const expectedHash = crypto.createHash('sha256').update(Buffer.from(content)).digest('hex');
    const gotHash = await calculateFileHash(fname);
    assert.equal(gotHash, expectedHash);

    const rel = path.relative(process.cwd(), path.join(process.cwd(), fname));
    const ledger = { byNotionId: { nid: { notion_id: 'nid', outputs: { [rel]: { last_synced_remote_mtime: '2020-01-01T00:00:00.000Z', last_synced_local_hash: gotHash } } } }, byPath: { [rel]: 'nid' } };

    await saveStateLedger(ledger);
    const loaded = await loadStateLedger();
    assert.deepEqual(loaded.byNotionId.nid.outputs[rel].last_synced_local_hash, gotHash);
  } finally {
    process.chdir(originalCwd);
    await rm(dir, { recursive: true, force: true });
  }
});
