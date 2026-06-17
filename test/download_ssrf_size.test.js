import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { processAssets, downloadFile } from '../src/download.js';

// Helper that provides a fake fetch implementation
function makeMockFetch(contentBytes = [1, 2, 3], contentLength = 3) {
  return async (url, opts) => {
    const chunks = [Buffer.from(contentBytes)];
    return {
      ok: true,
      headers: { get: (k) => (k === 'content-length' ? (contentLength === null ? null : String(contentLength)) : null) },
      body: {
        getReader() {
          let i = 0;
          return {
            async read() {
              if (i < chunks.length) {
                const v = chunks[i++];
                return { done: false, value: v };
              }
              return { done: true, value: undefined };
            },
            cancel() {},
          };
        },
      },
    };
  };
}

test('processAssets skips blocked hostnames and private IPs', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'pagesdown-ssrf-'));
  try {
    const md = 'Hello ![a](http://127.0.0.1/secret.png) ![b](http://10.0.0.5/p.png) ![c](http://localhost/x.png)';
    // Should not attempt fetches for these private/blocked hosts and should return unchanged markdown
    const out = await processAssets(md, base, { totalAssets: 0 }, { onStatus: () => {} });
    assert.equal(out.includes('./assets/'), false, 'No local asset rewrites should occur');
    assert.ok(out.includes('127.0.0.1'), 'Original URL preserved');

    // Ensure assets directory was not created
    try {
      await access(path.join(base, 'assets'));
      assert.fail('assets directory should not exist for blocked hosts');
    } catch (err) {
      // expected: assets dir does not exist
      assert.ok(true);
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('downloadFile succeeds without Content-Length header', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'pagesdown-asset-'));
  const dest = path.join(base, 'f.bin');
  const orig = global.fetch;
  try {
    global.fetch = makeMockFetch([1, 2, 3], null);
    await downloadFile('https://example.com/f.bin', dest);
    await access(dest);
    const data = await readFile(dest);
    assert.equal(data.length, 3);
  } finally {
    global.fetch = orig;
    await rm(base, { recursive: true, force: true });
  }
});

test('downloadFile rejects when Content-Length header too large', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'pagesdown-asset-'));
  const dest = path.join(base, 'big.bin');
  const orig = global.fetch;
  try {
    // Content-Length intentionally above the 50MB limit
    const tooLarge = 50 * 1024 * 1024 + 1;
    global.fetch = makeMockFetch([0], tooLarge);
    await assert.rejects(async () => {
      await downloadFile('https://example.com/big.bin', dest);
    }, /File too large/);
  } finally {
    global.fetch = orig;
    await rm(base, { recursive: true, force: true });
  }
});
