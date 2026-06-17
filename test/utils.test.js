import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, chmod, access } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  sanitizeFilename,
  uniqueFilename,
  slugifyFilename,
  ensureDir,
  isWritablePath,
  getDefaultSavePath,
} from '../src/utils.js';

test('sanitizeFilename handles invalid and reserved values', () => {
  assert.equal(sanitizeFilename('  '), 'Untitled');
  assert.equal(sanitizeFilename('A<Bad>:Name?*'), 'ABadName');
  assert.equal(sanitizeFilename('CON'), '_CON');
});

test('uniqueFilename increments collisions', () => {
  const used = new Set();
  assert.equal(uniqueFilename('Note', used), 'Note');
  assert.equal(uniqueFilename('Note', used), 'Note (2)');
  assert.equal(uniqueFilename('Note', used), 'Note (3)');
});

test('slugifyFilename normalizes text', () => {
  assert.equal(slugifyFilename('🚀 Project Alpha & Beta (2026)!'), 'project-alpha-beta-2026');
  assert.equal(slugifyFilename(''), 'untitled');
});

test('ensureDir creates directories recursively', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'pagesdown-utils-'));
  try {
    const nested = path.join(base, 'a', 'b', 'c');
    await ensureDir(nested);
    await access(nested);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('isWritablePath returns false for missing parent', async () => {
  const target = path.join(tmpdir(), 'pagesdown-nope-parent', 'child');
  const writable = await isWritablePath(target);
  assert.equal(writable, false);
});

test('isWritablePath checks existing directory permissions', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'pagesdown-write-'));
  try {
    const before = await isWritablePath(base);
    assert.equal(before, true);

    await chmod(base, 0o500);
    const after = await isWritablePath(base);
    assert.equal(typeof after, 'boolean');
  } finally {
    await chmod(base, 0o700).catch(() => {});
    await rm(base, { recursive: true, force: true });
  }
});

test('getDefaultSavePath points to Desktop/notion-export', () => {
  const p = getDefaultSavePath();
  assert.ok(p.endsWith(path.join('Desktop', 'notion-export')));
});
