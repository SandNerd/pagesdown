import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { processAssets, downloadFile, getAssetFilename } from '../src/download.js';

// Mock a simple fetch that returns 3 bytes and correct headers
function makeMockFetch(contentBytes = [1,2,3], contentLength = 3) {
  return async (url, opts) => {
    let called = false;
    const chunks = [Buffer.from(contentBytes)];
    return {
      ok: true,
      headers: { get: (k) => (k === 'content-length' ? String(contentLength) : null) },
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

test('getAssetFilename derives names and adds extension', () => {
  const used = new Set();
  const n1 = getAssetFilename('https://example.com/image', used);
  assert.ok(n1.endsWith('.png'));
  const n2 = getAssetFilename('https://example.com/image.png', used);
  assert.ok(n2.endsWith('.png'));
});

test('downloadFile saves content from fetch', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'notiondrive-asset-'));
  try {
    const dest = path.join(base, 'f.bin');
    const orig = global.fetch;
    global.fetch = makeMockFetch([1,2,3], 3);
    try {
      await downloadFile('https://example.com/f.bin', dest);
      await access(dest);
      const data = await readFile(dest);
      assert.equal(data.length, 3);
    } finally {
      global.fetch = orig;
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('processAssets downloads and rewrites image URLs', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'notiondrive-asset-'));
  try {
    const md = 'Hello ![alt](https://example.com/img.png) world';
    const orig = global.fetch;
    global.fetch = makeMockFetch([4,5,6], 3);
    try {
      const out = await processAssets(md, base, { totalAssets: 0 }, { onStatus: () => {} });
      // Should reference ./assets/
      assert.ok(out.includes('./assets/'));
      // file should exist
      const assetsDir = path.join(base, 'assets');
      const files = await import('node:fs/promises').then(m => m.readdir(assetsDir));
      assert.ok(files.length >= 1);
    } finally {
      global.fetch = orig;
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
