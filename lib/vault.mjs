import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { AiWikiError } from './errors.mjs';
import { INDEX_SKIP_DIRS, INDEX_SKIP_NAMES } from './schema.mjs';

const FENCE = '\x60\x60\x60';

export function normalizeText(input) {
  let text = String(input === null || input === undefined ? '' : input);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.replace(/\r\n?/g, '\n');
}

export function parseFallbackFrontmatter(raw) {
  const data = {};
  let last = null;
  for (const line of String(raw).split('\n')) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && last) {
      const previous = data[last] === undefined ? '' : String(data[last]);
      const value = item[1].trim().replace(/^["']|["']$/g, '');
      data[last] = previous ? previous + ', ' + value : value;
      continue;
    }
    const pair = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (pair) {
      last = pair[1];
      data[last] = pair[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return data;
}

export function parseFrontmatter(input) {
  const text = normalizeText(input);
  if (!text.startsWith('---')) {
    return { data: {}, body: text, raw: '', error: null, hasFrontmatter: false };
  }
  const close = /\n---[ \t]*(?:\n|$)/g;
  close.lastIndex = 3;
  const match = close.exec(text);
  if (match === null) {
    return { data: {}, body: text, raw: '', error: new Error('unterminated frontmatter'), hasFrontmatter: false };
  }
  const raw = text.slice(3, match.index).replace(/^\n/, '');
  const body = text.slice(match.index + match[0].length);
  let data = {};
  let error = null;
  try {
    const parsed = parseYaml(raw, { maxAliasCount: 10, prettyErrors: false });
    if (parsed !== null && parsed !== undefined) {
      if (typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
      else error = new Error('frontmatter is not a mapping');
    }
  } catch (failure) {
    error = failure;
  }
  if (error !== null || Object.keys(data).length === 0) {
    const fallback = parseFallbackFrontmatter(raw);
    if (Object.keys(fallback).length > 0) data = fallback;
  }
  return { data, body, raw, error, hasFrontmatter: true };
}

export function stringValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

export function normalizeList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => stringValue(item).trim()).filter(Boolean);
  }
  if (value === null || value === undefined) return [];
  let text = stringValue(value).trim();
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  return text.split(',').map((item) => item.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

export function pageMeta(rel, data, stat) {
  const base = path.posix.basename(rel).replace(/\.md$/, '');
  const name = stringValue(data.name).trim() || base;
  return {
    rel,
    name,
    type: stringValue(data.type).trim(),
    status: stringValue(data.status).trim(),
    created: stringValue(data.created).trim(),
    updated: stringValue(data.updated).trim(),
    tags: normalizeList(data.tags).map((tag) => tag.toLowerCase()),
    aliases: normalizeList(data.aliases),
    kw: normalizeList(data.kw),
    sources: normalizeList(data.sources),
    zone: rel.split('/')[0],
    llm: stringValue(data.llm).trim().toLowerCase(),
    raw: stringValue(data.raw).trim(),
    mtimeMs: stat && Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : 0,
    size: stat && Number.isFinite(stat.size) ? stat.size : 0
  };
}

export function walkMarkdown(root, options) {
  const settings = options || {};
  const skipDirs = settings.skipDirs || INDEX_SKIP_DIRS;
  const skipNames = settings.skipNames || INDEX_SKIP_NAMES;
  const maxBytes = settings.maxBytes || 8 * 1024 * 1024;
  const out = [];
  const visit = (absDir, relDir) => {
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const rel = relDir === '' ? entry.name : relDir + '/' + entry.name;
      const abs = path.join(absDir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (skipDirs.some((prefix) => rel === prefix || rel.startsWith(prefix + '/'))) continue;
        visit(abs, rel);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      if (skipNames.includes(entry.name)) continue;
      let stat;
      try {
        stat = statSync(abs);
      } catch {
        continue;
      }
      if (stat.size > maxBytes) continue;
      out.push({ rel, abs, size: stat.size, mtimeMs: stat.mtimeMs, zone: rel.split('/')[0] });
    }
  };
  visit(root, '');
  return out;
}

export function isInsidePath(root, target) {
  const from = path.resolve(root);
  const to = path.resolve(target);
  const rel = path.relative(from, to);
  if (rel === '') return true;
  const normalized = process.platform === 'win32' ? rel.toLowerCase() : rel;
  return !normalized.startsWith('..') && !path.isAbsolute(rel);
}

export function resolveInside(root, candidate) {
  const rootReal = realpathSync(root);
  let abs = path.resolve(candidate);
  try {
    abs = realpathSync(abs);
  } catch {
    // Keep the lexical path for missing targets; the caller reports PAGE_NOT_FOUND.
  }
  if (!isInsidePath(rootReal, abs)) {
    throw new AiWikiError('PATH_OUTSIDE_VAULT', 'Path is outside the configured vault: ' + candidate);
  }
  return abs;
}

function allMarkdown(root) {
  return walkMarkdown(root, {
    skipDirs: ['.git', '.obsidian', '.trash', '.wiki-index'],
    skipNames: []
  });
}

export function resolvePage(root, input) {
  let value = String(input === null || input === undefined ? '' : input).trim();
  if (value.startsWith('[[') && value.endsWith(']]')) value = value.slice(2, -2);
  const pipe = value.indexOf('|');
  if (pipe >= 0) value = value.slice(0, pipe);
  const hash = value.indexOf('#');
  if (hash >= 0) value = value.slice(0, hash);
  value = value.trim().replace(/\\/g, '/');
  if (value === '') throw new AiWikiError('PAGE_NOT_FOUND', 'A page path is required.');

  if (path.isAbsolute(value)) {
    const abs = resolveInside(root, value);
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      throw new AiWikiError('PAGE_NOT_FOUND', 'No page at ' + value);
    }
    return { rel: path.relative(root, abs).split(path.sep).join('/'), abs };
  }

  const candidates = [value, value.endsWith('.md') ? value : value + '.md'];
  for (const candidate of candidates) {
    try {
      const abs = resolveInside(root, path.resolve(root, candidate));
      if (statSync(abs).isFile()) {
        return { rel: path.relative(root, abs).split(path.sep).join('/'), abs };
      }
    } catch {
      // Missing or outside the vault: try the next form.
    }
  }

  if (!value.includes('/')) {
    const base = path.posix.basename(value).replace(/\.md$/, '').toLowerCase();
    const matches = allMarkdown(root).filter((entry) => path.posix.basename(entry.rel).replace(/\.md$/, '').toLowerCase() === base);
    if (matches.length === 1) return { rel: matches[0].rel, abs: matches[0].abs };
    if (matches.length > 1) {
      throw new AiWikiError('AMBIGUOUS_PAGE', 'Several pages match ' + value, matches.map((entry) => entry.rel).join(', '));
    }
  }

  throw new AiWikiError('PAGE_NOT_FOUND', 'No page matches ' + value);
}

const ACL_MARKERS = [
  ['.llm-ro', 'none'],
  ['.llm-append', 'append'],
  ['.llm-rw', 'full']
];

export function aclFor(root, rel) {
  let dir = path.dirname(path.join(root, rel));
  const stop = path.resolve(root);
  for (let depth = 0; depth < 20; depth += 1) {
    for (const marker of ACL_MARKERS) {
      if (existsSync(path.join(dir, marker[0]))) {
        const where = path.relative(root, dir).split(path.sep).join('/');
        return { mode: marker[1], reason: marker[0] + (where ? ' in ' + where : ' in vault root') };
      }
    }
    if (path.resolve(dir) === stop) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { mode: 'none', reason: 'no .llm-* marker; the vault root is read-only' };
}

export function permissionsFor(root, rel, data) {
  const llm = stringValue(data && data.llm).trim().toLowerCase();
  if (llm === 'ro') {
    return { write: 'none', reason: 'frontmatter llm: ro overrides the zone marker' };
  }
  if (rel === 'index.md' || rel === 'log.md') {
    return { write: 'full', reason: 'root index.md/log.md are maintained by the agent per contract' };
  }
  const acl = aclFor(root, rel);
  return { write: acl.mode, reason: acl.reason };
}

export function parseWikiLink(raw) {
  let target = String(raw === null || raw === undefined ? '' : raw).trim();
  let alias = null;
  const pipe = target.indexOf('|');
  if (pipe >= 0) {
    alias = target.slice(pipe + 1).trim();
    target = target.slice(0, pipe).trim();
  }
  let heading = null;
  const hash = target.indexOf('#');
  if (hash >= 0) {
    heading = target.slice(hash + 1).trim();
    target = target.slice(0, hash).trim();
  }
  return { target, alias, heading };
}

export function extractBodyLinks(body) {
  const out = [];
  const seen = new Set();
  let fenced = false;
  for (const line of String(body === null || body === undefined ? '' : body).split('\n')) {
    if (line.trim().startsWith(FENCE)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const regex = /(!?)\[\[([^\]\n]+)\]\]/g;
    let match;
    while ((match = regex.exec(line)) !== null) {
      const parsed = parseWikiLink(match[2]);
      if (parsed.target === '') continue;
      const key = parsed.target + '|' + (parsed.heading || '');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ target: parsed.target, alias: parsed.alias, heading: parsed.heading, embed: match[1] === '!', source: 'body' });
    }
  }
  return out;
}

export function extractFrontmatterLinks(data) {
  const out = [];
  for (const key of ['work_ref', 'person', 'project']) {
    const raw = data && data[key];
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    const value = raw.trim();
    if (value.startsWith('[[') && value.endsWith(']]')) {
      const parsed = parseWikiLink(value.slice(2, -2));
      if (parsed.target !== '') out.push({ target: parsed.target, alias: parsed.alias, heading: parsed.heading, embed: false, source: key });
    } else {
      out.push({ target: value, alias: null, heading: null, embed: false, source: key });
    }
  }
  return out;
}

export function createLinkResolver(pages) {
  const byPath = new Map();
  const byBase = new Map();
  const byName = new Map();
  const add = (map, key, page) => {
    const normalized = String(key).trim().toLowerCase();
    if (normalized === '') return;
    const list = map.get(normalized);
    if (list) list.push(page);
    else map.set(normalized, [page]);
  };
  for (const page of pages) {
    const rel = page.rel;
    const noExt = rel.replace(/\.md$/, '');
    add(byPath, noExt, page);
    add(byBase, path.posix.basename(noExt), page);
    add(byName, page.name || path.posix.basename(noExt), page);
    for (const alias of page.aliases || []) add(byName, alias, page);
  }
  return { byPath, byBase, byName };
}

function pickMatch(matches, fromRel) {
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];
  const zone = fromRel.split('/')[0];
  const sameZone = matches.filter((page) => page.rel.split('/')[0] === zone);
  if (sameZone.length === 1) return sameZone[0];
  return matches;
}

export function resolveLink(link, fromRel, resolver) {
  const target = String(link.target || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (target === '') return { resolvedPath: null, ambiguous: [] };
  const noExt = target.replace(/\.md$/, '');
  const relCandidate = noExt + '.md';
  const direct = resolver.byPath.get(relCandidate.toLowerCase());
  if (direct && direct.length === 1) return { resolvedPath: direct[0].rel, ambiguous: [] };
  if (direct && direct.length > 1) return { resolvedPath: null, ambiguous: direct.map((page) => page.rel) };

  const relative = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), target)).replace(/\.md$/, '') + '.md';
  const local = resolver.byPath.get(relative.toLowerCase());
  if (local && local.length === 1) return { resolvedPath: local[0].rel, ambiguous: [] };
  if (local && local.length > 1) return { resolvedPath: null, ambiguous: local.map((page) => page.rel) };

  const base = path.posix.basename(noExt).toLowerCase();
  const byBase = pickMatch(resolver.byBase.get(base) || [], fromRel);
  if (Array.isArray(byBase)) return { resolvedPath: null, ambiguous: byBase.map((page) => page.rel) };
  if (byBase) return { resolvedPath: byBase.rel, ambiguous: [] };

  const byName = pickMatch(resolver.byName.get(target.toLowerCase()) || [], fromRel);
  if (Array.isArray(byName)) return { resolvedPath: null, ambiguous: byName.map((page) => page.rel) };
  if (byName) return { resolvedPath: byName.rel, ambiguous: [] };

  return { resolvedPath: null, ambiguous: [] };
}
