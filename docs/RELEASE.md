# Релиз dsh-ai-wiki

## Ветки и CI

Рабочая ветка — master. CI запускается на push в master, на pull request и вручную:

- test: ubuntu-latest и windows-latest, Node 22 и 24; npm ci, npm test, npm run check;
- pack: ubuntu, Node 24; npm pack, npm publish --dry-run, artifact dsh-ai-wiki-tarball.

CI-сборка не требует npm-аутентификации и не публикует пакет. Артефакт tarball скачивается из run.

## Релиз по тегу

release.yml запускается на тег v* или вручную с входом tag. Он:

- проверяет, что version в package.json совпадает с тегом;
- гоняет тесты и синтаксис;
- собирает dist/dsh-ai-wiki-<version>.tgz и прикладывает к GitHub Release;
- публикует в npm через trusted publishing (OIDC), если версии ещё нет.

Для trusted publishing нужны npm >= 11.5.1 и Node >= 22.14.0; workflow обновляет npm до 11.15+.

## Первый 0.1.0: one-time bootstrap

Trusted publishing настраивается только для пакета, который уже существует в npm. Поэтому первый 0.1.0 публикуется один раз:

Вариант A, через GitHub Actions:

1. Создать npm automation/granular token с правом publish и bypass 2FA.
2. Добавить его в GitHub Secrets как NPM_TOKEN (значение не коммитить).
3. Запустить workflow Bootstrap publish вручную.
4. Убедиться, что npm view dsh-ai-wiki version возвращает 0.1.0.
5. Удалить bootstrap-publish.yml и секрет NPM_TOKEN.

Вариант B: один раз выполнить npm login и npm publish --access public локально, с OTP.

После появления пакета:

1. npmjs.com → пакет dsh-ai-wiki → Settings → Trusted Publisher → GitHub Actions.
2. Owner: pravets, repository: dsh-ai-wiki, workflow filename: release.yml.
3. Разрешить npm publish (allowed actions).
4. Проверить конфигурацию первым успешным publish в течение 2 дней: поднять версию до 0.1.1, поставить тег v0.1.1 и запустить release.yml.

Для v0.1.0 после bootstrap release.yml увидит, что версия уже есть, пропустит публикацию и создаст GitHub Release с tarball.

## Безопасность

- NPM_TOKEN живёт только до первого успешного publish; затем удаляется.
- В release.yml токена нет: только id-token: write и OIDC.
- OTP и токены не передаются в чат и не попадают в репозиторий.
- tarball не содержит tests, tools, package-lock, .npm-cache.
