#!/usr/bin/env node

// Node version check — must run before any ESM imports
const [major, minor] = process.version.slice(1).split('.').map(Number);
if (major < 20 || (major === 20 && minor < 12)) {
  console.error(
    `\nNotionDrive requires Node.js 20.12 or later.\n` +
    `You are running ${process.version}.\n\n` +
    `Download the latest version from: https://nodejs.org\n`
  );
  process.exit(1);
}

// Launch the CLI
const _envKey = ['NOTION', 'TOKEN'].join('_');
import('../src/cli.js').then(({ main }) => main(process.env[_envKey] || null)).catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
