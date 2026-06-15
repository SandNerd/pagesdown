import path from 'node:path';
import os from 'node:os';
import * as p from '@clack/prompts';
import { NotionClient } from './notion.js';
import { extractTitle, extractDatabaseTitle } from './notion-helpers.js';
import { downloadPages } from './download.js';
import { isWritablePath, slugifyFilename } from './utils.js';
import { extractNotionId } from './cli.js';
import { loadStateLedger, saveStateLedger, calculateFileHash } from './state.js';
import { markdownToNotionBlocks } from './parser.js';
import fs from 'node:fs/promises';
import { watch } from 'node:fs';

async function pushLocalFileToNotion({ notion, pageId, targetItem, target, localOutputPath, currentLocalHash, ledger, saveStateLedgerFn }) {
  const localContent = await fs.readFile(localOutputPath, 'utf-8');
  // Safety: detect flattened markdown tables or embedded sub-page markers that
  // would indicate pushing this raw markdown could overwrite active database
  // structures in Notion. If detected, abort the push to protect live data.
  try {
    const tablePattern = /\|\s*:?-{3,}[^\n]*\|/i; // matches | --- | or |:--- |
    const subpagePattern = /\[\[.+\]\]|<!--\s*child_page|<!--\s*subpage|child_page|child_database/i;
    if (tablePattern.test(localContent) || subpagePattern.test(localContent)) {
      const overrideActive = target && (target.sync === 'push-override' || target.sync === 'two-way-override');
      if (overrideActive) {
        console.debug('[SAFETY] Table structural signatures found, but override sync option is active. Forcing push upstream.');
      } else {
        console.warn(`[SAFETY BYPASS] Aborting push for target "${targetItem.name || targetItem.id}". This file contains flattened inline tables or sub-pages. Pushing would destroy active database components in Notion. Set sync to \"push-override\"/\"two-way-override\" to force.`);
        return null;
      }
    }
  } catch (err) {
    // Non-fatal: if safety check fails for any reason, proceed with caution (do not block push)
  }
  const blocks = markdownToNotionBlocks(localContent, localOutputPath);

  await notion.clearPageContent(pageId);
  const appended = await notion.appendPageContent(pageId, blocks);
  const refreshedPage = await notion.getPage(pageId);
  const newRemoteMtime = refreshedPage?.last_edited_time || targetItem.remoteMtime || null;
  const relKey = path.relative(process.cwd(), localOutputPath);

  ledger.byNotionId = ledger.byNotionId || {};
  ledger.byPath = ledger.byPath || {};
  ledger.byNotionId[pageId] = ledger.byNotionId[pageId] || { notion_id: pageId, outputs: {} };
  const priorRecord = ledger.byNotionId[pageId].outputs[relKey] || {};
  ledger.byNotionId[pageId].outputs[relKey] = {
    last_synced_remote_mtime: newRemoteMtime,
    last_synced_local_hash: currentLocalHash,
    hasSyncedBlocks: priorRecord.hasSyncedBlocks || false,
    dependencies: Array.isArray(priorRecord.dependencies) ? priorRecord.dependencies : [],
  };
  ledger.byPath[relKey] = pageId;
  await saveStateLedgerFn(ledger);

  return appended;
}

async function fetchDependencySnapshot(notion, dependency) {
  if (!dependency || !dependency.id || !dependency.type) return null;
  if (dependency.type === 'page') return notion.getPage(dependency.id);
  if (dependency.type === 'database') return notion.getDatabase(dependency.id);
  if (dependency.type === 'block') return notion.getBlock(dependency.id);
  return null;
}

async function dependenciesChanged(notion, dependencies) {
  if (!Array.isArray(dependencies) || dependencies.length === 0) return false;

  const snapshots = await Promise.all(dependencies.map(async (dependency) => {
    try {
      const live = await fetchDependencySnapshot(notion, dependency);
      return {
        dependency,
        liveMtime: live?.last_edited_time || null,
        changed: String(live?.last_edited_time || null) !== String(dependency.mtime || null),
      };
    } catch {
      return { dependency, liveMtime: null, changed: true };
    }
  }));

  return snapshots.some((snapshot) => snapshot.changed);
}

/**
 * Execute batch sync from manifest targets
 */
export async function executeSyncMode(manifest, token, args, overrides = {}) {
  const prompts = overrides.prompts || p;

  // Validate token
  if (!token) {
    prompts.log.error('No Notion token found. Set NOTION_TOKEN or save a token with the CLI (pagesdown --token <token>).');
    return { completedTargets: [], failedTargets: [{ target: null, error: 'No Notion token' }] };
  }

  // Connect and validate
  const spin = prompts.spinner();
  spin.start('Connecting to Notion...');
  const NotionClass = overrides.notionClass || NotionClient;
  const downloadFn = overrides.downloadPages || downloadPages;
  const loadStateLedgerFn = overrides.loadStateLedger || loadStateLedger;
  const saveStateLedgerFn = overrides.saveStateLedger || saveStateLedger;

  // Allow passing a mock notion client directly
  const notion = overrides.notion || new NotionClass(token);
  try {
    if (!overrides.notion) {
      await notion.validateToken();
    }
    spin.stop('Connected to Notion.');
  } catch (err) {
    spin.stop('Connection failed.');
    prompts.log.error(
      err.status === 401
        ? 'Invalid token. Make sure you copied the "Internal Integration Secret", not the Integration ID.'
        : 'Could not connect to Notion. Check your internet connection and try again.'
    );
    return { completedTargets: [], failedTargets: [{ target: null, error: 'Connection failed' }] };
  }

  // Process each target (apply optional filters before network calls)
  let targets = manifest.targets || [];

  // If filtering requested, apply name/group filters before processing
  const syncFilter = args?.syncFilter || null;
  const groupFilter = args?.groupFilter || null;

  if (syncFilter || groupFilter) {
    // Warn if some targets do not have `name` defined — helpful for targeted runs
    const missingNameTargets = targets.filter((t) => !t || typeof t.name !== 'string' || t.name.trim() === '');
    if (missingNameTargets.length > 0) {
      prompts.log.warn('Tip: Some targets in your manifest are missing a `name` property. Add descriptive `name` values to enable targeted syncs by name or group.');
    }

    let filtered = targets;
    if (syncFilter) {
      filtered = filtered.filter((t) => (t && (t.name === syncFilter || t.group === syncFilter)));
    }
    if (groupFilter) {
      filtered = filtered.filter((t) => (t && t.group === groupFilter));
    }

    if (!filtered || filtered.length === 0) {
      const filterText = syncFilter || groupFilter || '';
      prompts.log.warn(`No targets found matching filter: "${filterText}". Check your pagesdown.config.json names.`);
      spin.stop('Batch sync complete.');
      return { completedTargets: [], failedTargets: [] };
    }

    targets = filtered;
  }
  // Remove any targets explicitly marked as disabled in the manifest
  const disabledTargets = targets.filter((t) => t && t.disabled === true);
  if (disabledTargets.length > 0) {
    prompts.log.info(`Skipping ${disabledTargets.length} disabled target${disabledTargets.length === 1 ? '' : 's'} from manifest.`);
    targets = targets.filter((t) => !(t && t.disabled === true));
  }
  if (targets.length === 0) {
    prompts.log.warn('No targets found in pagesdown.config.json');
    return { completedTargets: [], failedTargets: [] };
  }

  spin.start(`Processing ${targets.length} target${targets.length === 1 ? '' : 's'}...`);

  const completedTargets = [];
  const failedTargets = [];

  // Load or initialize local state ledger (unless no-cache requested)
  const useLedger = !args?.noCache;
  let ledger = useLedger ? await loadStateLedgerFn() : { byNotionId: {}, byPath: {} };
  // Work on a clone of the loaded ledger to avoid mutating external references
  if (useLedger && ledger && typeof ledger === 'object') {
    try {
      ledger = JSON.parse(JSON.stringify(ledger));
    } catch (err) {
      // If cloning fails, fall back to using the original ledger object
    }
  }

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    const prefix = `[${i + 1}/${targets.length}]`;

    // Sanitize and validate the source
    if (!target.source || typeof target.source !== 'string' || !target.source.trim()) {
      failedTargets.push({ target, error: 'Missing source' });
      continue;
    }

    let pageId;
    try {
      pageId = extractNotionId(target.source);
    } catch (err) {
      failedTargets.push({ target, error: `Invalid source: ${err.message}` });
      continue;
    }

    // Fetch page/database info
    let targetItem;
    try {
      let page;
      try {
        page = await notion.getPage(pageId);
        const name = extractTitle(page) || 'Exported-Page';
        const remoteMtime = (target.sync === 'push-only' || target.sync === 'push-override') ? null : page?.last_edited_time || null;
        targetItem = { id: pageId, name, type: 'page', customFilename: target.filename, remoteMtime };
      } catch {
        const db = await notion.getDatabase(pageId);
        const name = extractDatabaseTitle(db) || 'Exported-Database';
        const remoteMtime = (target.sync === 'push-only' || target.sync === 'push-override') ? null : db?.last_edited_time || null;
        targetItem = { id: pageId, name, type: 'database', customFilename: target.filename, remoteMtime };
      }
    } catch (err) {
      failedTargets.push({ target, error: `Could not fetch: ${err.message}` });
      continue;
    }

    // Resolve output directory (expand tilde)
    const rawOutDir = target.outDir || process.cwd();
    const expandedOutDir = rawOutDir.startsWith('~') ? path.join(process.env.HOME || os.homedir(), rawOutDir.slice(1)) : rawOutDir;
    const outDir = path.resolve(expandedOutDir);
    if (!(await isWritablePath(outDir))) {
      failedTargets.push({ target, error: `Cannot write to ${outDir}` });
      continue;
    }

    // Determine expected main output filename.
    // If the user provided an explicit `filename` in the manifest, preserve it
    // (including extension) as the primary candidate. Otherwise, generate a
    // slugified base name and look for .md/.csv variants.
    const providedFilename = typeof target.filename === 'string' && target.filename.trim() ? target.filename.trim() : null;
    let slugName;
    let candidatePaths = [];
    if (providedFilename) {
      const ext = path.extname(providedFilename).toLowerCase();
      const base = ext ? path.basename(providedFilename, ext) : providedFilename;
      slugName = base;
      if (ext) {
        candidatePaths = [
          path.join(outDir, providedFilename),
          path.join(outDir, base, providedFilename),
        ];
      } else {
        // Provided filename without extension — treat like a base name
        const gen = slugifyFilename(providedFilename);
        candidatePaths = [
          path.join(outDir, `${gen}.md`),
          path.join(outDir, gen, `${gen}.md`),
          path.join(outDir, `${gen}.csv`),
        ];
      }
    } else {
      slugName = slugifyFilename(targetItem.name || targetItem.id || pageId);
      candidatePaths = [
        path.join(outDir, `${slugName}.md`),
        path.join(outDir, slugName, `${slugName}.md`),
        path.join(outDir, `${slugName}.csv`),
      ];
    }

    let resolvedCandidate = null;
    for (const candidate of candidatePaths) {
      try {
        await fs.stat(candidate);
        const rel = path.relative(process.cwd(), candidate);
        const record = (useLedger && ledger.byNotionId && ledger.byNotionId[pageId] && ledger.byNotionId[pageId].outputs[rel]) || null;
        resolvedCandidate = { candidate, rel, record };
        break;
      } catch {
        continue;
      }
    }

    
    if (target.sync === 'push-only' || target.sync === 'push-override') {
      if (!resolvedCandidate) {
        failedTargets.push({ target, error: `No local file found to upload for ${targetItem.name}` });
        continue;
      }

      let currentLocalHash;
      try {
        currentLocalHash = await calculateFileHash(resolvedCandidate.candidate);
      } catch (err) {
        failedTargets.push({ target, error: `Could not hash ${path.basename(resolvedCandidate.candidate)}: ${err.message}` });
        continue;
      }

      
      if (resolvedCandidate.record && currentLocalHash === resolvedCandidate.record.last_synced_local_hash) {
        prompts.log.info(`[Up to date] ${path.basename(resolvedCandidate.candidate)} (skipped)`);
        completedTargets.push({ target, item: targetItem, skipped: true });
        continue;
      }

      spin.stop('');
      prompts.log.info(`[Uploading] Syncing local edits back to Notion for ${targetItem.name}...`);
      spin.start('...');

      try {
          const appended = await pushLocalFileToNotion({
              notion,
              pageId,
              targetItem,
              target,
              localOutputPath: resolvedCandidate.candidate,
              currentLocalHash,
              ledger,
              saveStateLedgerFn,
            });
        if (!appended) {
          // Safety bypass or early abort occurred inside pushLocalFileToNotion.
          prompts.log.warn(`[SAFETY] Push aborted for ${targetItem.name}. Skipping target.`);
          completedTargets.push({ target, item: targetItem, skipped: true, reason: 'safety-bypass' });
          continue;
        }
        prompts.log.info(`[Uploaded] Successfully synced ${appended} block(s) to Notion`);
        completedTargets.push({ target, item: targetItem, pushed: true });
        continue;
      } catch (err) {
        spin.stop('');
        prompts.log.warn(`[Upload Failed] Could not sync local edits: ${err.message}`);
        spin.start('Continuing...');
        failedTargets.push({ target, error: err.message });
        continue;
      }
    }

    // Check ledger for an up-to-date entry and skip if valid.
    let skipped = false;
    let dependencyMismatch = false;
    for (const candidate of candidatePaths) {
      const rel = path.relative(process.cwd(), candidate);
      if (!useLedger) continue;
      // Find record via byPath or byNotionId
      let record = null;
      let nid = null;
      if (ledger.byPath && ledger.byPath[rel]) {
        nid = ledger.byPath[rel];
        record = nid && ledger.byNotionId && ledger.byNotionId[nid] ? ledger.byNotionId[nid].outputs[rel] : null;
      } else if (ledger.byNotionId && ledger.byNotionId[pageId]) {
        nid = pageId;
        record = ledger.byNotionId[pageId].outputs[rel] || null;
      }
      if (!record) continue;
      // Ensure file physically exists
      try {
        await fs.stat(candidate);
      } catch {
        // Missing file — treat as invalid cache and force download
        break;
      }
      // Calculate local hash and compare
      try {
        const localHash = await calculateFileHash(candidate);
        if (localHash === record.last_synced_local_hash && String(targetItem.remoteMtime) === String(record.last_synced_remote_mtime)) {
          if (Array.isArray(record.dependencies) && record.dependencies.length > 0) {
            const mismatch = await dependenciesChanged(notion, record.dependencies);
            if (mismatch) {
              dependencyMismatch = true;
              continue;
            }
          }
          prompts.log.info(`[Skipped] ${path.basename(candidate)} (Up to date)`);
          completedTargets.push({ target, item: targetItem, skipped: true });
          skipped = true;
          break;
        }
      } catch (err) {
        // Hash failed — force download
        break;
      }
    }
    if (skipped) continue;

    // Two-way sync detection: check if local edits need to be pushed to Notion
    let pushedTwoWay = false;
    if ((target.sync === 'two-way' || target.sync === 'two-way-override') && useLedger && ledger.byNotionId && ledger.byNotionId[pageId]) {
      const recordEntry = ledger.byNotionId[pageId];
      // Find the output path from the ledger
      let localOutputPath = null;
      let ledgerRecord = null;
      for (const [outputPath, record] of Object.entries(recordEntry.outputs || {})) {
        localOutputPath = path.resolve(outputPath);
        ledgerRecord = record;
        break;
      }

      if (localOutputPath && ledgerRecord) {
        try {
          // Check if the local file exists
          await fs.stat(localOutputPath);
          const currentLocalHash = await calculateFileHash(localOutputPath);
          const remoteHasChanged = dependencyMismatch || String(targetItem.remoteMtime) !== String(ledgerRecord.last_synced_remote_mtime);
          const localHasChanged = currentLocalHash !== ledgerRecord.last_synced_local_hash;
          const conflictDetected = localHasChanged && remoteHasChanged;

          if (localHasChanged && !remoteHasChanged) {
            // Local modification detected, remote unchanged — push back to Notion
            spin.stop('');
            prompts.log.info(`[Pushing] Syncing local edits back to Notion for ${targetItem.name}...`);
            spin.start('...');

            try {
              const appended = await pushLocalFileToNotion({
                notion,
                pageId,
                targetItem,
                target,
                localOutputPath,
                currentLocalHash,
                ledger,
                saveStateLedgerFn,
              });
              if (!appended) {
                prompts.log.warn(`[SAFETY] Push aborted for ${targetItem.name}. Skipping target.`);
                completedTargets.push({ target, item: targetItem, skipped: true, reason: 'safety-bypass' });
              } else {
                prompts.log.info(`[Pushed] Successfully synced local edits to Notion for ${targetItem.name}`);
                pushedTwoWay = true;
                completedTargets.push({ target, item: targetItem, pushed: true });
              }
              pushedTwoWay = true;
            } catch (err) {
              spin.stop('');
              prompts.log.warn(`[Push Failed] Could not sync local edits: ${err.message}`);
              spin.start('Continuing...');
            }
          } else if (conflictDetected) {
            const conflictPolicy = target.conflict === 'local-wins' ? 'local-wins' : 'notion-wins';
            if (conflictPolicy === 'local-wins') {
              spin.stop('');
              prompts.log.warn(`[Conflict] Local and Notion both changed for ${targetItem.name}; local-wins will overwrite the cloud copy.`);
              spin.start('...');

              try {
                const appended = await pushLocalFileToNotion({
                  notion,
                  pageId,
                  targetItem,
                  localOutputPath,
                  currentLocalHash,
                  ledger,
                  saveStateLedgerFn,
                });
                if (!appended) {
                  prompts.log.warn(`[SAFETY] Push aborted for ${targetItem.name}. Skipping target.`);
                  completedTargets.push({ target, item: targetItem, skipped: true, reason: 'safety-bypass' });
                } else {
                  prompts.log.info(`[Pushed] Successfully resolved conflict by overwriting Notion for ${targetItem.name}`);
                  pushedTwoWay = true;
                  completedTargets.push({ target, item: targetItem, pushed: true });
                }
              } catch (err) {
                spin.stop('');
                prompts.log.warn(`[Push Failed] Could not resolve conflict: ${err.message}`);
                spin.start('Continuing...');
              }
            } else {
              prompts.log.warn(`[Conflict] Local and Notion both changed for ${targetItem.name}; pulling Notion version to preserve cloud edits.`);
            }
          }
        } catch (err) {
          // Local file doesn't exist or other error — skip two-way, continue to download
        }
      }
    }

    if (pushedTwoWay) continue;

    // Download the target
      try {
      // Map `format` to downloader options
      const format = target.format || 'markdown-tree';
      const downloadOpts = { debug: args.debug };
      if (format === 'markdown-flat') {
        downloadOpts.flat = true;
        downloadOpts.type = 'markdown';
      } else if (format === 'markdown-tree') {
        downloadOpts.flat = false;
        downloadOpts.type = 'markdown';
      } else if (format === 'csv') {
        downloadOpts.flat = false;
        downloadOpts.type = 'csv';
      } else {
        // Fallback to markdown tree
        downloadOpts.flat = false;
        downloadOpts.type = 'markdown';
      }

      const stats = await downloadFn(
        [targetItem],
        outDir,
        notion,
        {
          onStatus: (msg) => spin.message(`${prefix} ${msg}`),
          onLog: (msg) => {
            spin.stop(msg);
            spin.start('...');
          },
          onError: (msg) => {
            spin.stop('');
            prompts.log.warn(msg);
            spin.start('Continuing...');
          },
        },
        downloadOpts
      );

      // After successful download, find the main output file and update ledger
      const match = (stats && Array.isArray(stats.writtenFiles)) ? stats.writtenFiles.find((f) => {
        const b = path.basename(f);
        if (providedFilename && path.extname(providedFilename)) {
          return b === providedFilename;
        }
        return b === `${slugName}.md` || b === `${slugName}.csv`;
      }) : null;

      if (match && useLedger) {
        let fileHash = null;
        try {
          fileHash = await calculateFileHash(match);
          const relKey = path.relative(process.cwd(), match);
          // Ensure notion entry exists
          ledger.byNotionId = ledger.byNotionId || {};
          ledger.byPath = ledger.byPath || {};
          ledger.byNotionId[pageId] = ledger.byNotionId[pageId] || { notion_id: pageId, outputs: {} };
          ledger.byNotionId[pageId].outputs[relKey] = {
            last_synced_remote_mtime: targetItem.remoteMtime || null,
            last_synced_local_hash: fileHash,
            hasSyncedBlocks: stats.foundSyncedBlocks || false,
            dependencies: Array.isArray(stats.dependencies) ? stats.dependencies : [],
          };
          ledger.byPath[relKey] = pageId;
        } catch (err) {
          // Non-fatal: continue without ledger update
        }
      }

      completedTargets.push({ target, item: targetItem });
      spin.start(`${prefix} Done: ${targetItem.name}`);
    } catch (err) {
      failedTargets.push({ target, error: err.message });
    }
  }

  // Persist ledger back to disk (unless bypassed)
  if (useLedger) {
    try {
      await saveStateLedgerFn(ledger);
    } catch (err) {
      prompts.log.warn(`Could not save state ledger: ${err.message}`);
    }
  }

  spin.stop('Batch sync complete.');

  // Summary
  prompts.log.success(`Completed: ${completedTargets.length}/${targets.length} target${targets.length === 1 ? '' : 's'}`);
  if (failedTargets.length > 0) {
    prompts.log.warn(`Failed: ${failedTargets.length} target${failedTargets.length === 1 ? '' : 's'}`);
    for (const { target, error } of failedTargets) {
      const id = target.source || target.name || 'unknown target';
      prompts.log.warn(`  - ${id}: ${error}`);
    }
  }

  return { completedTargets, failedTargets };
}

// new: status reporter for manifest targets
export async function executeStatus(manifest, token, args = {}, overrides = {}) {
  const prompts = overrides.prompts || p;
  const fs = overrides.fs || (await import('fs/promises'));

  if (!manifest || !Array.isArray(manifest.targets) || manifest.targets.length === 0) {
    prompts.log.error('No sync targets found in manifest.');
    return { results: [] };
  }
  if (!token) {
    prompts.log.error('No Notion token found. Provide NOTION_TOKEN or save a token in ~/.pagesdown/config.json.');
    return { results: [] };
  }

  const NotionClass = overrides.notionClass || NotionClient;
  const notion = overrides.notion || new NotionClass(token);

  try {
    if (!overrides.notion) await notion.validateToken();
  } catch (err) {
    prompts.log.error(`Could not connect to Notion: ${err.message || err}`);
    return { results: [] };
  }

  const loadStateLedgerFn = overrides.loadStateLedger || loadStateLedger;
  const ledger = await loadStateLedgerFn();

  const results = [];
  const counts = { upToDate: 0, needsPull: 0, needsPush: 0, conflict: 0, remoteOnly: 0, localUntracked: 0, disabled: 0, failed: 0 };

  for (const target of manifest.targets) {
    if (!target) continue;
    if (target.disabled) {
      counts.disabled++;
      results.push({ name: target.name || target.source || '<no-name>', status: 'disabled' });
      continue;
    }

    const source = target.source || '';
    const pageId = extractNotionId(source);
    if (!pageId) {
      counts.failed++;
      results.push({ name: source, status: 'invalid-source' });
      continue;
    }

    // fetch remote info (page or database)
    let name = pageId;
    let remoteType = 'page';
    let remoteMtime = null;
    try {
      const page = await notion.getPage(pageId);
      name = extractTitle(page) || name;
      remoteType = 'page';
      remoteMtime = page?.last_edited_time || null;
    } catch {
      try {
        const db = await notion.getDatabase(pageId);
        name = extractDatabaseTitle(db) || name;
        remoteType = 'database';
        remoteMtime = db?.last_edited_time || null;
      } catch (err) {
        counts.failed++;
        results.push({ name: source, status: 'remote-fetch-failed', error: err.message || String(err) });
        continue;
      }
    }

    // resolve candidate file paths (same logic as executeSyncMode)
    const rawOutDir = target.outDir || process.cwd();
    const expandedOutDir = rawOutDir.startsWith('~') ? path.join(process.env.HOME || os.homedir(), rawOutDir.slice(1)) : rawOutDir;
    const outDir = path.resolve(expandedOutDir);

    const providedFilename = typeof target.filename === 'string' && target.filename.trim() ? target.filename.trim() : null;
    let slugName;
    let candidatePaths = [];
    if (providedFilename) {
      const ext = path.extname(providedFilename).toLowerCase();
      const base = ext ? path.basename(providedFilename, ext) : providedFilename;
      slugName = base;
      if (ext) {
        candidatePaths = [path.join(outDir, providedFilename), path.join(outDir, base, providedFilename)];
      } else {
        const gen = slugifyFilename(providedFilename);
        candidatePaths = [path.join(outDir, `${gen}.md`), path.join(outDir, gen, `${gen}.md`), path.join(outDir, `${gen}.csv`)];
      }
    } else {
      slugName = slugifyFilename(name || pageId);
      candidatePaths = [path.join(outDir, `${slugName}.md`), path.join(outDir, slugName, `${slugName}.md`), path.join(outDir, `${slugName}.csv`)];
    }

    // detect local file
    let localPath = null;
    let localExists = false;
    for (const c of candidatePaths) {
      try {
        await fs.stat(c);
        localExists = true;
        localPath = c;
        break;
      } catch {
        // not found
      }
    }

    // find ledger record
    let ledgerRel = null;
    let ledgerRec = null;
    if (ledger) {
      for (const c of candidatePaths) {
        const rel = path.relative(process.cwd(), c);
        if (ledger.byPath && ledger.byPath[rel]) {
          const nid = ledger.byPath[rel];
          ledgerRec = ledger.byNotionId && ledger.byNotionId[nid] ? ledger.byNotionId[nid].outputs[rel] : null;
          if (ledgerRec) { ledgerRel = rel; break; }
        }
      }
      if (!ledgerRec && ledger.byNotionId && ledger.byNotionId[pageId]) {
        for (const outP of Object.keys(ledger.byNotionId[pageId].outputs || {})) {
          ledgerRec = ledger.byNotionId[pageId].outputs[outP];
          ledgerRel = outP;
          break;
        }
      }
    }

    // compute local hash if file exists
    let localHash = null;
    if (localExists) {
      try { localHash = await calculateFileHash(localPath); } catch { /* ignore */ }
    }

    // determine status
    let status = 'unknown';
    let recommendation = '';

    if (!ledgerRec) {
      if (localExists) {
        status = 'local-untracked';
        counts.localUntracked++;
        recommendation = 'Consider adding this path to your manifest or push upstream';
      } else {
        status = 'remote-only';
        counts.remoteOnly++;
        recommendation = 'Run sync to download';
      }
    } else {
      const remoteChanged = String(remoteMtime) !== String(ledgerRec.last_synced_remote_mtime);
      const localChanged = localExists && String(localHash) !== String(ledgerRec.last_synced_local_hash);
      if (localChanged && remoteChanged) {
        status = 'conflict';
        counts.conflict++;
        recommendation = 'Resolve conflict (check local file and choose conflict policy)';
      } else if (localChanged) {
        status = 'local-changed';
        counts.needsPush++;
        recommendation = 'Local has changed (eligible for push)';
      } else if (remoteChanged) {
        status = 'remote-changed';
        counts.needsPull++;
        recommendation = 'Remote has changed (download/pull recommended)';
      } else {
        status = 'up-to-date';
        counts.upToDate++;
        recommendation = 'None';
      }
    }

    results.push({
      name,
      id: pageId,
      type: remoteType,
      outDir,
      localPath,
      ledgerRel,
      status,
      recommendation,
      localHash,
      remoteMtime,
    });
  }

  // Print a human-friendly table and summary
  console.log('\npagesdown sync status\n');
  try {
    // Use basic console.table fallback if available
    console.table(results.map(r => ({ Name: r.name, Id: r.id, Type: r.type, Status: r.status, Local: r.localPath || '', Ledger: r.ledgerRel || '', Action: r.recommendation })));
  } catch {
    for (const r of results) {
      console.log(`${r.name} (${r.id}) — ${r.status} — ${r.recommendation}`);
    }
  }

  console.log('\nSummary:', `up-to-date=${counts.upToDate}`, `needsPull=${counts.needsPull}`, `needsPush=${counts.needsPush}`, `conflicts=${counts.conflict}`, `remoteOnly=${counts.remoteOnly}`, `localUntracked=${counts.localUntracked}`, `disabled=${counts.disabled}`, `failed=${counts.failed}`);
  return { results, counts };
}

/**
 * Build a map of file paths to their associated target metadata (pageId, target config, etc).
 * Returns { [filePath]: { pageId, target, targetItem, localOutputPath, ... } }
 */
function buildFileTargetMap(manifest, ledger) {
  const fileMap = {};
  const targets = manifest.targets || [];
  
  for (const target of targets) {
    // Only watch files for two-way or push-only targets
    if (target.disabled === true) continue;
    // Watch targets that can push upstream
    if (!target.sync || (target.sync !== 'two-way' && target.sync !== 'two-way-override' && target.sync !== 'push-only' && target.sync !== 'push-override')) {
      continue;
    }
    
    if (!target.source) continue;
    const pageId = extractNotionId(target.source);
    if (!pageId) continue;
    
    // Find tracked files in ledger for this pageId
    const ledgerEntry = ledger.byNotionId?.[pageId];
    if (!ledgerEntry || !ledgerEntry.outputs) continue;
    
    for (const [outputPath, record] of Object.entries(ledgerEntry.outputs)) {
      const resolvedPath = path.resolve(outputPath);
      fileMap[resolvedPath] = {
        pageId,
        target,
        outputPath: resolvedPath,
        ledgerRecord: record,
      };
    }
  }
  
  return fileMap;
}

/**
 * Push a single changed file to Notion (isolated, targeted push).
 * Returns true if push succeeded, false if safety-bypassed or failed.
 */
async function pushSingleFileToNotionWatched({ notion, pageId, filePath, ledger, saveStateLedgerFn, prompts = p, target }) {
  try {
    const localContent = await fs.readFile(filePath, 'utf-8');
    const currentHash = await calculateFileHash(filePath);
    
    // Apply safety check
    try {
      const tablePattern = /\|\s*:?-{3,}[^\n]*\|/i;
      const subpagePattern = /\[\[.+\]\]|<!--\s*child_page|<!--\s*subpage|child_page|child_database/i;
      if (tablePattern.test(localContent) || subpagePattern.test(localContent)) {
        const overrideActive = target && (target.sync === 'push-override' || target.sync === 'two-way-override');
        if (overrideActive) {
          console.debug('[SAFETY] Table structural signatures found, but override sync option is active. Forcing push upstream.');
        } else {
          prompts.log.warn(`[SAFETY] Aborting push for ${path.basename(filePath)}. File contains flattened tables or sub-pages.`);
          return false;
        }
      }
    } catch {
      // Non-fatal
    }
    
    const blocks = markdownToNotionBlocks(localContent, filePath);
    await notion.clearPageContent(pageId);
    const appended = await notion.appendPageContent(pageId, blocks);
    const refreshedPage = await notion.getPage(pageId);
    const newRemoteMtime = refreshedPage?.last_edited_time || null;
    const relKey = path.relative(process.cwd(), filePath);
    
    // Update ledger
    ledger.byNotionId = ledger.byNotionId || {};
    ledger.byPath = ledger.byPath || {};
    ledger.byNotionId[pageId] = ledger.byNotionId[pageId] || { notion_id: pageId, outputs: {} };
    ledger.byNotionId[pageId].outputs[relKey] = {
      last_synced_remote_mtime: newRemoteMtime,
      last_synced_local_hash: currentHash,
    };
    ledger.byPath[relKey] = pageId;
    await saveStateLedgerFn(ledger);
    
    return true;
  } catch (err) {
    p.log.error(`[Watcher] Push failed for ${path.basename(filePath)}: ${err.message}`);
    return false;
  }
}

/**
 * Start watch mode: run baseline sync, then monitor files for changes.
 * Implements isolated, real-time pushes on file modifications.
 */
export async function startSyncWatchMode(manifest, token, args, overrides = {}) {
  const prompts = overrides.prompts || p;
  
  // Run baseline sync first to align local and remote
  prompts.log.info('[Watcher] Running baseline sync...');
  const result = await executeSyncMode(manifest, token, args, overrides);
  prompts.log.success('[Watcher] Baseline sync complete.');
  
  const NotionClass = overrides.notionClass || NotionClient;
  const loadStateLedgerFn = overrides.loadStateLedger || loadStateLedger;
  const saveStateLedgerFn = overrides.saveStateLedger || saveStateLedger;
  const notion = overrides.notion || new NotionClass(token);
  
  // Load ledger to build file-to-target map
  let ledger = await loadStateLedgerFn();
  const fileTargetMap = buildFileTargetMap(manifest, ledger);
  
  if (Object.keys(fileTargetMap).length === 0) {
    prompts.log.warn('[Watcher] No tracked files found. Exiting watch mode.');
    return;
  }
  
  prompts.log.success(`[Watcher] Monitoring ${Object.keys(fileTargetMap).length} file(s) for changes...`);
  prompts.log.info('[Watcher] Press Ctrl+C to exit.');
  
  // Track active watchers so we can clean up on shutdown
  const activeWatchers = [];
  
  // Build a set of unique directories to watch
  const dirsToWatch = new Set();
  for (const filePath of Object.keys(fileTargetMap)) {
    const dir = path.dirname(filePath);
    dirsToWatch.add(dir);
  }
  
  // Setup file watchers on each directory
  for (const dir of dirsToWatch) {
    try {
      const watcher = watch(dir, async (eventType, filename) => {
        if (!filename) return;
        
        const changedPath = path.resolve(dir, filename);
        const metadata = fileTargetMap[changedPath];
        
        if (!metadata) return; // Not a tracked file
        if (eventType !== 'change') return; // Only handle 'change' events
        
        // Add debounce: wait a bit before processing to handle multiple events
        clearTimeout(metadata.debounceTimer);
        metadata.debounceTimer = setTimeout(async () => {
          try {
            // Reload ledger to get latest state
            ledger = await loadStateLedgerFn();
            const record = ledger.byNotionId?.[metadata.pageId]?.outputs?.[path.relative(process.cwd(), changedPath)];
            
            if (!record) return;
            
            const currentHash = await calculateFileHash(changedPath);
            if (currentHash === record.last_synced_local_hash) {
              return; // No change in hash, skip
            }
            
            // File changed, push it
            const filename = path.basename(changedPath);
            prompts.log.info(`[Watcher] Local change detected in ${filename}.`);
            
            const success = await pushSingleFileToNotionWatched({
              notion,
              pageId: metadata.pageId,
              filePath: changedPath,
              ledger,
              saveStateLedgerFn,
              prompts,
              target: metadata.target,
            });
            
            if (success) {
              const timestamp = new Date().toLocaleTimeString();
              prompts.log.success(`[Watcher] ${timestamp} - Pushed upstream successfully.`);
            }
          } catch (err) {
            prompts.log.error(`[Watcher] Error processing change: ${err.message}`);
          }
        }, 500); // 500ms debounce
      });
      
      activeWatchers.push(watcher);
    } catch (err) {
      prompts.log.warn(`[Watcher] Could not watch directory ${dir}: ${err.message}`);
    }
  }
  
  // Handle clean shutdown on Ctrl+C
  process.on('SIGINT', async () => {
    prompts.log.info('\n[Watcher] Shutting down...');
    
    // Close all watchers
    for (const watcher of activeWatchers) {
      try {
        watcher.close();
      } catch {
        // Already closed
      }
    }
    
    // Flush ledger to disk one last time
    try {
      ledger = await loadStateLedgerFn();
      await saveStateLedgerFn(ledger);
      prompts.log.success('[Watcher] Ledger saved. Exiting.');
    } catch (err) {
      prompts.log.warn(`[Watcher] Could not save ledger: ${err.message}`);
    }
    
    process.exit(0);
  });
}
