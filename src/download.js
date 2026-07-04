import { NotionToMarkdown } from 'notion-to-md';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sanitizeFilename, slugifyFilename, uniqueFilename, ensureDir } from './utils.js';
import { downloadToPath, isAllowedUrl } from './fetch-stream.js';
import { wrapError } from './error.js';
import { extractTitle } from './notion-helpers.js';

const MAX_DEPTH = 20;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const ASSET_CONCURRENCY = 5;
const BLOCK_CONCURRENCY = 4;
const MAX_ASSET_SIZE = 50 * 1024 * 1024; // 50 MB

// Block private/internal IP ranges to prevent SSRF
const BLOCKED_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);
const PRIVATE_IP_PREFIXES = ['10.', '192.168.', '169.254.', '172.16.', '172.17.', '172.18.',
  '172.19.', '172.20.', '172.21.', '172.22.', '172.23.', '172.24.', '172.25.', '172.26.',
  '172.27.', '172.28.', '172.29.', '172.30.', '172.31.'];

async function prefetchRelationTitles(relationIds, notion, concurrency = 6) {
  const cache = new Map();
  if (!relationIds || relationIds.size === 0) return cache;
  const ids = Array.from(relationIds);
  for (let i = 0; i < ids.length; i += concurrency) {
    const batch = ids.slice(i, i + concurrency);
    await Promise.all(batch.map(async (rid) => {
      try {
        const relPage = await notion.getPage(rid);
        const relTitle = extractTitle(relPage) || rid;
        cache.set(rid, relTitle);
      } catch {
        cache.set(rid, rid);
      }
    }));
  }
  return cache;
}

function escapeCsvCell(val) {
  if (val === null || val === undefined) return '';
  const s = String(val);
  const mustQuote = /[",\n]/.test(s);
  const escaped = s.replace(/"/g, '""');
  return mustQuote ? `"${escaped}"` : escaped;
}

// Note: fetch/streaming helpers were moved to src/fetch-stream.js and
// are intentionally not duplicated here to keep streaming lifecycle
// and error handling in one place for static analysis.

/**
 * Split blocks at child_page/child_database boundaries.
 * Returns { markdownParts, childEntries } for conversion and recursion.
 */
function splitBlocksAtBoundaries(blocks) {
  const usedNames = new Set();
  const childEntries = [];
  const markdownParts = [];
  let currentSegment = [];

  for (const block of blocks) {
    if (block.type === 'child_page') {
      if (currentSegment.length > 0) {
        markdownParts.push({ type: 'blocks', blocks: currentSegment });
        currentSegment = [];
      }
      const childTitle = block.child_page?.title || 'Untitled';
      const childName = uniqueFilename(sanitizeFilename(childTitle), usedNames);
      childEntries.push({ block, title: childTitle, name: childName, type: 'page' });
      markdownParts.push({ type: 'link', title: childTitle, name: childName });
    } else if (block.type === 'child_database') {
      if (currentSegment.length > 0) {
        markdownParts.push({ type: 'blocks', blocks: currentSegment });
        currentSegment = [];
      }
      const dbTitle = block.child_database?.title || 'Untitled Database';
      const dbName = uniqueFilename(sanitizeFilename(dbTitle), usedNames);
      childEntries.push({ block, title: dbTitle, name: dbName, type: 'database' });
      markdownParts.push({ type: 'link', title: dbTitle, name: dbName });
    } else {
      currentSegment.push(block);
    }
  }
  if (currentSegment.length > 0) {
    markdownParts.push({ type: 'blocks', blocks: currentSegment });
  }

  return { markdownParts, childEntries };
}

/**
 * Check whether markdown content contains external image URLs.
 */
function hasExternalImages(markdown) {
  return /!\[[^\]]*\]\(https?:\/\/[^)]+\)/.test(markdown);
}

function normalizeSpacing(md) {
  if (!md) return '';
  // Prevent accidental triple-blank-lines from mixed sources.
  return md.replace(/\n{3,}/g, '\n\n');
}

function prepareNumberedLists(blocks) {
  if (!Array.isArray(blocks)) return blocks;

  function walk(list) {
    let counter = 0;
    for (let i = 0; i < list.length; i++) {
      const block = list[i];
      if (block && block.type === 'numbered_list_item') {
        counter = (i > 0 && list[i - 1] && list[i - 1].type === 'numbered_list_item') ? counter + 1 : 1;
        if (!block.numbered_list_item) block.numbered_list_item = {};
        block.numbered_list_item.number = counter;
      } else {
        counter = 0;
      }
      if (block && Array.isArray(block.children)) walk(block.children);
    }
  }

  walk(blocks);
  return blocks;
}

function escapeTableCell(text) {
  if (text === null || text === undefined) return '';
  return String(text).replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}

function notionRichTextToPlain(richText) {
  if (!Array.isArray(richText) || richText.length === 0) return '';
  return richText.map((t) => t.plain_text || '').join('');
}

function pagePropertyToText(prop) {
  if (!prop || typeof prop !== 'object') return '';
  try {
    const formatUser = (user) => user?.name || user?.person?.email || user?.id || '';

    function _formatFiles(propFiles) {
      if (!Array.isArray(propFiles) || propFiles.length === 0) return '';
      return propFiles
        .map((f) => f?.name || f?.file?.url || f?.external?.url)
        .filter(Boolean)
        .join(', ');
    }

    function _formatRelation(propRel) {
      if (!Array.isArray(propRel)) return '';
      return propRel
        .map((r) => r?.id)
        .filter(Boolean)
        .map((id) => `${id} (relation)`)
        .join(', ');
    }

    function _formatFormula(f) {
      if (!f) return '';
      const handlers = {
        string: (v) => v.string || '',
        number: (v) => (v.number === null || v.number === undefined ? '' : String(v.number)),
        boolean: (v) => (v.boolean ? 'true' : 'false'),
        date: (v) => v.date?.start || '',
      };
      const fn = handlers[f.type];
      return typeof fn === 'function' ? fn(f) : '';
    }

    function _formatRollup(r) {
      if (!r) return '';
      if (r.type === 'number') return r.number === null || r.number === undefined ? '' : String(r.number);
      if (r.type === 'date') return r.date?.start || '';
      if (r.type === 'array') return Array.isArray(r.array) ? r.array.map((it) => pagePropertyToText(it)).filter(Boolean).join(', ') : '';
      return '';
    }

    function _formatPeople(propPeople) {
      return Array.isArray(propPeople) ? propPeople.map(formatUser).filter(Boolean).join(', ') : '';
    }

    const handlers = {
      title: (p) => notionRichTextToPlain(p.title),
      rich_text: (p) => notionRichTextToPlain(p.rich_text),
      number: (p) => (p.number === null || p.number === undefined ? '' : String(p.number)),
      select: (p) => p.select?.name || '',
      multi_select: (p) => (Array.isArray(p.multi_select) ? p.multi_select.map((s) => s?.name).filter(Boolean).join(', ') : ''),
      status: (p) => p.status?.name || '',
      date: (p) => { if (!p.date) return ''; return p.date.end ? `${p.date.start} → ${p.date.end}` : p.date.start; },
      checkbox: (p) => (p.checkbox ? 'true' : 'false'),
      url: (p) => p.url || '',
      email: (p) => p.email || '',
      phone_number: (p) => p.phone_number || '',
      people: (p) => _formatPeople(p.people),
      created_time: (p) => p.created_time || '',
      last_edited_time: (p) => p.last_edited_time || '',
      created_by: (p) => formatUser(p.created_by),
      last_edited_by: (p) => formatUser(p.last_edited_by),
      files: (p) => _formatFiles(p.files),
      relation: (p) => _formatRelation(p.relation),
      formula: (p) => _formatFormula(p.formula),
      rollup: (p) => _formatRollup(p.rollup),
    };

    const fn = handlers[prop.type];
    return typeof fn === 'function' ? fn(prop) : '';
  } catch {
    return '';
  }
}

/**
 * Convert database rows to an RFC4180-compliant CSV string.
 * Resolves relation titles via the Notion client when possible.
 */
async function convertToCSV(rows, orderedProperties, notion) {
  const relationIds = new Set();
  for (const row of rows) {
    const pageProps = row?.properties && typeof row.properties === 'object' ? row.properties : {};
    for (const [, prop] of Object.entries(pageProps)) {
      if (prop && prop.type === 'relation' && Array.isArray(prop.relation)) {
        for (const r of prop.relation) if (r?.id) relationIds.add(r.id);
      }
    }
  }

  const relationTitleCache = await prefetchRelationTitles(relationIds, notion);
  const escapeCell = escapeCsvCell;

  const headers = orderedProperties.map(([key, schema]) => schema?.name || key);
  const lines = [];
  lines.push(headers.map(escapeCell).join(','));

  for (const row of rows) {
    const pageProps = row?.properties && typeof row.properties === 'object' ? row.properties : {};
    const cells = orderedProperties.map(([key]) => {
      const prop = pageProps[key];
      if (prop && prop.type === 'relation' && Array.isArray(prop.relation)) {
        const titles = prop.relation.map((r) => (r?.id && relationTitleCache.has(r.id) ? relationTitleCache.get(r.id) : r?.id)).filter(Boolean);
        return escapeCell(titles.join(', '));
      }
      return escapeCell(pagePropertyToText(prop));
    });
    lines.push(cells.join(','));
  }

  return lines.join('\r\n') + '\r\n';
}

// Export internals for unit testing
export {
  splitBlocksAtBoundaries,
  hasExternalImages,
  normalizeSpacing,
  escapeTableCell,
  notionRichTextToPlain,
  pagePropertyToText,
  convertToCSV,
};

// Also export asset helpers for testing
export { processAssets, downloadFile, getAssetFilename };

async function childDatabaseToMarkdownTable(block, ctx, titleForErrors, { includeHeading = true } = {}) {
  const databaseId = block?.id;
  if (!databaseId) return '';

  const { notion, stats, onError } = ctx;

  let db;
  try {
    db = await notion.getDatabase(databaseId);
    addDependency(ctx, databaseId, 'database', db?.last_edited_time || null);
  } catch (err) {
    stats.errors.push({ title: titleForErrors, error: `Could not retrieve database schema: ${err.message}` });
    onError(`Could not retrieve database schema in ${titleForErrors} — ${err.message}`);
    return '';
  }

  let rows;
  try {
    rows = await notion.queryDatabase(databaseId);
    for (const row of rows) {
      addDependency(ctx, row?.id, 'page', row?.last_edited_time || null);
    }
  } catch (err) {
    stats.errors.push({ title: titleForErrors, error: `Could not query database: ${err.message}` });
    onError(`Could not query database in ${titleForErrors} — ${err.message}`);
    return '';
  }

  const props = db?.properties && typeof db.properties === 'object' ? db.properties : {};

  // Keep Notion's property order as returned; also include Title first if present.
  const propEntries = Object.entries(props);
  const titleProp = propEntries.find(([, p]) => p?.type === 'title');
  const otherProps = propEntries.filter(([, p]) => p?.type !== 'title');
  let ordered = titleProp ? [titleProp, ...otherProps] : otherProps;

  // Pre-fetch relation titles (like convertToCSV does)
  const relationIds = new Set();
  for (const row of rows) {
    const pageProps = row?.properties && typeof row.properties === 'object' ? row.properties : {};
    for (const [, prop] of Object.entries(pageProps)) {
      if (prop && prop.type === 'relation' && Array.isArray(prop.relation)) {
        for (const r of prop.relation) if (r?.id) relationIds.add(r.id);
      }
    }
  }

  const relationTitleCache = await prefetchRelationTitles(relationIds, notion);

  // Helper to convert property to text, with relation resolution
  function propToText(prop) {
    if (!prop || prop.type !== 'relation') return pagePropertyToText(prop);
    if (!Array.isArray(prop.relation)) return '';
    return prop.relation
      .map((r) => r?.id && relationTitleCache.has(r.id) ? relationTitleCache.get(r.id) : r?.id)
      .filter(Boolean)
      .join(', ');
  }

  // Sparse column pruning: only keep columns with non-empty data
  const hasNonEmptyData = new Set();
  for (const page of rows) {
    const pageProps = page?.properties && typeof page.properties === 'object' ? page.properties : {};
    for (const [propName] of ordered) {
      const text = escapeTableCell(propToText(pageProps[propName]));
      if (text.trim()) {
        hasNonEmptyData.add(propName);
      }
    }
  }
  // Filter to only columns with data (or keep all if no data found, for structure)
  if (hasNonEmptyData.size > 0) {
    ordered = ordered.filter(([propName]) => hasNonEmptyData.has(propName));
  }

  const colNames = ordered.map(([name]) => name);
  if (colNames.length === 0) return '';

  const header = `| ${colNames.map(escapeTableCell).join(' | ')} |`;
  const divider = `| ${colNames.map(() => '---').join(' | ')} |`;
  const bodyLines = [];

  for (const page of rows) {
    const pageProps = page?.properties && typeof page.properties === 'object' ? page.properties : {};
    const cells = ordered.map(([name]) => escapeTableCell(propToText(pageProps[name])));
    bodyLines.push(`| ${cells.join(' | ')} |`);
  }

  const title = block?.child_database?.title || db?.title?.map((t) => t.plain_text).join('') || 'Database';
  const out = includeHeading
    ? [`\n\n### ${title}\n\n`, header, divider, ...bodyLines, '\n\n'].join('\n')
    : [`\n\n`, header, divider, ...bodyLines, '\n\n'].join('\n');
  return normalizeSpacing(out);
}

async function resolveSyncedBlockChildren(block, ctx, titleForErrors) {
  const { notion, stats, onError } = ctx;
  const synced = block?.synced_block;
  if (!synced) return [];

  const sourceBlockId = synced.synced_from?.block_id || block?.id || null;
  if (sourceBlockId) {
    try {
      const sourceBlock = sourceBlockId === block?.id ? block : await notion.getBlock(sourceBlockId);
      addDependency(ctx, sourceBlockId, 'block', sourceBlock?.last_edited_time || null);
    } catch {
      addDependency(ctx, sourceBlockId, 'block', null);
    }
  }

  if (!synced.synced_from) {
    // Original synced block, its children should already be inlined by deep fetch.
    return Array.isArray(block.children) ? block.children : [];
  }

  const targetId = synced.synced_from?.block_id;
  if (!targetId) return [];

  try {
    const result = await notion.getBlockChildrenDeep(targetId);
    for (const w of result.warnings) {
      stats.errors.push({ title: titleForErrors, error: `Skipped block ${w.blockType}: ${w.error}` });
      onError(`Partial fetch in ${titleForErrors}: skipped ${w.blockType} block — ${w.error}`);
    }
    return result.blocks || [];
  } catch (err) {
    stats.errors.push({ title: titleForErrors, error: `Could not resolve synced block: ${err.message}` });
    onError(`Could not resolve synced block in ${titleForErrors} — ${err.message}`);
    return [];
  }
}

/**
 * Convert block segments in markdownParts to markdown strings (one pass).
 * Returns an array mirroring markdownParts where block entries have a `content`
 * field with the converted markdown, and link entries are passed through as-is.
 */
async function convertBlockParts(markdownParts, n2m, titleForErrors, stats, onError) {
  const converted = [];

  for (const part of markdownParts) {
    if (part.type === 'link') {
      converted.push(part);
    } else if (part.type === 'raw') {
      converted.push(part);
    } else {
      try {
        // Inject sequence numbers to prevent fallback to bullet items
        const annotatedBlocks = prepareNumberedLists(part.blocks);
        const mdBlocks = await n2m.blocksToMarkdown(annotatedBlocks);
        const mdResult = n2m.toMarkdownString(mdBlocks);
        converted.push({ type: 'blocks', content: normalizeSpacing(mdResult.parent || '') });
      } catch (err) {
        stats.errors.push({ title: titleForErrors, error: `Markdown conversion failed: ${err.message}` });
        onError(`Conversion failed for segment in ${titleForErrors}: ${err.message}`);
        converted.push({ type: 'blocks', content: '' });
      }
    }
  }

  return converted;
}

function addDependency(ctx, id, type, mtime) {
  if (!ctx || !id) return;
  if (!Array.isArray(ctx.dependencies)) ctx.dependencies = [];
  const key = `${type}:${id}`;
  const existing = ctx.dependencies.find((dep) => `${dep.type}:${dep.id}` === key);
  if (existing) {
    if (mtime !== undefined && mtime !== null) existing.mtime = mtime;
    return;
  }
  ctx.dependencies.push({ id, type, mtime: mtime || null });
}

/**
 * Assemble pre-converted parts into a final markdown string.
 * Uses childResults to determine link format: leaf children get flat links.
 */
function assembleMarkdown(convertedParts, childResults = new Map()) {
  let markdown = '';

  for (const part of convertedParts) {
    if (part.type === 'link') {
      const childInfo = childResults.get(part.name);
      const isLeaf = childInfo ? childInfo.isLeaf : false;
      const relativePath = isLeaf
        ? `./${part.name}.md`
        : `./${part.name}/${part.name}.md`;
      markdown += `- [${part.title}](${relativePath})\n`;
    } else if (part.type === 'raw') {
      const segment = part.content || '';
      if (segment.trim()) {
        markdown += normalizeSpacing(segment);
        if (!markdown.endsWith('\n\n')) {
          markdown += '\n';
        }
      }
    } else {
      const segment = part.content;
      if (segment.trim()) {
        markdown += segment;
        if (!markdown.endsWith('\n\n')) {
          markdown += '\n';
        }
      }
    }
  }

  return markdown;
}

async function blocksToInlineParts(blocks, ctx, visited, depth, titleForErrors, assetsDirForFlatChildren) {
  const items = Array.isArray(blocks) ? blocks : [];
  const resolved = new Array(items.length);

  async function resolveBlock(block) {
    if (!block || typeof block !== 'object') return null;

    if (block.type === 'synced_block') {
      ctx.foundSyncedBlocks = true;
      const nested = await resolveSyncedBlockChildren(block, ctx, titleForErrors);
      if (nested.length === 0) return null;
      const nestedParts = await blocksToInlineParts(nested, ctx, visited, depth + 1, titleForErrors, assetsDirForFlatChildren);
      return { type: 'parts', parts: nestedParts };
    }

    if (block.type === 'child_database') {
      const table = await childDatabaseToMarkdownTable(block, ctx, titleForErrors);
      if (table.trim()) return { type: 'parts', parts: [{ type: 'raw', content: table }] };
      return null;
    }

    if (block.type === 'child_page' && ctx.format === 'flattened') {
      const childPageId = block.id;
      const childTitle = block.child_page?.title || 'Untitled';
      if (!childPageId) return null;
      if (visited.has(childPageId)) return null;

      visited.add(childPageId);

      const [pageResult, childResult] = await Promise.allSettled([
        ctx.notion.getPage(childPageId),
        ctx.notion.getBlockChildrenDeep(childPageId),
      ]);

      addDependency(ctx, childPageId, 'page', pageResult.status === 'fulfilled' ? pageResult.value?.last_edited_time || null : null);

      if (childResult.status !== 'fulfilled') {
        ctx.stats.errors.push({ title: childTitle, error: `Could not fetch blocks: ${childResult.reason?.message || 'Unknown error'}` });
        ctx.onError(`Could not fetch: ${childTitle} — ${childResult.reason?.message || 'Unknown error'}`);
        return null;
      }

      const result = childResult.value;
      for (const w of result.warnings) {
        ctx.stats.errors.push({ title: childTitle, error: `Skipped block ${w.blockType}: ${w.error}` });
        ctx.onError(`Partial fetch in ${childTitle}: skipped ${w.blockType} block — ${w.error}`);
      }

      const childParts = await blocksToInlineParts(result.blocks || [], ctx, visited, depth + 1, childTitle, assetsDirForFlatChildren);
      const converted = await convertBlockParts(childParts, ctx.n2m, childTitle, ctx.stats, ctx.onError);
      let childMarkdown = normalizeSpacing(assembleMarkdown(converted, new Map())).trim();

      try {
        if (assetsDirForFlatChildren) {
          const processed = await processAssets(childMarkdown, assetsDirForFlatChildren, ctx.stats, ctx);
          childMarkdown = normalizeSpacing(processed).trim();
        }
      } catch (err) {
        ctx.stats.errors.push({ title: childTitle, error: `Asset processing failed: ${err.message}` });
        ctx.onError(`Asset processing failed in ${childTitle} — ${err.message}`);
      }

      const sanitizedSlug = childTitle.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      const anchorBase = `#sub-page-${sanitizedSlug}`;
      let anchorId = anchorBase;
      let suffix = 2;
      while (ctx.anchorMap && Array.from(ctx.anchorMap.values()).includes(anchorId)) {
        anchorId = `${anchorBase}-${suffix}`;
        suffix += 1;
      }
      if (ctx.anchorMap) {
        ctx.anchorMap.set(childPageId, anchorId);
      }

      const wrapped =
        `<!-- notiondrive:subpage:start -->${anchorId}\n` +
        `### Sub-Page Content: ${childTitle}\n\n` +
        (childMarkdown ? `${childMarkdown}\n\n` : '') +
        `<!-- notiondrive:subpage:end -->\n\n`;

      return { type: 'parts', parts: [{ type: 'raw', content: wrapped }] };
    }

    if (block.type === 'child_page' && ctx.format !== 'flattened') {
      return { type: 'block', block };
    }

    return { type: 'block', block };
  }

  await runWithConcurrency(items.map((block, index) => ({ block, index })), BLOCK_CONCURRENCY, async ({ block, index }) => {
    resolved[index] = await resolveBlock(block);
  });

  const parts = [];
  let current = [];
  for (const entry of resolved) {
    if (!entry) continue;
    if (entry.type === 'block') {
      current.push(entry.block);
      continue;
    }
    if (current.length > 0) {
      parts.push({ type: 'blocks', blocks: current });
      current = [];
    }
    if (Array.isArray(entry.parts)) {
      parts.push(...entry.parts);
    }
  }
  if (current.length > 0) {
    parts.push({ type: 'blocks', blocks: current });
  }

  return parts;
}

/**
 * Download selected pages/databases to the local filesystem.
 *
 * Callbacks:
 *   onStatus(message)  – spinner/progress text (frequently updated)
 *   onLog(message)     – milestone log line (page saved, db started, etc.)
 *   onError(message)   – error log line (shown immediately, not batched)
 */
export async function downloadPages(selectedItems, savePath, notion, { onStatus, onLog, onError }, { format = 'markdown-tree', debug = false, frontmatter = false } = {}) {
  await ensureDir(savePath);

  const n2m = new NotionToMarkdown({
    notionClient: notion.throttledClient,
    config: {
      separateChildPage: true,
      parseChildPages: false,
    },
  });

  const stats = { totalPages: 0, totalAssets: 0, errors: [] };
  // Track files written to disk so callers can inspect outputs
  stats.writtenFiles = [];
  const anchorMap = format === 'flattened' ? new Map() : null; // Track page IDs to anchor slugs in flat mode
  const ctx = { notion, n2m, stats, onStatus, onLog, onError, format, anchorMap, debug, frontmatter, foundSyncedBlocks: false, dependencies: [] };
  const usedNames = new Set();
  const visited = new Set();

  for (let i = 0; i < selectedItems.length; i++) {
    // Reset synced block flag for each item
    ctx.foundSyncedBlocks = false;
    const item = selectedItems[i];
    const displayTitle = item.title || item.name || item.id || 'Untitled';
    // Use custom filename if provided; preserve the exact string as much as possible
    // but remove any path separators or illegal control characters. Only fall
    // back to sanitization for generated titles.
    let safeName;
    if (item.customFilename) {
      // Strip directory parts and dangerous characters but keep user intent (hyphens, multiple dashes)
      const base = path.basename(String(item.customFilename));
      const cleaned = base.replace(/[<>:"|?*\x00-\x1f]/g, '');
      safeName = uniqueFilename(cleaned || 'Untitled', usedNames);
    } else {
      safeName = uniqueFilename(sanitizeFilename(displayTitle), usedNames);
    }
    const prefix = `[${i + 1}/${selectedItems.length}]`;

    onLog(`${prefix} Starting: ${displayTitle}`);

    try {
      if (item.type === 'database') {
        await downloadDatabase(item.id, safeName, savePath, ctx, visited, 0, !!item.customFilename);
      } else {
        await downloadPage(item.id, safeName, savePath, ctx, visited, 0, true, !!item.customFilename);
      }
      onLog(`${prefix} Done: ${displayTitle} (${stats.totalPages} pages, ${stats.totalAssets} assets so far)`);
    } catch (err) {
      stats.errors.push({ title: item.title, error: err.message });
      onError(`${prefix} Failed: ${item.title} — ${err.message}`);
    }
  }

  // Transfer dependency and synced block state to stats for ledger updates
  stats.foundSyncedBlocks = ctx.foundSyncedBlocks || false;
  stats.dependencies = Array.isArray(ctx.dependencies) ? ctx.dependencies : [];

  return stats;
}

/**
 * Recursively download a single page and its children.
 * Fetches blocks once through the throttled API wrapper, then:
 *   1. Passes them to notion-to-md for markdown conversion (no extra API calls)
 *   2. Extracts child_page/child_database blocks for recursion
 */
async function downloadPage(pageId, name, parentDir, ctx, visited, depth, isTopLevel = false, isCustomFilename = false) {
  if (visited.has(pageId)) return { isLeaf: true };
  if (depth > MAX_DEPTH) {
    ctx.stats.errors.push({ title: name, error: `Skipped: exceeded max depth of ${MAX_DEPTH}` });
    return { isLeaf: true };
  }
  visited.add(pageId);

  const { notion, n2m, stats, onStatus, onError } = ctx;

  onStatus(`Fetching: ${name}`);

  // Fetch blocks FIRST (before creating any directory)
  let blocks;
  try {
    const result = await notion.getBlockChildrenDeep(pageId);
    blocks = result.blocks;
    for (const w of result.warnings) {
      stats.errors.push({ title: name, error: `Skipped block ${w.blockType}: ${w.error}` });
      onError(`Partial fetch in ${name}: skipped ${w.blockType} block — ${w.error}`);
    }
  } catch (err) {
    // Block fetch failed — conservatively use folder structure
    stats.errors.push({ title: name, error: `Could not fetch blocks: ${err.message}` });
    onError(`Could not fetch: ${name} — ${err.message}`);

    const pageDir = path.join(parentDir, name);
    await ensureDir(pageDir);

    let content = '';
    try {
      const page = await notion.getPage(pageId);
      let frontmatterBody = '';
      if (ctx.frontmatter === true) {
        frontmatterBody = buildFrontmatter(page.properties);
      } else if (typeof ctx.frontmatter === 'string') {
        const prop = page.properties?.[ctx.frontmatter];
        if (prop) {
          const rawText = pagePropertyToText(prop);
          if (rawText.trim()) {
            frontmatterBody = rawText.endsWith('\n') ? rawText : `${rawText}\n`;
          }
        }
      }

      if (frontmatterBody) {
        content += `---\n${frontmatterBody}---\n\n`;
      }
    } catch {
      // Page metadata also inaccessible — continue with bare stub
    }
    content += `# ${name}\n`;

    const mdPath = path.join(pageDir, `${name}.md`);
    await writeFile(mdPath, content, 'utf-8');
    stats.totalPages++;
    return { isLeaf: false };
  }

  onStatus(`Converting: ${name} (${blocks.length} blocks)`);

  // If the desired output filename has a code extension, extract raw code
  // blocks and write them directly as a plain code file (no markdown).
  try {
    const extension = ctx.format === 'csv' ? '.csv' : '.md';
    const desiredFilename = isCustomFilename ? name : `${slugifyFilename(name)}${extension}`;
    const ext = path.extname(desiredFilename).toLowerCase();
    const codeExts = new Set(['.js', '.ts', '.py', '.sh', '.json', '.yml', '.yaml', '.sql']);
    if (codeExts.has(ext)) {
      // Collect Notion code blocks and extract plain text content
      const codeBlocks = Array.isArray(blocks) ? blocks.filter((b) => b && b.type === 'code') : [];
      const snippets = codeBlocks.map((b) => notionRichTextToPlain(b.code && b.code.rich_text));
      const outContent = snippets.join('\n\n');
      // Ensure parent directory exists and write raw code file
      await ensureDir(parentDir);
      const outPath = path.join(parentDir, desiredFilename);
      await writeFile(outPath, outContent, 'utf-8');
      stats.writtenFiles.push(outPath);
      stats.totalPages++;
      if (ctx.onLog) ctx.onLog(`Wrote code file: ${outPath}`);
      return { isLeaf: true };
    }
  } catch (err) {
    // Non-fatal: fall back to regular markdown flow on any failure
  }

  let markdownParts;
  let childEntries;

  if (ctx.format === 'flattened') {
    // In flat mode, assets for this whole document (and any inlined sub-pages)
    // should live alongside the single output markdown file.
    markdownParts = await blocksToInlineParts(blocks, ctx, visited, depth, name, parentDir);
    childEntries = [];
  } else {
    // Legacy behavior for child_page: split into links + recurse.
    // But child_database is now rendered inline, so we post-process segments.
    const boundary = splitBlocksAtBoundaries(blocks);
    childEntries = boundary.childEntries.filter((e) => e.type !== 'database');

    // Convert any child_database "link" parts into inline tables.
    markdownParts = [];
    for (const part of boundary.markdownParts) {
      if (part.type === 'link') {
        const matchingDb = boundary.childEntries.find((e) => e.type === 'database' && e.name === part.name);
        if (matchingDb) {
          const table = await childDatabaseToMarkdownTable(matchingDb.block, ctx, name);
          if (table.trim()) markdownParts.push({ type: 'raw', content: table });
          continue;
        }
        markdownParts.push(part);
      } else {
        // Expand synced blocks inside each segment without breaking link boundaries.
        const expanded = await blocksToInlineParts(part.blocks, ctx, visited, depth, name);
        markdownParts.push(...expanded);
      }
    }
  }

  // Convert block segments once (avoids double conversion)
  const convertedParts = await convertBlockParts(markdownParts, n2m, name, stats, onError);

  // Check converted block content for images to determine leaf status
  const blockContent = convertedParts
    .filter((p) => p.type === 'blocks')
    .map((p) => p.content)
    .join('');
  const hasImages = hasExternalImages(blockContent);

  // A page is a leaf if it has no children and no images (applies to all pages)
  const isLeaf = childEntries.length === 0 && !hasImages;

  // Decide directory structure
  // If custom filename: use as-is (user controls extension)
  // Otherwise: slugify and add .md extension (backward compat)
  const extension = ctx.format === 'csv' ? '.csv' : '.md';
  const filename = isCustomFilename ? name : `${slugifyFilename(name)}${extension}`;
  const slugName = slugifyFilename(name); // Still need slugName for folder creation
  let pageDir, mdPath;
  if (ctx.format === 'flattened') {
    // Flat mode always writes a single markdown file at parentDir level.
    mdPath = path.join(parentDir, filename);
    pageDir = parentDir;
  } else if (isLeaf) {
    mdPath = path.join(parentDir, filename);
    pageDir = parentDir;
  } else {
    pageDir = path.join(parentDir, slugName);
    await ensureDir(pageDir);
    mdPath = path.join(pageDir, filename);
  }

  // Recurse into children BEFORE writing parent (to get leaf status for links)
  const childResults = new Map();
  if (ctx.format !== 'flattened' && childEntries.length > 0) {
    const pageCount = childEntries.filter((e) => e.type === 'page').length;
    const dbCount = childEntries.filter((e) => e.type === 'database').length;
    onStatus(`${name}: ${pageCount} sub-pages, ${dbCount} sub-databases`);
  }

  if (ctx.format !== 'flattened') {
    for (const entry of childEntries) {
      try {
        let result;
        if (entry.type === 'page') {
          result = await downloadPage(entry.block.id, entry.name, pageDir, ctx, visited, depth + 1, false);
        } else {
          result = await downloadDatabase(entry.block.id, entry.name, pageDir, ctx, visited, depth + 1, false);
        }
        childResults.set(entry.name, result || { isLeaf: false });
      } catch (err) {
        stats.errors.push({ title: entry.title, error: err.message });
        onError(`Failed: ${entry.title} — ${err.message}`);
        childResults.set(entry.name, { isLeaf: false });
      }
    }
  }

  // Before writing markdown, extract and prepend frontmatter if configured
  let frontmatterBody = '';
  if (ctx.frontmatter === true || typeof ctx.frontmatter === 'string') {
    try {
      const page = await notion.getPage(pageId);
      if (ctx.frontmatter === true) {
        frontmatterBody = buildFrontmatter(page.properties);
      } else {
        const prop = page.properties?.[ctx.frontmatter];
        if (prop) {
          const rawText = pagePropertyToText(prop);
          if (rawText.trim()) {
            frontmatterBody = rawText.endsWith('\n') ? rawText : `${rawText}\n`;
          }
        }
      }
    } catch (err) {
      if (ctx.debug) console.error(`[DEBUG] Failed to fetch page properties for frontmatter: ${err.message}`);
    }
  }

  // Assemble final markdown with the conditional frontmatter block
  let markdown = '';
  if (frontmatterBody) {
    markdown += `---\n${frontmatterBody}---\n\n`;
  }
  markdown += `# ${name}\n\n` + assembleMarkdown(convertedParts, childResults);

  if (!markdown.trim()) {
    markdown = `# ${name}\n`;
  }

  // Even in flat mode we want to download/rewire assets so the final single file
  // doesn't contain expiring external URLs.
  markdown = await processAssets(markdown, pageDir, stats, ctx);

  // In flat mode, rewrite internal links to inlined sub-pages to use anchor references
  if (ctx.format === 'flattened' && ctx.anchorMap && ctx.anchorMap.size > 0) {
    // Rewrite markdown links [text](pageId) or [text](pageId.md) to anchor references
    for (const [pageId, anchor] of ctx.anchorMap.entries()) {
      // Match both bare IDs and ID.md format
      const idRegex = new RegExp(`\\]\\(${pageId}(?:\\.md)?\\)`, 'g');
      markdown = markdown.replace(idRegex, `](${anchor})`);
    }
  }

  await writeFile(mdPath, markdown, 'utf-8');
  stats.writtenFiles.push(mdPath);
  stats.totalPages++;

  return { isLeaf };
}

/**
 * Download a database: create a folder and download each row as a page.
 */
async function downloadDatabase(databaseId, name, parentDir, ctx, visited, depth, isCustomFilename = false) {
  if (visited.has(databaseId)) return;
  if (depth > MAX_DEPTH) {
    ctx.stats.errors.push({ title: name, error: `Skipped: exceeded max depth of ${MAX_DEPTH}` });
    return;
  }
  visited.add(databaseId);

  const { notion, n2m, stats, onStatus, onLog, onError } = ctx;
  const slugName = slugifyFilename(name);
  const dbDir = path.join(parentDir, slugName);

  onStatus(`Querying database: ${name}`);

  let rows;
  try {
    rows = await notion.queryDatabase(databaseId);
  } catch (err) {
    stats.errors.push({ title: name, error: `Could not query database: ${err.message}` });
    onError(`Could not query database: ${name} — ${err.message}`);
    return;
  }

  onLog(`Database "${name}": ${rows.length} row${rows.length === 1 ? '' : 's'}`);

  // CSV mode: write one file at parentDir and skip per-row recursion/files.
  if (ctx.format === 'csv') {
    let ordered = [];
    try {
      const db = await notion.getDatabase(databaseId);
      const props = db?.properties && typeof db.properties === 'object' ? db.properties : {};
      const propEntries = Object.entries(props);
      const titleProp = propEntries.find(([, p]) => p?.type === 'title');
      const otherProps = propEntries.filter(([, p]) => p?.type !== 'title');
      ordered = titleProp ? [titleProp, ...otherProps] : otherProps;
    } catch {
      ordered = [];
    }

    const csv = await convertToCSV(rows, ordered, notion);
    await ensureDir(parentDir);
    // If custom filename: use as-is (user controls extension)
    // Otherwise: slugify and add .csv extension (backward compat)
    const csvFilename = isCustomFilename ? name : `${slugifyFilename(name)}.csv`;
    const csvPath = path.join(parentDir, csvFilename);
    try {
      await writeFile(csvPath, csv, 'utf-8');
      stats.writtenFiles.push(csvPath);
      onLog(`Wrote CSV: ${csvPath}`);
    } catch (err) {
      stats.errors.push({ title: name, error: `Could not write CSV: ${err.message}` });
      onError(`Could not write CSV for ${name} — ${err.message}`);
    }
    return { isLeaf: false };
  }

  // Flat markdown database export: write a single file with the database table only.
  if (ctx.format === 'flattened') {
    await ensureDir(parentDir);
    const block = { id: databaseId, child_database: { title: name } };
    const table = await childDatabaseToMarkdownTable(block, ctx, name, { includeHeading: false });
    const extension = ctx.format === 'csv' ? '.csv' : '.md';
    const filename = isCustomFilename ? name : `${slugifyFilename(name)}${extension}`;
    const mdPath = path.join(parentDir, filename);
    const content = `# ${name}\n\n${table}`;
    await writeFile(mdPath, content, 'utf-8');
    stats.writtenFiles.push(mdPath);
    stats.totalPages++;
    return { isLeaf: true };
  }

  await ensureDir(dbDir);

  const rowNames = new Set();
  const rowLinks = [];
  const rowLeafStatus = new Map();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    // Database rows ARE pages in Notion's model — track them for cycle detection
    if (visited.has(row.id)) continue;
    visited.add(row.id);

    const rowTitle = extractTitle(row);
    const rowName = uniqueFilename(sanitizeFilename(rowTitle), rowNames);

    onStatus(`${name}: row ${i + 1}/${rows.length} — ${rowTitle}`);
    rowLinks.push({ title: rowTitle, name: rowName });

    try {
      let frontmatterBody = '';
      if (ctx.frontmatter === true) {
        frontmatterBody = buildFrontmatter(row.properties);
      } else if (typeof ctx.frontmatter === 'string') {
        const prop = row.properties?.[ctx.frontmatter];
        if (prop) {
          const rawText = pagePropertyToText(prop);
          if (rawText.trim()) {
            frontmatterBody = rawText.endsWith('\n') ? rawText : `${rawText}\n`;
          }
        }
      }

      // Fetch blocks through throttled wrapper
      let blocks;
      try {
        const result = await notion.getBlockChildrenDeep(row.id);
        blocks = result.blocks;
        for (const w of result.warnings) {
          stats.errors.push({ title: rowTitle, error: `Skipped block ${w.blockType}: ${w.error}` });
          onError(`Partial fetch in ${rowTitle}: skipped ${w.blockType} block — ${w.error}`);
        }
      } catch (err) {
        blocks = [];
        stats.errors.push({ title: rowTitle, error: `Could not fetch blocks: ${err.message}` });
        onError(`Could not fetch blocks for row: ${rowTitle} — ${err.message}`);
      }

      const { markdownParts, childEntries } = splitBlocksAtBoundaries(blocks);

      // Convert block segments once
      const convertedParts = await convertBlockParts(markdownParts, n2m, rowTitle, stats, onError);
      const blockContent = convertedParts
        .filter((p) => p.type === 'blocks')
        .map((p) => p.content)
        .join('');
      const hasImages = hasExternalImages(blockContent);
      const rowIsLeaf = childEntries.length === 0 && !hasImages;
      rowLeafStatus.set(rowName, rowIsLeaf);

      // Recurse into children BEFORE writing row (to get leaf status for links)
      let rowDir;
      if (rowIsLeaf) {
        rowDir = dbDir;
      } else {
        rowDir = path.join(dbDir, rowName);
        await ensureDir(rowDir);
      }

      const childResults = new Map();
      for (const entry of childEntries) {
        try {
          let result;
          if (entry.type === 'page') {
            result = await downloadPage(entry.block.id, entry.name, rowDir, ctx, visited, depth + 1, false);
          } else {
            result = await downloadDatabase(entry.block.id, entry.name, rowDir, ctx, visited, depth + 1, false);
          }
          childResults.set(entry.name, result || { isLeaf: false });
        } catch (err) {
          stats.errors.push({ title: entry.title, error: err.message });
          onError(`Failed: ${entry.title} — ${err.message}`);
          childResults.set(entry.name, { isLeaf: false });
        }
      }

      // Assemble final markdown with correct links
      const markdown = assembleMarkdown(convertedParts, childResults);

      let content = '';
      if (frontmatterBody) {
        content += `---\n${frontmatterBody}---\n\n`;
      }
      content += `# ${rowName}\n\n${markdown}`;

      if (!rowIsLeaf) {
        content = await processAssets(content, rowDir, stats, ctx);
      }

      const mdPath = rowIsLeaf
        ? path.join(dbDir, `${rowName}.md`)
        : path.join(rowDir, `${rowName}.md`);
      await writeFile(mdPath, content, 'utf-8');
      stats.writtenFiles.push(mdPath);
      stats.totalPages++;
    } catch (err) {
      stats.errors.push({ title: rowTitle, error: err.message });
      onError(`Row failed: ${rowTitle} — ${err.message}`);
    }
  }

  // Create database index file listing all rows (with leaf-aware links)
  const indexLines = [`# ${name}\n`];
  for (const row of rowLinks) {
    const isLeaf = rowLeafStatus.get(row.name) || false;
    const linkPath = isLeaf
      ? `./${row.name}.md`
      : `./${row.name}/${row.name}.md`;
    indexLines.push(`- [${row.title}](${linkPath})`);
  }
  const indexPath = path.join(dbDir, `${name}.md`);
  await writeFile(indexPath, indexLines.join('\n') + '\n', 'utf-8');
  stats.writtenFiles.push(indexPath);

  return { isLeaf: false };
}

/**
 * Find and download all images/files in markdown content.
 * Rewrites URLs to relative ./assets/ paths using a single-pass replacement.
 */
async function processAssets(markdown, pageDir, stats, ctx) {
  const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
  const assetsDir = path.join(pageDir, 'assets');
  const usedAssetNames = new Set();

  const replacements = new Map();
  const downloads = [];

  for (const match of markdown.matchAll(imageRegex)) {
    const [full, alt, url] = match;

    if (url.startsWith('data:') || !url.startsWith('http')) continue;
    if (!isAllowedUrl(url)) continue;

    const filename = getAssetFilename(url, usedAssetNames);
    downloads.push({ url, fullMatch: full, alt, filename });
  }

  if (downloads.length === 0) return markdown;

  ctx.onStatus(`Downloading ${downloads.length} asset${downloads.length === 1 ? '' : 's'}...`);

  await ensureDir(assetsDir);

  // Download assets with bounded concurrency (CDN, not Notion API — no rate limit)
  let completed = 0;
  const downloadControllers = new Map();

  try {
    await runWithConcurrency(downloads, ASSET_CONCURRENCY, async (dl) => {
      const assetPath = path.join(assetsDir, dl.filename);
      const controller = new AbortController();
      downloadControllers.set(dl.filename, controller);
      try {
        await downloadFile(dl.url, assetPath, { parentSignal: controller.signal });
        stats.totalAssets++;
        replacements.set(dl.fullMatch, `![${dl.alt}](./assets/${dl.filename})`);
      } catch (err) {
        ctx.onError(`Asset failed: ${dl.filename} — ${err.message}`);
      } finally {
        downloadControllers.delete(dl.filename);
        completed++;
        ctx.onStatus(`Assets: ${completed}/${downloads.length}`);
      }
    });
  } catch (err) {
    // Ensure any in-flight downloads are aborted so there are no lingering
    // network handles or background work (addresses orphaned resource reports).
    for (const ctrl of downloadControllers.values()) {
      try { ctrl.abort(); } catch (e) {}
    }
    throw err;
  }

  if (replacements.size === 0) return markdown;

  return markdown.replace(imageRegex, (match) => {
    return replacements.get(match) || match;
  });
}

/**
 * Run async tasks with bounded concurrency.
 */
async function runWithConcurrency(items, limit, fn) {
  let index = 0;
  let stopped = false;
  const errors = [];

  async function worker() {
    while (!stopped && index < items.length) {
      const item = items[index++];
      try {
        await fn(item);
      } catch (err) {
        // Signal other workers to stop and capture error for re-throwing
        stopped = true;
        errors.push(err);
        break;
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  if (errors.length) throw errors[0];
}

/**
 * Download a file from a URL to a local path with timeout.
 */
async function downloadFile(url, destPath, { parentSignal } = {}) {
  const controller = new AbortController();
  let parentListener = null;
  if (parentSignal) {
    if (parentSignal.aborted) controller.abort();
    else {
      parentListener = () => controller.abort();
      try { parentSignal.addEventListener('abort', parentListener, { once: true }); } catch (e) {}
    }
  }

  const timeoutId = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  try {
    if (!isAllowedUrl(url)) {
      throw new Error('Disallowed URL');
    }
    await downloadToPath(url, destPath, { parentSignal: controller.signal, retries: 2, backoff: 150, timeoutMs: DOWNLOAD_TIMEOUT_MS, maxSize: MAX_ASSET_SIZE });
  } catch (err) {
    throw wrapError(`Failed to download ${url} — ${err && err.message ? err.message : String(err)}`, err);
  } finally {
    clearTimeout(timeoutId);
    if (parentSignal && parentListener) {
      try { parentSignal.removeEventListener('abort', parentListener); } catch (e) {}
    }
  }
}

/**
 * Extract a suitable filename from a URL.
 */
function getAssetFilename(url, usedNames) {
  try {
    const parsed = new URL(url);
    let filename = parsed.pathname.split('/').pop() || 'file';

    if (!path.extname(filename)) {
      filename += '.png';
    }

    filename = filename.replace(/[<>:"/\\|?*]/g, '');

    if (usedNames.has(filename)) {
      const ext = path.extname(filename);
      const base = path.basename(filename, ext);
      let counter = 2;
      while (usedNames.has(`${base}-${counter}${ext}`)) {
        counter++;
      }
      filename = `${base}-${counter}${ext}`;
    }

    usedNames.add(filename);
    return filename;
  } catch {
    const fallback = `asset-${usedNames.size + 1}.png`;
    usedNames.add(fallback);
    return fallback;
  }
}

/**
 * Build YAML frontmatter from database page properties.
 * All string values are properly quoted to prevent YAML injection.
 */
function buildFrontmatter(properties) {
  if (!properties) return '';

  const lines = [];

  for (const [key, prop] of Object.entries(properties)) {
    if (prop.type === 'title') continue;

    const value = extractPropertyValue(prop);
    if (value !== null) {
      const safeKey = /[:#{}[\],&*?|>!%@`]/.test(key) ? `"${escapeYaml(key)}"` : key;
      lines.push(`${safeKey}: ${value}`);
    }
  }

  return lines.length > 0 ? lines.join('\n') + '\n' : '';
}

function escapeYaml(str) {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function yamlString(val) {
  if (val === null || val === undefined) return null;
  return `"${escapeYaml(String(val))}"`;
}

function extractPropertyValue(prop) {
  switch (prop.type) {
    case 'rich_text': {
      const text = prop.rich_text?.map((t) => t.plain_text).join('');
      return text ? yamlString(text) : null;
    }
    case 'number':
      return prop.number;
    case 'select':
      return prop.select?.name ? yamlString(prop.select.name) : null;
    case 'multi_select':
      if (!prop.multi_select?.length) return null;
      return `[${prop.multi_select.map((s) => yamlString(s.name)).join(', ')}]`;
    case 'date':
      if (!prop.date) return null;
      return prop.date.end
        ? yamlString(`${prop.date.start} → ${prop.date.end}`)
        : yamlString(prop.date.start);
    case 'checkbox':
      return prop.checkbox;
    case 'url':
      return prop.url ? yamlString(prop.url) : null;
    case 'email':
      return prop.email ? yamlString(prop.email) : null;
    case 'phone_number':
      return prop.phone_number ? yamlString(prop.phone_number) : null;
    case 'status':
      return prop.status?.name ? yamlString(prop.status.name) : null;
    default:
      return null;
  }
}
