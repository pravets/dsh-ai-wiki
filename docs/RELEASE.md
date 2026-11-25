# Релиз dsh-ai-wiki

## Ветки и CI

Рабочая ветка — master. CI запускается на push в master, на pull request и вручную:

- test: ubuntu-latest и windows-latest, Node 22 и 24; npm ci, npm test, npm run check;
- pack: ubuntu, Node 24; npm pack и artifact dsh-ai-wiki-tarball.

CI-сборка не требует npm-аутентификации и не публикует пакет. Артефакт tarball скачивается из run.

## Версии в npm

- 0.1.0 — опубликован вручную 2026-11-23 с OTP.
- 0.1.1 — опубликован через trusted publishing (OIDC) из release.yml, с provenance.
- 0.1.2 — фикс объявлений параметров инструментов (канонический JSON Schema); опубликован через trusted publishing (OIDC) из release.yml, с provenance.
- latest указывает на 0.1.2.
- 0.0.0-stage — служебный placeholder staged publishing; latest на него не указывает.

Provenance 0.1.2: https://registry.npmjs.org/-/npm/v1/attestations/dsh-ai-wiki@0.1.2
Provenance 0.1.1: https://registry.npmjs.org/-/npm/v1/attestations/dsh-ai-wiki@0.1.1

## Trusted publisher

Настроен и проверен на npmjs.com:

- provider: GitHub Actions;
- owner: pravets;
- repository: dsh-ai-wiki;
- workflow filename: release.yml;
- allowed: npm publish.

Первый успешный OIDC-publish (0.1.1) прошёл, значит конфигурация активна. NPM_TOKEN и bootstrap-workflow не нужны и удалены.

## Релиз по тегу

release.yml запускается на тег v* или вручную с входом tag. Он:

- проверяет, что version в package.json совпадает с тегом;
- гоняет тесты и синтаксис;
- собирает dist/dsh-ai-wiki-<version>.tgz и прикладывает к GitHub Release;
- публикует в npm через trusted publishing (OIDC), если версии ещё нет.

Для trusted publishing нужны npm >= 11.5.1 и Node >= 22.14.0; workflow обновляет npm до 11.15+.

## Следующий релиз

1. Поднять version в package.json и package-lock.json.
2. Закоммитить и запушить master.
3. Поставить тег vX.Y.Z и запушить его.
4. release.yml соберёт tarball, создаст GitHub Release и опубликует версию через OIDC.

## Безопасность

- В release.yml нет NPM_TOKEN: только id-token: write и OIDC.
- Bootstrap-workflow с токеном удалён после ручной публикации 0.1.0.
- OTP и токены не передаются в чат и не попадают в репозиторий.
- tarball не содержит tests, tools, package-lock, .npm-cache.
