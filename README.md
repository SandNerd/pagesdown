## Notion Drive

Download your Notion content to local Markdown files. It now supports both a guided interactive flow and a fully headless CLI, with LLM-friendly flat exports, slugged filenames, and config-backed defaults.

### Why?

I got sick of Notion's MCP server burning through tokens on every read, querying back and forth for what should be a simple task. The search tool can't even list database pages without a query. Connection drops kill your flow mid-task.

**Works with** Claude Code, Codex, and any agent that reads your local filesystem.

### How It Works

```bash
npx notiondrive      # one-shot, no install
notiondrive          # after global install
```

Under the hood:

- **You choose** which Notion pages / databases to export.
- Notion Drive walks the block tree, resolves synced content, converts everything to Markdown, and mirrors structure on disk.
- Your local agent just reads `.md` files — no live Notion calls, no token burn.

### Developer documentation

- **Architecture & module map:** [docs/ARCH.md](docs/ARCH.md)
- **Spec (manifest, ledger, markers):** [docs/SPEC.md](docs/SPEC.md)
- **Developer quickstart & code map:** [docs/DEVELOPER_QUICKSTART.md](docs/DEVELOPER_QUICKSTART.md)

**Before (MCP):** Agent → Notion API call → wait → parse response → tokens burned on every read
**After (Notion Drive):** Agent → reads local `.md` file → done

### Prerequisites

- **Node.js 20.12 or later** — download from [`https://nodejs.org`](https://nodejs.org) (click the big green button, run the installer).
- A Notion workspace where you can create an internal integration.

### Install & Run as a CLI

You can either use `npx` for a one‑off run or install globally as a normal CLI.

- **One‑off (no install):**

  ```bash
  npx notiondrive
  ```

- **Global install (recommended if you use it often):**

  ```bash
  npm install -g notiondrive

  # then anywhere:
  notiondrive
  ```

The package exposes a `notiondrive` binary via `bin/cli.js`, so once installed globally it behaves like any other Node‑based CLI.

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
- Add your integration

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

### Flat mode: single‑file, LLM‑friendly context

By default, Notion Drive creates folders and separate markdown files for sub‑pages.

If you want a **single, unified context file** for local LLMs (similar to repomix‑style dumps), use `--format flattened`:

```bash
notiondrive --format flattened
# or
npx notiondrive --format flattened
```

When `--format flattened` is used:

- **No sub‑page folders/files** are created for `child_page` blocks.
- Instead, each sub‑page is **fully downloaded and rendered inline** into the parent document.
- The inlined sub‑page is wrapped with explicit markers so LLMs can see context shifts clearly (and so nested code blocks can’t accidentally break the parent document):

```text
<!-- notiondrive:subpage:start -->
### Sub-Page Content: Your Sub-Page Title

<Rendered Markdown content of the sub-page...>
<!-- notiondrive:subpage:end -->
```

This preserves structure but keeps everything in a single file that’s easy to feed to an LLM.

### Headless Mode

Notion Drive can run without prompts when you already know the target page or database:

```bash
notiondrive --source "https://www.notion.so/My-Page-abcdef1234567890abcdef1234567890" --out ~/Desktop/notion-export
```

Useful variants:

```bash
notiondrive --source <uuid-or-url> --out <folder>
notiondrive -s - --out <folder>              # read the URL from stdin
notiondrive --source-clip --out <folder>     # macOS clipboard input
notiondrive --token <secret> --source <uuid> # validate and save token before exporting
notiondrive --set-default-out <folder>       # save a global default output directory and exit
notiondrive --debug --source <uuid>          # verbose logs for troubleshooting
```

When you run headless, the save path is resolved in this order:

1. `--out`
2. saved default output directory from `~/.notiondrive/config.json`
3. the current working directory

If you choose a custom folder interactively, notiondrive can also offer to save it as the new default for future headless exports.

### Batch Sync Mode

For automated, declarative batch downloads, use `notiondrive sync` with a `notiondrive.config.json` manifest:

```bash
notiondrive sync
```

This reads sync targets from `notiondrive.config.json` in the current directory first, then falls back to `~/.notiondrive/config.json` if no local targets are defined. Each target can specify a `path` which is either an output directory or a full file path.

Filtering targets: `notiondrive sync [filter]` accepts a positional filter or `--group` to limit which targets are processed. Matching is flexible:

- Directory containment: if the filter resolves to a directory, Notion Drive matches any target whose `path` resolves to that directory or is nested inside it (subdirectories). Tilde expansion (`~`) and `realpath` normalization are applied before comparison to ensure consistent behavior across symlinks and trailing slashes.
- Path prefix matching: if the filter resolves to a path that is not an existing directory, Notion Drive will match targets whose resolved path equals the filter or starts with the filter (path prefix).
- Filename & name prefix matching: Notion Drive matches targets where the `filename` equals the filter or starts with the filter; target `name` matches are case-insensitive and support prefix matches.
- Notion source matching: the filter matches a target's `source` value (Notion URL or ID) exactly; the implementation extracts Notion IDs from URLs for robust comparisons.
- Group matching: use `--group <name>` or pass the group name as the positional filter to match targets in a group.

If `notiondrive.config.json` also includes a `token` or `defaultOutputDir`, those values take precedence over `~/.notiondrive/config.json` when the file is present in the current directory.

#### Config File Format

Create a `notiondrive.config.json` in your project root:

```json
{
  "token": "ntn_xxx_local_override",
  "defaultOutputDir": "./exports",
  "targets": [
    {
      "source": "https://www.notion.so/My-Page-abcdef1234567890abcdef1234567890",
      "path": "./docs/my-page/main",
      "format": "markdown-tree"
    },
    {
      "source": "abcdef1234567890abcdef1234567890ab",
      "path": "./exports/database",
      "format": "flattened"
    }
  ]
}
```

Each target supports:

- **`source`** (required): Notion page/database UUID or full share URL.
- **`path`** (required): local output directory or file path. If the basename of `path` contains a file extension, `path` is treated as an explicit file path; otherwise it is treated as an output directory and Notion Drive will generate a filename automatically from the Notion title or slug.
- **`format`** (optional): one of `"markdown-tree"` (default), `"flattened"`, or `"csv"`. Controls how the downloader emits files for this target.
  - **`sync`** (optional): one of `"pull-only"` (default), `"push-only"`, or `"two-way"`. Controls sync behavior and whether local edits are pushed back to Notion. To force a push that may overwrite Notion structural content, run `notiondrive sync` with the `--force` (`-f`) flag.
- **`conflict`** (optional, `"local-wins"` | `"notion-wins"`): conflict policy used when both the local file and the remote page changed. Default is `"notion-wins"`, which preserves the Notion version by downloading it. Set `"local-wins"` to overwrite the cloud copy from the local file.
- **`disabled`** (optional, boolean): set to `true` to temporarily disable a target. Disabled targets are ignored by `notiondrive sync` and by watch mode; they will not be fetched, downloaded, or pushed. Use this to temporarily exclude a target without removing it from your manifest.
- **`frontmatter`** (optional, boolean|string): controls YAML frontmatter behavior for this target. When set to `true`, Notion Drive will include generated YAML frontmatter at the top of downloaded Markdown files. When omitted or set to `false`, YAML frontmatter will be omitted from downloaded files (CLI/headless default). When set to a string (e.g. `"metadata"`), Notion Drive will strip YAML from the uploaded body and instead inject the raw YAML text into the named Notion page property during pushes/uploads.

Or, use grouped configuration to reduce repetition and apply shared defaults across multiple targets. A manifest may include either a top-level `targets` array or a `groups` array where each group defines shared defaults and a nested `targets` list. Targets inside a group inherit group-level fields (`format`, `sync`, `conflict`, `frontmatter`) and receive the group's `name` as their `group` property. Individual target fields override group defaults.

Grouped example:

```json
{
  "token": "ntn_xxx_local_override",
  "defaultOutputDir": "./exports",
  "groups": [
    {
      "name": "docs",
      "format": "markdown-tree",
      "sync": "pull-only",
      "targets": [
        { "source": "https://www.notion.so/page-A", "path": "./docs/page-a" },
        { "source": "https://www.notion.so/page-B", "path": "./docs/page-b", "format": "flattened" }
      ]
    }
  ]
}
```

Implementation note: when a manifest with `groups` is loaded, Notion Drive flattens the groups into a unified `targets` array for processing. Each flattened target will contain a `group` property with the group's name and inherited defaults applied. This normalization is transparent to CLI commands and scripts.

#### Format Options

Notion Drive supports three per-target output formats: `markdown-tree` (default), `flattened`, and `csv`. Set the `format` field on each target to choose how pages and databases are emitted on disk.

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
  "path": "./docs/my-page",
  "format": "markdown-tree"
}
```

- `flattened`
  - What it does: inlines child pages into the parent document and writes a single `.md` file at the `path` level (or at the generated filename under `path` if `path` is a directory). Inlined sub-pages are wrapped with explicit markers so LLMs and tools can detect boundaries.
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
<!-- notiondrive:subpage:start -->
### Sub-Page Title

<content of sub-page...>
<!-- notiondrive:subpage:end -->
```

- Config example:

```json
{
  "source": "...",
  "path": "./docs/my-page.md",
  "format": "flattened"
}
```

- `csv`
  - What it does: when a target points at a Notion database, notiondrive writes a single RFC4180-compliant CSV file with one row per database row. Column order follows the database properties (Title first when present). The CSV is written to the configured `path` (if `path` is a file) or into the `path` directory as `<slugified-database-name>.csv` when `path` is a directory.
  - When to use: exporting Notion databases for spreadsheets or downstream data processing.
  - Notes:
    - Multi-select values are joined with `,`.
    - Relation columns attempt to resolve and include related page titles when possible.
    - Fields are quoted according to RFC4180 rules when needed.
  - Config example:

```json
{
  "source": "<database-id-or-url>",
  "path": "./exports/db/my-database.csv",
  "format": "csv"
}
```

Tips:

- If `path` points to a file whose basename contains a code extension (for example `script.js` or `deploy.sh`), notiondrive treats the target as a code artifact and extracts Notion `code` blocks into a plain file (no Markdown).
- Use `--format` to select the output form: `--format flattened` for single-file flattening, and `--format csv` for database exports.

#### Two-Way Sync

When `sync` is set to `"two-way"`, notiondrive will:

1. Check the local file hash against the notiondrive ledger (project-local `.notiondrive-state.json` or global `~/.notiondrive/state.json`).
2. If the local file has changed but the Notion page hasn't (same `last_edited_time`), push the local edits to Notion.
3. Clear the page content and replace it with the Markdown-generated blocks.
4. Update the ledger with the new file hash and remote mtime.

Script & code-file syncs

If you configure a target with a `filename` that includes a code extension (for example `script.js`, `deploy.sh`, or `schema.sql`), notiondrive treats that target as a code artifact rather than a Markdown document when downloading.

- On download, notiondrive will extract raw `code` blocks from the Notion page and concatenate them into a plain code file (no Markdown fences or headers). This produces a clean, ready-to-run source file for local development or LLM agents.
-- On upload (two-way, push-only), notiondrive performs a safety check and will abort any push if the local file contains flattened Markdown tables or sub-page markers — these indicate that pushing could destroy live Notion database structure. To force a push despite detected table/subpage signatures, run the command with `--force` (or `-f`). In non-forced runs the CLI will warn with a `[SAFETY BYPASS]` message and skip the push for that target.

This creates a safe developer workflow: keep scripts as code files in Notion using `code` blocks, and use notiondrive to synchronize them without accidental structural damage to your Notion databases.

This enables safe round-trip editing: make changes to the local Markdown file, and they'll be synced back to Notion when you run `notiondrive sync`.

When `sync` is set to `"push-only"`, notiondrive will:

1. Skip remote timestamp checks for that target.
2. Compare the local file hash to the ledger's `last_synced_local_hash`.
3. Push local changes with a clear-and-append overwrite when the hash changes.
4. Log `[Up to date] filename (skipped)` when nothing changed locally.

When `conflict` is set, notiondrive will:

1. Treat `local-wins` as an overwrite to Notion when both sides changed.
2. Treat `notion-wins` as the safe default that keeps the cloud version and downloads it instead.

Top-level `notiondrive.config.json` fields can also include:

- **`token`** (optional): local Notion token override for this directory.
- **`defaultOutputDir`** (optional): default export path for headless exports in this directory.

#### JSON Schema

A machine-readable JSON Schema is included to help editors validate and autocomplete `notiondrive` config files.

- **Schema file:** [schemas/config.schema.json](schemas/config.schema.json)
- **Enable editor validation:** Add a top-level `$schema` entry to your `~/.notiondrive/config.json` pointing to the raw schema URL:

```json
{
  "$schema": "https://raw.githubusercontent.com/neethanwu/notiondrive/main/schemas/config.schema.json"
}
```

- **Validate locally:** A small validator script is provided at `scripts/validate-config.js` (it uses `ajv`):

```bash
# install the validator dependency
npm install --save-dev ajv

# validate the user config (default: ~/.notiondrive/config.json)
node scripts/validate-config.js

# or validate a specific file
node scripts/validate-config.js ./notiondrive.config.json
```

#### Usage

```bash
# Run sync with saved token from ~/.notiondrive/config.json
notiondrive sync

# Or with explicit token
NOTION_TOKEN=ntn_xxx notiondrive sync

# With debug logging
notiondrive sync --debug

# Cache behavior: by default `notiondrive sync` records a ledger (project-local `.notiondrive-state.json` or global `~/.notiondrive/state.json`)
# mapping Notion IDs to generated output files and file hashes, so future syncs can
# skip unchanged targets. To force full downloads and bypass the ledger, use:

notiondrive sync --no-cache
```

The sync command:

1. Loads the manifest from `notiondrive.config.json`.
2. Uses your saved Notion token (from `~/.notiondrive/config.json` or `NOTION_TOKEN` env var).
3. Processes each target in sequence.
4. Reports success/failure for each target and exits with status 1 if any target failed.

Filtering targets

You can limit which targets are processed by passing a positional filter after the `sync` command or by using the `--group`/`-g` flag.

- Positional filter: `notiondrive sync sys-design` — runs only targets whose `name` or `group` matches `sys-design`.
- Group flag: `notiondrive sync --group docs` or `notiondrive sync -g docs` — runs only targets with `group: "docs"`.
- Directory path: `notiondrive sync ./docs` — when you pass a local directory path, notiondrive will match all targets whose configured `outDir` resolves to that absolute directory (tilde-expansion and realpath normalization are applied). This also accepts absolute paths, e.g. `notiondrive sync /home/me/projects/site/docs`.

Note: To use name-based filtering, ensure your targets include a `name` field in `notiondrive.config.json`. If some targets lack `name`, notiondrive will warn with a tip asking you to add descriptive names to the manifest.

#### Watch Mode

Enable real-time file monitoring and automatic push-to-Notion with the `--watch` or `-w` flag:

```bash
notiondrive sync --watch
# or shorthand
notiondrive sync -w
```

When watch mode is active:

1. **Baseline sync runs first** to ensure local and remote are aligned.
2. **File watchers** are set up on all tracked directories for your sync targets.
3. **On local file change**, notiondrive detects the modification, calculates the new SHA-256 hash, and compares it to the ledger.
4. **If the hash differs**, notiondrive immediately:
   - Validates the file doesn't contain flattened Markdown tables or sub-page markers (safety check).
   - Pushes the changed file to Notion by clearing the page content and appending new blocks.
   - Updates the ledger with the new hash and remote mtime.
   - Logs a timestamped confirmation: `[Watcher] HH:MM:SS - Pushed upstream successfully.`
5. **Ctrl+C** closes all file watchers cleanly, flushes the ledger to disk, and exits.

Watch mode works with both `push-only` and `two-way` sync modes. Use the `--force` (`-f`) flag to bypass the structural safety preflight when pushing. It requires that your targets have been downloaded and tracked in the notiondrive ledger (project-local `.notiondrive-state.json` or global `~/.notiondrive/state.json`) before entering watch mode (run `notiondrive sync` once first if you're starting fresh).

Example workflow:

```bash
# Initial sync to establish baseline
notiondrive sync

# Start watching for changes
notiondrive sync --watch

# Edit a local file in another editor
# notiondrive detects the change within ~500ms and pushes it

# Press Ctrl+C to stop watching and exit
```

This creates a live sync loop ideal for developers and AI agents that need to continuously update scripts, config files, or documentation in Notion while working locally.

### Output Conventions

- Markdown content keeps the original page title inside the file.
- Folder and file names are slugified to lowercase, web-safe names.
- Child pages, databases, and assets still live in predictable local folders.
-- In `flattened` mode, internal links are rewritten with explicit anchors so the final document stays readable and navigable.

### Features

- **Guided or headless** — interactive prompts when you want them, one-shot export when you do not.
- **Explicit source handling** — accepts Notion UUIDs, full share URLs, stdin input, and clipboard input on macOS.
- **Token persistence** — validates and saves your token for next time in `~/.notiondrive/config.json`.
- **Config-backed defaults** — remembers a default output directory and lets you set it directly with `--set-default-out`.
-- **Flat mode (`--format flattened`)** — inlines sub-pages into a single LLM-friendly document with internal anchors.
- **Inline synced blocks** — referenced content is resolved and rendered inline.
- **Inline child databases** — rendered as Markdown tables, with sparse empty columns pruned and relation titles resolved when possible.
- **Metadata-aware tables** — includes useful Notion property types like created/edited timestamps and author fields.
- **Slugged output names** — uses lowercase, web-safe filenames while keeping the original title in the Markdown body.
- **Rate-limit aware** — uses a throttled Notion client to stay under API limits.
- **Progress updates** — spinner + logs while downloading, with `--debug` for extra diagnostics.
- **Cross-platform export** — works on macOS, Windows, and Linux.

### CLI Reference

```bash
notiondrive [command] [options]
```

**Commands:**

- `sync`: Run batch download from `notiondrive.config.json` manifest

**Options:**

- `-s, --source <id-or-url>`: export a specific page or database by UUID or full Notion share link.
- `--format <format>`: select output format; use `--format flattened` to flatten sub-pages into one document.
- `-o, --out <path>`: choose the output directory for this run.
- `--set-default-out <path>`: save a default output directory for future runs and exit.
- `-t, --token <token>`: validate and save a Notion integration token.
- `--source-clip`: read the page or database link from the clipboard on macOS.
- `-d, --debug`: enable verbose diagnostic logging.
- `-h, --help`: show the full CLI help.

Examples:

```bash
notiondrive --source "https://www.notion.so/My-Page-abcdef1234567890abcdef1234567890" --format flattened
notiondrive --source 12345678-1234-1234-1234-1234567890ab --out ~/Desktop/notion-export
echo "https://www.notion.so/Another-Page-abcdef1234567890abcdef1234567890" | notiondrive -s -
notiondrive sync                    # batch download from config file
NOTION_TOKEN=ntn_xxx notiondrive sync   # sync with explicit token
```

### License

MIT
