# Mouse King Pro — инструкция для ИИ-ассистентов

Прочитайте этот файл целиком перед любой работой в репозитории. Подробности — в `docs/`:

| Файл | О чём |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | устройство программы: процессы, модули, режимы, данные, IPC |
| [docs/RUNPOD.md](docs/RUNPOD.md) | «Картинка Pro» и «Убрать текст с видео» на своём RunPod: эндпоинты, диск, воркфлоу, подводные камни |
| [docs/STATUS.md](docs/STATUS.md) | что готово, что в работе, что осталось сделать — **начинайте отсюда, если продолжаете чужую работу** |

## Что это

Mouse King Pro — десктопный ИИ-агент для **Windows и Linux** на моделях [Venice AI](https://venice.ai):
чат с инструментами (файлы, команды, браузер, SSH, git, MCP), генерация и правка картинок и видео,
«Картинка Pro» на собственном RunPod Serverless (ComfyUI) и WaveSpeed, Telegram-бот, расписания, галерея.

- Код программы — `desktop/` (Electron 45 + electron-vite + React 19 + TypeScript).
- Воркеры для RunPod — `worker/`.
- `legacy-qt/` — первая версия на Python/Qt, **не развивается**, не трогать.
- Репозиторий публичный: https://github.com/danikrutov12-ship-it/mousekingpro

## Правила работы (обязательны)

1. **Язык.** Владелец пишет по-русски — отвечайте по-русски. Интерфейс, комментарии в коде, сообщения коммитов — на русском.
2. **Обсуждение до переделки.** Перед новой функцией или крупной переделкой опишите решение, варианты и вопросы
   и дождитесь явного «да». Мелкие исправления ошибок можно делать сразу.
3. **Выпуск версии — только по слову «выпускай».** В остальных случаях коммитьте локально.
   Push в `main` запускает сборку в GitHub Actions, но не релиз; релиз — тег `vX.Y.Z` через `./release.sh`.
4. **Обе платформы.** Каждая функция должна работать на Windows и Linux. Различия ОС — только в
   `desktop/src/main/platform.ts` и через `isWin`.
5. **Секреты никогда не попадают в репозиторий, код, git config или URL remote.** Ключи пользователь вводит
   в настройках программы (хранятся зашифрованными через `safeStorage`, `desktop/src/main/secrets.ts`).
   Локальные файлы ключей на машине разработчика (chmod 600, только для скриптов):
   - `~/.mkp-token` — токен GitHub для `release.sh` и push (передаётся через `http.extraheader`, не сохраняется в git);
   - `~/.runpod-key` — ключ API RunPod;
   - `~/.runpod-s3` — S3-ключ RunPod (строка 1 — access key `user_…`, строка 2 — secret `rps_…`), если создан;
   - `~/.amo-keys` — ключи Mozilla для `firefox-sign.sh`.
   Идентификаторы эндпоинтов и дисков RunPod в репозиторий тоже не пишем — программа находит их по имени.
6. **Не публиковать e-mail владельца.** Коммиты — от `danikrutov12-ship-it <danikrutov12-ship-it@users.noreply.github.com>`.
7. **Не менять `app.setName('Venice Agent')` на Linux.** К этому имени привязан ключ GNOME keyring для
   `safeStorage`: после переименования сохранённые секреты перестают расшифровываться (проверено).
   Поэтому папка данных на Linux так и осталась `~/.local/share/venice-agent`.
8. **Деньги владельца.** Всё, что запускает видеокарты RunPod, стоит денег: не оставляйте поды и воркеры
   включёнными, у эндпоинтов `workersMin` всегда 0, временные поды удаляйте сразу после работы.
9. **Удалённое не возвращать без просьбы владельца:** режим «Фейсвап» (ReActor) удалён в коммите `42cddf4`.

## Сборка, запуск, проверка

Node.js лежит в `~/.local/lib/nodejs/current/bin` (добавьте в `PATH`). Все команды — из `desktop/`.

```bash
export PATH=$HOME/.local/lib/nodejs/current/bin:$PATH
cd desktop
npx tsc --noEmit -p tsconfig.json     # проверка типов (то же, что npm run typecheck); tsconfig.node.json нет
npx electron-vite build               # сборка в desktop/out
../run.sh                             # запуск из исходников (сам пересоберёт при изменениях)
```

- В терминале VS Code выставлена `ELECTRON_RUN_AS_NODE` — без `env -u ELECTRON_RUN_AS_NODE` Electron
  запускается как Node и падает с «Cannot find module electron». `run.sh` это учитывает.
- **Проверка интерфейса снимками** (без ручного клика): переменные `VA_SHOT=папка VA_SCRIPT=сценарий.json`.
  Сценарий — список шагов `[js-код, пауза мс, имя снимка | null]`; в js доступен `window.__va`
  (все действия из `lib/actions.ts` + `get`/`set` хранилища). Первым шагом ставьте паузу ~4 с — настройки
  загружаются не сразу. Пример: `desktop/test/smoke.json` (его же гоняет CI на Windows и Linux).
  ```bash
  env -u ELECTRON_RUN_AS_NODE VA_SHOT=/tmp/shots VA_SCRIPT=desktop/test/smoke.json desktop/node_modules/.bin/electron desktop
  ```
  Строка `step error TypeError: ... reading 'slice'` в выводе безвредна — так печатается шаг без возвращаемого значения.
  Внимание: тестовый режим работает с настоящими настройками пользователя — если меняете их в сценарии, верните обратно.

## Выпуск и обновления

- `./release.sh 2.2.0 "Что нового"` — меняет версию в `desktop/package.json`, коммитит, ставит тег, пушит.
  Требует чистого дерева. GitHub Actions (`.github/workflows/build.yml`) собирает NSIS-установщик и AppImage,
  публикует релиз; текст «Что нового» берётся из описания тега.
- Установленные программы обновляются сами (`electron-updater`, `desktop/src/main/updater.ts`).
  Копия владельца на Linux работает из исходников и обновляется через `git pull`.
- Текущая версия — в `desktop/package.json` (`"version"`).

## Частые ловушки

- Хранилище интерфейса — на `useSyncExternalStore` (`renderer/src/lib/store.ts`): селектор `useApp(...)`
  обязан возвращать **ту же ссылку** при неизменном состоянии. Не возвращайте из селектора новый `[]`/`{}` —
  будет бесконечная перерисовка. Используйте константы (`const EMPTY = []`).
- Python `urllib` к `rest.runpod.io` получает Cloudflare 1010 — используйте `curl` или `fetch` из Node.
- Длинные Python-скрипты через heredoc в некоторых средах блокируются проверкой безопасности оболочки —
  кладите скрипт во временный файл и запускайте `python3 -I файл`.
- Модели и файлы на RunPod — см. раздел «Подводные камни» в [docs/RUNPOD.md](docs/RUNPOD.md).
