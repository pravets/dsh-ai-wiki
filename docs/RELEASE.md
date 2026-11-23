# Релиз dsh-ai-wiki

## Ветки и CI

Рабочая ветка — master. CI запускается на push в master, на pull request и вручную:

- test: ubuntu-latest и windows-latest, Node 22 и 24; npm ci, npm test, npm run check;
- pack: ubuntu, Node 24; npm pack, npm publish --dry-run, artifact dsh-ai-wiki-tarball.

CI-сборка не требует npm-аутентификации и не публикует пакет. Артефакт tarball скачивается из run.

## Первый 0.1.0

Версия 0.1.0 опубликована вручную 2026-11-23: npm publish --access public с OTP. Пакет доступен как dsh-ai-wiki, dist-tag latest указывает на 0.1.0. Placeholder 0.0.0-stage, созданный staged publishing, остаётся служебной версией и не является latest.

## Trusted publisher для CI

Настроить один раз на npmjs.com:

1. Открыть https://www.npmjs.com/package/dsh-ai-wiki → Settings.
2. Найти Trusted Publisher → GitHub Actions.
3. Заполнить: owner pravets, repository dsh-ai-wiki, workflow filename release.yml; environment пустой.
4. Разрешить npm publish (allow publish).
5. Подтвердить 2FA.

Альтернатива через CLI с npm >= 11.15 и 2FA:

    npx -y npm@11.21.3 trust github dsh-ai-wiki --file release.yml --repo pravets/dsh-ai-wiki --allow-publish

После настройки первый успешный publish через OIDC должен пройти в течение 2 дней, иначе конфигурацию нужно создать заново. Для проверки поднять версию до 0.1.1, поставить тег v0.1.1 и запустить release.yml.

## Релиз по тегу

release.yml запускается на тег v* или вручную с входом tag. Он:

- проверяет, что version в package.json совпадает с тегом;
- гоняет тесты и синтаксис;
- собирает dist/dsh-ai-wiki-<version>.tgz и прикладывает к GitHub Release;
- публикует в npm через trusted publishing (OIDC), если версии ещё нет.

Для trusted publishing нужны npm >= 11.5.1 и Node >= 22.14.0; workflow обновляет npm до 11.15+.

## Безопасность

- В release.yml нет NPM_TOKEN: только id-token: write и OIDC.
- Bootstrap- workflow с токеном удалён после ручной публикации 0.1.0.
- OTP и токены не передаются в чат и не попадают в репозиторий.
- tarball не содержит tests, tools, package-lock, .npm-cache.
