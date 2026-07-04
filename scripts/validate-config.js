#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

async function loadJson(path, label) {
  const raw = await readFile(path, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON (${label}): ${err.message}`);
  }
}

function patchSchemaForPathTarget(schema) {
  // Backwards-compatibility: accept a new `path` target field in addition to
  // the legacy `outDir`/`filename` shape. We do this by wrapping the existing
  // targets item schema in an `anyOf` that also accepts a variant requiring
  // `path` so users can validate manifests that use `path` without changing
  // the on-disk schema file.
  try {
    if (schema && schema.properties && schema.properties.targets && schema.properties.targets.items) {
      const originalItem = schema.properties.targets.items;
      const pathVariant = JSON.parse(JSON.stringify(originalItem));
      if (!pathVariant.properties) pathVariant.properties = {};
      pathVariant.type = 'object';
      pathVariant.properties.path = { type: 'string' };
      pathVariant.required = (pathVariant.required || []).filter((r) => r !== 'outDir' && r !== 'filename');
      if (!pathVariant.required.includes('path')) pathVariant.required.push('path');
      schema.properties.targets.items = { anyOf: [originalItem, pathVariant] };
    }
  } catch {
    // If patching fails for any reason, fall back to the unmodified schema.
  }

  return schema;
}

function normalizeTargetFromGroup(groupName, groupDefaults, target) {
  if (!target || typeof target !== 'object') return null;

  let resolvedPath = target.path;
  if (!resolvedPath && target.relativePath && groupDefaults.path) {
    // Combine group path and target relativePath cleanly
    resolvedPath = join(groupDefaults.path, target.relativePath);
  }

  // Include the resolved path in the normalized target object if computed
  const normalizedTarget = Object.assign(
    { group: groupName || groupDefaults.group },
    groupDefaults,
    target,
    resolvedPath ? { path: resolvedPath } : {}
  );
  return normalizedTarget;
}

function flattenGroup(group) {
  if (!group || typeof group !== 'object') return [];
  const { targets: groupTargets, name: groupName, ...groupDefaults } = group;
  if (!Array.isArray(groupTargets)) return [];

  const out = [];
  for (const target of groupTargets) {
    const normalized = normalizeTargetFromGroup(groupName, groupDefaults, target);
    if (!normalized) continue;
    out.push(normalized);
  }
  return out;
}

function flattenManifest(data) {
  if (!data || typeof data !== 'object') return data;

  const flatTargets = Array.isArray(data.targets) ? [...data.targets] : [];
  if (Array.isArray(data.groups)) {
    for (const group of data.groups) {
      flatTargets.push(...flattenGroup(group));
    }
  }

  data.targets = flatTargets;
  return data;
}

async function createValidator() {
  let AjvModule;
  try {
    AjvModule = (await import('ajv')).default;
  } catch {
    console.error('Dependency missing: please install `ajv` first:');
    console.error('  npm install --save-dev ajv');
    process.exit(2);
  }

  const Ajv = AjvModule;
  const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });

  let addFormats;
  try {
    addFormats = (await import('ajv-formats')).default || (await import('ajv-formats'));
  } catch {
    console.error('Dependency missing: please install `ajv-formats` to validate URI formats:');
    console.error('  npm install --save-dev ajv-formats');
    process.exit(2);
  }
  addFormats(ajv);
  return ajv;
}

async function main() {
  const schemaPath = resolve(process.cwd(), 'schemas/config.schema.json');
  const configPath = process.argv[2] || join(homedir(), '.notiondrive', 'config.json');

  const [schemaRaw, configRaw] = await Promise.all([
    readFile(schemaPath, 'utf8'),
    readFile(configPath, 'utf8'),
  ]);

  let schema;
  try {
    schema = JSON.parse(schemaRaw);
  } catch (err) {
    console.error(`Invalid schema JSON at ${schemaPath}: ${err.message}`);
    process.exit(1);
  }

  schema = patchSchemaForPathTarget(schema);
  let config;
  try {
    config = JSON.parse(configRaw);
  } catch (err) {
    console.error(`Failed to parse config file ${configPath}: ${err.message}`);
    process.exit(1);
  }

  config = flattenManifest(config);
  const ajv = await createValidator();
  const validate = ajv.compile(schema);
  const valid = validate(config);

  if (valid) {
    console.log(`Valid: ${configPath}`);
    process.exit(0);
  }

  console.error(`Invalid: ${configPath}`);
  for (const err of validate.errors || []) {
    console.error(`- ${err.instancePath || '/'} ${err.message}`);
  }
  process.exit(3);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
