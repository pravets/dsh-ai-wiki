import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { walkMarkdown, parseFrontmatter, stringValue } from './vault.mjs';
import { resolvePage } from './vault.mjs';
import {
  COMMON_FIELDS, LINT_SKIP_DIRS, LINT_SKIP_NAMES, SIZE_LIMITS, DEFAULT_SIZE_LIMIT,
  ruleFor, tagList, isWarn, CANON, TAGS
} from './schema.mjs';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function isEmptyValue(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '' || value.trim() === '[]';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function gitDate(root, rel) {
  try {
    const out = execFileSync('git', ['-C', root, 'log', '-1', '--format=%ad', '--date=short', '--', rel], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const line = String(out).trim().split('\n')[0];
    return line === '' ? null : line;
  } catch {
    return null;
  }
}

function sizeLimit(rel) {
  for (const [prefix, limit] of SIZE_LIMITS) {
    if (rel.startsWith(prefix)) return limit;
  }
  return DEFAULT_SIZE_LIMIT;
}

export function checkPage(root, rel, text, options) {
  const rule = ruleFor(rel);
  if (rule === null) return [];
  const fm = parseFrontmatter(text);
  if (!fm.hasFrontmatter) return ['no-frontmatter'];
  const data = fm.data || {};
  const problems = [];
  const types = rule[1];
  const extra = rule[2];
  const nonempty = rule[3];

  for (const key of COMMON_FIELDS.concat(extra)) {
    if (key === 'name' && rel.endsWith('/slides.md')) {
      if (!Object.prototype.hasOwnProperty.call(data, 'name') && !Object.prototype.hasOwnProperty.call(data, 'title')) {
        problems.push('missing:name');
      }
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(data, key)) {
      problems.push('missing:' + key);
      continue;
    }
    if (nonempty.includes(key) && isEmptyValue(data[key])) {
      problems.push('empty:' + key);
    }
  }

  if (extra.includes('sources') && Object.prototype.hasOwnProperty.call(data, 'sources') && isEmptyValue(data.sources)) problems.push('empty:sources');
  if (Object.prototype.hasOwnProperty.call(data, 'title') && !rel.endsWith('/slides.md')) problems.push('title-duplicate');

  const type = stringValue(data.type).trim();
  if (type !== '' && !types.includes(type)) problems.push('type-not-in-enum');

  for (const key of ['created', 'updated']) {
    const value = stringValue(data[key]).trim();
    if (value !== '' && !DATE.test(value)) problems.push(key + '-not-iso');
  }
  const created = stringValue(data.created).trim();
  const updated = stringValue(data.updated).trim();
  if (DATE.test(created) && DATE.test(updated) && updated < created) problems.push('updated-before-created');

  const tags = tagList(data.tags);
  if (tags.length > 5) problems.push('too-many-tags');
  for (const tag of tags) {
    if (Object.prototype.hasOwnProperty.call(CANON, tag)) problems.push('tag-canonicalize:' + tag);
    else if (!TAGS.has(tag)) problems.push('tag-outside:' + tag);
  }
  if (tagList(data.kw).length > 8) problems.push('too-many-kw');

  const raw = stringValue(data.raw).trim().replace(/^01-raw[\\/]/, '');
  if (raw !== '') {
    const rawPath = path.resolve(root, '01-raw', raw);
    if (!existsSync(rawPath)) problems.push('raw-missing-file');
  }

  try {
    const size = Buffer.byteLength(text, 'utf8');
    if (size > sizeLimit(rel)) problems.push('too-large:' + Math.floor(sizeLimit(rel) / 1024) + 'k');
  } catch {
    // Size is advisory.
  }

  if (options && options.checkGitDates === true && DATE.test(updated)) {
    const last = gitDate(root, rel);
    if (last !== null && last > updated) problems.push('updated-stale');
  }

  return Array.from(new Set(problems)).sort();
}

export function checkLog(root) {
  const file = path.join(root, 'log.md');
  if (!existsSync(file)) return [];
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const dates = [];
  const regex = /^## \[(\d{4}-\d{2}-\d{2})\]/gm;
  let match;
  while ((match = regex.exec(text)) !== null) dates.push(match[1]);
  const bad = [];
  for (let index = 1; index < dates.length; index += 1) {
    if (dates[index] < dates[index - 1]) bad.push('log-order:' + dates[index] + ' after ' + dates[index - 1]);
  }
  return bad;
}

function loadBaseline(root) {
  const file = path.join(root, '90-meta', 'lint-baseline.json');
  if (!existsSync(file)) return { file, violations: {}, generated: '' };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const violations = parsed && typeof parsed.violations === 'object' && parsed.violations !== null ? parsed.violations : {};
    return { file, violations, generated: stringValue(parsed.generated) };
  } catch {
    return { file, violations: {}, generated: '' };
  }
}

export function lintVault(vault, options) {
  const settings = options || {};
  const root = vault.path;
  let entries = walkMarkdown(root, { skipDirs: LINT_SKIP_DIRS, skipNames: LINT_SKIP_NAMES });
  if (settings.path) {
    const page = resolvePage(root, settings.path);
    entries = entries.filter((entry) => entry.rel === page.rel);
  }
  const all = new Map();
  for (const entry of entries) {
    let text = '';
    try {
      text = readFileSync(entry.abs, 'utf8');
    } catch {
      continue;
    }
    const problems = checkPage(root, entry.rel, text, { checkGitDates: settings.checkGitDates === true });
    if (problems.length > 0) all.set(entry.rel, problems);
  }
  const log = settings.path ? [] : checkLog(root);
  const baseline = settings.useBaseline === false ? { file: '', violations: {}, generated: '' } : loadBaseline(root);
  const knownMap = baseline.violations;
  const newViolations = new Map();
  const warningMap = new Map();
  for (const [rel, problems] of all) {
    const blocking = problems.filter((problem) => !isWarn(problem));
    const warnings = problems.filter((problem) => isWarn(problem));
    if (warnings.length > 0) warningMap.set(rel, warnings);
    const allowed = new Set(Array.isArray(knownMap[rel]) ? knownMap[rel] : []);
    const fresh = blocking.filter((problem) => !allowed.has(problem));
    if (fresh.length > 0) newViolations.set(rel, fresh);
  }
  const fixed = Object.keys(knownMap).filter((rel) => !all.has(rel)).sort();
  const improved = [];
  for (const [rel, problems] of all) {
    if (!Object.prototype.hasOwnProperty.call(knownMap, rel)) continue;
    const known = Array.isArray(knownMap[rel]) ? knownMap[rel] : [];
    if (known.length > 0 && problems.every((problem) => known.includes(problem)) && problems.length < known.length) {
      improved.push(rel);
    }
  }
  const perZone = {};
  let blockingPages = 0;
  let warningPages = 0;
  for (const [rel, problems] of all) {
    const blocking = problems.some((problem) => !isWarn(problem));
    if (blocking) {
      blockingPages += 1;
      const zone = rel.split('/')[0];
      perZone[zone] = (perZone[zone] || 0) + 1;
    }
    if (problems.some((problem) => isWarn(problem))) warningPages += 1;
  }
  const limit = Number(settings.limit) || 50;
  const violations = Array.from(all.entries())
    .sort((left, right) => left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([rel, problems]) => ({ path: rel, codes: problems }));
  return {
    totalPages: entries.length,
    blocking: blockingPages,
    warnings: warningPages,
    perZone,
    known: Object.keys(knownMap).length,
    newSinceBaseline: Array.from(newViolations.entries()).map(([rel, problems]) => ({ path: rel, codes: problems })),
    fixed,
    improved,
    log,
    violations,
    truncated: all.size > violations.length,
    baselinePath: baseline.file,
    baselineGenerated: baseline.generated
  };
}
