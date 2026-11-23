import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRuntime, createTools } from '../lib/tools.mjs';
import { createFixtureVault } from './helpers.mjs';

test('user-level config works from another project directory', async () => {
  const fixture = createFixtureVault();
  const home = mkdtempSync(path.join(os.tmpdir(), 'aiwiki-home-'));
  const project = mkdtempSync(path.join(os.tmpdir(), 'aiwiki-project-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    writeFileSync(path.join(home, 'dsh-wiki.json'), JSON.stringify({
      vaults: [{ name: 'personal', path: fixture.root }],
      indexDir: fixture.indexDir
    }), 'utf8');
    const ctx = { workingDirectory: { get: () => project } };
    const runtime = createRuntime(ctx, {});
    const tools = {};
    for (const definition of createTools(runtime)) tools[definition.name] = definition;
    const exec = { name: 'test', arguments: {}, signal: new AbortController().signal, agent: null };
    const result = await tools.aiwiki_search.execute({ query: 'индексы', limit: 3 }, exec);
    assert.equal(result.ok, true);
    assert.equal(result.results[0].path, '10-wiki/concept.md');
    assert.equal(runtime.hasVaults(null), true);
    runtime.dispose();
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    fixture.cleanup();
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});
