import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/cli.js';

test('parseArgs: captures positional sync filter', () => {
  const args = parseArgs(['sync', 'sys-design']);
  assert.equal(args.syncMode, true);
  assert.equal(args.syncFilter, 'sys-design');
  assert.equal(args.groupFilter, null);
});

test('parseArgs: captures --group short flag -g', () => {
  const args = parseArgs(['sync', '-g', 'docs']);
  assert.equal(args.syncMode, true);
  assert.equal(args.groupFilter, 'docs');
  assert.equal(args.syncFilter, null);
});

test('parseArgs: captures --group long flag', () => {
  const args = parseArgs(['sync', '--group', 'team-a']);
  assert.equal(args.syncMode, true);
  assert.equal(args.groupFilter, 'team-a');
  assert.equal(args.syncFilter, null);
});

test('parseArgs: captures --watch long flag for sync', () => {
  const args = parseArgs(['sync', '--watch']);
  assert.equal(args.syncMode, true);
  assert.equal(args.watchMode, true);
});

test('parseArgs: captures -w short flag for sync', () => {
  const args = parseArgs(['sync', '-w']);
  assert.equal(args.syncMode, true);
  assert.equal(args.watchMode, true);
});

test('parseArgs: combines sync with watch and filter', () => {
  const args = parseArgs(['sync', 'my-target', '--watch']);
  assert.equal(args.syncMode, true);
  assert.equal(args.syncFilter, 'my-target');
  assert.equal(args.watchMode, true);
});
