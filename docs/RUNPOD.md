# Свой RunPod и WaveSpeed: «Картинка Pro» и «Убрать текст с видео»

## Общая схема

- **RunPod Serverless.** Видеокарта включается только на время задачи. У всех эндпоинтов `workersMin = 0`,
  поэтому без задач платится только хранение сетевого диска.
- **Сетевой диск `mouse-king-pro-models`.** Датацентр EU-RO-1, 200 ГБ. Монтируется в воркеры как `/runpod-volume`.
  На нём лежат модели ComfyUI и обработчик VSR. Уменьшить диск RunPod нельзя, только завести новый и перенести.
- **Программа находит эндпоинты по имени** (`endpointByName` в `main/runpod.ts`, запрос к REST
  `https://rest.runpod.io/v1/endpoints`). Пользователь вводит ключ API и ID основного эндпоинта
  в Настройки → «RunPod / WaveSpeed».
- **Ключ API RunPod.** Программа хранит его зашифрованным (секрет `app:runpod`). Для скриптов
  на машине разработчика он лежит в `~/.runpod-key`.

### Эндпоинты (имена)

| Имя | Образ | Видеокарты | Для чего |
|---|---|---|---|
| `mouse-king-pro` | `runpod/worker-comfyui:5.10.0-base` (шаблон `mouse-king-pro-comfyui`) | 5090 → 4090 → L40S → 6000 Ada → PRO 6000 (по цене) | все модели «Картинки Pro» |
| `mouse-king-pro-hq` | тот же шаблон | 48 ГБ+ | «Макс. качество»: Qwen Edit 2511 в bf16 (41 ГБ) |
| `mouse-king-vsr` | `eritpchy/video-subtitle-remover:1.4.0-cuda12.8` (шаблон `mkp-vsr`) | 24–48 ГБ | «Убрать текст с видео», все алгоритмы (ветка `vsr`) |
| `mouse-king-vsr-hq` | тот же | 48 ГБ+ | не используется, на паузе (`workersMax 0`) — см. STATUS.md |

### Настройки, при которых не платим лишнего

Эти настройки подобраны по опыту, не меняйте их без причины:

- **`workersMin 0`.** Без задач видеокарты не работают.
- **`scalerType REQUEST_COUNT`, `scalerValue 1`.** Одна задача запускает один воркер. Раньше стоял `QUEUE_DELAY 1`,
  и во время холодного старта RunPod поднимал ещё два-три воркера, каждый из которых оплачивался.
- **`workersMax 3`.** Платятся только работающие воркеры. При `workersMax 1` единственный воркер часто
  получает статус «throttled» (на его машине нет свободной видеокарты), и задача ждёт в очереди десятки минут.
- **`idleTimeout 20`.** Простой после задачи — 20 с. Если повторить запрос за это время, модель не грузится заново.
- **`executionTimeoutMs`.** Для картинок 600 000 (зависшая задача не съест больше 10 минут),
  для VSR 3 600 000, потому что видео обрабатывается долго.
- **`flashboot`** включён.
- **Порядок видеокарт** — от дешёвых к дорогим.

Расходы видны в программе: Настройки → RunPod (`RunpodSpend.tsx`). Данные берутся из REST `billing/endpoints`
и `billing/networkvolumes`.

## «Картинка Pro» (режим `pro`)

Каталог моделей лежит в `desktop/src/shared/runpod.ts` (`PRO_MODELS`). Поля:
- `kind`: `edit` — правка по фото, `gen` — генерация по тексту, фото по желанию как основа для img2img;
- `maxRefs` — сколько фото-референсов принимает модель;
- `negative(fast)` — работает ли негативный промпт, интерфейс прямо пишет пользователю, учитывается ли он;
- `fast`, `lora`;
- `quality` — для модели доступно «Макс. качество»;
- `provider` — по умолчанию RunPod, `wavespeed` — модель через API WaveSpeed;
- `file` — файл модели на диске.

| id | Модель | Тип | Где |
|---|---|---|---|
| `ws-qwen3-pro-edit` | Qwen Image 3 Pro Edit | edit, до 3 фото | WaveSpeed |
| `ws-qwen3-pro` | Qwen Image 3 Pro | gen | WaveSpeed |
| `qwen-edit-2511` | Qwen Edit 2511 (основная) | edit, до 3 фото | RunPod |
| `qwen-rapid` | Qwen Rapid (Rapid AIO v23, полный чекпоинт) | edit | RunPod |
| `kontext-dev` | Flux Kontext dev | edit, до 2 фото | RunPod |
| `qwen-image-2512` | Qwen Image 2512 | gen | RunPod |
| `chroma-hd` | Chroma HD | gen | RunPod |
| `z-image-turbo` | Z-Image Turbo | gen | RunPod |
| `realvis-xl`, `juggernaut-xi` | SDXL-чекпоинты | gen | RunPod |

### Как идёт запрос (`main/runpod.ts` → `generate`)

1. `buildWorkflow(params, imageNames)` из `main/workflows.ts` собирает граф ComfyUI в формате API.
2. Фото уменьшаются до 1536 px и уходят в запрос как JPEG base64. Лимит запроса RunPod — 10 МБ.
3. Запрос `POST /run` на `https://api.runpod.ai/v2/<id>`, затем опрос `/status/<job>` раз в 2 с.
   Остановка — `/cancel/<job>`.
4. Ответ приходит в `output.images[].data` (base64 PNG). Если включено «Сохранять исходник», к результату
   применяется `keepSource` (`blend.ts`). Затем файлы сохраняются в `generated/` и попадают в галерею.
5. Ошибки ComfyUI вида `value_not_in_list` переводятся в понятный текст (`friendlyError`). Такая ошибка
   заодно перечисляет файлы, которые есть в папке на диске, этим удобно пользоваться для проверки.

### Особенности правки по фото (Qwen Edit 2511)

Qwen Edit слегка перерисовывает весь кадр: кожа становится глаже и розовее, свет примерно на 10% ярче,
кадр сдвигается и растягивается. Что с этим сделано:
- **Пропорции.** Фото масштабируется с сохранением пропорций: `keepAspect` использует `ImageScaleToTotalPixels`
  с `resolution_steps 16`. Узел `FluxKontextImageScale` для правки не подходит, он меняет пропорции.
- **«Сохранять исходник»** (`blend.ts`, `keepOriginal`):
  1. совмещение генерации с оригиналом (масштаб и сдвиг: грубый перебор, затем уточнение);
  2. подгонка цвета;
  3. маска изменившихся мест;
  4. композит в полном разрешении.
  Из генерации берётся только изменённое. Если изменилось больше 70% кадра, смешивание не применяется.
- **«Больше деталей»** (`hires`): правка в ~1.6 МП вместо 1 МП.
- **«Текстура»** (`detail`): второй проход Z-Image Turbo img2img при denoise 0.22, возвращает поры и фактуру ткани.
  LoRA qwen-edit-skin, сделанная для версии 2509, на 2511 почти не действует, от неё отказались.
- **«Макс. качество»** (`maxq`): bf16-файл на эндпоинте `mouse-king-pro-hq`. Прирост небольшой, первый запуск около 210 с.

### WaveSpeed (`main/wavespeed.ts`)

- Qwen Image 3.0 Pro — закрытая модель Alibaba, доступна только по API.
- Ключ хранится в секрете `app:wavespeed`, вводится в Настройки → «RunPod / WaveSpeed».
- API: `https://api.wavespeed.ai/api/v3`, авторизация Bearer.
  - Запуск: `POST /alibaba/qwen-image-3.0-pro/edit` или `/text-to-image`.
  - Результат: `GET /predictions/<id>/result`.
  - Фото сначала загружаются через `POST /media/uploads`, затем PUT по выданной ссылке. Хранятся 7 дней.
  - Баланс: `GET /balance`.
- Цена: около $0.04 за картинку 1K и $0.075 за 2K, плюс $0.003 за каждое входное фото.

## Диск: где что лежит

worker-comfyui 5.10.0 ищет модели в `/runpod-volume/models/{checkpoints,clip,clip_vision,configs,controlnet,embeddings,loras,upscale_models,vae,unet}`.

**Подводный камень:** ComfyUI-папки `diffusion_models` и `text_encoders` этот воркер **не видит**. Модели
диффузии кладите в `unet`, текстовые энкодеры — в `clip`. Откуда скачивать каждый файл, записано
в `MODEL_FILES` (`shared/runpod.ts`).

Обработчик VSR лежит в `/runpod-volume/vsr/` (`handler.py`, `start.sh`, `diag.py`, `pylib/` с пакетом `runpod`,
`jobs/<id>/` с временными файлами задач).

### Как положить файлы на диск

- **Временный CPU-под** (около $0.06/ч) с этим диском, которому в `dockerStartCmd` передаётся команда
  (скачать, переложить, записать). Под удаляется сразу после работы. Готовый пример — `worker/vsr/tools/deploy.sh`
  в ветке `vsr`.
  - Создание пода: `POST https://rest.runpod.io/v1/pods` с `computeType: "CPU"`, `networkVolumeId`, `dataCenterIds: ["EU-RO-1"]`.
  - Время работы пода: GraphQL `pod { runtime { uptimeInSeconds } }`.
  - Логи пода через API недоступны, HTTP-прокси CPU-пода отвечал 403.
- **S3 RunPod**: `https://s3api-eu-ro-1.runpod.io`, регион `eu-ro-1`, бакет — ID сетевого диска.
  Ключ создаётся в runpod.io → Settings → S3 API Keys. Access key выглядит как `user_…`, secret — как `rps_…`.
  Клиент без AWS SDK — `main/s3.ts` в ветке `vsr`.

## «Убрать текст с видео» (VSR) — ветка `vsr`, в работе

- **Инструмент:** [video-subtitle-remover](https://github.com/YaoFANGUK/video-subtitle-remover), лицензия Apache-2.0.
  Запуск из командной строки: `python backend/main.py -i IN -o OUT -c YMIN YMAX XMIN XMAX --inpaint-mode MODE`.
  Флаг `-c` можно повторять, координаты в пикселях. Режимы: `sttn-auto` (стирает всю рамку, без поиска текста),
  `sttn-det`, `lama`, `propainter`, `opencv`. Если рамок нет, VSR берёт весь кадр, а `sttn-auto` тогда стёр бы всё,
  поэтому обработчик переключает его на `sttn-det`.
- **Объём памяти ProPainter:** 720p при `MaxLoadNum` 80 занимает 25 ГБ, при 50 — 19 ГБ. Обработчик подбирает
  `MaxLoadNum` под размер кадра и память видеокарты и записывает его в `/vsr/config/config.json`.
- **В программе:**
  - модель `vsr-remove-text` добавлена в список «Видео» (`shared/vsr.ts`, `vsrModel()`);
  - параметры и редактор рамок — `components/VsrOptions.tsx`;
  - рамки хранятся в долях кадра `[x0, y0, x1, y1]` в состоянии `vsrAreas` и `vsrFor`;
  - отправка — ветка в `actions.send`, запуск — `runVsr` в `main/index.ts`, работа с RunPod — `main/vsr.ts`;
  - лимит — 10 минут видео.
- **Передача видео:**
  - если сохранён S3-ключ (секрет `app:runpod-s3`), видео загружается на диск в `vsr/jobs/<id>/in.<ext>`
    (файлы больше 32 МБ — по частям), задача получает `{job, file, mode, areas}`, результат `out.mp4`
    программа скачивает по S3 и удаляет с диска;
  - без ключа видео до 7 МБ передаётся прямо в запросе как `video_b64`, и результат возвращается так же.
- **Воркер** (`worker/vsr/`):
  - `start.sh` один раз ставит пакет `runpod` в `/runpod-volume/vsr/pylib` и запускает `handler.py`;
  - `handler.py` запускает CLI VSR отдельным процессом, по выводу tqdm шлёт прогресс через
    `runpod.serverless.progress_update`, а задачи старше суток удаляет;
  - если обработчик упал, `diag.py` на чистой стандартной библиотеке берёт задачу и возвращает лог запуска как ошибку.
- **Тест без программы:** `worker/vsr/tools/test.sh видео.mp4 sttn-auto '[[x0,y0,x1,y1]]'`.
- VSR 1.4.0 пишет MPEG-4 Part 2, его не играет Chromium — `handler.py` перекодирует результат в H.264 встроенным
  ffmpeg VSR (`/vsr/backend/ffmpeg/linux_x64/ffmpeg`, есть libx264), звук копируется.
- Пакет `runpod` нельзя ставить на сетевой диск при старте воркера — см. «Почему воркер раньше не работал» в STATUS.md.
- **REST `rest.runpod.io` бывает недоступен** — для поиска эндпоинтов/дисков и управления используйте GraphQL `https://api.runpod.io/graphql`.
