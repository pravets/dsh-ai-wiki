import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { walkMarkdown } from '../lib/vault.mjs';

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const vaultPath = arg('--vault') || process.env.DSH_WIKI_TEST_VAULT || 'C:/git/vault';
const entries = walkMarkdown(vaultPath, { skipDirs: ['.git', '.obsidian', '.trash', '.wiki-index'], skipNames: [] });
const rows = entries.map((entry) => {
  const hash = createHash('sha256').update(readFileSync(entry.abs)).digest('hex').slice(0, 16);
  return { path: entry.rel, size: entry.size, hash };
}).sort((left, right) => left.path.localeCompare(right.path));
const combined = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
console.log(JSON.stringify({ vault: vaultPath, pages: rows.length, combined, rows }, null, 2));
