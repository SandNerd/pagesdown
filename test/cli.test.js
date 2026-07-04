import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, extractNotionId, getHeadlessExitCode } from '../src/cli.js';

test('parseArgs recognizes flags and type', () => {
  const args = parseArgs(['--format', 'flattened', '--out', '/tmp', '--type', 'csv', '--debug']);
  assert.equal(args.format, 'flattened');
  assert.equal(args.out, '/tmp');
  assert.equal(args.type, 'csv');
  assert.equal(args.debug, true);
});

test('parseArgs preserves token short flag', () => {
  const args = parseArgs(['-t', 'ntn_example_token']);
  assert.equal(args.token, 'ntn_example_token');
});

test('extractNotionId extracts 32 char id or hyphenated', () => {
  const id = extractNotionId('https://notion.so/Page-Title-0123456789abcdef0123456789abcdef');
  assert.equal(id.length, 32);
});

test('getHeadlessExitCode fails when stats contain errors', () => {
  assert.equal(getHeadlessExitCode({ errors: [] }), 0);
  assert.equal(getHeadlessExitCode({ errors: [{ title: 'x', error: 'y' }] }), 1);
});
