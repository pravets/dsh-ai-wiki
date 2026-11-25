# Design — dsh-ai-wiki

## Goal

Give a DSH agent in any project read access to a personal ai-wiki vault with the vault's own semantics: zones and ACL markers, frontmatter, wiki links, BM25, raw transcripts and lint. The vault must remain untouched; only the index cache is written.

## Non-goals (v1)

Writing, ingest, index.md/log.md regeneration, sidebar UI, slash commands, ambient recall. These are deliberate extensions, not missing plumbing.

## Data flow

    Markdown files
      -> walkMarkdown() with wiki_search.py skip rules
      -> parseFrontmatter() (YAML, fallback line parser)
      -> pageMeta() + normalizeList()
      -> tokenize() (lowercase, [а-яёa-z0-9]+, Snowball Russian for Cyrillic)
      -> SQLite FTS5 (docs, search, doc_tags, links, meta)
      -> BM25 / filters / links / lint
      -> canonical JSON -> tool render

The index is external to the vault: indexDir/<sha256(vault path)[0:16]>.db. The vault is read with node:fs; the plugin's own tools never write there.

## Modules

- lib/index.js — plugin entry: registration with when, prompt section, write guard, disposal.
- lib/config.mjs — layers: cordis config -> env -> $DSH_HOME/dsh-wiki.json -> <cwd>/.dsh-wiki.json; auto-detection of a vault from cwd.
- lib/vault.mjs — walking, path containment, ACL markers, frontmatter, wiki links and resolution.
- lib/schema.mjs — constants mirrored from lint_frontmatter.py (zones, types, tags, sizes, skips).
- lib/tokenize.mjs — tokenizer, Snowball stemmer, FTS query builder, body plain text and excerpt.
- lib/index.mjs — SQLite FTS5 schema, incremental build, BM25 search, similar, list, links, stats.
- lib/lint.mjs — read-only lint and baseline filtering.
- lib/tools.mjs — six tool definitions on top of the schema compiler, runtime (config/index cache), renderers, prompt and guard helpers.
- lib/tool-schema.mjs — compiles the flat per-property parameter map into canonical JSON Schema, mirroring dsh-tools defineTool.

Tool parameters are authored flat ({ name: { type, description, required: true } }) and compiled at registration into { type: 'object', properties, required }. DSH sends a tool's parameters in the request body verbatim, so a flat map would put a property named type where a provider expects the schema keyword and a validating service would reject the whole request, not just that tool.

## Index schema

    docs(id, path, corpus, zone, name, type, status, created, updated, tags, aliases, mtime, size, excerpt, frontmatter)
    doc_tags(doc_id, tag)
    search FTS5(doc_id UNINDEXED, name, tags, headings, kw, body)
    links(from_id, target, resolved_path, alias, heading, source, candidates)
    meta(key, value)

BM25 uses bm25(search, 0, 5, 3, 2, 2, 1), matching the vault weights. The search path first tries AND over quoted prefix terms, then OR. Raw is excluded by default and enabled explicitly.

Incremental refresh compares path+mtime+size. When any page changes, all links are re-resolved: a new target can turn an unresolved link into a resolved one, and a deleted target must disappear from backlinks. This costs a full read of the vault on change but keeps the graph correct; the real vault (547 indexed pages, 5.1 MB) builds in under 2 seconds.

## Links

Body links: [[target]], [[target|alias]], [[target#heading]], ![[...]]; fenced code is skipped. Frontmatter refs work_ref, person and project are typed edges. Resolution order: exact path -> relative path from the source directory -> unique basename -> unique name/alias -> ambiguous (candidates returned) -> unresolved. This approximates Obsidian's shortest-path rule and never silently picks among duplicates.

## ACL

Nearest .llm-ro/.llm-append/.llm-rw from the page directory up to the vault root wins. No marker means read-only; the root is read-only. Frontmatter llm: ro overrides a writable zone; llm: rw does not raise a read-only zone. Root index.md and log.md are the contract's exception (full), but the plugin still never writes. Permissions are reported to the model; a monotonic tool guard denies write/edit/str_replace_editor/apply_patch for vault paths.

The guard cannot interpret shell commands. Sessions inside the vault still rely on the DSH sandbox and the vault's AGENTS.md.

## Configuration

Vaults are user-level by default (one personal vault used from many projects), with a project-level override. Tools are registered with when: configured vaults exist, so an unrelated session pays no schema cost. The prompt section is a short static text (no dates/counters) to preserve prompt caching.

## Failure model

Expected failures are canonical values: { ok: false, error: { code, message, hint } }. Codes include VAULT_NOT_CONFIGURED, VAULT_NOT_FOUND, VAULT_NOT_A_WIKI, INDEX_UNAVAILABLE, INDEX_STALE, INDEX_BUILD_FAILED, INVALID_QUERY, INVALID_CORPUS, RAW_DISABLED, PAGE_NOT_FOUND, AMBIGUOUS_PAGE, PATH_OUTSIDE_VAULT, SECTION_NOT_FOUND. Cancellation is cooperative (exec.signal); a build aborts and rolls back its transaction.

## Testing

Fixtures build a temporary vault with all zones, markers, inline and block frontmatter, aliases, raw, unresolved links and broken YAML. Unit tests cover tokenizer, frontmatter, ACL, link resolution, index build and search, lint and baseline. Tool tests execute all six definitions through the runtime; plugin tests use a fake context for registration, when, prompt and guard. A real-vault test is opt-in via DSH_WIKI_TEST_VAULT and asserts the control queries, backlinks and a clean baseline.

## Future

1. ACL-aware append/create plus log.md/index.md regeneration.
2. Opt-in ambient recall (not default: it risks prompt cache and context bloat).
3. Bundled aiwiki-query skill mirroring skills/wiki-query.
4. Web sidebar panel over the same index.
