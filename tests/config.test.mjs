import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../lib/config.mjs';

function temp(name) {
  return mkdtempSync(path.join(os.tmpdir(), 'aiwiki-' + name + '-'));
}

function vaultAt(root) {
  mkdirSync(path.join(root, '10-wiki'), { recursive: true });
  writeFileSync(path.join(root, 'AGENTS.md'), '# Vault Contract\n', 'utf8');
  writeFileSync(path.join(root, '10-wiki', '.llm-rw'), '', 'utf8');
}

test('user config, project override and env are layered', () => {
  const home = temp('home');
  const project = temp('project');
  const first = temp('vault-one');
  const second = temp('vault-two');
  vaultAt(first);
  vaultAt(second);
  try {
    writeFileSync(path.join(home, 'dsh-wiki.json'), JSON.stringify({
      vaults: [{ name: 'personal', path: first }],
      indexDir: path.join(home, 'cache')
    }), 'utf8');
    const user = loadConfig({ cwd: project, env: {}, dshHome: home });
    assert.equal(user.vaults.length, 1);
    assert.equal(user.vaults[0].name, 'personal');

    writeFileSync(path.join(project, '.dsh-wiki.json'), JSON.stringify({
      vaults: [{ name: 'team', path: second }],
      replaceVaults: true
    }), 'utf8');
    const withProject = loadConfig({ cwd: project, env: {}, dshHome: home });
    assert.equal(withProject.vaults.length, 1);
    assert.equal(withProject.vaults[0].name, 'team');

    const withEnv = loadConfig({ cwd: project, env: { DSH_WIKI_ROOTS: second }, dshHome: home });
    assert.ok(withEnv.vaults.some((vault) => vault.name === 'team'));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

test('vault is detected from the session directory', () => {
  const home = temp('home-detect');
  const root = temp('vault-detect');
  vaultAt(root);
  try {
    const config = loadConfig({ cwd: root, env: {}, dshHome: home });
    assert.ok(config.vaults.some((vault) => path.resolve(vault.path) === path.resolve(root)));
    assert.ok(config.sources.some((source) => source.startsWith('detected:')));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
