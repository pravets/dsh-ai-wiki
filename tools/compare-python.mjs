import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WikiIndex } from '../lib/index.mjs';

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const vaultPath = arg('--vault') || process.env.DSH_WIKI_TEST_VAULT || 'C:/git/vault';
const script = path.join(vaultPath, '90-meta', 'scripts', 'wiki_search.py');
const queries = ['индексы postgres', 'контекст агента', 'bsl диагностика', '1c mtp', 'арочный мост'];
const indexDir = mkdtempSync(path.join(os.tmpdir(), 'aiwiki-compare-'));
const vault = { name: 'vault', path: vaultPath, includeRaw: true, exists: true };
const index = new WikiIndex(vault, { vaults: [vault], indexDir, autoIndex: true });

function pythonTop(query) {
  const out = execFileSync('python3', [script, query, '-n', '10'], { cwd: vaultPath, encoding: 'utf8', timeout: 30000 });
  return out.split('\n')
    .map((line) => /^\s*[-\d.]+\s+(\S+\.md)/.exec(line))
    .filter(Boolean)
    .map((match) => match[1]);
}

try {
  await index.ensureFresh({});
  if (!existsSync(script)) throw new Error('wiki_search.py not found: ' + script);
  for (const query of queries) {
    const ours = index.search({ query, corpus: 'wiki', limit: 10 }).rows.map((row) => row.path);
    let theirs = [];
    try {
      theirs = pythonTop(query);
    } catch (error) {
      console.log(query + ': python failed — ' + (error && error.message ? error.message : String(error)));
      continue;
    }
    const overlap = ours.filter((item) => theirs.includes(item)).length;
    console.log(query + ': overlap ' + overlap + '/10');
    if (overlap < 5) {
      console.log('  ours:   ' + ours.join(', '));
      console.log('  python: ' + theirs.join(', '));
    }
  }
} finally {
  index.close();
  rmSync(indexDir, { recursive: true, force: true });
}
