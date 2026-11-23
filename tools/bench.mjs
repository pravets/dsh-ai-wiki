import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WikiIndex } from '../lib/index.mjs';

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const vaultPath = arg('--vault') || process.env.DSH_WIKI_TEST_VAULT || 'C:/git/vault';
const indexDir = arg('--index') || mkdtempSync(path.join(os.tmpdir(), 'aiwiki-bench-'));
const vault = { name: 'bench', path: vaultPath, includeRaw: true, exists: true };
const config = { vaults: [vault], indexDir, autoIndex: true };
const index = new WikiIndex(vault, config);

try {
  const started = Date.now();
  const stats = await index.ensureFresh({});
  const cold = Date.now() - started;
  console.log('pages: ' + stats.total + ' · cold build: ' + cold + 'ms · db: ' + stats.dbBytes + ' bytes');

  const queries = [
    'индексы postgres', 'контекст агента', 'bsl диагностика', '1c mtp',
    'арочный мост', 'карелия', 'ванесса', 'доклад', 'n8n', 'кашбек'
  ];
  const runs = 20;
  const begin = process.hrtime.bigint();
  let hits = 0;
  for (let i = 0; i < runs; i += 1) {
    for (const query of queries) {
      hits += index.search({ query, corpus: 'wiki', limit: 8 }).rows.length;
    }
  }
  const elapsedMs = Number(process.hrtime.bigint() - begin) / 1e6;
  console.log('warm search: ' + (elapsedMs / (runs * queries.length)).toFixed(2) + 'ms/query · ' + hits + ' hits');
  const read = index.linksFor('10-wiki/1c-postgres-indexes');
  console.log('links: out=' + read.out.length + ' backlinks=' + read.backlinks.length);
} finally {
  index.close();
  if (arg('--index') === undefined) rmSync(indexDir, { recursive: true, force: true });
}
