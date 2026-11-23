import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseFrontmatter, normalizeList, permissionsFor, resolvePage,
  parseWikiLink, extractBodyLinks, createLinkResolver, resolveLink
} from '../lib/vault.mjs';
import { createFixtureVault } from './helpers.mjs';

test('frontmatter parses fixture page', () => {
  const fixture = createFixtureVault();
  try {
    const text = readFileSync(fixture.root + '/10-wiki/second.md', 'utf8');
    const fm = parseFrontmatter(text);
    assert.equal(fm.hasFrontmatter, true);
    assert.equal(fm.data.name, 'Агенты и контекст');
    assert.deepEqual(normalizeList(fm.data.sources), ['https://example.com/agents']);
    assert.ok(fm.body.includes('# Агенты'));
  } finally {
    fixture.cleanup();
  }
});

test('ACL resolves markers and llm: ro', () => {
  const fixture = createFixtureVault();
  try {
    const root = fixture.root;
    const wiki = readFileSync(root + '/10-wiki/concept.md', 'utf8');
    assert.equal(permissionsFor(root, '10-wiki/concept.md', parseFrontmatter(wiki).data).write, 'full');
    assert.equal(permissionsFor(root, '01-raw/2026-01-01-source.md', {}).write, 'none');
    assert.equal(permissionsFor(root, '20-people/Иван Петров.md', parseFrontmatter(readFileSync(root + '/20-people/Иван Петров.md', 'utf8')).data).write, 'none');
    assert.equal(permissionsFor(root, 'index.md', {}).write, 'full');
    assert.equal(permissionsFor(root, 'AGENTS.md', {}).write, 'none');
  } finally {
    fixture.cleanup();
  }
});

test('page resolver supports path, slug and wikilink', () => {
  const fixture = createFixtureVault();
  try {
    assert.equal(resolvePage(fixture.root, '10-wiki/concept.md').rel, '10-wiki/concept.md');
    assert.equal(resolvePage(fixture.root, 'concept').rel, '10-wiki/concept.md');
    assert.equal(resolvePage(fixture.root, '[[concept|alias]]').rel, '10-wiki/concept.md');
  } finally {
    fixture.cleanup();
  }
});

test('wikilinks parse alias and heading', () => {
  assert.deepEqual(parseWikiLink('10-wiki/foo|метка'), { target: '10-wiki/foo', alias: 'метка', heading: null });
  assert.deepEqual(parseWikiLink('foo#Раздел'), { target: 'foo', alias: null, heading: 'Раздел' });
});

test('links resolve by path, basename and alias', () => {
  const fixture = createFixtureVault();
  try {
    const text = readFileSync(fixture.root + '/10-wiki/concept.md', 'utf8');
    const links = extractBodyLinks(parseFrontmatter(text).body);
    assert.ok(links.some((link) => link.target === 'second'));
    const pages = [
      { rel: '10-wiki/concept.md', name: 'Индексы', aliases: ['postgres-indexes'] },
      { rel: '10-wiki/second.md', name: 'Агенты', aliases: [] }
    ];
    const resolver = createLinkResolver(pages);
    assert.equal(resolveLink({ target: 'second' }, '10-wiki/concept.md', resolver).resolvedPath, '10-wiki/second.md');
    assert.equal(resolveLink({ target: 'postgres-indexes' }, '10-wiki/second.md', resolver).resolvedPath, '10-wiki/concept.md');
    assert.equal(resolveLink({ target: 'missing' }, '10-wiki/concept.md', resolver).resolvedPath, null);
  } finally {
    fixture.cleanup();
  }
});
