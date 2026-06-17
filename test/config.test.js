import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function importConfigWithHome(home) {
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const module = await import(`../src/config.js?home=${Date.now()}-${Math.random()}`);
  process.env.HOME = previousHome;
  return module;
}

test('loadConfig returns null when config is missing', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'notiondrive-home-'));
  try {
    const { loadConfig } = await importConfigWithHome(home);
    const config = await loadConfig();
    assert.equal(config, null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('saveConfig persists and loadConfig reads valid token config', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'notiondrive-home-'));
  try {
    const { saveConfig, loadConfig } = await importConfigWithHome(home);
    const input = { token: 'ntn_test', workspace: 'ws', defaultOutputDir: '/tmp/x' };
    await saveConfig(input);

    const loaded = await loadConfig();
    assert.deepEqual(loaded, input);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('loadConfig returns null for invalid JSON and bad shape', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'notiondrive-home-'));
  try {
    const notiondriveDir = path.join(home, '.notiondrive');
    await writeFile(path.join(home, 'seed.txt'), 'ok', 'utf8');

    const { loadConfig, saveConfig } = await importConfigWithHome(home);
    await saveConfig({ token: 'ntn_seed' });

    const configFile = path.join(notiondriveDir, 'config.json');
    await writeFile(configFile, '{ invalid', 'utf8');
    assert.equal(await loadConfig(), null);

    await writeFile(configFile, JSON.stringify({ token: 123 }), 'utf8');
    assert.equal(await loadConfig(), null);

    await writeFile(configFile, JSON.stringify({ token: 'ntn_ok', workspace: 'x' }), 'utf8');
    assert.deepEqual(await loadConfig(), { token: 'ntn_ok', workspace: 'x' });

    const raw = await readFile(configFile, 'utf8');
    assert.ok(raw.includes('ntn_ok'));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('loadProjectConfig reads local notiondrive.config.json', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'notiondrive-home-'));
  const cwd = await mkdtemp(path.join(tmpdir(), 'notiondrive-cwd-'));
  const originalCwd = process.cwd();
  try {
    const { loadProjectConfig } = await importConfigWithHome(home);
    process.chdir(cwd);

    const input = {
      token: 'ntn_local',
      defaultOutputDir: './exports',
      targets: [{ source: 'https://notion.so/page', outDir: './exports' }],
    };
    await writeFile(path.join(cwd, 'notiondrive.config.json'), JSON.stringify(input), 'utf8');

    const loaded = await loadProjectConfig();
    assert.deepEqual(loaded, input);
  } finally {
    process.chdir(originalCwd);
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test('project config precedence overrides saved config values', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'notiondrive-home-'));
  try {
    const { resolveConfigSources } = await import(`../src/cli.js?resolve=${Date.now()}-${Math.random()}`);
    const resolved = resolveConfigSources(
      { token: 'ntn_local', defaultOutputDir: './local', workspace: 'local-ws' },
      { token: 'ntn_saved', defaultOutputDir: './saved', workspace: 'saved-ws' },
      'ntn_env'
    );

    assert.deepEqual(resolved, {
      token: 'ntn_local',
      defaultOutputDir: './local',
      workspace: 'local-ws',
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('resolveSyncManifest prefers local targets and falls back to saved config', async () => {
  const { resolveSyncManifest } = await import(`../src/cli.js?syncresolve=${Date.now()}-${Math.random()}`);

  const local = { token: 'ntn_local', targets: [{ source: 'https://notion.so/local', outDir: './local' }] };
  const saved = { token: 'ntn_saved', targets: [{ source: 'https://notion.so/saved', outDir: './saved' }] };

  assert.deepEqual(resolveSyncManifest(local, saved), local);
  assert.deepEqual(resolveSyncManifest({}, saved), saved);
  assert.equal(resolveSyncManifest({}, {}), null);
});
