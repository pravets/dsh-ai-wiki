import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, stemWord, plainBody, excerpt, buildMatchQuery } from '../lib/tokenize.mjs';

test('Russian forms share a stem', () => {
  assert.deepEqual(tokenize('индексы'), tokenize('индекс'));
  assert.deepEqual(tokenize('агенты'), tokenize('агент'));
  assert.equal(stemWord('postgres'), 'postgres');
  assert.equal(stemWord('1c'), '1c');
});

test('tokenizer keeps ё, latin and digits', () => {
  const tokens = tokenize('Ёлка, postgres-16 и 1С');
  assert.ok(tokens.includes('елк'));
  assert.ok(tokens.includes('postgres'));
  assert.ok(tokens.includes('16'));
  assert.ok(tokens.includes('1с'));
});

test('plainBody removes markup and fenced code', () => {
  const text = 'См. [[10-wiki/second|второй]] и [[concept]].\n\x60\x60\x60\ncode block\n\x60\x60\x60\n[link](https://example.com)';
  const plain = plainBody(text);
  assert.ok(plain.includes('второй'));
  assert.ok(plain.includes('concept'));
  assert.ok(plain.includes('link'));
  assert.ok(!plain.includes('code block'));
  assert.ok(!plain.includes('https://'));
});

test('excerpt skips headings and returns text', () => {
  const value = excerpt('# Заголовок\n\n> цитата\n\nПервый абзац с [[ссылкой|меткой]].\n');
  assert.equal(value, 'Первый абзац с меткой.');
});

test('match query quotes terms and appends wildcard', () => {
  assert.equal(buildMatchQuery(['a', 'b'], 'AND'), '"a"* AND "b"*');
  assert.equal(buildMatchQuery(['a'], 'OR'), '"a"*');
});
