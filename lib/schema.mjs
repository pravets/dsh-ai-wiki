// Contract constants mirrored from ai-wiki-template / lint_frontmatter.py.
// The vault's AGENTS.md remains the source of truth; these are read-only checks.

export const COMMON_FIELDS = ['name', 'type', 'created', 'updated', 'tags'];

export const ZONE_RULES = [
  ['15-precedent/bank', ['precedent'], ['text', 'kind', 'author', 'theme', 'device', 'attribution', 'sources'], []],
  ['15-precedent/works', ['work'], ['author', 'year', 'kind', 'sources'], []],
  ['42-repos', ['repo'], ['repo', 'role', 'status', 'sources'], []],
  ['60-travel/poi', ['church', 'abandoned', 'nature', 'urban', 'fortress', 'route', 'other'], ['region', 'status', 'coords', 'location', 'sources'], []],
  ['10-wiki', ['concept', 'howto', 'tool', 'survey', 'comparison', 'case', 'talk', 'company', 'style-guide'], ['sources'], []],
  ['15-precedent', ['precedent'], ['sources'], []],
  ['20-people', ['work', 'client', 'contractor', 'community', 'personal', 'travel'], ['org', 'role', 'contact', 'status', 'first_met'], []],
  ['25-interactions', ['meeting', 'call', 'chat', 'email'], ['date', 'person'], []],
  ['40-projects', ['project', 'talk', 'spec', 'status', 'plan', 'masterclass'], ['project', 'status'], []],
  ['50-drafts', ['ideas', 'draft', 'outline', 'slides', 'plan', 'post'], ['status'], []],
  ['60-travel', ['church', 'abandoned', 'nature', 'urban', 'fortress', 'route', 'other'], ['region', 'status', 'coords', 'location', 'sources'], []],
  ['70-personal', ['cashback-profile', 'cashback-bank', 'cashback-month', 'cashback-report', 'cashback-readme'], [], []],
  ['90-meta', ['template', 'accumulator', 'script'], [], []]
];

export const TAGS = new Set([
  '1c', 'ai', 'llm', 'local-models', 'agents', 'mcp', 'devops', 'ci-cd', 'monitoring',
  'git', 'linux', 'windows', 'macos', 'networking', 'security', 'database', 'testing',
  'docker', 'kubernetes', 'self-hosted', 'cloud', 'gpu', 'audio', 'video', 'media',
  'design', 'content', 'product', 'management', 'gaming', 'tools', 'api', 'integrations', 'ocr',
  'conference', 'speaker', 'community', 'blogger', 'analytics', 'hr',
  'travel', 'finance', 'personal', 'health', 'learning', 'household',
  'digest'
]);

export const CANON = {
  selfhost: 'self-hosted', selfhosted: 'self-hosted', 'self-hosting': 'self-hosted',
  agent: 'agents', 'ai-agents': 'agents', 'агенты': 'agents',
  'локальные-модели': 'local-models', 'local-ai-models': 'local-models',
  'тестирование': 'testing', 'unit-тесты': 'testing',
  'мониторинг': 'monitoring', observability: 'monitoring',
  'аналитика': 'analytics', 'конспект': 'digest',
  'конференции': 'conference', 'спикер': 'speaker',
  'интеграции': 'integrations'
};

export const SIZE_LIMITS = [
  ['10-wiki', 26 * 1024],
  ['15-precedent/bank', 4 * 1024],
  ['20-people', 8 * 1024],
  ['42-repos', 12 * 1024],
  ['05-chats', 100 * 1024]
];
export const DEFAULT_SIZE_LIMIT = 60 * 1024;

// Index scope from wiki_search.py: raw and chats are indexed, service pages are not.
export const INDEX_SKIP_DIRS = [
  '90-meta/templates', '60-travel/trips', '30-journal', '00-inbox',
  '.git', '.obsidian', '.trash', '.wiki-index'
];
export const INDEX_SKIP_NAMES = ['index.md', 'AGENTS.md', 'README.md', 'log.md', 'status.md'];

// Lint scope from lint_frontmatter.py: raw is not linted, service pages are skipped.
export const LINT_SKIP_DIRS = [
  '90-meta/templates', '60-travel/trips', '30-journal', '01-raw', '00-inbox',
  '.git', '.obsidian', '.trash', '.wiki-index'
];
export const LINT_SKIP_NAMES = [
  'README.md', 'log.md', 'status.md', 'index.md', 'AGENTS.md',
  'hub.md', 'themes.md', 'poi-map.md', 'tag-proposals.md'
];

export const WARN_PREFIXES = ['updated-stale'];

export function ruleFor(rel) {
  let best = null;
  for (const rule of ZONE_RULES) {
    const prefix = rule[0];
    if (rel === prefix || rel.startsWith(prefix + '/')) {
      if (best === null || prefix.length > best[0].length) best = rule;
    }
  }
  return best;
}

export function tagList(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item).trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  }
  if (value === null || value === undefined) return [];
  let text = String(value).trim();
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  return text
    .split(',')
    .map((item) => item.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

export function isWarn(code) {
  return WARN_PREFIXES.some((prefix) => code.startsWith(prefix));
}
