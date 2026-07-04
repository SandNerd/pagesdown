import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { wrapError } from './error.js';
import path from 'node:path';
import os from 'node:os';

const CONFIG_DIR = path.join(os.homedir(), '.notiondrive');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

/**
 * Remove trailing commas that appear before a closing `}` or `]`.
 * This scanner avoids touching commas that are inside JSON strings.
 */
function removeTrailingCommas(raw) {
  function isWhitespace(c) {
    return /\s/.test(c);
  }

  function nextNonWhitespaceIndex(str, start) {
    let j = start;
    while (j < str.length && isWhitespace(str[j])) j++;
    return j;
  }

  function readStringEnd(str, start) {
    // start points to opening quote
    let i = start + 1;
    while (i < str.length) {
      const ch = str[i];
      if (ch === '\\') {
        i += 2; // skip escaped char
        continue;
      }
      if (ch === '"') return i + 1;
      i++;
    }
    return i;
  }

  let out = '';
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '"') {
      const end = readStringEnd(raw, i);
      out += raw.slice(i, end);
      i = end;
      continue;
    }

    if (ch === ',') {
      const j = nextNonWhitespaceIndex(raw, i + 1);
      const next = raw[j];
      if (next === '}' || next === ']') {
        i++;
        continue; // skip trailing comma
      }
    }

    out += ch;
    i++;
  }

  return out;
}

function tolerantJsonParse(text, opts = {}) {
  try {
    return JSON.parse(text);
  } catch (err) {
    // Fallback: remove obvious trailing commas and try strict parse
    try {
      const cleaned = removeTrailingCommas(text);
      const parsed = JSON.parse(cleaned);
      console.warn(
        'Parsed config after removing trailing commas.',
        opts.path || 'your config file',
        '\nRecommendation: add a JSON Schema entry to enable editor validation:',
        '\n  "$schema": "https://raw.githubusercontent.com/neethanwu/notiondrive/main/schemas/config.schema.json"',
        '\nor run `npm run validate-config` to check the file.'
      );
      return parsed;
    } catch (err2) {
      throw err;
    }
  }
}

/**
 * Load saved config. Returns { token, workspace } or null if none/invalid.
 */
export async function loadConfig() {
  try {
    const data = await readFile(CONFIG_FILE, 'utf-8');
    const parsed = await tolerantJsonParse(data, { path: CONFIG_FILE });
    // Apply manifest flattening so callers can rely on `targets` uniformly
    const flattened = flattenManifest(parsed);
    // Return the parsed config object (may or may not include a token).
    // Callers will handle absence of token separately.
    if (flattened && typeof flattened === 'object') {
      return flattened;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Load project-local notiondrive.config.json from current working directory.
 * Returns the parsed object or null if the file does not exist.
 */
export async function loadProjectConfig() {
  const projectFile = path.resolve(process.cwd(), 'notiondrive.config.json');
  try {
    const data = await readFile(projectFile, 'utf-8');
    const parsed = await tolerantJsonParse(data, { path: projectFile });
    if (parsed && typeof parsed === 'object') {
      return flattenManifest(parsed);
    }
    return null;
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return null;
    }
    throw wrapError(`Failed to load ${projectFile}`, err);
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
  function _expandGroups(groups) {
    if (!Array.isArray(groups)) return;
    for (const group of groups) {
      if (!group || typeof group !== 'object') continue;
      const { targets: groupTargets, name: groupName, ...groupDefaults } = group;
      if (!Array.isArray(groupTargets)) continue;
      for (const target of groupTargets) {
        if (!target || typeof target !== 'object') continue;

        let resolvedPath = target.path;
        if (!resolvedPath && target.relativePath && groupDefaults.path) {
          // Combine group path and target relativePath cleanly
          resolvedPath = path.join(groupDefaults.path, target.relativePath);
        }

        // Include the resolved path in the flattened target object if computed
        const flattenedTarget = Object.assign(
          { group: groupName || groupDefaults.group },
          groupDefaults,
          target,
          resolvedPath ? { path: resolvedPath } : {}
        );
        flatTargets.push(flattenedTarget);
      }
    }
  }

  if (hadGroups) _expandGroups(data.groups);

  // Only assign a `targets` property if the original input had targets/groups
  // or if we built a non-empty flattened list. This avoids adding empty
  // artifacts to user config files that don't define sync targets.
  if (hadTargets || hadGroups || flatTargets.length > 0) {
    data.targets = flatTargets;
  }

  return data;
}

/**
 * Save config to ~/.notiondrive/config.json.
 * Directory and file are created with restrictive permissions from the start.
 */
export async function saveConfig(config) {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });
}
