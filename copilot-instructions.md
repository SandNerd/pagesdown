# Copilot Agent Instructions — pagesdown

Purpose
-------
This repository-level instruction file is the first document an automated assistant (or human reviewer) should read when asked to perform work in this repo. Read this file at the start of every new session and before making any substantive change.

Read order (first things first)
--------------------------------
1. `docs/ARCH.md` — high-level architecture and code map.
2. `docs/SPEC.md` — manifest, ledger, markers, and runtime invariants.
3. `docs/DEVELOPER_QUICKSTART.md` — quick setup, test commands, and feature→file mappings.
4. `README.md` — user-facing usage, flags, and examples.
5. `AGENTS.md` and `CLAUDE.md` — governance, Rigour rules, and approval requirements.
6. `CHANGELOG.md` — recent behavior changes.

Primary source files to inspect (quick scan)
-------------------------------------------
- `bin/cli.js` and `src/cli.js` — entrypoint and arg parsing.
- `src/sync.js` — batch sync engine and watch/push logic.
- `src/download.js` — conversion pipeline, flat mode, assets.
- `src/notion.js` — Notion client and throttling.
- `src/parser.js` — Markdown ↔ Notion upload parsing.
- `src/state.js` — ledger shape and hash utilities.
- `src/config.js`, `src/utils.js` — config and filesystem helpers.
- `schemas/config.schema.json` — authoritative manifest schema.
- `test/` — unit and integration tests for verification.

Rules for making changes
------------------------
1. Read this file and the read-order docs before touching code. They are canonical and explain where to look next.
2. If you propose a behavior or interface change, show evidence (logs, failing test, reproducer) and a short root-cause summary, then ask for approval — the project requires explicit approval for non-trivial changes (see `AGENTS.md`). If the user says "approved" or explicitly says "just do it", proceed.
3. When implementing code changes, always:
   - Add or update focused unit tests in `test/` that exercise the change.
   - Update `docs/ARCH.md` and `docs/DEVELOPER_QUICKSTART.md` to reflect the code change and point to the modified files.
   - Update `docs/SPEC.md` if the public manifest/ledger/format or markers change.
   - Update the `README.md` if CLI flags, usage, or examples change.
   - Update `CHANGELOG.md` with a concise entry (under Unreleased).
4. Run the test suite (or the relevant subset) locally and report the exact commands and outcome. Helpful commands:

```bash
npm install
npm test
npm run test:coverage
npx @rigour-labs/cli check   # if Rigour is available in the environment
```

5. If tests fail for unrelated reasons, stop and ask the user; do not attempt broad unrelated fixes.

Documentation upkeep rule
-------------------------
If you implement anything in the repo that changes public behavior, file formats, CLI flags, or manifest semantics, you MUST update the documentation files added to this repo: `docs/ARCH.md`, `docs/SPEC.md`, `docs/DEVELOPER_QUICKSTART.md`, and `README.md`. Keep the docs synchronized with code so future sessions (and other agents) do not need to scan the codebase to answer basic questions.

Commit & PR guidance
--------------------
- Prefer a single focused commit per small change. Include test changes and documentation updates in the same commit when they are part of the same logical change.
- In the PR description include: short summary, reasoning, tests run (commands + brief output), and files changed that require reviewer attention.

When to ask the user
---------------------
- When a change affects export format, manifest semantics, or could cause data loss (uploads/pushes), ask for explicit approval before proceeding. Cite evidence and the proposed fix.
- When external secrets or environment variables are required to run tests locally, request guidance rather than embedding secrets.

End of instructions.
