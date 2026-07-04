import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, rm, access, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { downloadToPath } from '../src/fetch-stream.js';

function makeHeaders(initial = {}) {
  return {
    get(key) {
      const v = initial[key.toLowerCase()];
      return v === undefined ? null : String(v);
    },
  };
}

function makeReaderFromChunks(chunks) {
  let i = 0;
  return {
    async read() {
      if (i >= chunks.length) return { done: true, value: undefined };
      const value = chunks[i++];
      return { done: false, value };
    },
    async cancel() {
      makeReaderFromChunks.cancelled = true;
    },
    releaseLock() {},
  };
}

function makeMockFetch({
  ok = true,
  status = 200,
  bodyChunks = [Buffer.from([1, 2, 3])],
  contentLength = null,
  readerHasGetReader = true,
  onFetch,
  throwAbort = false,
  maxCalls = null,
} = {}) {
  makeMockFetch.calls = 0;

  return async (url, opts) => {
    makeMockFetch.calls++;
    if (maxCalls !== null && makeMockFetch.calls > maxCalls) throw new Error('Unexpected extra fetch call');
    if (typeof onFetch === 'function') onFetch(url, opts, makeMockFetch.calls);

    if (throwAbort) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }

    return {
      ok,
      status,
      headers: makeHeaders(contentLength === null ? {} : { 'content-length': contentLength }),
      body: readerHasGetReader
        ? {
            getReader() {
              const reader = makeReaderFromChunks(bodyChunks);
              return reader;
            },
            cancel: async () => {},
          }
        : {},
    };
  };
}

test('downloadToPath throws on disallowed URL and does not write file', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'notiondrive-fetch-'));
  try {
    const dest = path.join(base, 'out.bin');

    const orig = global.fetch;
    global.fetch = makeMockFetch({ ok: true });
    try {
      await assert.rejects(
        downloadToPath('http://127.0.0.1/private', dest, { retries: 0 }),
        /Disallowed URL/
      );
    } finally {
      global.fetch = orig;
    }

    await assert.rejects(access(dest));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('downloadToPath retries on 5xx until success', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'notiondrive-fetch-'));
  try {
    const dest = path.join(base, 'out.bin');

    const orig = global.fetch;
    let attempt = 0;
    global.fetch = async (url, opts) => {
      attempt++;
      if (attempt < 3) {
        return {
          ok: false,
          status: 503,
          headers: makeHeaders({ 'content-length': null }),
          body: { getReader: () => makeReaderFromChunks([Buffer.from([0])]) },
        };
      }

      return {
        ok: true,
        status: 200,
        headers: makeHeaders({ 'content-length': 3 }),
        body: {
          getReader: () => makeReaderFromChunks([Buffer.from([1, 2, 3])]),
          cancel: async () => {},
        },
      };
    };

    try {
      await downloadToPath('https://example.com/file.bin', dest, { retries: 2, backoff: 1, timeoutMs: 10_000, maxSize: 1024 });

      const buf = await readFile(dest);
      assert.equal(buf.toString('hex'), '010203');
      assert.equal(attempt, 3);
    } finally {
      global.fetch = orig;
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('downloadToPath does not retry on 404', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'notiondrive-fetch-'));
  try {
    const dest = path.join(base, 'out.bin');

    const orig = global.fetch;
    let calls = 0;
    global.fetch = async () => {
      calls++;
      return {
        ok: false,
        status: 404,
        headers: makeHeaders({ 'content-length': 1 }),
        body: { getReader: () => makeReaderFromChunks([Buffer.from([0])]) },
      };
    };

    try {
      await assert.rejects(downloadToPath('https://example.com/missing', dest, { retries: 3, backoff: 1, maxSize: 1024 }), /HTTP 404/);
      assert.equal(calls, 1);
    } finally {
      global.fetch = orig;
    }

    await assert.rejects(access(dest));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('downloadToPath rejects when Content-Length exceeds maxSize', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'notiondrive-fetch-'));
  try {
    const dest = path.join(base, 'out.bin');

    const orig = global.fetch;
    global.fetch = makeMockFetch({ ok: true, status: 200, contentLength: 2048, bodyChunks: [Buffer.from([1])] });
    try {
      await assert.rejects(
        downloadToPath('https://example.com/big', dest, { retries: 0, maxSize: 1024 }),
        /File too large/
      );
      await assert.rejects(access(dest));
    } finally {
      global.fetch = orig;
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('downloadToPath rejects when no response body reader', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'notiondrive-fetch-'));
  try {
    const dest = path.join(base, 'out.bin');

    const orig = global.fetch;
    global.fetch = makeMockFetch({ ok: true, status: 200, readerHasGetReader: false });
    try {
      await assert.rejects(downloadToPath('https://example.com/nobody', dest, { retries: 0 }), /No response body/);
      await assert.rejects(access(dest));
    } finally {
      global.fetch = orig;
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('downloadToPath cancels and throws when maxSize exceeded during streaming', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'notiondrive-fetch-'));
  try {
    const dest = path.join(base, 'out.bin');

    const orig = global.fetch;
    const reader = makeReaderFromChunks([Buffer.alloc(600), Buffer.alloc(600)]);
    makeReaderFromChunks.cancelled = false;

    global.fetch = async () => ({
      ok: true,
      status: 200,
      headers: makeHeaders({ 'content-length': null }),
      body: {
        getReader: () => reader,
        cancel: async () => {},
      },
    });

    try {
      await assert.rejects(
        downloadToPath('https://example.com/stream', dest, { retries: 0, maxSize: 1000 }),
        /exceeded/
      );
      assert.equal(makeReaderFromChunks.cancelled, true);
      await assert.rejects(access(dest));
    } finally {
      global.fetch = orig;
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('downloadToPath abort errors are not retried', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'notiondrive-fetch-'));
  try {
    const dest = path.join(base, 'out.bin');

    const orig = global.fetch;
    let calls = 0;
    global.fetch = async () => {
      calls++;
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    };

    try {
      await assert.rejects(
        downloadToPath('https://example.com/abort', dest, { retries: 5, backoff: 1 }),
        /(aborted|AbortError)/i
      );
      assert.equal(calls, 1);
    } finally {
      global.fetch = orig;
    }

    await assert.rejects(access(dest));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
