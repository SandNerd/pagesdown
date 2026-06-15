## pagesdown

Download your Notion content to local Markdown files. It now supports both a guided interactive flow and a fully headless CLI, with LLM-friendly flat exports, slugged filenames, and config-backed defaults.

### Why?

I got sick of Notion's MCP server burning through tokens on every read, querying back and forth for what should be a simple task. The search tool can't even list database pages without a query. Connection drops kill your flow mid-task.

I'm local-first on almost everything now — the cloud just happens after my work, for syncing results. So I decided to pull my thousands of Notion pages down to local Markdown and enjoy my sweet time with my agents. Zero MCP overhead, zero token waste, works offline.

**Works with** Claude Code, Codex, and any agent that reads your local filesystem.

### How It Works

```bash
npx pagesdown      # one-shot, no install
pagesdown          # after global install
```

Under the hood:

- **You choose** which Notion pages / databases to export.
- pagesdown walks the block tree, resolves synced content, converts everything to Markdown, and mirrors structure on disk.
- Your local agent just reads `.md` files — no live Notion calls, no token burn.

### Developer documentation

For contributors and automation agents, we maintain concise developer docs that map features to files, explain the ledger and manifest formats, and provide quick setup steps:

- **Architecture & module map:** [docs/ARCH.md](docs/ARCH.md)
- **Spec (manifest, ledger, markers):** [docs/SPEC.md](docs/SPEC.md)
- **Developer quickstart & code map:** [docs/DEVELOPER_QUICKSTART.md](docs/DEVELOPER_QUICKSTART.md)

**Before (MCP):** Agent → Notion API call → wait → parse response → tokens burned on every read
**After (pagesdown):** Agent → reads local `.md` file → done

### Prerequisites

- **Node.js 20.12 or later** — download from [`https://nodejs.org`](https://nodejs.org) (click the big green button, run the installer).
- A Notion workspace where you can create an internal integration.

### Install & Run as a CLI

You can either use `npx` for a one‑off run or install globally as a normal CLI.

- **One‑off (no install):**

  ```bash
  npx pagesdown
  ```

- **Global install (recommended if you use it often):**

  ```bash
  npm install -g pagesdown

  # then anywhere:
  pagesdown
  ```

The package exposes a `pagesdown` binary via `bin/cli.js`, so once installed globally it behaves like any other Node‑based CLI.

### Setup Your Notion Integration (2 minutes)

The CLI guides you through this, but here's the overview:

**1. Create an internal integration**

Go to: [notion.so/profile/integrations/internal/form/new-integration](https://www.notion.so/profile/integrations/internal/form/new-integration)

- **Name:** anything you want (e.g. "export-to-fs") — cannot contain the word "notion"
- **Associated workspace:** select yours
- **Icon:** skip it
- Click **Create**

**2. Set capabilities**

On the next page, under **Capabilities**:
- **Content capabilities:**
  - **Read content** — check this (the only one you need)
  - **Update content** — uncheck
  - **Insert content** — uncheck
- **Comment capabilities:**
  - **Read comments** — uncheck
  - **Insert comments** — uncheck
- **User capabilities:**
  - Select **"No user information"**

Click **Save**.

**3. Copy your token**

Copy the **Internal Integration Secret** (starts with `ntn_`).

**4. Share pages with the integration**

Open any page you want to download in Notion:
- Click the **•••** menu at the top right
- Select **Connections**
- Add your integration

> Sharing a parent page automatically shares all its children.

### What You Get

```text
~/Desktop/notion-export/
├── Project Alpha/
│   ├── Project Alpha.md
│   ├── Meeting Notes/
│   │   ├── Meeting Notes.md
│   │   └── assets/
│   │       └── screenshot.png
│   └── Design Doc/
│       └── Design Doc.md
└── Personal/
    ├── Personal.md
    └── Reading List/
        └── Reading List.md
```

- **Pages → Markdown**: each page becomes a `.md` file with clean Markdown.
- **Folders mirror Notion**: hierarchy on disk matches your Notion structure.
- **Assets downloaded**: images/files go into `assets/` folders with working relative links.
- **Databases exported**:
  - As folder hierarchies with one page file per row (existing behavior).
  - And when used inline (see below), as Markdown tables embedded directly in the parent page.

### Inline Flattening Features

- **Synced blocks** (`synced_block`):
  - Source blocks (where `synced_from` is `null`) render their child blocks inline.
  - Referencing synced blocks fetch the original children and render them inline exactly where they appear.
- **Inline databases** (`child_database` inside a page):
  - Rendered inline as a Markdown **pipe table** with:
    - Column headers from the database schema.
    - One row per Notion row/page, with property values (Title, Select, Multi‑Select, Text, Number, Date, Checkbox, etc.) converted to plain text.
  - Ideal for feeding LLMs a compact view of structured data without separate files.

### `--flat` mode: single‑file, LLM‑friendly context

By default, pagesdown creates folders and separate markdown files for sub‑pages.

If you want a **single, unified context file** for local LLMs (similar to repomix‑style dumps), use `--flat`:

```bash
pagesdown --flat
# or
npx pagesdown --flat
```

When `--flat` is enabled:

- **No sub‑page folders/files** are created for `child_page` blocks.
- Instead, each sub‑page is **fully downloaded and rendered inline** into the parent document.
- The inlined sub‑page is wrapped with explicit markers so LLMs can see context shifts clearly (and so nested code blocks can’t accidentally break the parent document):

```text
<!-- pagesdown:subpage:start -->
### Sub-Page Content: Your Sub-Page Title

<Rendered Markdown content of the sub-page...>
<!-- pagesdown:subpage:end -->
```

This preserves structure but keeps everything in a single file that’s easy to feed to an LLM.

### Headless Mode

pagesdown can run without prompts when you already know the target page or database:

```bash
pagesdown --id "https://www.notion.so/My-Page-abcdef1234567890abcdef1234567890" --out ~/Desktop/notion-export
```

Useful variants:

```bash
pagesdown --id <uuid-or-url> --out <folder>
pagesdown -i - --out <folder>              # read the URL from stdin
pagesdown --id-clip --out <folder>         # macOS clipboard input
pagesdown --token <secret> --id <uuid>     # validate and save token before exporting
pagesdown --set-default-out <folder>       # save a global default output directory and exit
pagesdown --debug --id <uuid>              # verbose logs for troubleshooting
```

When you run headless, the save path is resolved in this order:

1. `--out`
2. saved default output directory from `~/.pagesdown/config.json`
3. the current working directory

If you choose a custom folder interactively, pagesdown can also offer to save it as the new default for future headless exports.

### Batch Sync Mode

For automated, declarative batch downloads, use `pagesdown sync` with a `pagesdown.config.json` manifest:

```bash
pagesdown sync
```

This reads sync targets from `pagesdown.config.json` in the current directory first, then falls back to `~/.pagesdown/config.json` if no local targets are defined. Each target can have a custom output directory and optional custom filename.

If `pagesdown.config.json` also includes a `token` or `defaultOutputDir`, those values take precedence over `~/.pagesdown/config.json` when the file is present in the current directory.

#### Config File Format

Create a `pagesdown.config.json` in your project root:

```json
{
  "token": "ntn_xxx_local_override",
  "defaultOutputDir": "./exports",
  "targets": [
    {
      "source": "https://www.notion.so/My-Page-abcdef1234567890abcdef1234567890",
      "outDir": "./docs/my-page",
      "filename": "main",
      "format": "markdown-tree"
    },
    {
      "source": "abcdef1234567890abcdef1234567890ab",
      "outDir": "./exports/database",
      "format": "markdown-flat"
    }
  ]
}
```

Each target supports:
- **`source`** (required): Notion page/database UUID or full share URL (previously `id`/`url`).
- **`outDir`** (required): local directory where files will be saved.
- **`filename`** (optional): override the Notion title with this custom name (without extension).
- **`format`** (optional): one of `"markdown-tree"` (default), `"markdown-flat"`, or `"csv"`. Controls how the downloader emits files for this target.
- **`sync`** (optional): one of `"pull-only"` (default), `"push-only"`, `"two-way"`, `"push-override"`, `"two-way-override"`. Controls sync behavior and whether local edits are pushed back to Notion.
- **`conflict`** (optional, `"local-wins"` | `"notion-wins"`): conflict policy used when both the local file and the remote page changed. Default is `"notion-wins"`, which preserves the Notion version by downloading it. Set `"local-wins"` to overwrite the cloud copy from the local file.
- **`disabled`** (optional, boolean): set to `true` to temporarily disable a target. Disabled targets are ignored by `pagesdown sync` and by watch mode; they will not be fetched, downloaded, or pushed. Use this to temporarily exclude a target without removing it from your manifest.

#### Format Options

pagesdown supports three per-target output formats: `markdown-tree` (default), `markdown-flat`, and `csv`. Set the `format` field on each target to choose how pages and databases are emitted on disk.

- `markdown-tree` (default)
  - What it does: creates a directory hierarchy that mirrors Notion. Each page is written as its own `.md` file. Child pages become subfolders with their own `.md` files. Assets are saved into `assets/` folders alongside each page.
  - When to use: when you want a browsable on-disk mirror with one file per page.
  - Example output:

```text
./docs/my-page/
├── My Page.md
├── Sub-Page/
│   └── Sub-Page.md
└── assets/
    └── image.png
```

  - Config example:

```json
{
  "source": "https://www.notion.so/My-Page-abcdef...",
  "outDir": "./docs/my-page",
  "format": "markdown-tree"
}
```

- `markdown-flat`
  - What it does: inlines child pages into the parent document and writes a single `.md` file at the `outDir` level. Inlined sub-pages are wrapped with explicit markers so LLMs and tools can detect boundaries.
  - When to use: when you prefer a single LLM-friendly file per target.
  - Example output:

```text
./docs/
└── my-page.md      # contains full page + inlined sub-pages
└── assets/
    └── image.png
```

  - Inlined subpage markers example (inside `my-page.md`):

```html
<!-- pagesdown:subpage:start -->
### Sub-Page Title

<content of sub-page...>
<!-- pagesdown:subpage:end -->
```

  - Config example:

```json
{
  "source": "...",
  "outDir": "./docs",
  "filename": "my-page.md",
  "format": "markdown-flat"
}
```

- `csv`
  - What it does: when a target points at a Notion database, pagesdown writes a single RFC4180-compliant CSV file with one row per database row. Column order follows the database properties (Title first when present). The CSV is written into the target `outDir` as `filename` (if provided) or `<slugified-database-name>.csv`.
  - When to use: exporting Notion databases for spreadsheets or downstream data processing.
  - Notes:
    - Multi-select values are joined with `, `.
    - Relation columns attempt to resolve and include related page titles when possible.
    - Fields are quoted according to RFC4180 rules when needed.
  - Config example:

```json
{
  "source": "<database-id-or-url>",
  "outDir": "./exports/db",
  "format": "csv",
  "filename": "my-database.csv"
}
```

Tips:
- If `filename` contains a code extension (for example `script.js` or `deploy.sh`), pagesdown treats the target as a code artifact and extracts Notion `code` blocks into a plain file (no Markdown).
- The CLI flags `--flat` and the legacy `--type csv` map directly to `format` values: `--flat` → `markdown-flat`, `--type csv` or `--format csv` → `csv`.

#### Two-Way Sync

When `sync` is set to `"two-way"` (or `"two-way-override"`), pagesdown will:

1. Check the local file hash against the `.pagesdown-state.json` ledger.
2. If the local file has changed but the Notion page hasn't (same `last_edited_time`), push the local edits to Notion.
3. Clear the page content and replace it with the Markdown-generated blocks.
4. Update the ledger with the new file hash and remote mtime.

Script & code-file syncs

If you configure a target with a `filename` that includes a code extension (for example `script.js`, `deploy.sh`, or `schema.sql`), pagesdown treats that target as a code artifact rather than a Markdown document when downloading.

- On download, pagesdown will extract raw `code` blocks from the Notion page and concatenate them into a plain code file (no Markdown fences or headers). This produces a clean, ready-to-run source file for local development or LLM agents.
-- On upload (two-way, push-only, or their `-override` variants), pagesdown performs a safety check and will abort any push if the local file contains flattened Markdown tables or sub-page markers — these indicate that pushing could destroy live Notion database structure. To force a push despite detected table/subpage signatures, set `sync` to either `push-override` or `two-way-override`. In non-override modes the CLI will warn with a `[SAFETY BYPASS]` message and skip the push for that target.

This creates a safe developer workflow: keep scripts as code files in Notion using `code` blocks, and use pagesdown to synchronize them without accidental structural damage to your Notion databases.

This enables safe round-trip editing: make changes to the local Markdown file, and they'll be synced back to Notion when you run `pagesdown sync`.

When `sync` is set to `"push-only"` (or `"push-override"`), pagesdown will:

1. Skip remote timestamp checks for that target.
2. Compare the local file hash to the ledger's `last_synced_local_hash`.
3. Push local changes with a clear-and-append overwrite when the hash changes.
4. Log `[Up to date] filename (skipped)` when nothing changed locally.

When `conflict` is set, pagesdown will:

1. Treat `local-wins` as an overwrite to Notion when both sides changed.
2. Treat `notion-wins` as the safe default that keeps the cloud version and downloads it instead.

Top-level `pagesdown.config.json` fields can also include:
- **`token`** (optional): local Notion token override for this directory.
- **`defaultOutputDir`** (optional): default export path for headless exports in this directory.

#### JSON Schema

A machine-readable JSON Schema is included to help editors validate and autocomplete `pagesdown` config files.

- **Schema file:** [schemas/config.schema.json](schemas/config.schema.json)
- **Enable editor validation:** Add a top-level `$schema` entry to your `~/.pagesdown/config.json` pointing to the raw schema URL:

```json
{
  "$schema": "https://raw.githubusercontent.com/neethanwu/pagesdown/main/schemas/config.schema.json"
}
```

- **Validate locally:** A small validator script is provided at `scripts/validate-config.js` (it uses `ajv`):

```bash
# install the validator dependency
npm install --save-dev ajv

# validate the user config (default: ~/.pagesdown/config.json)
node scripts/validate-config.js

# or validate a specific file
node scripts/validate-config.js ./pagesdown.config.json
```

#### Usage

```bash
# Run sync with saved token from ~/.pagesdown/config.json
pagesdown sync

# Or with explicit token
NOTION_TOKEN=ntn_xxx pagesdown sync

# With debug logging
pagesdown sync --debug

# Cache behavior: by default `pagesdown sync` records a local ledger (.pagesdown-state.json)
# mapping Notion IDs to generated output files and file hashes, so future syncs can
# skip unchanged targets. To force full downloads and bypass the ledger, use:

pagesdown sync --no-cache
```

The sync command:
1. Loads the manifest from `pagesdown.config.json`.
2. Uses your saved Notion token (from `~/.pagesdown/config.json` or `NOTION_TOKEN` env var).
3. Processes each target in sequence.
4. Reports success/failure for each target and exits with status 1 if any target failed.

Filtering targets

You can limit which targets are processed by passing a positional filter after the `sync` command or by using the `--group`/`-g` flag.

- Positional filter: `pagesdown sync sys-design` — runs only targets whose `name` or `group` matches `sys-design`.
- Group flag: `pagesdown sync --group docs` or `pagesdown sync -g docs` — runs only targets with `group: "docs"`.

Note: To use name-based filtering, ensure your targets include a `name` field in `pagesdown.config.json`. If some targets lack `name`, pagesdown will warn with a tip asking you to add descriptive names to the manifest.

#### Watch Mode

Enable real-time file monitoring and automatic push-to-Notion with the `--watch` or `-w` flag:

```bash
pagesdown sync --watch
# or shorthand
pagesdown sync -w
```

When watch mode is active:

1. **Baseline sync runs first** to ensure local and remote are aligned.
2. **File watchers** are set up on all tracked directories for your sync targets.
3. **On local file change**, pagesdown detects the modification, calculates the new SHA-256 hash, and compares it to the ledger.
4. **If the hash differs**, pagesdown immediately:
   - Validates the file doesn't contain flattened Markdown tables or sub-page markers (safety check).
   - Pushes the changed file to Notion by clearing the page content and appending new blocks.
   - Updates the ledger with the new hash and remote mtime.
   - Logs a timestamped confirmation: `[Watcher] HH:MM:SS - Pushed upstream successfully.`
5. **Ctrl+C** closes all file watchers cleanly, flushes the ledger to disk, and exits.

Watch mode works with both `push-only` and `two-way` sync modes (or the corresponding override variants). It requires that your targets have been downloaded and tracked in `.pagesdown-state.json` before entering watch mode (run `pagesdown sync` once first if you're starting fresh).

Example workflow:

```bash
# Initial sync to establish baseline
pagesdown sync

# Start watching for changes
pagesdown sync --watch

# Edit a local file in another editor
# pagesdown detects the change within ~500ms and pushes it

# Press Ctrl+C to stop watching and exit
```

This creates a live sync loop ideal for developers and AI agents that need to continuously update scripts, config files, or documentation in Notion while working locally.

### Output Conventions

- Markdown content keeps the original page title inside the file.
- Folder and file names are slugified to lowercase, web-safe names.
- Child pages, databases, and assets still live in predictable local folders.
- In flat mode, internal links are rewritten with explicit anchors so the final document stays readable and navigable.

### Features

- **Guided or headless** — interactive prompts when you want them, one-shot export when you do not.
- **Explicit source handling** — accepts Notion UUIDs, full share URLs, stdin input, and clipboard input on macOS.
- **Token persistence** — validates and saves your token for next time in `~/.pagesdown/config.json`.
- **Config-backed defaults** — remembers a default output directory and lets you set it directly with `--set-default-out`.
- **Flat mode (`--flat`/`-f`)** — inlines sub-pages into a single LLM-friendly document with internal anchors.
- **Inline synced blocks** — referenced content is resolved and rendered inline.
- **Inline child databases** — rendered as Markdown tables, with sparse empty columns pruned and relation titles resolved when possible.
- **Metadata-aware tables** — includes useful Notion property types like created/edited timestamps and author fields.
- **Slugged output names** — uses lowercase, web-safe filenames while keeping the original title in the Markdown body.
- **Rate-limit aware** — uses a throttled Notion client to stay under API limits.
- **Progress updates** — spinner + logs while downloading, with `--debug` for extra diagnostics.
- **Cross-platform export** — works on macOS, Windows, and Linux.

### CLI Reference

```bash
pagesdown [command] [options]
```

**Commands:**
- `sync`: Run batch download from `pagesdown.config.json` manifest

**Options:**
- `-i, --id <id-or-url>`: export a specific page or database by UUID or full Notion share link.
- `-f, --flat`: flatten sub-pages into one document and use anchor-based internal links.
- `-o, --out <path>`: choose the output directory for this run.
- `--set-default-out <path>`: save a default output directory for future runs and exit.
- `-t, --token <token>`: validate and save a Notion integration token.
- `--id-clip`: read the page or database link from the clipboard on macOS.
- `-d, --debug`: enable verbose diagnostic logging.
- `-h, --help`: show the full CLI help.

Examples:

```bash
pagesdown --id "https://www.notion.so/My-Page-abcdef1234567890abcdef1234567890" --flat
pagesdown --id 12345678-1234-1234-1234-1234567890ab --out ~/Desktop/notion-export
echo "https://www.notion.so/Another-Page-abcdef1234567890abcdef1234567890" | pagesdown -i -
pagesdown sync                    # batch download from config file
NOTION_TOKEN=ntn_xxx pagesdown sync   # sync with explicit token
```

### License

MIT
