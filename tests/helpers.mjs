import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function write(root, rel, body) {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, body, 'utf8');
}

export function createFixtureVault() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'aiwiki-vault-'));
  const indexDir = mkdtempSync(path.join(os.tmpdir(), 'aiwiki-index-'));

  write(root, 'AGENTS.md', '# Vault Contract\n\nTest vault with zones and ACL markers.\n');
  write(root, '.llm-ro', '');
  write(root, 'index.md', '# Index\n\n- [[10-wiki/concept]]\n');
  write(root, 'log.md', '## [2026-01-01] init | test\n\n## [2026-01-02] update | test\n');

  write(root, '10-wiki/.llm-rw', '');
  write(root, '10-wiki/concept.md', [
    '---',
    'name: Индексы PostgreSQL',
    'type: concept',
    'created: 2026-01-01',
    'updated: 2026-01-02',
    'tags: [database, 1c]',
    'aliases: [postgres-indexes]',
    'kw: [bloat, индекс]',
    'sources: [https://example.com/source]',
    'raw: 2026-01-01-source.md',
    '---',
    '# Индексы',
    '',
    'Тело про индекс и распухание. Ссылки [[second]], [[10-wiki/second|второй]] и [[missing]].',
    'Ещё строка для окна.',
    ''
  ].join('\n'));
  write(root, '10-wiki/second.md', [
    '---',
    'name: Агенты и контекст',
    'type: howto',
    'created: 2026-01-01',
    'updated: 2026-01-03',
    'tags: [agents, ai]',
    'kw: [контекст]',
    'sources:',
    '  - https://example.com/agents',
    '---',
    '# Агенты',
    '',
    'Агенты читают контекст. Обратная ссылка [[concept]].',
    ''
  ].join('\n'));
  write(root, '10-wiki/README.md', '# Zone contract\n\nNot indexed.\n');
  write(root, '10-wiki/unknown-tag.md', [
    '---',
    'name: Unknown tag page',
    'type: concept',
    'created: 2026-01-01',
    'updated: 2026-01-02',
    'tags: [бла]',
    'sources: [https://example.com/x]',
    '---',
    '# Unknown',
    ''
  ].join('\n'));

  write(root, '01-raw/.llm-ro', '');
  write(root, '01-raw/2026-01-01-source.md', '# Raw source\n\nСырой транскрипт про индексы.\n');

  write(root, '20-people/.llm-rw', '');
  write(root, '20-people/Иван Петров.md', [
    '---',
    'name: Иван Петров',
    'type: community',
    'created: 2026-01-01',
    'updated: 2026-01-02',
    'tags: [1c]',
    'status: active',
    'llm: ro',
    '---',
    '# Иван Петров',
    ''
  ].join('\n'));

  write(root, '25-interactions/.llm-append', '');
  write(root, '25-interactions/2026-01-01-call.md', [
    '---',
    'name: Звонок',
    'type: call',
    'created: 2026-01-01',
    'updated: 2026-01-01',
    'tags: [1c]',
    'date: 2026-01-01',
    'person: "[[Иван Петров]]"',
    '---',
    '# Звонок',
    ''
  ].join('\n'));

  write(root, '40-projects/.llm-rw', '');
  write(root, '40-projects/demo.md', [
    '---',
    'name: Demo project',
    'type: project',
    'created: 2026-01-01',
    'updated: 2026-01-02',
    'tags: [project]',
    'project: demo',
    'status: active',
    '---',
    '# Demo',
    ''
  ].join('\n'));

  write(root, '42-repos/.llm-rw', '');
  write(root, '42-repos/owner-repo.md', [
    '---',
    'name: owner/repo',
    'type: repo',
    'created: 2026-01-01',
    'updated: 2026-01-04',
    'tags: [1c, tools]',
    'repo: owner/repo',
    'role: maintainer',
    'status: active',
    'sources: [https://github.com/owner/repo]',
    '---',
    '# Repo',
    ''
  ].join('\n'));

  write(root, '60-travel/poi/.llm-rw', '');
  write(root, '60-travel/poi/most.md', [
    '---',
    'name: Арочный мост',
    'type: other',
    'created: 2026-01-01',
    'updated: 2026-01-02',
    'tags: [travel]',
    'region: Карелия',
    'status: planned',
    'coords: 61.0, 30.0',
    'location: "61.0, 30.0"',
    'sources: [https://example.com/most]',
    '---',
    '# Мост',
    ''
  ].join('\n'));

  write(root, '90-meta/templates/.llm-rw', '');
  write(root, '90-meta/templates/wiki-concept.md', '---\nname: <name>\ntype: concept\n---\n# Template\n');

  return {
    root,
    indexDir,
    cleanup() {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      try {
        rmSync(indexDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch {
        // Windows may keep a WAL handle briefly after a corrupt-database test; the OS temp dir is disposable.
      }
    }
  };
}

export function configFor(fixture, overrides) {
  return Object.assign({
    vaults: [{ name: 'test', path: fixture.root, includeRaw: true, exists: true }],
    indexDir: fixture.indexDir,
    autoIndex: true
  }, overrides || {});
}
