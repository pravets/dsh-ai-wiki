import test from 'node:test';
import assert from 'node:assert/strict';
import { parameterSchema } from '../lib/tool-schema.mjs';

test('flat property map becomes an object-rooted JSON Schema', () => {
  const schema = parameterSchema({
    path: { type: 'string', description: 'Page path.', required: true },
    vault: { type: 'string', description: 'Vault name.' }
  });
  assert.deepEqual(schema, {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Page path.' },
      vault: { type: 'string', description: 'Vault name.' }
    },
    required: ['path']
  });
});

test('a property named type stays a property, not a schema keyword', () => {
  const schema = parameterSchema({ type: { type: 'string', description: 'Filter by type.' } });
  assert.equal(schema.type, 'object');
  assert.deepEqual(schema.properties.type, { type: 'string', description: 'Filter by type.' });
});

test('required is omitted when nothing is required and never left inside a property', () => {
  const schema = parameterSchema({ limit: { type: 'number' } });
  assert.equal(Object.hasOwn(schema, 'required'), false);
  assert.equal(JSON.stringify(schema).includes('"required":true'), false);
});

test('enum, const and annotations survive compilation', () => {
  const schema = parameterSchema({
    corpus: { type: 'string', description: 'Corpus.', enum: ['wiki', 'raw'], default: 'wiki' },
    fixed: { type: 'string', const: 'x', title: 'Fixed' }
  });
  assert.deepEqual(schema.properties.corpus, {
    type: 'string',
    description: 'Corpus.',
    default: 'wiki',
    enum: ['wiki', 'raw']
  });
  assert.deepEqual(schema.properties.fixed, { type: 'string', title: 'Fixed', const: 'x' });
});

test('array items and nested objects compile recursively', () => {
  const schema = parameterSchema({
    tags: { type: 'array', items: { type: 'string' } },
    filter: {
      type: 'object',
      additionalProperties: false,
      properties: { zone: { type: 'string', required: true }, depth: { type: 'integer' } }
    }
  });
  assert.deepEqual(schema.properties.tags, { type: 'array', items: { type: 'string' } });
  assert.deepEqual(schema.properties.filter, {
    type: 'object',
    additionalProperties: false,
    properties: { zone: { type: 'string' }, depth: { type: 'integer' } },
    required: ['zone']
  });
});

test('oneOf and json compile without a type keyword of their own', () => {
  const schema = parameterSchema({
    either: { oneOf: [{ type: 'string' }, { type: 'number' }], description: 'One of.' },
    any: { type: 'json', description: 'Any value.' }
  });
  assert.deepEqual(schema.properties.either, {
    oneOf: [{ type: 'string' }, { type: 'number' }],
    description: 'One of.'
  });
  assert.deepEqual(schema.properties.any, { description: 'Any value.' });
});

test('invalid declarations fail at registration with a path', () => {
  const cases = [
    [null, 'parameters: must be an object'],
    [{ a: null }, 'parameters.a: must be a value schema object'],
    [{ a: { type: 'str' } }, 'parameters.a.type: must be string'],
    [{ a: { type: 'string', bogus: 1 } }, 'parameters.a.bogus: is not a supported keyword'],
    [{ a: { type: 'string', required: false } }, 'parameters.a.required: must be true when present'],
    [{ a: { type: 'string', enum: [] } }, 'parameters.a.enum: must be a non-empty array'],
    [{ a: { type: 'string', enum: [{}] } }, 'parameters.a.enum: must contain only scalar values'],
    [{ a: { type: 'object', properties: {} } }, 'parameters.a.additionalProperties: must be explicitly true or false'],
    [{ a: { oneOf: [{ type: 'string' }] } }, 'parameters.a.oneOf: must be an array of at least two'],
    [{ a: { oneOf: [{ type: 'string' }, { type: 'number' }], type: 'string' } }, 'parameters.a: cannot declare both type and oneOf']
  ];
  for (const [spec, expected] of cases) {
    assert.throws(() => parameterSchema(spec), (error) => {
      assert.ok(error instanceof TypeError);
      assert.ok(error.message.startsWith(expected), error.message + ' does not start with ' + expected);
      return true;
    });
  }
});

test('circular and reserved declarations are rejected', () => {
  const circular = { type: 'array' };
  circular.items = circular;
  assert.throws(() => parameterSchema({ loop: circular }), /is circular/u);

  const reserved = JSON.parse('{"__proto__": {"type": "string"}}');
  assert.throws(() => parameterSchema(reserved), /parameters\.__proto__: is a reserved property name/u);
});
