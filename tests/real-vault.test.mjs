import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WikiIndex } from '../lib/index.mjs';
import { lintVault } from '../lib/lint.mjs';
import { resolvePage, parseFrontmatter, permissionsFor } from '../lib/vault.mjs';

const vaultPath = process.env.DSH_WIKI_TEST_VAULT;

test('real vault: index, search, read and lint', { skip: vaultPath === undefined || vaultPath === '' }, async () => {
  const indexDir = mkdtempSync(path.join(os.tmpdir(), 'aiwiki-real-'));
  const vault = { name: 'vault', path: vaultPath, includeRaw: true, exists: true };
  const config = { vaults: [vault], indexDir, autoIndex: true };
  const index = new WikiIndex(vault, config);
  try {
    const started = Date.now();
    const stats = await index.ensureFresh({});
    const elapsed = Date.now() - started;
    assert.ok(stats.total >= 500, 'expected at least 500 indexed pages, got ' + stats.total);
    assert.ok(elapsed < 15000, 'cold build took ' + elapsed + 'ms');

    const checks = [
      ['индексы postgres', '10-wiki/1c-postgres-indexes.md'],
      ['контекст агента', '10-wiki/ai-context-engineering.md'],
      ['bsl диагностика', '42-repos/1c-syntax-bsl-language-server.md'],
      ['1c mtp', '10-wiki/1c-mtp.md'],
      ['арочный мост', '60-travel/poi/arocnyy-most-yanisjoki.md']
    ];
    for (const [query, expected] of checks) {
      const result = index.search({ query, corpus: 'wiki', limit: 5 });
      assert.ok(result.rows.some((row) => row.path === expected), query + ' did not return ' + expected + ': ' + result.rows.map((row) => row.path).join(', '));
    }

    const raw = index.search({ query: 'kubernetes', corpus: 'raw', limit: 3 });
    assert.ok(raw.rows.length > 0, 'raw corpus should return transcripts');

    const page = resolvePage(vaultPath, '10-wiki/1c-postgres-indexes');
    const fm = parseFrontmatter(readFileSync(page.abs, 'utf8'));
    assert.equal(permissionsFor(vaultPath, page.rel, fm.data).write, 'full');
    const links = index.linksFor('10-wiki/1c-postgres-indexes');
    assert.ok(links.backlinks.length > 0);

    const lint = lintVault(vault, { limit: 10 });
    assert.equal(lint.newSinceBaseline.length, 0, 'new lint violations: ' + JSON.stringify(lint.newSinceBaseline));
    assert.ok(lint.known >= 1);
  } finally {
    index.close();
    rmSync(indexDir, { recursive: true, force: true });
  }
});
