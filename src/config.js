import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const CONFIG_DIR = path.join(os.homedir(), '.pagesdown');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

/**
 * Load saved config. Returns { token, workspace } or null if none/invalid.
 */
export async function loadConfig() {
  try {
    const data = await readFile(CONFIG_FILE, 'utf-8');
    const parsed = JSON.parse(data);
    // Apply manifest flattening so callers can rely on `targets` uniformly
    const flattened = flattenManifest(parsed);
    // Validate shape — token must be a string if present
    if (flattened && typeof flattened === 'object' && typeof flattened.token === 'string') {
      return flattened;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Load project-local pagesdown.config.json from current working directory.
 * Returns the parsed object or null if the file does not exist.
 */
export async function loadProjectConfig() {
  const projectFile = path.resolve(process.cwd(), 'pagesdown.config.json');
  try {
    const data = await readFile(projectFile, 'utf-8');
    const parsed = JSON.parse(data);
    if (parsed && typeof parsed === 'object') {
      return flattenManifest(parsed);
    }
    return null;
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return null;
    }
    throw new Error(`Failed to load ${projectFile}: ${err.message}`);
  }
}

/**
 * Flatten manifest layout by expanding `groups` into a unified `targets` array.
 * Group-level defaults are applied and individual targets override group defaults.
 */
export function flattenManifest(data) {
  if (!data || typeof data !== 'object') return data;
  const flatTargets = [];

  const hadTargets = Array.isArray(data.targets);
  const hadGroups = Array.isArray(data.groups);

  // Preserve existing top-level standalone targets if present
  if (hadTargets) {
    flatTargets.push(...data.targets);
  }

  // Explode nested group targets and pass down cascading properties
  if (hadGroups) {
    for (const group of data.groups) {
      if (!group || typeof group !== 'object') continue;

      const { targets: groupTargets, name: groupName, ...groupDefaults } = group;

      if (Array.isArray(groupTargets)) {
        for (const target of groupTargets) {
          if (!target || typeof target !== 'object') continue;

          // Combine parameters: target attributes overwrite group defaults
          flatTargets.push({
            group: groupName || groupDefaults.group,
            ...groupDefaults,
            ...target,
          });
        }
      }
    }
  }

  // Only assign a `targets` property if the original input had targets/groups
  // or if we built a non-empty flattened list. This avoids adding empty
  // artifacts to user config files that don't define sync targets.
  if (hadTargets || hadGroups || flatTargets.length > 0) {
    data.targets = flatTargets;
  }

  return data;
}

/**
 * Save config to ~/.pagesdown/config.json.
 * Directory and file are created with restrictive permissions from the start.
 */
export async function saveConfig(config) {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });
}
