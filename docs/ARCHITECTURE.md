# Архитектура Mouse King Pro

Electron-приложение из трёх частей (стандартная схема electron-vite):

```
desktop/src/
├── main/       главный процесс (Node): окно, IPC, агент, генерация, файлы, секреты, RunPod, обновления
├── preload/    мост: `window.api` — только перечисленные вызовы, без доступа к Node из интерфейса
├── renderer/   интерфейс (React 19): компоненты, хранилище состояния, действия
└── shared/     типы и чистые функции, общие для main и renderer (без Electron и DOM)
```

Псевдонимы импорта: `@shared/...` → `desktop/src/shared/...`.

## Поток одного сообщения

1. Интерфейс: `renderer/src/lib/actions.ts` → `send(text, attachments, params, extra)` проверяет ввод
   по режиму, собирает `SendRequest` (`shared/types.ts`) и вызывает `api.run.send` (IPC `run:send`).
2. Главный процесс: `main/index.ts`, обработчик `run:send` → по `req.mode`:
   - `text` → `runAgent` → `AgentRun` (`main/agent.ts`): агентный цикл со стримингом, вызовы инструментов
     (`main/tools.ts`, нативные tool calls или текстовый протокол — настройка `tool_mode`), подтверждения
     опасных действий, учёт стоимости;
   - `image` / `video` → `runMedia` (Venice: `main/images.ts`, `generateMedia` в `agent.ts`);
     действия над готовой картинкой (`MediaOp`: увеличить, убрать фон, правка, объединение) → `runOp`;
   - `pro` → `runPro` → RunPod (`main/runpod.ts`) или WaveSpeed (`main/wavespeed.ts`), см. RUNPOD.md;
   - `video` + модель `vsr-remove-text` → `runVsr` (`main/vsr.ts`), «Убрать текст с видео» на своём RunPod.
3. Ход работы уходит в интерфейс событиями `run:event` (`RunEvent`: start, delta, message, status, output,
   approval, done). Сообщения сохраняются в JSON чата (`main/store.ts`).
4. Остановка — `run:stop` → функция `stop` из карты `active` (по id чата).

## Режимы (переключатель под полем ввода)

| Режим | `Mode` | Что делает | Где код |
|---|---|---|---|
| Чат | `text` | агент с инструментами | `agent.ts`, `tools.ts` |
| Картинка | `image` | генерация Venice; с прикреплёнными фото — правка (`edit`/`combine`) | `images.ts`, `venice.ts` |
| Видео | `video` | видео Venice: text→video, image→video, reference→video, video→video | `venice.ts`, `shared/video.ts` |
| Картинка Pro | `pro` | свои модели на RunPod (ComfyUI) и Qwen Image 3 Pro на WaveSpeed | `runpod.ts`, `workflows.ts`, `blend.ts`, `wavespeed.ts`, `shared/runpod.ts` |

Список моделей приходит из IPC `models`: Venice (`text`, `image`, `video`) + каталог «Картинки Pro» из
`shared/runpod.ts` (`PRO_MODELS`) в поле `pro`.

## Модули главного процесса (`desktop/src/main`)

| Файл | Назначение |
|---|---|
| `index.ts` | окно, все IPC-обработчики (`h('канал', ...)`), маршрутизация запусков, тестовый режим `VA_SHOT` |
| `agent.ts` | агентный цикл: стриминг, инструменты, стоимость, сжатие контекста |
| `tools.ts` | инструменты агента: файлы (`read_file`, `write_file`, `edit_file`, `list_dir`, `find_files`, `search_files`), `run_command`, фоновые задачи, архивы, веб (`web_search`, `fetch_url`, `download_file`), браузер (`browser_*`), Firefox пользователя (`firefox_*`), SSH (`ssh_run`, `ssh_upload`), картинки, `semantic_search`, `update_plan` |
| `venice.ts` | REST-клиент Venice: модели, баланс, веб-поиск, картинки, видео, цена видео |
| `images.ts` | операции с картинками: имена по описанию, метаданные PNG, галерея, стоимость |
| `gallery.ts` | реестр картинок/видео: источник, промпт, модель, родительская версия |
| `store.ts` | проекты и чаты в JSON (формат совместим с legacy-qt) |
| `config.ts` | настройки (`settings.json`), путь к данным `APP_DIR` |
| `secrets.ts` | секреты через `safeStorage` (ключи RunPod/WaveSpeed/S3, пароли серверов, токены) |
| `attachments.ts` | вложения: копия в папку проекта (`uploads/`), архивы, текст для модели |
| `browser.ts` | скрытое окно Chromium агента со своим профилем |
| `firefox.ts` | связь с Firefox пользователя через расширение (`desktop/firefox-extension`, подпись — `firefox-sign.sh`) |
| `git.ts` | ветка на чат, коммит после ответа, слияние/PR (настройка `git_auto`) |
| `jobs.ts` | фоновые долгие команды (деплой, сервер) |
| `terminal.ts` | встроенный терминал через утилиту `script` (без нативных модулей) |
| `mcp.ts` | подключения MCP |
| `memory.ts` | память между чатами (агент предлагает, пользователь сохраняет) |
| `semantic.ts` | поиск по смыслу (эмбеддинги Venice) |
| `scheduler.ts` | задачи по расписанию |
| `telegram.ts` | управление агентом из Telegram |
| `batch.ts` | пакетная обработка фото |
| `spend.ts` | учёт расходов по дням (лимиты) |
| `updater.ts` | автообновление из GitHub-релизов |
| `install.ts` | пункт в меню приложений Linux |
| `platform.ts` | различия Windows/Linux |
| `runpod.ts` | клиент RunPod Serverless, генерация «Картинки Pro», `keepSource`, `account()` — эндпоинты и диски через GraphQL |
| `workflows.ts` | графы ComfyUI (формат API) для каждой модели; без Electron — проверяется обычным Node |
| `blend.ts` | «Сохранять исходник»: совмещение генерации с исходным фото, перенос только изменённого |
| `wavespeed.ts` | Qwen Image 3 Pro / Pro Edit через WaveSpeedAI |
| `s3.ts`, `vsr.ts` | S3 RunPod с подписью SigV4; «Убрать текст с видео» |

## Интерфейс (`desktop/src/renderer/src`)

- `lib/store.ts` — глобальное состояние на `useSyncExternalStore`: `get()`, `set(patch)`, хук `useApp(selector)`.
  Селектор должен возвращать стабильную ссылку (см. ловушки в AGENTS.md).
- `lib/actions.ts` — все действия: загрузка данных, чаты, `send`, обработка `RunEvent`, `toast`, `saveSettings`.
- `lib/api.ts` — `window.api` из preload. Тип `Api` — в `shared/types.ts`; новые вызовы добавляются в три места:
  обработчик в `main/index.ts`, строка в `preload/index.ts`, тип в `Api`.
- Компоненты (`components/`): `Composer` (поле ввода, режимы, параметры), `Thread` (лента сообщений),
  `ModelPicker`, `MediaOptions` (параметры Venice), `ProOptions` (параметры «Картинки Pro»), `Gallery`,
  `ImageEditor`, `MaskEditor`, `Batch`, `Compare`, `SidePanel`/`Workbench` (терминал, файлы, предпросмотр),
  `Dialogs` + `SettingsMore` + `SettingsExtra` (настройки), `RunpodSpend`, `UpdateBanner`.

## Данные пользователя

| | Windows | Linux |
|---|---|---|
| Настройки, чаты, галерея (`APP_DIR`) | `%APPDATA%\Mouse King Pro` | `~/.local/share/venice-agent` |
| Папки проектов | `C:\Users\<имя>\MouseKingPro` | `~/VeniceAgent` или `~/MouseKingPro` |

Результаты генерации — в `<папка проекта>/generated`, вложения — в `<папка проекта>/uploads`.

## Сборка и CI

- `electron-vite build` → `desktop/out`; `electron-builder` → `desktop/dist` (AppImage, NSIS).
- `.github/workflows/build.yml`: на каждый push в `main` — типы, сборка, пакеты, запуск собранной программы
  со сценарием `desktop/test/smoke.json` и снимками (артефакты в Actions). На тег `v*` — то же + публикация релиза.
