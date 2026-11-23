import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const TOKEN = /[а-яёa-z0-9]+/g;
const CYR = /^[а-яё]/;
const FENCED_CODE = new RegExp('\\x60\\x60\\x60[\\s\\S]*?\\x60\\x60\\x60', 'g');
const FENCE = '\x60\x60\x60';

let stemmer = null;
let stemmerError = null;

export function getStemmer() {
  if (stemmer !== null) return stemmer;
  if (stemmerError !== null) throw stemmerError;
  try {
    const mod = require('snowball-stemmers-js');
    stemmer = mod.newStemmer('russian');
    return stemmer;
  } catch (error) {
    stemmerError = new Error('snowball stemmer is unavailable: ' + (error && error.message ? error.message : String(error)));
    throw stemmerError;
  }
}

export function stemmerAvailable() {
  try {
    getStemmer();
    return true;
  } catch {
    return false;
  }
}

export function stemWord(word) {
  const text = String(word);
  if (!CYR.test(text)) return text;
  return getStemmer().stemWord(text);
}

export function tokenize(text) {
  const matches = String(text === null || text === undefined ? '' : text).toLowerCase().match(TOKEN);
  if (matches === null) return [];
  return matches.map((token) => stemWord(token));
}

export function buildMatchQuery(terms, op) {
  return terms.map((term) => '"' + term + '"*').join(' ' + op + ' ');
}

// Port of wiki_search.py plain(): index words instead of Markdown syntax.
export function plainBody(body) {
  let text = String(body === null || body === undefined ? '' : body);
  text = text.replace(FENCED_CODE, ' ');
  text = text.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2');
  text = text.replace(/\[\[([^\]]+)\]\]/g, '$1');
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  text = text.replace(/[|>*_\x60#-]/g, ' ');
  return text;
}

export function headings(body) {
  const lines = String(body === null || body === undefined ? '' : body).split('\n');
  return lines
    .filter((line) => line.startsWith('#'))
    .map((line) => line.replace(/^#+\s*/, ''))
    .join(' ');
}

export function excerpt(body) {
  const lines = String(body === null || body === undefined ? '' : body).split('\n');
  for (const line of lines) {
    let text = line.trim();
    if (text === '') continue;
    if (text.startsWith('---') || text.startsWith(FENCE) || text.startsWith('#') || text.startsWith('|') || text.startsWith('>')) continue;
    text = text.replace(/\[\[([^\]|]+)\|?([^\]]*)\]\]/g, function (_m, target, alias) {
      return alias || target;
    });
    text = text.replace(/[*_\x60]/g, '');
    return text.slice(0, 200);
  }
  return '';
}
