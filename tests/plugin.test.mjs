import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';
import { createFixtureVault, configFor } from './helpers.mjs';

function fakeContext(cwd) {
  const state = { registrations: [], sections: [], guards: [], effects: [] };
  const ctx = {
    tools: {
      register(definition, options) {
        state.registrations.push({ definition, options });
      },
      guard(guard) {
        state.guards.push(guard);
      }
    },
    inject(names, callback) {
      if (names.includes('systemPrompt')) {
        callback({
          systemPrompt: {
            getSectionOrder: () => 3100,
            section: (section) => state.sections.push(section)
          }
        });
      }
    },
    effect(effect) {
      state.effects.push(effect);
    },
    workingDirectory: { get: () => cwd }
  };
  return { ctx, state };
}

test('plugin registers six tools, prompt and guard', () => {
  const fixture = createFixtureVault();
  try {
    const { ctx, state } = fakeContext(fixture.root);
    apply(ctx, configFor(fixture));
    assert.equal(state.registrations.length, 6);
    const names = state.registrations.map((item) => item.definition.name).sort();
    assert.deepEqual(names, ['aiwiki_links', 'aiwiki_lint', 'aiwiki_list', 'aiwiki_read', 'aiwiki_search', 'aiwiki_status']);
    assert.equal(state.registrations[0].options.when({ agent: null }), true);
    assert.equal(state.sections.length, 1);
    assert.ok(state.sections[0].text({ agent: null }).includes('Личная вики'));
    const denial = state.guards[0]({ name: 'edit', arguments: { file_path: fixture.root + '/10-wiki/x.md' } });
    assert.equal(typeof denial, 'string');
    assert.equal(state.guards[0]({ name: 'edit', arguments: { file_path: 'C:/elsewhere/x.md' } }), undefined);
    assert.equal(typeof state.effects[0], 'function');
  } finally {
    fixture.cleanup();
  }
});

test('without configuration tools are hidden and prompt is empty', () => {
  const { ctx, state } = fakeContext('C:/git/dsh-ai-wiki');
  apply(ctx, {});
  assert.equal(state.registrations.length, 6);
  assert.equal(state.registrations[0].options.when({ agent: null }), false);
  assert.equal(state.sections[0].text({ agent: null }), '');
});
