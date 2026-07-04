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

  const baseTargets = Array.isArray(data.targets) ? [...data.targets] : [];

  const groupTargets = (Array.isArray(data.groups) ? data.groups : []).flatMap((group) => {
    if (!group || typeof group !== 'object') return [];
    const { targets: gTargets, name: groupName, ...groupDefaults } = group;
    if (!Array.isArray(gTargets)) return [];
    return gTargets
      .filter((t) => t && typeof t === 'object')
      .map((target) => {
        let resolvedPath = target.path;
        if (!resolvedPath && target.relativePath && groupDefaults.path) {
          // Combine group path and target relativePath cleanly
          resolvedPath = path.join(groupDefaults.path, target.relativePath);
        }

        // Include the resolved path in the flattened target object if computed
        return Object.assign(
          { group: groupName || groupDefaults.group },
          groupDefaults,
          target,
          resolvedPath ? { path: resolvedPath } : {}
        );
      });
  });

  data.targets = baseTargets.concat(groupTargets);
  return data;
}

const projectFile = path.resolve(process.cwd(), 'notiondrive.config.json');
const userFile = path.join(os.homedir(), '.notiondrive', 'config.json');

const manifests = [];
if (fs.existsSync(projectFile)) {
  try {
    const raw = fs.readFileSync(projectFile, 'utf8');
    let parsed = JSON.parse(raw);
    // Flatten grouped manifests into unified targets list
    parsed = flattenManifest(parsed);
    manifests.push({ type: 'project', path: projectFile, manifest: parsed });
  } catch (e) {
    console.error('Failed to parse project manifest', e.message);
  }
}
if (fs.existsSync(userFile)) {
  try {
    const raw = fs.readFileSync(userFile, 'utf8');
    let parsed = JSON.parse(raw);
    parsed = flattenManifest(parsed);
    manifests.push({ type: 'user', path: userFile, manifest: parsed });
  } catch (e) {
    console.error('Failed to parse user manifest', e.message);
  }
}
if (manifests.length === 0) {
  console.log('No project or user manifest files found.');
  process.exit(0);
}

const entries = [];
for (const m of manifests) {
  const targets = m.manifest && Array.isArray(m.manifest.targets) ? m.manifest.targets : [];
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    if (!t) continue;
    try {
      const pageId = extractNotionId(t.source || '');
      const providedFilename = typeof t.filename === 'string' && t.filename.trim() ? t.filename.trim() : null;
      let targetFilename;
      if (providedFilename) {
        targetFilename = providedFilename;
      } else {
        targetFilename = `${slugifyFilename(t.name || pageId)}.md`;
      }
      const rawOutDir = t.outDir || process.cwd();
      const expandedOutDir = rawOutDir && rawOutDir.startsWith('~') ? path.join(os.homedir(), rawOutDir.slice(1)) : rawOutDir;
      const absoluteLocalPath = path.resolve(expandedOutDir || process.cwd(), targetFilename);
      entries.push({ manifestType: m.type, manifestPath: m.path, index: i, target: t, absoluteLocalPath });
    } catch (e) {
      console.error('Error computing path for target', e.message);
    }
  }
}

const byPath = new Map();
for (const e of entries) {
  const list = byPath.get(e.absoluteLocalPath) || [];
  list.push(e);
  byPath.set(e.absoluteLocalPath, list);
}

let found = false;
for (const [p, list] of byPath.entries()) {
  if (list.length > 1) {
    found = true;
    console.log('\nCollision for path:', p);
    for (const it of list) {
      console.log(`- defined in ${it.manifestType} manifest: ${it.manifestPath} (target index ${it.index})`);
      console.log(`  name: ${it.target.name || '<no-name>'}`);
      console.log(`  filename: ${it.target.filename || '<none>'}`);
      console.log(`  outDir: ${it.target.outDir || '<none>'}`);
      console.log(`  source: ${it.target.source || '<none>'}`);
    }
  }
}
if (!found) console.log('No collisions found between project and user manifests.');
