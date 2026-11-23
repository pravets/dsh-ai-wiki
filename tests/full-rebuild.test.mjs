import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createFixtureVault, configFor } from './helpers.mjs';
import { WikiIndex } from '../lib/index.mjs';

async function openFixture() {
  const fixture = createFixtureVault();
  const config = configFor(fixture);
  const index = new WikiIndex(config.vaults[0], config);
  await index.ensureFresh({});
  return { fixture, index };
}

test('full rebuild keeps the same documents searchable', async () => {
  const { fixture, index } = await openFixture();
  try {
    const before = index.stats().total;
    await index.ensureFresh({ full: true });
    const after = index.stats();
    assert.equal(after.total, before);
    assert.ok(index.search({ query: 'индексы', corpus: 'wiki', limit: 3 }).rows.some((row) => row.path === '10-wiki/concept.md'));
    assert.ok(index.linksFor('10-wiki/concept.md').out.length > 0);
  } finally {
    index.close();
    fixture.cleanup();
  }
});
test('a corrupt cache database is rebuilt', async () => {
  const fixture = createFixtureVault();
  const config = configFor(fixture);
  const index = new WikiIndex(config.vaults[0], config);
  try {
    mkdirSync(path.dirname(index.file), { recursive: true });
    writeFileSync(index.file, 'not a database', 'utf8');
    try {
      const stats = await index.ensureFresh({});
      assert.equal(stats.total, 9);
      assert.ok(index.search({ query: 'индексы', corpus: 'wiki', limit: 3 }).rows.length > 0);
    } finally {
      index.close();
    }
  } finally {
    fixture.cleanup();
  }
});

