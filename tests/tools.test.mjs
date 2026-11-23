import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime, createTools } from '../lib/tools.mjs';
import { createFixtureVault, configFor } from './helpers.mjs';

function makeRuntime(fixture) {
  const ctx = { workingDirectory: { get: () => fixture.root } };
  return createRuntime(ctx, configFor(fixture));
}

function execOf() {
  return { name: 'test', arguments: {}, signal: new AbortController().signal, agent: null };
}

function byName(definitions) {
  const map = {};
  for (const definition of definitions) map[definition.name] = definition;
  return map;
}

test('all six tools execute against a fixture vault', async () => {
  const fixture = createFixtureVault();
  try {
    const runtime = makeRuntime(fixture);
    const tools = byName(createTools(runtime));
    const exec = execOf();
    const search = await tools.aiwiki_search.execute({ query: 'индексы', limit: 3 }, exec);
    assert.equal(search.ok, true);
    assert.equal(search.results[0].path, '10-wiki/concept.md');
    const read = await tools.aiwiki_read.execute({ path: '10-wiki/concept', section: 'Индексы' }, exec);
    assert.equal(read.ok, true);
    assert.ok(read.body.includes('распухание'));
    assert.equal(read.permissions.write, 'full');
    const raw = await tools.aiwiki_read.execute({ path: '01-raw/2026-01-01-source.md' }, exec);
    assert.equal(raw.permissions.write, 'none');
    const list = await tools.aiwiki_list.execute({ type: 'repo' }, exec);
    assert.equal(list.total, 1);
    const links = await tools.aiwiki_links.execute({ path: '10-wiki/concept.md' }, exec);
    assert.ok(links.out.some((link) => link.resolvedPath === '10-wiki/second.md'));
    assert.ok(links.backlinks.some((link) => link.path === '10-wiki/second.md'));
    const status = await tools.aiwiki_status.execute({}, exec);
    assert.equal(status.ok, true);
    assert.equal(status.index.indexed, true);
    const lint = await tools.aiwiki_lint.execute({ limit: 10 }, exec);
    assert.equal(lint.ok, true);
    assert.ok(lint.violations.some((item) => item.path === '10-wiki/unknown-tag.md'));
    runtime.dispose();
  } finally {
    fixture.cleanup();
  }
});

test('search rejects ambiguous query/similarTo and unknown corpus', async () => {
  const fixture = createFixtureVault();
  try {
    const runtime = makeRuntime(fixture);
    const tools = byName(createTools(runtime));
    const exec = execOf();
    const none = await tools.aiwiki_search.execute({}, exec);
    assert.equal(none.ok, false);
    assert.equal(none.error.code, 'INVALID_QUERY');
    const both = await tools.aiwiki_search.execute({ query: 'x', similarTo: '10-wiki/concept' }, exec);
    assert.equal(both.ok, false);
    const corpus = await tools.aiwiki_search.execute({ query: 'x', corpus: 'bogus' }, exec);
    assert.equal(corpus.ok, false);
    runtime.dispose();
  } finally {
    fixture.cleanup();
  }
});

test('guard denies writes inside the vault and allows outside', async () => {
  const fixture = createFixtureVault();
  try {
    const runtime = makeRuntime(fixture);
    const inside = runtime.writeDenial({ name: 'write', arguments: { file_path: fixture.root + '/10-wiki/x.md' }, agent: null });
    assert.equal(typeof inside, 'string');
    assert.ok(inside.includes('read-only') || inside.includes('только для чтения'));
    const outside = runtime.writeDenial({ name: 'write', arguments: { file_path: fixture.root + '-outside/x.md' }, agent: null });
    assert.equal(outside, undefined);
    runtime.dispose();
  } finally {
    fixture.cleanup();
  }
});

test('prompt text names the vault and tools', () => {
  const fixture = createFixtureVault();
  try {
    const runtime = makeRuntime(fixture);
    const text = runtime.promptText(null);
    assert.ok(text.includes('Личная вики'));
    assert.ok(text.includes(fixture.root));
    assert.ok(text.includes('aiwiki_search'));
    runtime.dispose();
  } finally {
    fixture.cleanup();
  }
});
