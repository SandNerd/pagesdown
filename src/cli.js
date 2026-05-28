import * as p from '@clack/prompts';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { NotionClient, extractTitle } from './notion.js';
import { loadConfig, saveConfig } from './config.js';
import { getSaveLocationOptions, isWritablePath } from './utils.js';
import { downloadPages } from './download.js';

/** Exit cleanly if the user cancels a prompt. */
function exitIfCancelled(value) {
  if (p.isCancel(value)) {
    p.cancel('Cancelled.');
    process.exit(0);
  }
  return value;
}

/**
 * Extract a Notion ID from a raw input (URL or UUID). Returns a 32-char hex string
 * when possible, otherwise returns the original input.
 */
function extractNotionId(input) {
  if (!input || typeof input !== 'string') return input;
  const re = /([a-f0-9]{8}-?[a-f0-9]{4}-?[a-f0-9]{4}-?[a-f0-9]{4}-?[a-f0-9]{12})|([a-f0-9]{32})/i;
  const m = input.match(re);
  if (!m) return input;
  const id = (m[1] || m[2] || '').replace(/-/g, '');
  return id;
}

const BANNER = `
██████╗  █████╗  ██████╗ ███████╗███████╗
██╔══██╗██╔══██╗██╔════╝ ██╔════╝██╔════╝
██████╔╝███████║██║  ███╗█████╗  ███████╗
██╔═══╝ ██╔══██║██║   ██║██╔══╝  ╚════██║
██║     ██║  ██║╚██████╔╝███████╗███████║
╚═╝     ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚══════╝
██████╗  ██████╗ ██╗    ██╗███╗   ██╗
██╔══██╗██╔═══██╗██║    ██║████╗  ██║
██║  ██║██║   ██║██║ █╗ ██║██╔██╗ ██║
██║  ██║██║   ██║██║███╗██║██║╚██╗██║
██████╔╝╚██████╔╝╚███╔███╔╝██║ ╚████║
╚═════╝  ╚═════╝  ╚══╝╚══╝ ╚═╝  ╚═══╝
`;

function parseArgs(argv) {
  const out = { flat: false, id: null, out: null, help: false, token: null };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--flat' || a === '-f') out.flat = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--id' || a === '-i') {
      const raw = argv[i + 1];
      out.id = extractNotionId(raw);
      i += 1;
    } else if (a === '--out' || a === '-o') {
      out.out = argv[i + 1];
      i += 1;
    } else if (a === '--token' || a === '-t') {
      out.token = argv[i + 1];
      i += 1;
    }
  }

  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log([
      'Usage: pagesdown [options]',
      '',
      'Options:',
      '  -i, --id <id-or-url>  Specify an explicit Notion Page/Database UUID or full Share Link',
      '  -f, --flat            Enable unified single-file context layout mode',
      '  -o, --out <path>      Specify a custom local directory output path (default: current directory)',
      '  -h, --help            Show this help information',
    ].join('\n'));
    process.exit(0);
  }
  console.log(BANNER);
  p.intro('pagesdown v0.1.2');

  // ── Prepare config/token ──────────────────────────────────────────
  let token = null;
  let workspaceName = null;

  const savedConfig = await loadConfig();

  // If user supplied a new token via CLI flag, prefer and save it (after validation)
  let tokenSavedViaFlag = false;
  if (args.token) {
    token = args.token;
    const spinValidate = p.spinner();
    spinValidate.start('Validating token...');
    const tmpClient = new NotionClient(token);
    try {
      await tmpClient.validateToken();
      spinValidate.stop('Token valid.');
      // Save immediately
      await saveConfig({ token, workspace: savedConfig?.workspace });
      tokenSavedViaFlag = true;
      p.log.success('Token saved to ~/.pagesdown/config.json');
    } catch (err) {
      spinValidate.stop('Validation failed.');
      p.log.error('Provided token is invalid. Aborting.');
      process.exit(1);
    }
  }

  // Use saved token silently if present (no interactive prompt)
  if (!token && savedConfig?.token) {
    token = savedConfig.token;
    workspaceName = savedConfig.workspace;
  }

  // Headless mode: --id provided -> skip interactive prompts entirely
  if (args.id) {
    // Prefer token already resolved (flag or saved), fallback to env var
    token = token || process.env.NOTION_TOKEN || null;

    if (!token) {
      p.log.error('No Notion token found. Set NOTION_TOKEN or save a token with the CLI.');
      process.exit(1);
    }

    // Connect and validate
    const spin = p.spinner();
    spin.start('Connecting to Notion...');

    const notion = new NotionClient(token);
    try {
      await notion.validateToken();
      spin.stop('Connected to Notion.');
    } catch (err) {
      spin.stop('Connection failed.');
      p.log.error(
        err.status === 401
          ? 'Invalid token. Make sure you copied the "Internal Integration Secret", not the Integration ID.'
          : 'Could not connect to Notion. Check your internet connection and try again.'
      );
      process.exit(1);
    }

    // Resolve target id (page or database) and fetch title
    let targetItem;
    try {
      const page = await notion.getPage(args.id);
      const name = extractTitle(page) || 'Exported-Page';
      targetItem = { id: args.id, name, type: 'page' };
    } catch (errPage) {
      try {
        const db = await notion.getDatabase(args.id);
        const name = db?.title?.length ? db.title.map((t) => t.plain_text).join('') : 'Exported-Page';
        targetItem = { id: args.id, name, type: 'database' };
      } catch (errDb) {
        p.log.error(`Could not fetch page or database with id "${args.id}". Ensure the ID is correct and shared with the integration.`);
        process.exit(1);
      }
    }

    // Resolve output path
    const savePath = path.resolve(args.out || process.cwd());

    if (!(await isWritablePath(savePath))) {
      p.log.error(`Cannot write to "${savePath}". Check that the folder exists and you have permission.`);
      process.exit(1);
    }

    if (existsSync(savePath)) {
      p.log.info(`"${savePath}" already exists. New pages will be added, existing pages will be updated.`);
    }

    // Start download immediately with a single-item map
    spin.start('Starting download...');

    const stats = await downloadPages([ { id: targetItem.id, name: targetItem.name, type: targetItem.type } ], savePath, notion, {
      onStatus: (message) => spin.message(message),
      onLog: (message) => {
        spin.stop(message);
        spin.start('...');
      },
      onError: (message) => {
        spin.stop('');
        p.log.warn(message);
        spin.start('Continuing...');
      },
    }, { flat: args.flat });

    spin.stop(`${stats.totalPages} page${stats.totalPages === 1 ? '' : 's'}, ${stats.totalAssets} asset${stats.totalAssets === 1 ? '' : 's'} downloaded.`);

    // Summary
    const summary = [`${stats.totalPages} page${stats.totalPages === 1 ? '' : 's'} downloaded`];
    if (stats.totalAssets > 0) summary.push(`${stats.totalAssets} file${stats.totalAssets === 1 ? '' : 's'} saved`);
    if (stats.errors.length > 0) summary.push(`${stats.errors.length} error${stats.errors.length === 1 ? '' : 's'}`);

    if (stats.errors.length > 0) {
      p.log.warn('Some items had errors:');
      for (const err of stats.errors) {
        p.log.warn(`  - ${err.title}: ${err.error}`);
      }
    }

    p.note(savePath, 'Saved to');
    p.outro(`Done! ${summary.join(', ')}.`);
    process.exit(0);
  }

  if (!token) {
    p.note(
      [
        '1. Open: https://www.notion.so/profile/integrations/internal/form/new-integration',
        '2. Fill in a name (e.g. "export-to-fs"), select your workspace',
        '   Note: the name cannot contain the word "notion"',
        '3. Under Capabilities:',
        '   - Content: check only "Read content", uncheck the rest',
        '   - Comments: uncheck all',
        '   - User capabilities: select "No user information"',
        '4. Click "Create" → copy the "Internal Integration Secret"',
      ].join('\n'),
      'Step 1: Create a Notion integration'
    );

    token = exitIfCancelled(
      await p.password({
        message: 'Paste your integration token:',
        validate: (val) => {
          if (!val) return 'Token is required.';
          if (!val.startsWith('ntn_') && !val.startsWith('secret_')) {
            return 'Token should start with "ntn_" (or "secret_" for older tokens).';
          }
        },
      })
    );
  }

  // ── Step 2: Validate token ────────────────────────────────────────
  const spin = p.spinner();
  spin.start('Connecting to Notion...');

  const notion = new NotionClient(token);

  try {
    await notion.validateToken();
    spin.stop('Connected to Notion.');
  } catch (err) {
    spin.stop('Connection failed.');
    p.log.error(
      err.status === 401
        ? 'Invalid token. Make sure you copied the "Internal Integration Secret", not the Integration ID.'
        : 'Could not connect to Notion. Check your internet connection and try again.'
    );
    process.exit(1);
  }

  // ── Step 3: Share pages with integration ──────────────────────────
  if (!savedConfig?.token || savedConfig.token !== token) {
    p.note(
      [
        'Now share ALL the pages you want to download:',
        '',
        '  1. Open a page in Notion',
        '  2. Click the ••• menu at the top right',
        '  3. Select "Connections"',
        '  4. Add your integration',
        '',
        'Repeat for each top-level page or database you want.',
        'Sharing a parent page automatically shares all its children.',
        '',
        'Don\'t worry if you miss some — you can add more later.',
      ].join('\n'),
      'Step 2: Share pages with your integration'
    );

    exitIfCancelled(
      await p.confirm({
        message: 'I\'ve shared my pages. Continue?',
      })
    );
  }

  // ── Step 3: Fetch & select pages (with refresh loop) ──────────────
  let selected;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    spin.start('Fetching your pages...');

    let topLevelItems;
    try {
      topLevelItems = await notion.getTopLevelPages({
        onProgress: (count) => spin.message(`Scanning... (${count} items found)`),
      });
    } catch (err) {
      spin.stop('Failed to fetch pages.');
      p.log.error(`Error: ${err.message}`);
      process.exit(1);
    }

    spin.stop(`Found ${topLevelItems.length} top-level item${topLevelItems.length === 1 ? '' : 's'}.`);

    if (topLevelItems.length === 0) {
      p.log.warn('No pages found. Make sure you\'ve shared at least one page with your integration.');

      const retry = exitIfCancelled(
        await p.confirm({
          message: 'Share some pages in Notion, then try again?',
        })
      );

      if (!retry) {
        p.cancel('No pages to download.');
        process.exit(0);
      }
      continue;
    }

    const options = topLevelItems.map((item) => ({
      value: item,
      label: item.title,
      hint: item.type === 'database' ? 'database' : undefined,
    }));

    p.log.info('Hint: arrows move, space toggle, enter confirm');

    selected = exitIfCancelled(
      await p.multiselect({
        message: 'Select pages to download:',
        options,
        required: true,
      })
    );

    const looksGood = exitIfCancelled(
      await p.confirm({
        message: 'Look good? (No = share more pages in Notion and refresh the list)',
      })
    );

    if (!looksGood) {
      p.note(
        [
          '  1. Open a page in Notion',
          '  2. Click the ••• menu at the top right',
          '  3. Select "Connections"',
          '  4. Add your integration',
          '',
          'Sharing a parent page automatically shares all its children.',
        ].join('\n'),
        'How to share pages with your integration'
      );
      exitIfCancelled(
        await p.confirm({ message: 'Done sharing? Press Enter to refresh.' })
      );
      continue;
    }

    break;
  }

  // ── Step 5: Save location ─────────────────────────────────────────
  const locationOptions = getSaveLocationOptions();

  let savePath;

  const locationChoice = exitIfCancelled(
    await p.select({
      message: 'Where should we save the files?',
      options: locationOptions,
    })
  );

  if (locationChoice === 'custom') {
    const rawPath = exitIfCancelled(
      await p.text({
        message: 'Enter the full path:',
        validate: (val) => {
          if (!val?.trim()) return 'Path is required.';
        },
      })
    );
    savePath = path.resolve(rawPath);
  } else {
    savePath = locationChoice;
  }

  // Validate the path is writable
  if (!(await isWritablePath(savePath))) {
    p.log.error(`Cannot write to "${savePath}". Check that the folder exists and you have permission.`);
    process.exit(1);
  }

  // Inform user about merge behavior if directory exists
  if (existsSync(savePath)) {
    p.log.info(`"${savePath}" already exists. New pages will be added, existing pages will be updated.`);
  }

  // ── Step 6: Confirm & Download ────────────────────────────────────
  const proceed = exitIfCancelled(
    await p.confirm({
      message: `Download ${selected.length} item${selected.length === 1 ? '' : 's'} to ${savePath}?`,
    })
  );

  if (!proceed) {
    p.cancel('Cancelled.');
    process.exit(0);
  }

  // Save token automatically if we prompted for it (no saved config existed)
  if (!savedConfig?.token && !tokenSavedViaFlag && token) {
    try {
      await saveConfig({ token, workspace: workspaceName });
      p.log.success('Token saved to ~/.pagesdown/config.json');
    } catch {
      p.log.warn('Failed to save token to config file.');
    }
  }

  // ── Download ──────────────────────────────────────────────────────
  spin.start('Starting download...');

  const stats = await downloadPages(selected, savePath, notion, {
    onStatus: (message) => spin.message(message),
    onLog: (message) => {
      spin.stop(message);
      spin.start('...');
    },
    onError: (message) => {
      spin.stop('');
      p.log.warn(message);
      spin.start('Continuing...');
    },
  }, { flat: args.flat });

  spin.stop(`${stats.totalPages} page${stats.totalPages === 1 ? '' : 's'}, ${stats.totalAssets} asset${stats.totalAssets === 1 ? '' : 's'} downloaded.`);

  // ── Summary ───────────────────────────────────────────────────────
  const summary = [`${stats.totalPages} page${stats.totalPages === 1 ? '' : 's'} downloaded`];
  if (stats.totalAssets > 0) {
    summary.push(`${stats.totalAssets} file${stats.totalAssets === 1 ? '' : 's'} saved`);
  }
  if (stats.errors.length > 0) {
    summary.push(`${stats.errors.length} error${stats.errors.length === 1 ? '' : 's'}`);
  }

  if (stats.errors.length > 0) {
    p.log.warn('Some items had errors:');
    for (const err of stats.errors) {
      p.log.warn(`  - ${err.title}: ${err.error}`);
    }
  }

  p.note(savePath, 'Saved to');
  p.outro(`Done! ${summary.join(', ')}.`);
}

main().catch(() => {
  p.log.error('Unexpected error. Please try again.');
  process.exit(1);
});
