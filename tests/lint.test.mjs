import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { lintVault } from '../lib/lint.mjs';
import { createFixtureVault } from './helpers.mjs';

function vaultOf(fixture) {
  return { name: 'test', path: fixture.root, includeRaw: true, exists: true };
}

test('lint reports unknown tags and baseline suppresses them', () => {
  const fixture = createFixtureVault();
  try {
    const before = lintVault(vaultOf(fixture), { limit: 100 });
    const unknown = before.violations.find((item) => item.path === '10-wiki/unknown-tag.md');
    assert.ok(unknown);
    assert.ok(unknown.codes.includes('tag-outside:бла'));

    mkdirSync(path.join(fixture.root, '90-meta'), { recursive: true });
    writeFileSync(path.join(fixture.root, '90-meta', 'lint-baseline.json'), JSON.stringify({
      version: 1,
      count: 1,
      violations: { '10-wiki/unknown-tag.md': ['tag-outside:бла'] }
    }), 'utf8');
    const after = lintVault(vaultOf(fixture), { limit: 100 });
    assert.equal(after.known, 1);
    assert.ok(!after.newSinceBaseline.some((item) => item.path === '10-wiki/unknown-tag.md'));
  } finally {
    fixture.cleanup();
  }
});

test('lint checks type enum, raw file and log order', () => {
  const fixture = createFixtureVault();
  try {
    const bad = path.join(fixture.root, '10-wiki', 'bad-type.md');
    writeFileSync(bad, '---\nname: Bad\ntype: bogus\ncreated: 2026-01-01\nupdated: 2026-01-02\ntags: [ai]\nsources: [https://example.com]\nraw: missing.md\n---\n# Bad\n', 'utf8');
    appendFileSync(path.join(fixture.root, 'log.md'), '\n## [2025-01-01] old | out of order\n', 'utf8');
    const result = lintVault(vaultOf(fixture), { limit: 100 });
    const badItem = result.violations.find((item) => item.path === '10-wiki/bad-type.md');
    assert.ok(badItem);
    assert.ok(badItem.codes.includes('type-not-in-enum'));
    assert.ok(badItem.codes.includes('raw-missing-file'));
    assert.ok(result.log.some((line) => line.startsWith('log-order:')));
  } finally {
    fixture.cleanup();
  }
});
