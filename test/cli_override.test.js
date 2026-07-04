import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { parseArgs, createPushOverrideManifest, createPullOverrideManifest } from '../src/cli.js';

test('parseArgs detects push/pull and captures required args', () => {
  const args = parseArgs(['push', '--file', '/tmp/a.md', '--page', '381abd95e1708089adeedb3c32dded00']);
  assert.equal(args.pushMode, true);
  assert.equal(args.pullMode, false);
  assert.equal(args.file, '/tmp/a.md');
  assert.equal(args.page, '381abd95e1708089adeedb3c32dded00');
});

test('parseArgs parses boolean frontmatter flag', () => {
  const args = parseArgs(['push', '--file', '/tmp/a.md', '--page', '381abd95e1708089adeedb3c32dded00', '--frontmatter', 'true']);
  assert.equal(args.frontmatter, 'true');
});

test('createPushOverrideManifest derives outDir/filename from file', () => {
  const manifest = createPushOverrideManifest({
    filePath: '/tmp/note.md',
    page: '381abd95e1708089adeedb3c32dded00',
    frontmatter: 'metadata',
    title: 'filename',
    format: 'markdown-flat',
  });

  assert.ok(Array.isArray(manifest.targets));
  assert.equal(manifest.targets.length, 1);
  assert.equal(manifest.targets[0].source, '381abd95e1708089adeedb3c32dded00');
  assert.equal(manifest.targets[0].outDir, path.resolve('/tmp'));
  assert.equal(manifest.targets[0].filename, 'note.md');
  assert.equal(manifest.targets[0].sync, 'push-only');
  assert.equal(manifest.targets[0].frontmatter, 'metadata');
  assert.equal(manifest.targets[0].title, 'filename');
});

test('createPullOverrideManifest respects provided outDir/filename', () => {
  const manifest = createPullOverrideManifest({
    page: '381abd95e1708089adeedb3c32dded00',
    outDir: '/tmp/myout',
    filename: 'export.md',
    frontmatter: 'true',
    title: 'relativePath',
    format: 'flattened',
  });

  assert.equal(manifest.targets[0].outDir, path.resolve('/tmp/myout'));
  assert.equal(manifest.targets[0].filename, 'export.md');
  assert.equal(manifest.targets[0].sync, 'pull-only');
  assert.equal(manifest.targets[0].frontmatter, true);
  assert.equal(manifest.targets[0].title, 'relativePath');
});

test('parseArgs accepts --use-cache', () => {
  const args = parseArgs(['push', '--file', '/tmp/a.md', '--page', '381abd95e1708089adeedb3c32dded00', '--use-cache']);
  assert.equal(args.useCache, true);
});
