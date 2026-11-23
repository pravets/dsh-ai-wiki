#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WikiIndex } from '../lib/index.mjs';
import { lintVault } from '../lib/lint.mjs';
import { resolvePage, parseFrontmatter, permissionsFor } from '../lib/vault.mjs';

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  return process.argv[index + 1];
}

const vaultPath = option('--vault', process.env.DSH_WIKI_VAULT || process.env.DSH_WIKI_TEST_VAULT || 'C:/git/vault');
const indexDir = option('--index', path.join(os.homedir(), '.dsh', 'cache', 'dsh-ai-wiki'));
const rawArgs = process.argv.slice(2);
const args = [];
for (let index = 0; index < rawArgs.length; index += 1) {
  const item = rawArgs[index];
  if (item === '--vault' || item === '--index' || item === '--limit' || item === '--corpus') {
    index += 1;
    continue;
  }
  if (item === '--rebuild') continue;
  args.push(item);
}
const command = args[0] || 'help';
const vault = { name: path.basename(vaultPath), path: vaultPath, includeRaw: true, exists: true };
const config = { vaults: [vault], indexDir, autoIndex: true };

async function main() {
  if (command === 'help') {
    console.log('aiwiki search <query> [--vault PATH] [--index DIR] [--corpus wiki|chats|raw|all] [--limit N]');
    console.log('aiwiki read <page> [--vault PATH]');
    console.log('aiwiki status [--vault PATH] [--index DIR] [--rebuild]');
    console.log('aiwiki lint [--vault PATH] [--limit N]');
    return 0;
  }
  if (command === 'search') {
    const query = args.slice(1).join(' ').trim();
    if (query === '') throw new Error('search: query is required');
    const index = new WikiIndex(vault, config);
    try {
      await index.ensureFresh({ full: process.argv.includes('--rebuild') });
      const limit = Number(option('--limit', '8')) || 8;
      const result = index.search({ query, corpus: option('--corpus', 'wiki'), limit });
      for (const row of result.rows) console.log(row.score.toFixed(2) + '  ' + row.path + ' — ' + row.name + (row.excerpt ? '\n      ' + row.excerpt : ''));
      if (result.rows.length === 0) console.log('no matches');
      return 0;
    } finally {
      index.close();
    }
  }
  if (command === 'read') {
    const target = args.slice(1).join(' ').trim();
    if (target === '') throw new Error('read: page is required');
    const page = resolvePage(vaultPath, target);
    const text = readFileSync(page.abs, 'utf8');
    const fm = parseFrontmatter(text);
    const meta = fm.data;
    const permissions = permissionsFor(vaultPath, page.rel, meta);
    console.log(page.rel + ' — ' + (meta.name || page.rel));
    console.log('permissions: ' + permissions.write + ' (' + permissions.reason + ')');
    console.log('');
    console.log(fm.body.slice(0, 8000));
    return 0;
  }
  if (command === 'status') {
    const index = new WikiIndex(vault, config);
    try {
      if (process.argv.includes('--rebuild')) await index.ensureFresh({ full: true });
      const stats = index.stats();
      console.log(JSON.stringify(stats, null, 2));
      return 0;
    } finally {
      index.close();
    }
  }
  if (command === 'lint') {
    const result = lintVault(vault, { limit: Number(option('--limit', '50')) || 50 });
    console.log('pages: ' + result.totalPages + ' · blocking: ' + result.blocking + ' · new: ' + result.newSinceBaseline.length);
    for (const item of result.violations) console.log(item.path + ': ' + item.codes.join(', '));
    return 0;
  }
  throw new Error('unknown command: ' + command);
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error('aiwiki: ' + (error && error.message ? error.message : String(error)));
  process.exit(1);
});
