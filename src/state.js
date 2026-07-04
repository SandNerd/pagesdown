import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import crypto from 'node:crypto';
import { safeMerge } from './utils.js';
const GLOBAL_STATE_DIR = join(homedir(), '.notiondrive');
const GLOBAL_STATE_FILE = join(GLOBAL_STATE_DIR, 'state.json');

function resolveStateFilePaths() {
  if (process.env.NOTIONDRIVE_STATE_FILE && typeof process.env.NOTIONDRIVE_STATE_FILE === 'string') {
    return { explicit: resolve(process.env.NOTIONDRIVE_STATE_FILE) };
  }
  const global = GLOBAL_STATE_FILE;
  return { global };
}

function normalizeLegacy(parsed) {
  // Legacy shape: { '<relPath>': { notion_id, last_synced_remote_mtime, last_synced_local_hash } }
  const out = { byNotionId: {}, byPath: {} };
  for (const [rel, rec] of Object.entries(parsed || {})) {
    const nid = rec && rec.notion_id ? String(rec.notion_id) : null;
    if (!nid) {
      // store as path-only mapping under special null key
      out.byPath[rel] = null;
      continue;
    }
    out.byPath[rel] = nid;
    out.byNotionId[nid] = out.byNotionId[nid] || { notion_id: nid, outputs: {} };
    out.byNotionId[nid].outputs[rel] = {
      last_synced_remote_mtime: rec.last_synced_remote_mtime || null,
      last_synced_local_hash: rec.last_synced_local_hash || null,
    };
  }
  return out;
}

export async function loadStateLedger() {
  const emptyLedger = { byNotionId: {}, byPath: {} };
  const paths = resolveStateFilePaths();
  let buf = null;

  // If an explicit path is provided, prefer it
  if (paths.explicit) {
    try {
      buf = await readFile(paths.explicit, 'utf-8');
    } catch (err) {
      // fallthrough to other locations
      buf = null;
    }
  }

  // Prefer explicit path, then global ledger.
  if (!buf) {
    try {
      const stg = await stat(paths.global);
      if (stg && stg.isFile()) {
        buf = await readFile(paths.global, 'utf-8');
      }
    } catch (err) {
      // ignore
    }
  }

  if (!buf) return emptyLedger;

  const parsed = (() => {
    try {
      return JSON.parse(buf);
    } catch (err) {
      throw err;
    }
  })();

  if (!parsed || typeof parsed !== 'object') return emptyLedger;

  // If already normalized
  if (parsed.byNotionId || parsed.byPath) {
    return safeMerge({ byNotionId: {}, byPath: {} }, parsed);
  }

  // Legacy shape: convert
  return normalizeLegacy(parsed);
}

export async function saveStateLedger(state) {
  const out = safeMerge({ byNotionId: {}, byPath: {} }, state || {});
  const data = JSON.stringify(out, null, 2) + '\n';

  const paths = resolveStateFilePaths();
  // If an explicit path is requested, write there
  if (paths.explicit) {
    try {
      await mkdir(dirname(paths.explicit), { recursive: true, mode: 0o700 });
    } catch (err) {}
    await writeFile(paths.explicit, data, { encoding: 'utf-8', mode: 0o600 });
    return;
  }

  // Default: ensure global directory and write to ~/.notiondrive/state.json
  try {
    await mkdir(dirname(paths.global), { recursive: true, mode: 0o700 });
  } catch (err) {}
  await writeFile(paths.global, data, { encoding: 'utf-8', mode: 0o600 });
}

export async function calculateFileHash(filePath) {
  const abs = resolve(process.cwd(), filePath);
  const buf = await readFile(abs);
  const h = crypto.createHash('sha256');
  h.update(buf);
  return h.digest('hex');
}

export default { loadStateLedger, saveStateLedger, calculateFileHash };
