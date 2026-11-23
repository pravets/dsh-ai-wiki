# dsh-ai-wiki

[![CI](https://github.com/pravets/dsh-ai-wiki/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/pravets/dsh-ai-wiki/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-ai-wiki)](https://www.npmjs.com/package/dsh-ai-wiki)

Плагин DeepSeek Harness для чтения личной вики, собранной по шаблону [ai-wiki-template](https://github.com/pravets/ai-wiki-template): зоны, ACL-маркеры, frontmatter-контракт, wiki-ссылки и BM25-поиск. Плагин только читает вики; индекс живёт в кэше DSH.

## Зачем свой плагин

Готовые плагины решают соседние задачи, но не этот контракт:

- @pananfly/dsh-llm-wiki — OKF v0.2 со своей структурой .llm-wiki/ и своим индексом; зоны, .llm-* и BM25-веса этого шаблона не поддерживает.
- dsh-wiki-notes — сильный универсальный read-only шлюз к Markdown, но поиск keyword/recall, а не BM25-контракт vault; нет ACL, зон и raw-корпуса.
- dsh-wiki-rag — эмбеддинги, а не BM25.
- dsh-AIkb и dsh-knowledge-graph — про ingest/граф, а не про чтение этой вики.

Свой плагин небольшой (весь vault — около 5 МБ), зато повторяет контракт шаблона и не требует Python.

## Что даёт агенту

Шесть инструментов с префиксом aiwiki_, чтобы не пересекаться с другими wiki-плагинами:

| Инструмент | Назначение |
|---|---|
| aiwiki_search | BM25 по SQLite FTS5: веса name 5, tags/aliases 3, headings 2, kw 2, body 1; корпуса wiki/chats/raw; similarTo. |
| aiwiki_read | Frontmatter, тело или секция/окно строк, ACL-права, исходящие ссылки и бэклинки. |
| aiwiki_list | Каталог и агрегаты по зоне, типу, тегу, статусу и дате. |
| aiwiki_links | Исходящие ссылки, бэклинки, неразрешённые и неоднозначные wiki-ссылки. |
| aiwiki_status | Вики, зоны и ACL, счётчики, свежесть и размер индекса, generated index/hub, последние записи log.md, предупреждения. |
| aiwiki_lint | Read-only порт lint_frontmatter.py с поддержкой lint-baseline.json. |

Плюс короткая секция системного промпта и guard, который отклоняет write/edit по путям вики.

## Требования

- Node.js 22.13+ (нужен node:sqlite с FTS5); рекомендуется Node 24.
- DSH 0.2.2-rc.5.
- Vault по шаблону: AGENTS.md, каталоги зон и маркеры .llm-ro/.llm-append/.llm-rw.

Python и native-модули не нужны.

## Установка

Из каталога плагина:

    dsh plugin --profile web add C:\git\dsh-ai-wiki

После публикации:

    dsh plugin --profile web add dsh-ai-wiki

Откройте новую сессию. Конфиг перечитывается на каждом вызове, перезапуск DSH для добавления вики не нужен.

## Настройка

Создайте %USERPROFILE%\.dsh\dsh-wiki.json:

    {
      "vaults": [
        { "name": "vault", "path": "C:\\git\\vault", "includeRaw": true }
      ],
      "indexDir": "~/.dsh/cache/dsh-ai-wiki",
      "autoIndex": true,
      "promptSection": true,
      "guardWrites": true
    }

Можно проще: "vaults": ["C:\\git\\vault"]. Проектный .dsh-wiki.json в каталоге сессии перекрывает пользовательский; enabled:false отключает отдельную вики. Переменные DSH_WIKI_ROOTS (пути через ;) и DSH_WIKI_INDEX_DIR тоже работают.

Если сессия открыта внутри вики (AGENTS.md + каталоги зон или .llm-*), плагин найдёт её сам.

## Примеры

    aiwiki_search query="индексы postgres" limit=5
    aiwiki_search query="контекст агента" type=concept
    aiwiki_search similarTo="10-wiki/1c-postgres-indexes"
    aiwiki_read path="10-wiki/1c-postgres-indexes" section="Индексы"
    aiwiki_read path="01-raw/2026-10-08-1c-postgres-indexes-transcript" offset=1 limit=80
    aiwiki_list type=repo status=active groupBy=role
    aiwiki_links path="10-wiki/1c-postgres-indexes"
    aiwiki_status rebuild=true
    aiwiki_lint limit=20

## Как устроен поиск

Индекс — отдельная SQLite-база в indexDir, имя из хэша пути вики. Первый поиск собирает её, дальше обновляются только изменённые страницы по mtime и size. Полная пересборка — aiwiki_status rebuild=true.

Токенизация повторяет 90-meta/scripts/wiki_search.py: lower-case, [а-яёa-z0-9]+, Snowball Russian для кириллицы, латиница и цифры без стемминга. Запрос — "term"* с AND, затем OR. raw по умолчанию исключён; corpus="raw" или "all" включает транскрипты. similarTo берёт до 40 уникальных слов тела длиннее 4 символов.

Плагин не использует .wiki-index/search.db и не требует Python/snowballstemmer. Ранжирование сознательно близко к wiki_search.py; отличия: block-списки tags/aliases/kw разбираются YAML-парсером, путь БД другой, кириллические имена нормализуются в NFC.

## Права и read-only

Контракт вики: нет .llm-* — read-only; корень read-only; frontmatter llm: ro перекрывает rw зоны. aiwiki_read показывает permissions, guard отклоняет write/edit/str_replace_editor/apply_patch для путей внутри настроенной вики. Guard не разбирает произвольные shell-команды; для сессий внутри вики действуют sandbox и правила AGENTS.md.

Плагин пишет только в indexDir. В вики не создаётся даже .wiki-index.

## Диагностика

- «VAULT_NOT_CONFIGURED» — нет dsh-wiki.json и сессия вне вики; добавьте путь.
- «INDEX_UNAVAILABLE» — Node старше 22.13 или сборка без FTS5; проверьте node -v и node -e "require('node:sqlite')".
- «INDEX_STALE» — autoIndex=false и индекса нет; вызовите aiwiki_status rebuild=true.
- Пустой поиск — проверьте corpus (raw включается явно) и фильтры; для точной строки используйте обычный grep.
- Индекс устарел после ручных правок — aiwiki_search обновит его сам; при сомнении aiwiki_status.
- Кириллические имена и ё: стеммер приводит ё к е (Snowball), это ожидаемо.

## Разработка

    npm test
    DSH_WIKI_TEST_VAULT=C:\git\vault npm test
    node tools/bench.mjs --vault C:\git\vault
    node tools/compare-python.mjs --vault C:\git\vault   # если есть Python+snowballstemmer и собран .wiki-index

Тесты — node:test, временные вики в tests/helpers.mjs. Реальный vault — opt-in.


## CI и релиз

CI на GitHub Actions собирает пакет на каждый push и pull request: тесты, проверка синтаксиса, tarball и артефакт сборки. В npm опубликованы 0.1.0 (вручную) и 0.1.1 (trusted publishing, OIDC, provenance); latest — 0.1.1. Дальнейшие релизы идут по тегу v* через release.yml. Подробности — в docs/RELEASE.md.

Репозиторий: https://github.com/pravets/dsh-ai-wiki. Рабочая ветка — master.

## Ограничения

Первая версия только читает. Запись и ingest, правка index.md/log.md, UI-панель, слэш-команды и ambient recall не входят. ACL-aware append/create можно добавить следующим этапом.
