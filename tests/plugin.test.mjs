import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../lib/index.js';
import { createFixtureVault, configFor } from './helpers.mjs';

// The user-level config is $DSH_HOME/dsh-wiki.json. Point it at an empty directory
// around each test, so a developer's own vault cannot change what these assert.
function isolatedHome(body) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'aiwiki-home-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    return body();
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

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

test('plugin registers six tools, prompt and guard', () => isolatedHome(() => {
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
}));

test('without configuration tools are hidden and prompt is empty', () => isolatedHome(() => {
  const { ctx, state } = fakeContext('C:/git/dsh-ai-wiki');
  apply(ctx, {});
  assert.equal(state.registrations.length, 6);
  assert.equal(state.registrations[0].options.when({ agent: null }), false);
  assert.equal(state.sections[0].text({ agent: null }), '');
}));

// Providers validate the request body against the sent schema, so every declaration
// must be canonical JSON Schema. This walker is deliberately independent of the
// compiler under test: it re-reads the registered definitions as a provider would.
const SCHEMA_KEYWORDS = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'oneOf',
  'description', 'title', 'default', 'examples'
]);
const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

function assertCanonicalSchema(node, path, isProperty) {
  assert.ok(node !== null && typeof node === 'object' && !Array.isArray(node), path + ' must be an object');
  for (const key of Object.keys(node)) {
    assert.ok(SCHEMA_KEYWORDS.has(key), path + '.' + key + ' is not a JSON Schema keyword');
  }
  // `required: true` is the plugin's author-only shortcut; it must not reach the wire.
  if (isProperty) assert.equal(Object.hasOwn(node, 'required'), false, path + ' must not carry a per-property required');
  if (Object.hasOwn(node, 'type')) {
    assert.ok(typeof node.type === 'string' && SCHEMA_TYPES.has(node.type), path + '.type must be a type name');
    assert.equal(Object.hasOwn(node, 'oneOf'), false, path + ' cannot combine type and oneOf');
  } else {
    assert.ok(Object.hasOwn(node, 'oneOf') || Object.keys(node).length === 1, path + ' must declare type or oneOf');
  }
  if (Object.hasOwn(node, 'enum')) {
    assert.ok(Array.isArray(node.enum) && node.enum.length > 0, path + '.enum must be a non-empty array');
  }
  if (Object.hasOwn(node, 'properties')) assert.equal(node.type, 'object', path + '.properties requires type object');
  if (Object.hasOwn(node, 'items')) assert.equal(node.type, 'array', path + '.items requires type array');
  if (Object.hasOwn(node, 'items')) assertCanonicalSchema(node.items, path + '.items', false);
  if (Object.hasOwn(node, 'properties')) {
    for (const [name, child] of Object.entries(node.properties)) {
      assertCanonicalSchema(child, path + '.properties.' + name, true);
    }
  }
  if (Object.hasOwn(node, 'required')) {
    assert.ok(Array.isArray(node.required), path + '.required must be an array');
    for (const name of node.required) {
      assert.ok(Object.hasOwn(node.properties ?? {}, name), path + '.required names a missing property: ' + name);
    }
  }
  if (Object.hasOwn(node, 'oneOf')) {
    assert.ok(Array.isArray(node.oneOf) && node.oneOf.length >= 2, path + '.oneOf must hold at least two schemas');
    for (const [index, branch] of node.oneOf.entries()) {
      assertCanonicalSchema(branch, path + '.oneOf[' + index + ']', false);
    }
  }
}

test('every registered tool sends canonical JSON Schema parameters', () => isolatedHome(() => {
  const fixture = createFixtureVault();
  try {
    const { ctx, state } = fakeContext(fixture.root);
    apply(ctx, configFor(fixture));
    for (const { definition } of state.registrations) {
      const parameters = definition.parameters;
      assert.equal(parameters.type, 'object', definition.name + ' must be object-rooted');
      assert.equal(typeof parameters.properties, 'object', definition.name + ' must declare properties');
      assertCanonicalSchema(parameters, definition.name, false);
      assert.equal(JSON.stringify(parameters).includes('"required":true'), false, definition.name + ' leaks a per-property required');
    }
    const byName = Object.fromEntries(state.registrations.map((item) => [item.definition.name, item.definition]));
    for (const name of ['aiwiki_list', 'aiwiki_search']) {
      assert.deepEqual(byName[name].parameters.properties.type, {
        type: 'string',
        description: 'Filter by frontmatter type.'
      });
    }
    assert.deepEqual(byName.aiwiki_read.parameters.required, ['path']);
    assert.deepEqual(byName.aiwiki_links.parameters.required, ['path']);
  } finally {
    fixture.cleanup();
  }
}));

