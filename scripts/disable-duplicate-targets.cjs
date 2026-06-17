#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');

function slugifyFilename(title){
  if (!title || !title.trim()) return 'untitled';
  return title
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
}
function extractNotionId(input){
  if (!input || typeof input !== 'string') return input;
  const re = /([a-f0-9]{8}-?[a-f0-9]{4}-?[a-f0-9]{4}-?[a-f0-9]{4}-?[a-f0-9]{12})|([a-f0-9]{32})/i;
  const m = input.match(re);
  if (!m) return input;
  const id = (m[1] || m[2] || '').replace(/-/g, '');
  return id;
}

function flattenManifest(data) {
  if (!data || typeof data !== 'object') return data;
  const flatTargets = [];

  if (Array.isArray(data.targets)) flatTargets.push(...data.targets);

  if (Array.isArray(data.groups)) {
    for (const group of data.groups) {
      if (!group || typeof group !== 'object') continue;
      const groupTargets = group.targets;
      const groupName = group.name;
      const groupDefaults = {};
      for (const k in group) {
        if (k !== 'targets' && k !== 'name') groupDefaults[k] = group[k];
      }
      if (Array.isArray(groupTargets)) {
        for (const target of groupTargets) {
          if (!target || typeof target !== 'object') continue;
          flatTargets.push(Object.assign({ group: groupName || groupDefaults.group }, groupDefaults, target));
        }
      }
    }
  }

  data.targets = flatTargets;
  return data;
}

const args = process.argv.slice(2);
const doApply = args.includes('--apply') || args.includes('-a');
const verbose = args.includes('--verbose') || args.includes('-v');

const projectFile = path.resolve(process.cwd(), 'notiondrive.config.json');
const userFile = path.join(os.homedir(), '.notiondrive', 'config.json');

const manifests = [];
if (fs.existsSync(projectFile)) {
  try {
    const raw = fs.readFileSync(projectFile, 'utf8');
    let parsed = JSON.parse(raw);
    parsed = flattenManifest(parsed);
    manifests.push({ type: 'project', path: projectFile, manifest: parsed, raw });
  } catch (e) {
    console.error('Failed to parse project manifest', e.message);
  }
}
if (fs.existsSync(userFile)) {
  try {
    const raw = fs.readFileSync(userFile, 'utf8');
    let parsed = JSON.parse(raw);
    parsed = flattenManifest(parsed);
    manifests.push({ type: 'user', path: userFile, manifest: parsed, raw });
  } catch (e) {
    console.error('Failed to parse user manifest', e.message);
  }
}
if (manifests.length === 0) {
  console.log('No project or user manifest files found.');
  process.exit(0);
}

function resolveTargetPath(t) {
  const pageId = extractNotionId(t.source || '');
  const providedFilename = typeof t.filename === 'string' && t.filename.trim() ? t.filename.trim() : null;
  const targetFilename = providedFilename ? providedFilename : `${slugifyFilename(t.name || pageId)}.md`;
  const rawOutDir = t.outDir || process.cwd();
  const expandedOutDir = rawOutDir && rawOutDir.startsWith('~') ? path.join(os.homedir(), rawOutDir.slice(1)) : rawOutDir;
  const absoluteLocalPath = path.resolve(expandedOutDir || process.cwd(), targetFilename);
  return absoluteLocalPath;
}

const entries = [];
for (const m of manifests) {
  const targets = m.manifest && Array.isArray(m.manifest.targets) ? m.manifest.targets : [];
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    if (!t) continue;
    const abs = resolveTargetPath(t);
    entries.push({ manifest: m, index: i, target: t, abs });
  }
}

const byPath = new Map();
for (const e of entries) {
  const list = byPath.get(e.abs) || [];
  list.push(e);
  byPath.set(e.abs, list);
}

const changes = [];
for (const [p, list] of byPath.entries()) {
  if (list.length > 1) {
    // keep the first, disable the rest
    for (let i = 1; i < list.length; i++) {
      const e = list[i];
      // Skip if already disabled
      if (e.target.disabled === true) continue;
      changes.push({ path: e.manifest.path, index: e.index, name: e.target.name || '<no-name>' });
    }
  }
}

if (changes.length === 0) {
  console.log('No duplicate targets to disable.');
  process.exit(0);
}

console.log('Planned changes:');
for (const c of changes) {
  console.log(`- ${c.path}: targets[${c.index}] (name=${c.name}) -> will be disabled`);
}

if (!doApply) {
  console.log('\nDry-run mode (no files modified). Run with --apply to make the changes.');
  process.exit(0);
}

// Apply changes grouped by manifest file
const grouped = new Map();
for (const c of changes) {
  const list = grouped.get(c.path) || [];
  list.push(c.index);
  grouped.set(c.path, list);
}

for (const [mPath, idxs] of grouped.entries()) {
  try {
    const raw = fs.readFileSync(mPath, 'utf8');
    const parsed = JSON.parse(raw);
    // Work on a flattened view so we can reliably index into targets
    const flattened = flattenManifest(JSON.parse(raw));
    for (const idx of idxs) {
      if (flattened.targets && flattened.targets[idx]) {
        flattened.targets[idx].disabled = true;
      }
    }
    // Persist flattened targets back to disk (this will convert grouped manifests
    // into a top-level `targets` array). This keeps the behavior simple and
    // deterministic for the CLI tooling.
    parsed.targets = flattened.targets;
    delete parsed.groups;
    const out = JSON.stringify(parsed, null, 2) + '\n';
    fs.writeFileSync(mPath, out, { encoding: 'utf8', mode: 0o600 });
    console.log(`Updated ${mPath}: disabled targets[${idxs.join(',')}].`);
  } catch (err) {
    console.error(`Failed to update ${mPath}: ${err.message}`);
  }
}

console.log('Done.');
