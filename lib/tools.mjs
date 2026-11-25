import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AiWikiError, fail, ok, clamp } from './errors.mjs';
import { loadConfig } from './config.mjs';
import { WikiIndex } from './index.mjs';
import {
  resolvePage, parseFrontmatter, pageMeta, permissionsFor, extractBodyLinks,
  extractFrontmatterLinks, createLinkResolver, resolveLink, stringValue,
  walkMarkdown, aclFor, isInsidePath, resolveInside
} from './vault.mjs';
import { lintVault } from './lint.mjs';
import { parameterSchema } from './tool-schema.mjs';
import { INDEX_SKIP_DIRS, INDEX_SKIP_NAMES } from './schema.mjs';

const WRITE_TOOLS = new Set(['write', 'edit', 'str_replace_editor', 'apply_patch']);
const PATH_KEYS = ['file_path', 'path', 'target', 'file'];

function agentOf(value) {
  return value && value.agent ? value.agent : value;
}

function renderError(toolName, value) {
  const hint = value.error && value.error.hint ? '\n' + value.error.hint : '';
  return [toolName + ': ' + value.error.code + ' — ' + value.error.message + hint];
}

function renderSearch(value) {
  if (!value.ok) return renderError('aiwiki_search', value);
  const lines = [];
  lines.push('vault: ' + value.vault + ' · docs: ' + value.index.docs + ' · built: ' + (value.index.builtAt || 'never'));
  if (value.index.stale) lines.push('warning: index is stale; results may be incomplete');
  if (value.results.length === 0) {
    lines.push('No matches. Try corpus=raw or corpus=all, or fewer filters.');
    return lines;
  }
  for (const row of value.results) {
    const score = Number(row.score || 0);
    lines.push(score.toFixed(2) + '  ' + row.path + ' — ' + row.name + (row.type ? ' [' + row.type + ']' : ''));
    if (row.excerpt) lines.push('      ' + row.excerpt);
  }
  if (value.truncated) lines.push('(truncated; raise limit or narrow the query)');
  return lines;
}

function renderRead(value) {
  if (!value.ok) return renderError('aiwiki_read', value);
  const lines = [];
  lines.push(value.path + ' — ' + value.name);
  lines.push('zone: ' + value.zone + ' · type: ' + (value.type || '(none)') + ' · updated: ' + (value.updated || '(none)'));
  lines.push('permissions: ' + value.permissions.write + ' (' + value.permissions.reason + ')');
  if (value.tags.length > 0) lines.push('tags: ' + value.tags.join(', '));
  lines.push('');
  if (value.section) lines.push('## ' + value.section);
  lines.push(value.body);
  if (value.truncated) lines.push('\n[truncated; next offset: ' + (value.nextOffset === null ? 'n/a' : value.nextOffset) + ']');
  if (value.rawPath) lines.push('\nraw: ' + value.rawPath);
  if (value.links.out.length > 0) {
    lines.push('\nOutgoing links:');
    for (const link of value.links.out) {
      lines.push('  ' + link.target + ' -> ' + (link.resolvedPath || (link.candidates.length > 0 ? 'ambiguous: ' + link.candidates.join(', ') : 'unresolved')));
    }
  }
  if (value.links.backlinks.length > 0) {
    lines.push('\nBacklinks:');
    for (const link of value.links.backlinks) lines.push('  ' + link.path + ' — ' + link.name);
  }
  if (value.indexWarning) lines.push('\nindex warning: ' + value.indexWarning);
  return lines;
}

function renderList(value) {
  if (!value.ok) return renderError('aiwiki_list', value);
  const lines = [];
  lines.push('vault: ' + value.vault + ' · total: ' + value.total);
  if (value.groups.length > 0) {
    lines.push('Groups:');
    for (const group of value.groups) lines.push('  ' + group.key + ': ' + group.count);
  }
  if (value.rows.length > 0) {
    lines.push('Pages:');
    for (const row of value.rows) {
      lines.push('  ' + row.path + ' — ' + row.name + (row.type ? ' [' + row.type + ']' : '') + (row.status ? ' status=' + row.status : ''));
    }
  }
  if (value.truncated) lines.push('(truncated; use offset/limit)');
  return lines;
}

function renderLinks(value) {
  if (!value.ok) return renderError('aiwiki_links', value);
  const lines = [value.path];
  if (value.out.length > 0) {
    lines.push('Outgoing:');
    for (const link of value.out) {
      const target = link.resolvedPath || (link.candidates.length > 0 ? 'ambiguous: ' + link.candidates.join(', ') : 'unresolved');
      lines.push('  ' + link.target + ' -> ' + target + ' (' + link.source + ')');
    }
  }
  if (value.backlinks.length > 0) {
    lines.push('Backlinks:');
    for (const link of value.backlinks) lines.push('  ' + link.path + ' — ' + link.name);
  }
  if (value.unresolved.length > 0) lines.push('Unresolved: ' + value.unresolved.join(', '));
  return lines;
}

function renderStatus(value) {
  if (!value.ok) return renderError('aiwiki_status', value);
  const lines = [];
  lines.push('vaults: ' + value.vaults.map((vault) => vault.name + '=' + vault.path + (vault.exists ? '' : ' (missing)')).join(', '));
  lines.push('config: ' + (value.sources.length > 0 ? value.sources.join(', ') : '(defaults)'));
  lines.push('zones:');
  for (const zone of value.zones) lines.push('  ' + zone.name + ' (' + zone.acl + '): ' + zone.docs);
  if (value.index.indexed) {
    lines.push('index: ' + value.index.total + ' docs, built ' + (value.index.builtAt || 'never') + ', ' + value.index.dbBytes + ' bytes');
    lines.push('corpora: ' + value.index.byCorpus.map((row) => row.key + '=' + row.count).join(', '));
  } else {
    lines.push('index: not built (call aiwiki_status with rebuild=true)');
  }
  if (value.generated.length > 0) {
    lines.push('generated:');
    for (const file of value.generated) lines.push('  ' + file.path + ': ' + file.state + (file.reason ? ' (' + file.reason + ')' : ''));
  }
  if (value.recentLog.length > 0) {
    lines.push('recent log:');
    for (const entry of value.recentLog) lines.push('  ' + entry);
  }
  if (value.warnings.length > 0) {
    lines.push('warnings:');
    for (const warning of value.warnings) lines.push('  ' + warning);
  }
  return lines;
}

function renderLint(value) {
  if (!value.ok) return renderError('aiwiki_lint', value);
  const lines = [];
  lines.push('pages: ' + value.totalPages + ' · blocking: ' + value.blocking + ' · warnings: ' + value.warnings);
  lines.push('baseline: ' + (value.baselinePath || '(none)') + ' · known: ' + value.known + ' · new: ' + value.newSinceBaseline.length);
  if (Object.keys(value.perZone).length > 0) {
    lines.push('per zone:');
    for (const zone of Object.keys(value.perZone).sort()) lines.push('  ' + zone + ': ' + value.perZone[zone]);
  }
  if (value.newSinceBaseline.length > 0) {
    lines.push('new violations:');
    for (const item of value.newSinceBaseline.slice(0, 20)) lines.push('  ' + item.path + ': ' + item.codes.join(', '));
  }
  if (value.log.length > 0) lines.push('log: ' + value.log.join('; '));
  if (value.violations.length > 0) {
    lines.push('violations:');
    for (const item of value.violations.slice(0, 20)) lines.push('  ' + item.path + ': ' + item.codes.join(', '));
  }
  if (value.truncated) lines.push('(violations truncated)');
  return lines;
}

function render(toolName, value) {
  switch (toolName) {
    case 'aiwiki_search': return renderSearch(value);
    case 'aiwiki_read': return renderRead(value);
    case 'aiwiki_list': return renderList(value);
    case 'aiwiki_links': return renderLinks(value);
    case 'aiwiki_status': return renderStatus(value);
    case 'aiwiki_lint': return renderLint(value);
    default: return [JSON.stringify(value)];
  }
}

function definition(name, description, parameters, execute) {
  return {
    name,
    description,
    parameters: parameterSchema(parameters),
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: render(name, value).join('\n') }]
    },
    execute
  };
}

async function runTool(exec, body) {
  try {
    return await body();
  } catch (error) {
    if (error && error.name === 'AbortError') throw error;
    if (error instanceof AiWikiError) return fail(error.code, error.message, error.hint);
    return fail('INTERNAL', error && error.message ? error.message : String(error));
  }
}

function sectionAt(body, needle) {
  const lines = String(body).split('\n');
  const headings = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(#{1,6})\s+(.*)$/.exec(lines[index]);
    if (match) headings.push({ line: index, level: match[1].length, title: match[2].trim() });
  }
  const wanted = String(needle).toLowerCase();
  const target = headings.find((heading) => heading.title.toLowerCase().includes(wanted));
  if (target === undefined) {
    return { error: new AiWikiError('SECTION_NOT_FOUND', 'Section not found: ' + needle, headings.slice(0, 12).map((heading) => heading.title).join(' | ')) };
  }
  let end = lines.length;
  for (const heading of headings) {
    if (heading.line > target.line && heading.level <= target.level) {
      end = heading.line;
      break;
    }
  }
  return { title: target.title, text: lines.slice(target.line, end).join('\n') };
}

function selectBody(body, args) {
  let text = String(body);
  let section = null;
  if (args.section) {
    const found = sectionAt(text, args.section);
    if (found.error) throw found.error;
    text = found.text;
    section = found.title;
  }
  const allLines = text.split('\n');
  const totalLines = allLines.length;
  const offset = Math.max(1, Number(args.offset) || 1);
  const limit = args.limit === undefined ? null : Math.max(1, Number(args.limit) || 1);
  const start = offset - 1;
  const end = limit === null ? allLines.length : start + limit;
  let selected = allLines.slice(start, end).join('\n');
  let truncated = limit !== null && end < allLines.length;
  let nextOffset = truncated ? offset + (end - start) : null;
  const maxChars = clamp(args.maxChars, 20000, 1000, 200000);
  if (selected.length > maxChars) {
    let cut = selected.lastIndexOf('\n', maxChars);
    if (cut < Math.floor(maxChars * 0.5)) cut = maxChars;
    const kept = selected.slice(0, cut);
    const keptLines = kept.split('\n').length;
    selected = kept;
    truncated = true;
    nextOffset = offset + keptLines;
  }
  return { text: selected, section, truncated, nextOffset, totalLines };
}

function pagesFromDisk(root) {
  const entries = walkMarkdown(root, { skipDirs: ['.git', '.obsidian', '.trash', '.wiki-index'], skipNames: [] });
  return entries.map((entry) => {
    let data = {};
    try {
      data = parseFrontmatter(readFileSync(entry.abs, 'utf8')).data;
    } catch {
      data = {};
    }
    const meta = pageMeta(entry.rel, data, { mtimeMs: entry.mtimeMs, size: entry.size });
    return { rel: entry.rel, name: meta.name, aliases: meta.aliases };
  });
}

function newestMtime(entries) {
  let newest = 0;
  for (const entry of entries) if (entry.mtimeMs > newest) newest = entry.mtimeMs;
  return newest;
}

function recentLog(root) {
  const file = path.join(root, 'log.md');
  if (!existsSync(file)) return [];
  try {
    const text = readFileSync(file, 'utf8');
    const matches = text.match(/^## \[\d{4}-\d{2}-\d{2}\][^\n]*/gm) || [];
    return matches.slice(-5).map((line) => line.replace(/^## /, ''));
  } catch {
    return [];
  }
}

export function createRuntime(ctx, baseConfig) {
  const indexes = new Map();
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');

  function cwdFor(value) {
    const agent = agentOf(value);
    try {
      const session = agent && agent.session;
      if (session && ctx && ctx.workingDirectory && typeof ctx.workingDirectory.get === 'function') {
        const dir = ctx.workingDirectory.get(session);
        if (typeof dir === 'string' && dir !== '') return dir;
      }
    } catch {
      // Fall back to the process directory.
    }
    return process.cwd();
  }

  function configFor(value) {
    return loadConfig({ cwd: cwdFor(value), env: process.env, dshHome, base: baseConfig });
  }

  function vaultFor(config, name) {
    if (config.vaults.length === 0) {
      throw new AiWikiError(
        'VAULT_NOT_CONFIGURED',
        'No ai-wiki vault is configured.',
        'Create ' + path.join(dshHome, 'dsh-wiki.json') + ' with {"vaults":[{"name":"vault","path":"C:\\\\git\\\\vault"}]}, or set DSH_WIKI_ROOTS.'
      );
    }
    let vault = null;
    if (name) {
      const wanted = String(name).toLowerCase();
      vault = config.vaults.find((entry) => entry.name.toLowerCase() === wanted) || null;
      if (vault === null) {
        throw new AiWikiError('VAULT_NOT_FOUND', 'Unknown vault: ' + name, 'Available: ' + config.vaults.map((entry) => entry.name).join(', '));
      }
    } else {
      vault = config.vaults[0];
    }
    if (!vault.exists) {
      throw new AiWikiError('VAULT_NOT_FOUND', 'Vault path does not exist: ' + vault.path, 'Fix the path in ' + path.join(dshHome, 'dsh-wiki.json') + '.');
    }
    if (config.allowAnyMarkdown !== true && !existsSync(path.join(vault.path, 'AGENTS.md')) && !existsSync(path.join(vault.path, '.llm-ro')) && !existsSync(path.join(vault.path, '.llm-rw')) && !existsSync(path.join(vault.path, '10-wiki'))) {
      throw new AiWikiError('VAULT_NOT_A_WIKI', 'The directory does not look like an ai-wiki vault: ' + vault.path, 'Set allowAnyMarkdown=true only for a deliberate Markdown-only vault.');
    }
    return vault;
  }

  function indexFor(vault, config) {
    const key = vault.path + '|' + config.indexDir;
    let index = indexes.get(key);
    if (index === undefined) {
      index = new WikiIndex(vault, config);
      indexes.set(key, index);
    }
    return index;
  }

  async function ensureIndex(vault, config, signal) {
    const index = indexFor(vault, config);
    if (config.autoIndex === false && !existsSync(index.file)) {
      throw new AiWikiError('INDEX_STALE', 'The index is not built and autoIndex is disabled.', 'Call aiwiki_status with rebuild=true.');
    }
    try {
      await index.ensureFresh({ signal });
      return index;
    } catch (error) {
      if (error && error.name === 'AbortError') throw error;
      if (error instanceof AiWikiError) throw error;
      throw new AiWikiError('INDEX_BUILD_FAILED', 'Could not build the index: ' + (error && error.message ? error.message : String(error)));
    }
  }

  function hasVaults(agent) {
    try {
      return configFor({ agent }).vaults.length > 0;
    } catch {
      return false;
    }
  }

  function promptText(agent) {
    const config = configFor({ agent });
    if (config.vaults.length === 0 || config.promptSection === false) return '';
    const lines = ['## Личная вики (aiwiki)', ''];
    lines.push('Настроена вики: ' + config.vaults.map((vault) => vault.name + ' (' + vault.path + ')').join(', ') + '. Это read-only база знаний.');
    lines.push('- Вопрос по содержимому — сначала aiwiki_search (BM25), не grep.');
    lines.push('- Читать страницу — aiwiki_read; ссылки и бэклинки — aiwiki_links; каталог/агрегаты — aiwiki_list.');
    lines.push('- Перед созданием страницы — aiwiki_search и aiwiki_links; свежесть индекса — aiwiki_status.');
    lines.push('- Вики только для чтения: write/edit по её путям запрещены.');
    return lines.join('\n');
  }

  function writeDenial(exec) {
    if (baseConfig && baseConfig.guardWrites === false) return undefined;
    const config = configFor(exec);
    if (config.guardWrites === false) return undefined;
    if (!WRITE_TOOLS.has(exec.name)) return undefined;
    const args = exec.arguments || {};
    let target = '';
    for (const key of PATH_KEYS) {
      if (typeof args[key] === 'string' && args[key] !== '') {
        target = args[key];
        break;
      }
    }
    if (target === '') return undefined;
    const cwd = cwdFor(exec);
    const absolute = path.isAbsolute(target) ? path.resolve(target) : path.resolve(cwd, target);
    for (const vault of config.vaults) {
      if (!vault.exists) continue;
      if (isInsidePath(vault.path, absolute)) {
        return 'Вики доступна только для чтения: ' + absolute + '. Правки вики — отдельная задача; попросите пользователя, если это нужно.';
      }
    }
    return undefined;
  }

  function dispose() {
    for (const index of indexes.values()) index.close();
    indexes.clear();
  }

  return { ctx, baseConfig, cwdFor, configFor, vaultFor, indexFor, ensureIndex, hasVaults, promptText, writeDenial, dispose };
}

export function createTools(runtime) {
  const vaultParam = { type: 'string', description: 'Vault name from config; defaults to the first configured vault.' };

  return [
    definition(
      'aiwiki_search',
      'Search the configured ai-wiki vault with BM25 (SQLite FTS5, Russian Snowball stemming). Use this before grep for any question about vault content. Pass exactly one of query or similarTo. corpus=wiki searches knowledge pages; raw is opt-in.',
      {
        query: { type: 'string', description: 'Words to search; Russian word forms are stemmed.' },
        similarTo: { type: 'string', description: 'Page path/slug; returns pages with similar body terms instead of a query.' },
        vault: vaultParam,
        corpus: { type: 'string', description: 'wiki | chats | raw | all (default wiki).', enum: ['wiki', 'chats', 'raw', 'all'] },
        limit: { type: 'number', description: 'Maximum results, 1..50 (default 8).' },
        zone: { type: 'string', description: 'Filter by first path segment, e.g. 10-wiki.' },
        type: { type: 'string', description: 'Filter by frontmatter type.' },
        tag: { type: 'string', description: 'Filter by one frontmatter tag.' },
        status: { type: 'string', description: 'Filter by frontmatter status.' },
        updatedSince: { type: 'string', description: 'Filter by updated date, YYYY-MM-DD.' }
      },
      async (args, exec) => runTool(exec, async () => {
        const config = runtime.configFor(exec);
        const vault = runtime.vaultFor(config, args.vault);
        const query = typeof args.query === 'string' ? args.query.trim() : '';
        const similarTo = typeof args.similarTo === 'string' ? args.similarTo.trim() : '';
        if ((query === '' && similarTo === '') || (query !== '' && similarTo !== '')) {
          throw new AiWikiError('INVALID_QUERY', 'Pass exactly one of query or similarTo.');
        }
        const index = await runtime.ensureIndex(vault, config, exec.signal);
        const limit = clamp(args.limit, 8, 1, 50);
        const result = query !== ''
          ? index.search({ query, corpus: args.corpus || 'wiki', zone: args.zone, type: args.type, tag: args.tag, status: args.status, updatedSince: args.updatedSince, limit })
          : index.similar({ path: similarTo, limit });
        return ok({ vault: vault.name, vaultPath: vault.path, index: index.summary(), results: result.rows, truncated: result.truncated });
      })
    ),

    definition(
      'aiwiki_read',
      'Read one ai-wiki page: parsed frontmatter, body or a section/line window, ACL permissions, outgoing links and backlinks. Use section= to keep context small; use offset/limit for raw transcripts.',
      {
        path: { type: 'string', description: 'Page path, slug, or wikilink.', required: true },
        vault: vaultParam,
        section: { type: 'string', description: 'Heading substring; returns that section only.' },
        offset: { type: 'number', description: '1-based first body line (default 1).' },
        limit: { type: 'number', description: 'Maximum body lines.' },
        maxChars: { type: 'number', description: 'Maximum body characters, 1000..200000 (default 20000).' }
      },
      async (args, exec) => runTool(exec, async () => {
        const config = runtime.configFor(exec);
        const vault = runtime.vaultFor(config, args.vault);
        const page = resolvePage(vault.path, args.path);
        const text = readFileSync(page.abs, 'utf8');
        const fm = parseFrontmatter(text);
        const meta = pageMeta(page.rel, fm.data, { mtimeMs: 0, size: text.length });
        const permissions = permissionsFor(vault.path, page.rel, fm.data);
        let pages = [];
        let backlinks = [];
        let indexWarning = null;
        try {
          const index = await runtime.ensureIndex(vault, config, exec.signal);
          pages = index.pages();
          backlinks = index.linksFor(page.rel).backlinks;
        } catch (error) {
          if (error && error.name === 'AbortError') throw error;
          indexWarning = error && error.message ? error.message : String(error);
          pages = pagesFromDisk(vault.path);
        }
        const resolver = createLinkResolver(pages);
        const links = extractBodyLinks(fm.body).concat(extractFrontmatterLinks(fm.data)).map((link) => {
          const resolution = resolveLink(link, page.rel, resolver);
          return {
            target: link.target,
            alias: link.alias,
            heading: link.heading,
            source: link.source,
            resolvedPath: resolution.resolvedPath,
            candidates: resolution.ambiguous,
            exists: resolution.resolvedPath !== null
          };
        });
        const selected = selectBody(fm.body, args);
        let rawPath = null;
        if (meta.raw !== '') {
          const candidate = meta.raw.startsWith('01-raw/') ? meta.raw : '01-raw/' + meta.raw;
          try {
            const abs = resolveInside(vault.path, path.resolve(vault.path, candidate));
            if (existsSync(abs)) rawPath = candidate.replace(/\\/g, '/');
          } catch {
            rawPath = null;
          }
        }
        return ok({
          vault: vault.name,
          path: page.rel,
          name: meta.name,
          type: meta.type,
          zone: meta.zone,
          tags: meta.tags,
          created: meta.created,
          updated: meta.updated,
          permissions,
          frontmatter: fm.data,
          frontmatterError: fm.error ? fm.error.message : null,
          body: selected.text,
          section: selected.section,
          truncated: selected.truncated,
          nextOffset: selected.nextOffset,
          totalLines: selected.totalLines,
          links: {
            out: links,
            backlinks,
            unresolved: links.filter((link) => !link.exists).map((link) => link.target)
          },
          rawPath,
          indexWarning
        });
      })
    ),

    definition(
      'aiwiki_list',
      'List or aggregate ai-wiki pages by zone, type, tag, status and date. Use countsOnly+groupBy for counts without rows; use rows for a catalog.',
      {
        vault: vaultParam,
        corpus: { type: 'string', description: 'wiki | chats | raw | all (default wiki).', enum: ['wiki', 'chats', 'raw', 'all'] },
        zone: { type: 'string', description: 'Filter by first path segment.' },
        type: { type: 'string', description: 'Filter by frontmatter type.' },
        tag: { type: 'string', description: 'Filter by one frontmatter tag.' },
        status: { type: 'string', description: 'Filter by frontmatter status.' },
        updatedSince: { type: 'string', description: 'Filter by updated date, YYYY-MM-DD.' },
        groupBy: { type: 'string', description: 'zone | type | tag | status.', enum: ['zone', 'type', 'tag', 'status'] },
        countsOnly: { type: 'boolean', description: 'Return groups/counts without page rows.' },
        sort: { type: 'string', description: 'updated | name | path (default updated).', enum: ['updated', 'name', 'path'] },
        limit: { type: 'number', description: 'Maximum rows, 1..200 (default 50).' },
        offset: { type: 'number', description: 'Rows to skip.' }
      },
      async (args, exec) => runTool(exec, async () => {
        const config = runtime.configFor(exec);
        const vault = runtime.vaultFor(config, args.vault);
        const index = await runtime.ensureIndex(vault, config, exec.signal);
        const result = index.list({
          corpus: args.corpus || 'wiki',
          zone: args.zone,
          type: args.type,
          tag: args.tag,
          status: args.status,
          updatedSince: args.updatedSince,
          groupBy: args.groupBy,
          countsOnly: args.countsOnly === true,
          sort: args.sort || 'updated',
          limit: clamp(args.limit, 50, 1, 200),
          offset: Math.max(0, Number(args.offset) || 0)
        });
        return ok({ vault: vault.name, ...result });
      })
    ),

    definition(
      'aiwiki_links',
      'Show outgoing links, backlinks and unresolved wikilinks for one ai-wiki page. Use it before creating a page and when checking whether a claim has incoming support.',
      {
        path: { type: 'string', description: 'Page path, slug, or wikilink.', required: true },
        vault: vaultParam,
        direction: { type: 'string', description: 'both | out | in (default both).', enum: ['both', 'out', 'in'] },
        limit: { type: 'number', description: 'Maximum links per direction, 1..200 (default 100).' }
      },
      async (args, exec) => runTool(exec, async () => {
        const config = runtime.configFor(exec);
        const vault = runtime.vaultFor(config, args.vault);
        const index = await runtime.ensureIndex(vault, config, exec.signal);
        const result = index.linksFor(args.path);
        const limit = clamp(args.limit, 100, 1, 200);
        const direction = args.direction || 'both';
        return ok({
          vault: vault.name,
          path: result.path,
          out: direction === 'in' ? [] : result.out.slice(0, limit),
          backlinks: direction === 'out' ? [] : result.backlinks.slice(0, limit),
          unresolved: result.unresolved,
          ambiguous: result.ambiguous
        });
      })
    ),

    definition(
      'aiwiki_status',
      'Show the configured ai-wiki vaults, zones and ACL, page counts, index freshness and size, generated index/hub files, recent log entries and warnings. Call it first in a new session; use rebuild=true to force a full reindex.',
      {
        vault: vaultParam,
        rebuild: { type: 'boolean', description: 'Force a full index rebuild.' }
      },
      async (args, exec) => runTool(exec, async () => {
        const config = runtime.configFor(exec);
        const vault = runtime.vaultFor(config, args.vault);
        const index = runtime.indexFor(vault, config);
        let indexStats = { indexed: false };
        if (args.rebuild === true) {
          indexStats = await runtime.ensureIndex(vault, config, exec.signal).then((value) => value.stats());
        } else if (existsSync(index.file)) {
          indexStats = index.stats();
        }
        const zones = [];
        try {
          const entries = readdirSync(vault.path, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'));
          for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
            const acl = aclFor(vault.path, entry.name + '/probe.md');
            const count = indexStats.indexed === false ? 0 : (indexStats.byZone.find((row) => row.key === entry.name) || { count: 0 }).count;
            zones.push({ name: entry.name, acl: acl.mode, docs: count });
          }
        } catch {
          zones.push({ name: '(unreadable)', acl: 'none', docs: 0 });
        }
        const entries = walkMarkdown(vault.path, { skipDirs: INDEX_SKIP_DIRS, skipNames: INDEX_SKIP_NAMES });
        const newest = newestMtime(entries);
        const generated = [];
        for (const rel of ['index.md', '42-repos/hub.md', '15-precedent/hub.md']) {
          const abs = path.join(vault.path, rel);
          if (!existsSync(abs)) continue;
          let mtimeMs = 0;
          try {
            mtimeMs = statSync(abs).mtimeMs;
          } catch {
            mtimeMs = 0;
          }
          const stale = newest > 0 && mtimeMs < newest - 1000;
          generated.push({ path: rel, state: stale ? 'stale' : 'fresh', reason: stale ? 'older than the newest page; run make index/hub' : '' });
        }
        const warnings = [];
        for (const error of config.errors) warnings.push(error.source + ': ' + error.message);
        if (indexStats.indexed !== false && indexStats.staleDocs > 0) warnings.push(indexStats.staleDocs + ' page(s) changed since the index was built');
        for (const file of generated) if (file.state === 'stale') warnings.push(file.path + ' is stale');
        const value = {
          vault: vault.name,
          vaultPath: vault.path,
          config: config,
          vaults: config.vaults.map((entry) => ({ name: entry.name, path: entry.path, exists: entry.exists })),
          sources: config.sources,
          zones,
          index: indexStats.indexed === false ? { indexed: false } : Object.assign({ indexed: true }, indexStats),
          generated,
          recentLog: recentLog(vault.path),
          warnings
        };
        delete value.config.errors;
        return ok(value);
      })
    ),

    definition(
      'aiwiki_lint',
      'Read-only frontmatter/link-health lint for the vault or one page. Mirrors lint_frontmatter.py (required fields, type enum, tag dictionary, dates, raw files, size, log order) and filters known violations through 90-meta/lint-baseline.json.',
      {
        vault: vaultParam,
        path: { type: 'string', description: 'Check one page instead of the whole vault.' },
        limit: { type: 'number', description: 'Maximum violations to return, 1..200 (default 50).' },
        useBaseline: { type: 'boolean', description: 'Filter known violations through lint-baseline.json (default true).' },
        checkGitDates: { type: 'boolean', description: 'Also compare updated with git log dates (slow).' }
      },
      async (args, exec) => runTool(exec, async () => {
        const config = runtime.configFor(exec);
        const vault = runtime.vaultFor(config, args.vault);
        const result = lintVault(vault, {
          path: args.path,
          limit: clamp(args.limit, 50, 1, 200),
          useBaseline: args.useBaseline !== false,
          checkGitDates: args.checkGitDates === true
        });
        return ok({ vault: vault.name, ...result });
      })
    )
  ];
}
