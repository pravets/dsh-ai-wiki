import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { AiWikiError } from './errors.mjs';
import { walkMarkdown, parseFrontmatter, pageMeta, extractBodyLinks, extractFrontmatterLinks, createLinkResolver, resolveLink, resolvePage } from './vault.mjs';
import { tokenize, buildMatchQuery, plainBody, headings, excerpt, getStemmer } from './tokenize.mjs';
import { INDEX_SKIP_DIRS, INDEX_SKIP_NAMES } from './schema.mjs';

let DatabaseSync = null;
let sqliteError = null;
try {
  const mod = await import('node:sqlite');
  DatabaseSync = mod.DatabaseSync;
} catch (error) {
  sqliteError = error;
}

const SCHEMA_VERSION = '1';

function hashPath(value) {
  return createHash('sha256').update(path.resolve(value)).digest('hex').slice(0, 16);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function splitTags(value) {
  const text = String(value === null || value === undefined ? '' : value).trim();
  return text === '' ? [] : text.split(/\s+/).filter(Boolean);
}

function parseAliases(value) {
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '{}';
  }
}

function corpusOf(zone) {
  if (zone === '01-raw') return 'raw';
  if (zone === '05-chats') return 'chats';
  return 'wiki';
}

function isCorruption(error) {
  const message = error && error.message ? String(error.message).toLowerCase() : '';
  return message.includes('not a database') || message.includes('malformed') || message.includes('sqlite_corrupt');
}

function abortIfNeeded(signal) {
  if (signal && signal.aborted) {
    const error = new Error('aborted');
    error.name = 'AbortError';
    throw error;
  }
}

export class WikiIndex {
  constructor(vault, config) {
    this.vault = vault;
    this.config = config;
    this.dir = config.indexDir;
    this.file = path.join(this.dir, hashPath(vault.path) + '.db');
    this.db = null;
    this.building = null;
    this.lastDocs = 0;
    this.lastStale = 0;
    this.lastBuiltAt = '';
    this.lastBuildMs = 0;
    this.lastError = null;
  }

  open() {
    if (this.db !== null) return this.db;
    if (sqliteError !== null || DatabaseSync === null) {
      throw new AiWikiError(
        'INDEX_UNAVAILABLE',
        'node:sqlite with FTS5 is required (Node >= 22.13). ' + (sqliteError && sqliteError.message ? sqliteError.message : ''),
        'Use Node 22.13+ or 24; the plugin does not fall back to a degraded index.'
      );
    }
    mkdirSync(this.dir, { recursive: true });
    const db = new DatabaseSync(this.file);
    this.db = db;
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA synchronous=NORMAL');
    db.exec('PRAGMA busy_timeout=5000');
    this.ensureSchema();
    return db;
  }

  ensureSchema() {
    const db = this.db;
    db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
    const version = db.prepare('SELECT value FROM meta WHERE key = ?').get('schemaVersion');
    if (version !== undefined && version.value !== SCHEMA_VERSION) {
      db.exec('DROP TABLE IF EXISTS search');
      db.exec('DROP TABLE IF EXISTS doc_tags');
      db.exec('DROP TABLE IF EXISTS links');
      db.exec('DROP TABLE IF EXISTS docs');
      db.exec('DROP TABLE IF EXISTS meta');
    }
    db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
    db.exec('CREATE TABLE IF NOT EXISTS docs (' +
      'id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, corpus TEXT NOT NULL, zone TEXT NOT NULL, ' +
      'name TEXT, type TEXT, status TEXT, created TEXT, updated TEXT, tags TEXT, aliases TEXT, ' +
      'mtime REAL, size INTEGER, excerpt TEXT, frontmatter TEXT)');
    db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(' +
      'doc_id UNINDEXED, name, tags, headings, kw, body, ' +
      "tokenize='unicode61 remove_diacritics 2')");
    db.exec('CREATE TABLE IF NOT EXISTS doc_tags (doc_id INTEGER, tag TEXT, PRIMARY KEY (doc_id, tag))');
    db.exec('CREATE TABLE IF NOT EXISTS links (' +
      'from_id INTEGER, target TEXT, resolved_path TEXT, alias TEXT, heading TEXT, source TEXT, candidates TEXT)');
    db.exec('CREATE INDEX IF NOT EXISTS docs_type ON docs(type)');
    db.exec('CREATE INDEX IF NOT EXISTS docs_zone ON docs(zone)');
    db.exec('CREATE INDEX IF NOT EXISTS docs_status ON docs(status)');
    db.exec('CREATE INDEX IF NOT EXISTS doc_tags_tag ON doc_tags(tag)');
    db.exec('CREATE INDEX IF NOT EXISTS links_resolved ON links(resolved_path)');
    db.exec('CREATE INDEX IF NOT EXISTS links_target ON links(target)');
    const current = db.prepare('SELECT value FROM meta WHERE key = ?').get('schemaVersion');
    if (current === undefined) {
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schemaVersion', SCHEMA_VERSION);
    }
  }

  entries() {
    const all = walkMarkdown(this.vault.path, { skipDirs: INDEX_SKIP_DIRS, skipNames: INDEX_SKIP_NAMES });
    if (this.vault.includeRaw === false) return all.filter((entry) => entry.zone !== '01-raw');
    return all;
  }

  async ensureFresh(options) {
    if (this.building !== null) return this.building;
    const settings = options || {};
    const run = this.refresh(settings.full === true, settings.signal)
      .catch(async (error) => {
        if (!isCorruption(error)) throw error;
        this.close();
        for (const suffix of ['', '-wal', '-shm']) {
          try {
            unlinkSync(this.file + suffix);
          } catch {
            // The file may not exist.
          }
        }
        return this.refresh(settings.full === true, settings.signal);
      })
      .finally(() => {
        this.building = null;
      });
    this.building = run;
    return run;
  }

  async refresh(full, signal) {
    const db = this.open();
    getStemmer();
    abortIfNeeded(signal);
    const entries = this.entries();
    const existingRows = db.prepare('SELECT id, path, mtime, size FROM docs').all();
    const existing = new Map();
    for (const row of existingRows) existing.set(row.path, row);
    const current = new Set(entries.map((entry) => entry.rel));
    const changed = [];
    if (full) {
      changed.push(...entries);
    } else {
      for (const entry of entries) {
        const old = existing.get(entry.rel);
        if (old === undefined || Math.abs(Number(old.mtime) - entry.mtimeMs) > 0.5 || Number(old.size) !== entry.size) {
          changed.push(entry);
        }
      }
    }
    const removed = existingRows.filter((row) => !current.has(row.path));
    if (!full && changed.length === 0 && removed.length === 0) {
      const meta = this.readMeta();
      this.lastDocs = meta.docsCount;
      this.lastBuiltAt = meta.builtAt;
      this.lastBuildMs = meta.buildMs;
      this.lastStale = 0;
      return this.stats();
    }

    const parsed = new Map();
    for (const entry of changed) {
      abortIfNeeded(signal);
      const text = readFileSync(entry.abs, 'utf8');
      const fm = parseFrontmatter(text);
      const meta = pageMeta(entry.rel, fm.data, { mtimeMs: entry.mtimeMs, size: entry.size });
      parsed.set(entry.rel, { entry, fm, meta });
    }

    const started = Date.now();
    db.exec('BEGIN IMMEDIATE');
    try {
      if (full) {
        db.exec('DELETE FROM search');
        db.exec('DELETE FROM doc_tags');
        db.exec('DELETE FROM links');
        db.exec('DELETE FROM docs');
      }
      for (const [rel, item] of parsed) {
        abortIfNeeded(signal);
        const old = full ? undefined : existing.get(rel);
        let docId;
        if (old !== undefined) {
          docId = Number(old.id);
          db.prepare('DELETE FROM search WHERE doc_id = ?').run(docId);
          db.prepare('DELETE FROM doc_tags WHERE doc_id = ?').run(docId);
          db.prepare('DELETE FROM links WHERE from_id = ?').run(docId);
          db.prepare('UPDATE docs SET corpus = ?, zone = ?, name = ?, type = ?, status = ?, created = ?, updated = ?, tags = ?, aliases = ?, mtime = ?, size = ?, excerpt = ?, frontmatter = ? WHERE id = ?')
            .run(corpusOf(item.meta.zone), item.meta.zone, item.meta.name, item.meta.type, item.meta.status, item.meta.created, item.meta.updated, item.meta.tags.join(' '), safeJson(item.meta.aliases), item.entry.mtimeMs, item.entry.size, excerpt(item.fm.body), safeJson(item.fm.data), docId);
        } else {
          const result = db.prepare('INSERT INTO docs (path, corpus, zone, name, type, status, created, updated, tags, aliases, mtime, size, excerpt, frontmatter) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(rel, corpusOf(item.meta.zone), item.meta.zone, item.meta.name, item.meta.type, item.meta.status, item.meta.created, item.meta.updated, item.meta.tags.join(' '), safeJson(item.meta.aliases), item.entry.mtimeMs, item.entry.size, excerpt(item.fm.body), safeJson(item.fm.data));
          docId = Number(result.lastInsertRowid);
        }
        const tagText = item.meta.tags.concat(item.meta.aliases).join(' ');
        db.prepare('INSERT INTO search (doc_id, name, tags, headings, kw, body) VALUES (?, ?, ?, ?, ?, ?)')
          .run(docId, tokenize(item.meta.name).join(' '), tokenize(tagText).join(' '), tokenize(headings(item.fm.body)).join(' '), tokenize(item.meta.kw.join(' ')).join(' '), tokenize(plainBody(item.fm.body)).join(' '));
        const tags = Array.from(new Set(item.meta.tags.map((tag) => tag.toLowerCase())));
        for (const tag of tags) {
          db.prepare('INSERT OR IGNORE INTO doc_tags (doc_id, tag) VALUES (?, ?)').run(docId, tag);
        }
        item.docId = docId;
      }
      for (const row of removed) {
        const docId = Number(row.id);
        db.prepare('DELETE FROM search WHERE doc_id = ?').run(docId);
        db.prepare('DELETE FROM doc_tags WHERE doc_id = ?').run(docId);
        db.prepare('DELETE FROM links WHERE from_id = ?').run(docId);
        db.prepare('DELETE FROM docs WHERE id = ?').run(docId);
      }

      const allRows = db.prepare('SELECT id, path, name, aliases FROM docs').all();
      const pages = allRows.map((row) => ({ rel: row.path, name: row.name, aliases: parseAliases(row.aliases) }));
      const resolver = createLinkResolver(pages);
      db.exec('DELETE FROM links');
      for (const row of allRows) {
        abortIfNeeded(signal);
        let text = '';
        try {
          text = readFileSync(path.join(this.vault.path, row.path), 'utf8');
        } catch {
          continue;
        }
        const fm = parseFrontmatter(text);
        const links = extractBodyLinks(fm.body).concat(extractFrontmatterLinks(fm.data));
        for (const link of links) {
          const resolution = resolveLink(link, row.path, resolver);
          db.prepare('INSERT INTO links (from_id, target, resolved_path, alias, heading, source, candidates) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(Number(row.id), link.target, resolution.resolvedPath, link.alias, link.heading, link.source, safeJson(resolution.ambiguous));
        }
      }

      const count = Number(db.prepare('SELECT COUNT(*) AS c FROM docs').get().c);
      const builtAt = new Date().toISOString();
      const buildMs = Date.now() - started;
      const writeMeta = (key, value) => db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, String(value));
      writeMeta('builtAt', builtAt);
      writeMeta('buildMs', buildMs);
      writeMeta('docsCount', count);
      writeMeta('stemmer', 'snowball-russian');
      writeMeta('roots', this.vault.path);
      db.exec('COMMIT');
      this.lastDocs = count;
      this.lastBuiltAt = builtAt;
      this.lastBuildMs = buildMs;
      this.lastStale = 0;
      this.lastError = null;
      return this.stats();
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // The transaction may already be closed.
      }
      this.lastError = error && error.message ? error.message : String(error);
      throw error;
    }
  }

  readMeta() {
    const db = this.open();
    const get = (key) => {
      const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
      return row === undefined ? '' : row.value;
    };
    return {
      builtAt: get('builtAt'),
      buildMs: Number(get('buildMs') || 0),
      docsCount: Number(get('docsCount') || 0),
      stemmer: get('stemmer'),
      roots: get('roots')
    };
  }

  summary() {
    return { builtAt: this.lastBuiltAt || this.readMeta().builtAt, docs: this.lastDocs || this.readMeta().docsCount, stale: this.lastStale };
  }

  filterClauses(options, params) {
    const clauses = [];
    const corpus = options.corpus || 'wiki';
    if (corpus === 'wiki') clauses.push("d.corpus = 'wiki'");
    else if (corpus === 'chats') clauses.push("d.corpus = 'chats'");
    else if (corpus === 'raw') {
      if (this.vault.includeRaw === false) throw new AiWikiError('RAW_DISABLED', 'Raw corpus is disabled for this vault.', 'Set includeRaw=true in the vault config.');
      clauses.push("d.corpus = 'raw'");
    } else if (corpus === 'all') {
      if (this.vault.includeRaw === false) clauses.push("d.corpus != 'raw'");
    } else {
      throw new AiWikiError('INVALID_CORPUS', 'Unknown corpus: ' + corpus);
    }
    if (options.zone) {
      clauses.push('d.zone = ?');
      params.push(String(options.zone));
    }
    if (options.type) {
      clauses.push('lower(d.type) = ?');
      params.push(String(options.type).toLowerCase());
    }
    if (options.status) {
      clauses.push('lower(d.status) = ?');
      params.push(String(options.status).toLowerCase());
    }
    if (options.tag) {
      clauses.push('EXISTS (SELECT 1 FROM doc_tags dt WHERE dt.doc_id = d.id AND dt.tag = ?)');
      params.push(String(options.tag).toLowerCase());
    }
    if (options.updatedSince) {
      clauses.push('d.updated >= ?');
      params.push(String(options.updatedSince));
    }
    return clauses;
  }

  search(options) {
    const db = this.open();
    const terms = tokenize(options.query);
    if (terms.length === 0) {
      throw new AiWikiError('INVALID_QUERY', 'Query has no searchable terms.', 'Try a word with letters or digits.');
    }
    const limit = Number(options.limit) || 8;
    for (const op of ['AND', 'OR']) {
      const match = buildMatchQuery(terms, op);
      const params = [match];
      const clauses = this.filterClauses(options, params);
      clauses.unshift('search MATCH ?');
      const sql = 'SELECT d.path, d.name, d.type, d.zone, d.updated, d.tags, d.excerpt, ' +
        'bm25(search, 0.0, 5.0, 3.0, 2.0, 2.0, 1.0) AS bm ' +
        'FROM search JOIN docs d ON d.id = search.doc_id WHERE ' + clauses.join(' AND ') +
        ' ORDER BY bm LIMIT ?';
      params.push(limit + 1);
      const rows = db.prepare(sql).all(...params);
      if (rows.length > 0) {
        return {
          rows: rows.slice(0, limit).map((row) => ({
            path: row.path,
            name: row.name,
            type: row.type,
            zone: row.zone,
            updated: row.updated,
            tags: splitTags(row.tags),
            score: -Number(row.bm),
            excerpt: row.excerpt
          })),
          truncated: rows.length > limit
        };
      }
    }
    return { rows: [], truncated: false };
  }

  similar(options) {
    const db = this.open();
    const page = resolvePage(this.vault.path, options.path);
    const doc = db.prepare('SELECT d.id, s.body FROM docs d JOIN search s ON s.doc_id = d.id WHERE d.path = ?').get(page.rel);
    let body = '';
    if (doc === undefined) {
      const text = readFileSync(page.abs, 'utf8');
      body = tokenize(plainBody(parseFrontmatter(text).body)).join(' ');
    } else {
      body = String(doc.body || '');
    }
    const words = [];
    const seen = new Set();
    for (const word of body.split(/\s+/)) {
      if (word.length <= 4 || seen.has(word)) continue;
      seen.add(word);
      words.push(word);
      if (words.length >= 40) break;
    }
    if (words.length === 0) return { rows: [], truncated: false };
    const match = words.map((word) => '"' + word + '"').join(' OR ');
    const limit = Number(options.limit) || 6;
    const params = [doc === undefined ? -1 : Number(doc.id), match];
    const clauses = ["d.corpus = 'wiki'", 'd.id != ?'];
    const sql = 'SELECT d.path, d.name, d.type, d.zone, d.updated, d.tags, d.excerpt, ' +
      'bm25(search, 0.0, 5.0, 3.0, 2.0, 2.0, 1.0) AS bm ' +
      'FROM search JOIN docs d ON d.id = search.doc_id WHERE ' + clauses.join(' AND ') +
      ' AND search MATCH ? ORDER BY bm LIMIT ?';
    const rows = db.prepare(sql).all(...params, limit + 1);
    return {
      rows: rows.slice(0, limit).map((row) => ({
        path: row.path,
        name: row.name,
        type: row.type,
        zone: row.zone,
        updated: row.updated,
        tags: splitTags(row.tags),
        score: -Number(row.bm),
        excerpt: row.excerpt
      })),
      truncated: rows.length > limit
    };
  }

  list(options) {
    const db = this.open();
    const params = [];
    const clauses = this.filterClauses(options, params);
    const where = clauses.length > 0 ? ' WHERE ' + clauses.join(' AND ') : '';
    const total = Number(db.prepare('SELECT COUNT(*) AS c FROM docs d' + where).get(...params).c);
    const groupBy = options.groupBy;
    let groups = [];
    if (groupBy) {
      if (groupBy === 'tag') {
        const groupSql = 'SELECT t.tag AS key, COUNT(DISTINCT d.id) AS count FROM docs d JOIN doc_tags t ON t.doc_id = d.id' + where + ' GROUP BY t.tag ORDER BY count DESC, key ASC';
        groups = db.prepare(groupSql).all(...params);
      } else if (['zone', 'type', 'status'].includes(groupBy)) {
        const column = groupBy === 'zone' ? 'd.zone' : groupBy === 'type' ? 'd.type' : 'd.status';
        const groupSql = 'SELECT COALESCE(NULLIF(' + column + ", ''), '(none)') AS key, COUNT(*) AS count FROM docs d" + where + ' GROUP BY key ORDER BY count DESC, key ASC';
        groups = db.prepare(groupSql).all(...params);
      } else {
        throw new AiWikiError('INVALID_GROUP', 'Unknown groupBy: ' + groupBy);
      }
    }
    if (options.countsOnly === true) {
      return { rows: [], total, groups: groups.map((row) => ({ key: row.key, count: Number(row.count) })), truncated: false };
    }
    const limit = Number(options.limit) || 50;
    const offset = Math.max(0, Number(options.offset) || 0);
    const sort = options.sort || 'updated';
    const order = sort === 'name' ? 'd.name COLLATE NOCASE ASC' : sort === 'path' ? 'd.path ASC' : 'd.updated DESC, d.path ASC';
    const rows = db.prepare('SELECT d.path, d.name, d.type, d.zone, d.status, d.tags, d.updated FROM docs d' + where + ' ORDER BY ' + order + ' LIMIT ? OFFSET ?')
      .all(...params, limit, offset);
    return {
      rows: rows.map((row) => ({
        path: row.path,
        name: row.name,
        type: row.type,
        zone: row.zone,
        status: row.status,
        tags: splitTags(row.tags),
        updated: row.updated
      })),
      total,
      groups: groups.map((row) => ({ key: row.key, count: Number(row.count) })),
      truncated: offset + rows.length < total
    };
  }

  linksFor(input) {
    const db = this.open();
    const page = resolvePage(this.vault.path, input);
    const doc = db.prepare('SELECT id FROM docs WHERE path = ?').get(page.rel);
    let out = [];
    if (doc !== undefined) {
      out = db.prepare('SELECT target, resolved_path, alias, heading, source, candidates FROM links WHERE from_id = ? ORDER BY target').all(Number(doc.id)).map((row) => ({
        target: row.target,
        resolvedPath: row.resolved_path,
        alias: row.alias,
        heading: row.heading,
        source: row.source,
        candidates: parseAliases(row.candidates)
      }));
    } else {
      let text = '';
      try {
        text = readFileSync(page.abs, 'utf8');
      } catch {
        text = '';
      }
      const fm = parseFrontmatter(text);
      const pages = this.pages();
      const current = pageMeta(page.rel, fm.data, { mtimeMs: 0, size: text.length });
      pages.push({ rel: page.rel, name: current.name, aliases: current.aliases });
      const resolver = createLinkResolver(pages);
      const links = extractBodyLinks(fm.body).concat(extractFrontmatterLinks(fm.data));
      out = links.map((link) => {
        const resolution = resolveLink(link, page.rel, resolver);
        return {
          target: link.target,
          resolvedPath: resolution.resolvedPath,
          alias: link.alias,
          heading: link.heading,
          source: link.source,
          candidates: resolution.ambiguous
        };
      });
    }
    const backlinks = db.prepare('SELECT d.path, d.name, d.type FROM links l JOIN docs d ON d.id = l.from_id WHERE l.resolved_path = ? ORDER BY d.path').all(page.rel);
    return {
      path: page.rel,
      out,
      backlinks: backlinks.map((row) => ({ path: row.path, name: row.name, type: row.type })),
      unresolved: out.filter((row) => row.resolvedPath === null).map((row) => row.target),
      ambiguous: out.filter((row) => row.resolvedPath === null && row.candidates.length > 0).map((row) => ({ target: row.target, candidates: row.candidates }))
    };
  }

  pages() {
    const db = this.open();
    return db.prepare('SELECT path, name, aliases FROM docs').all().map((row) => ({
      rel: row.path,
      name: row.name,
      aliases: parseAliases(row.aliases)
    }));
  }

  stats() {
    const db = this.open();
    const total = Number(db.prepare('SELECT COUNT(*) AS c FROM docs').get().c);
    const byCorpus = db.prepare('SELECT corpus, COUNT(*) AS count FROM docs GROUP BY corpus ORDER BY corpus').all().map((row) => ({ key: row.corpus, count: Number(row.count) }));
    const byZone = db.prepare('SELECT zone, COUNT(*) AS count FROM docs GROUP BY zone ORDER BY zone').all().map((row) => ({ key: row.zone, count: Number(row.count) }));
    const byType = db.prepare('SELECT COALESCE(NULLIF(type, \'\'), \'(none)\') AS key, COUNT(*) AS count FROM docs GROUP BY key ORDER BY count DESC').all().map((row) => ({ key: row.key, count: Number(row.count) }));
    const meta = this.readMeta();
    let dbBytes = 0;
    try {
      dbBytes = statSync(this.file).size;
    } catch {
      dbBytes = 0;
    }
    const existing = new Map(db.prepare('SELECT path, mtime, size FROM docs').all().map((row) => [row.path, row]));
    let staleDocs = 0;
    for (const entry of this.entries()) {
      const old = existing.get(entry.rel);
      if (old === undefined || Math.abs(Number(old.mtime) - entry.mtimeMs) > 0.5 || Number(old.size) !== entry.size) staleDocs += 1;
    }
    this.lastDocs = total;
    this.lastStale = staleDocs;
    return { total, byCorpus, byZone, byType, builtAt: meta.builtAt, buildMs: meta.buildMs, docsCount: meta.docsCount, stemmer: meta.stemmer, dbBytes, staleDocs, dbFile: this.file };
  }

  close() {
    if (this.db !== null) {
      try {
        this.db.close();
      } catch {
        // Already closed.
      }
      this.db = null;
    }
  }
}

export function indexAvailable() {
  return sqliteError === null && DatabaseSync !== null;
}

export function indexError() {
  return sqliteError;
}
