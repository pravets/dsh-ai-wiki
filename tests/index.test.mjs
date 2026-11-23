import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { WikiIndex } from '../lib/index.mjs';
import { createFixtureVault, configFor } from './helpers.mjs';

async function openFixture() {
  const fixture = createFixtureVault();
  const config = configFor(fixture);
  const index = new WikiIndex(config.vaults[0], config);
  await index.ensureFresh({});
  return { fixture, config, index };
}

test('index counts pages and corpora', async () => {
  const { fixture, index } = await openFixture();
  try {
    const stats = index.stats();
    assert.equal(stats.total, 9);
    assert.equal(stats.byCorpus.find((row) => row.key === 'raw').count, 1);
    assert.equal(stats.byCorpus.find((row) => row.key === 'wiki').count, 8);
    assert.equal(stats.docsCount, 9);
  } finally {
    index.close();
    fixture.cleanup();
  }
});

test('Russian morphology and BM25 ranking', async () => {
  const { fixture, index } = await openFixture();
  try {
    const result = index.search({ query: 'индексы', corpus: 'wiki', limit: 5 });
    assert.equal(result.rows[0].path, '10-wiki/concept.md');
    const agents = index.search({ query: 'агенты', corpus: 'wiki', limit: 5 });
    assert.ok(agents.rows.some((row) => row.path === '10-wiki/second.md'));
  } finally {
    index.close();
    fixture.cleanup();
  }
});

test('raw is opt-in and filters work', async () => {
  const { fixture, index } = await openFixture();
  try {
    const wiki = index.search({ query: 'транскрипт', corpus: 'wiki', limit: 5 });
    assert.equal(wiki.rows.length, 0);
    const raw = index.search({ query: 'транскрипт', corpus: 'raw', limit: 5 });
    assert.equal(raw.rows[0].path, '01-raw/2026-01-01-source.md');
    const filtered = index.search({ query: 'индексы', corpus: 'wiki', type: 'concept', tag: 'database', limit: 5 });
    assert.equal(filtered.rows[0].path, '10-wiki/concept.md');
    const none = index.search({ query: 'индексы', corpus: 'wiki', type: 'repo', limit: 5 });
    assert.equal(none.rows.length, 0);
  } finally {
    index.close();
    fixture.cleanup();
  }
});

test('list, groups and links', async () => {
  const { fixture, index } = await openFixture();
  try {
    const repos = index.list({ corpus: 'wiki', type: 'repo', limit: 10 });
    assert.equal(repos.total, 1);
    assert.equal(repos.rows[0].path, '42-repos/owner-repo.md');
    const groups = index.list({ corpus: 'wiki', groupBy: 'type', countsOnly: true });
    assert.ok(groups.groups.some((group) => group.key === 'concept' && group.count === 2));
    const links = index.linksFor('10-wiki/concept.md');
    assert.ok(links.out.some((link) => link.target === 'second' && link.resolvedPath === '10-wiki/second.md'));
    assert.ok(links.out.some((link) => link.target === 'missing' && link.resolvedPath === null));
    assert.ok(links.backlinks.some((link) => link.path === '10-wiki/second.md'));
    const similar = index.similar({ path: '10-wiki/concept.md', limit: 5 });
    assert.ok(similar.rows.some((row) => row.path === '10-wiki/second.md'));
    const serviceLinks = index.linksFor('index.md');
    assert.ok(serviceLinks.out.some((link) => link.target === '10-wiki/concept' && link.resolvedPath === '10-wiki/concept.md'));
  } finally {
    index.close();
    fixture.cleanup();
  }
});

test('incremental rebuild adds, updates and removes pages', async () => {
  const { fixture, index } = await openFixture();
  try {
    const newFile = path.join(fixture.root, '10-wiki', 'new.md');
    writeFileSync(newFile, '---\nname: Новая страница\ntype: concept\ncreated: 2026-01-01\nupdated: 2026-01-02\ntags: [ai]\nsources: [https://example.com/new]\n---\n# Новая\n\nУникальныйтермин здесь.\n', 'utf8');
    await index.ensureFresh({});
    assert.equal(index.stats().total, 10);
    assert.ok(index.search({ query: 'уникальныйтермин', corpus: 'wiki', limit: 3 }).rows.some((row) => row.path === '10-wiki/new.md'));

    writeFileSync(path.join(fixture.root, '10-wiki', 'concept.md'), '---\nname: Индексы PostgreSQL\ntype: concept\ncreated: 2026-01-01\nupdated: 2026-01-03\ntags: [database, 1c]\nsources: [https://example.com/source]\n---\n# Индексы\n\nОбновлённый текст про распухание.\n', 'utf8');
    await index.ensureFresh({});
    assert.equal(index.stats().total, 10);

    rmSync(newFile);
    await index.ensureFresh({});
    assert.equal(index.stats().total, 9);
  } finally {
    index.close();
    fixture.cleanup();
  }
});

test('links are re-resolved when targets appear and disappear', async () => {
  const { fixture, index } = await openFixture();
  try {
    const conceptual = index.linksFor('10-wiki/concept.md');
    assert.ok(conceptual.unresolved.includes('missing'));

    const target = path.join(fixture.root, '10-wiki', 'missing.md');
    writeFileSync(target, '---\nname: Missing target\ntype: concept\ncreated: 2026-01-01\nupdated: 2026-01-02\ntags: [ai]\nsources: [https://example.com/m]\n---\n# Missing\n\nОбратно на [[concept]].\n', 'utf8');
    await index.ensureFresh({});
    const resolved = index.linksFor('10-wiki/concept.md');
    assert.ok(resolved.out.some((link) => link.target === 'missing' && link.resolvedPath === '10-wiki/missing.md'));
    assert.ok(resolved.backlinks.some((link) => link.path === '10-wiki/missing.md'));

    rmSync(target);
    await index.ensureFresh({});
    const unresolved = index.linksFor('10-wiki/concept.md');
    assert.ok(unresolved.unresolved.includes('missing'));
    assert.ok(!unresolved.backlinks.some((link) => link.path === '10-wiki/missing.md'));
  } finally {
    index.close();
    fixture.cleanup();
  }
});
