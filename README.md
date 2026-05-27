## pagesdown

Download your Notion content to local Markdown files. Beautiful guided CLI, clean output, ready for AI coding agents.

### Why?

I got sick of Notion's MCP server burning through tokens on every read, querying back and forth for what should be a simple task. The search tool can't even list database pages without a query. Connection drops kill your flow mid-task.

I'm local-first on almost everything now — the cloud just happens after my work, for syncing results. So I decided to pull my thousands of Notion pages down to local Markdown and enjoy my sweet time with my agents. Zero MCP overhead, zero token waste, works offline.

**Works with** Claude Code, Codex, and any agent that reads your local filesystem.

### How It Works

```bash
npx pagesdown      # one‑shot, no install
pagesdown          # after global install
```

Under the hood:

- **You choose** which Notion pages / databases to export.
- pagesdown walks the block tree, resolves synced content, converts everything to Markdown, and mirrors structure on disk.
- Your local agent just reads `.md` files — no live Notion calls, no token burn.

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

### Features

- **Guided setup** — walks you through creating a Notion integration.
- **Interactive selection** — choose exactly which pages/databases to download.
- **Inline synced blocks** — referenced content resolved and rendered inline.
- **Inline child databases** — converted directly to Markdown tables.
- **Flat mode (`--flat`/`-f`)** — inline sub‑pages into a single, LLM‑friendly document.
- **Cross‑platform** — macOS, Windows, Linux.
- **Token persistence** — saves your token for next time in `~/.pagesdown/config.json`.
- **Rate‑limit aware** — uses a throttled Notion client to stay under API limits.
- **Progress updates** — spinner + logs while downloading.

### License

MIT
