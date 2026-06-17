#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

async function main() {
  const schemaPath = path.resolve(process.cwd(), 'schemas/config.schema.json');
  const configPath = process.argv[2] || path.join(os.homedir(), '.notiondrive', 'config.json');

  try {
    const [schemaRaw, configRaw] = await Promise.all([
      fs.readFile(schemaPath, 'utf8'),
      fs.readFile(configPath, 'utf8'),
    ]);

    let schema;
    try {
      schema = JSON.parse(schemaRaw);
    } catch (err) {
      console.error(`Invalid schema JSON at ${schemaPath}: ${err.message}`);
      process.exit(1);
    }
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
        pathVariant.properties.path = { type: 'string' };
        pathVariant.required = (pathVariant.required || []).filter((r) => r !== 'outDir' && r !== 'filename');
        if (!pathVariant.required.includes('path')) pathVariant.required.push('path');
        schema.properties.targets.items = { anyOf: [originalItem, pathVariant] };
      }
    } catch (e) {
      // If patching fails for any reason, fall back to the unmodified schema.
    }
    let config;
    try {
      config = JSON.parse(configRaw);
    } catch (err) {
      console.error(`Failed to parse config file ${configPath}: ${err.message}`);
      process.exit(1);
    }

    // Normalize grouped manifests into a flat targets array to make validation
    // and downstream tooling simpler.
    function flattenManifest(data) {
      if (!data || typeof data !== 'object') return data;
      const flatTargets = [];
      if (Array.isArray(data.targets)) flatTargets.push(...data.targets);
      if (Array.isArray(data.groups)) {
        for (const group of data.groups) {
          if (!group || typeof group !== 'object') continue;
          const { targets: groupTargets, name: groupName, ...groupDefaults } = group;
          if (Array.isArray(groupTargets)) {
            for (const target of groupTargets) {
              if (!target || typeof target !== 'object') continue;
              flatTargets.push({ group: groupName || groupDefaults.group, ...groupDefaults, ...target });
            }
          }
        }
      }
      data.targets = flatTargets;
      return data;
    }
    config = flattenManifest(config);

    let AjvModule;
    try {
      AjvModule = (await import('ajv')).default;
    } catch (err) {
      console.error('Dependency missing: please install `ajv` first:');
      console.error('  npm install --save-dev ajv');
      process.exit(2);
    }

    const Ajv = AjvModule;
    const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
    // Enable common format validators (uri, email, date-time, etc.)
    let addFormats;
    try {
      addFormats = (await import('ajv-formats')).default || (await import('ajv-formats'));
    } catch (err) {
      console.error('Dependency missing: please install `ajv-formats` to validate URI formats:');
      console.error('  npm install --save-dev ajv-formats');
      process.exit(2);
    }
    addFormats(ajv);
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
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
