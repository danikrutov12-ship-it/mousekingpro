// Главный процесс: окно, обмен с интерфейсом, запуск агента и генерации, разрешения.
import { randomBytes } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createTwoFilesPatch } from 'diff'
import { homedir, tmpdir, userInfo } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { imagePrice } from '@shared/pricing'
import { app, BrowserWindow, clipboard, ClipboardItem, dialog, ipcMain, nativeImage, nativeTheme, Notification, session, shell } from 'electron'
import type { ApprovalAnswer, Attachment, BatchOp, Chat, McpServer, MediaOp, Message, Mode, Model, Project, RunEvent, Schedule, SendRequest, Server, Settings } from '@shared/types'
import { AgentRun, generateMedia } from './agent'
import * as attachments from './attachments'
import { APP_DIR, loadSettings, saveSettings } from './config'
import * as browser from './browser'
import * as batch from './batch'
import * as gallery from './gallery'
import * as git from './git'
import * as images from './images'
import * as jobs from './jobs'
import * as mcp from './mcp'
import * as memory from './memory'
import * as scheduler from './scheduler'
import * as telegram from './telegram'
import * as terminal from './terminal'
import * as secrets from './secrets'
import * as spend from './spend'
import * as store from './store'
import { ICON, installDesktopEntry } from './install'
import { isWin, which } from './platform'
import * as updater from './updater'
import { isReferenceModel, MAX_REFERENCE_IMAGES } from '@shared/video'
import { isWavespeed, PRO_MODELS, proModel } from '@shared/runpod'
import * as runpod from './runpod'
import * as wavespeed from './wavespeed'
import { setServerSecrets, sshAuth } from './tools'
import { explain, Venice } from './venice'

let win: BrowserWindow | null = null

const venice = () => {
  const s = loadSettings()
  return new Venice(s.api_key, s.base_url)
}

function applyTheme(theme: Settings['theme']) {
  nativeTheme.themeSource = theme
}

function sendState() {
  if (!win || win.isDestroyed()) return
  win.webContents.send('win:state', {
    maximized: win.isMaximized(), focused: win.isFocused(), dark: nativeTheme.shouldUseDarkColors,
  })
}

function createWindow() {
  const settings = loadSettings()
  applyTheme(settings.theme)
  win = new BrowserWindow({
    width: 1380, height: 900, minWidth: 880, minHeight: 580,
    frame: false,
    show: false,
    title: 'Mouse King Pro',
    icon: ICON,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#181715' : '#f4f2ee',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
    },
  })
  win.once('ready-to-show', () => {
    if (!process.argv.includes('--hidden')) win?.show()
  })
  // в фоновом режиме закрытие окна только прячет его: расписание и Telegram продолжают работать
  win.on('close', (e) => {
    if (loadSettings().autostart && !quitting) {
      e.preventDefault()
      win?.hide()
    }
  })
  for (const ev of ['maximize', 'unmaximize', 'focus', 'blur', 'enter-full-screen', 'leave-full-screen'] as const) {
    win.on(ev as any, sendState)
  }
  nativeTheme.on('updated', sendState)
  win.webContents.on('did-finish-load', sendState)

  // ссылки из ответов открываем в браузере, само окно никуда не уходит
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    e.preventDefault()
    if (/^https?:/.test(url)) shell.openExternal(url)
  })

  if (process.env.VA_SHOT) shotMode(win, process.env.VA_SHOT)

  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

/**
 * Тестовый режим для проверки интерфейса: VA_SHOT=папка, VA_SCRIPT=файл со сценарием.
 * Сценарий — JSON-список шагов [js-код для интерфейса, пауза мс, имя снимка | null].
 */
function shotMode(w: BrowserWindow, dir: string) {
  mkdirSync(dir, { recursive: true })
  const steps: [string, number, string | null][] = process.env.VA_SCRIPT ? JSON.parse(readFileSync(process.env.VA_SCRIPT, 'utf-8')) : [['', 2500, 'main']]
  w.webContents.on('console-message', (e: any) => {
    if (e.level === 'error' || e.level === 3) console.log('renderer error:', String(e.message).slice(0, 400))
  })
  w.webContents.once('did-finish-load', async () => {
    for (const [js, wait, name] of steps) {
      try {
        if (js) console.log('step', JSON.stringify(await w.webContents.executeJavaScript(js, true)).slice(0, 300))
      } catch (e) {
        console.log('step error', String(e))
      }
      await new Promise((r) => setTimeout(r, wait))
      if (name) {
        writeFileSync(join(dir, name + '.png'), (await w.webContents.capturePage()).toPNG())
        console.log('shot', name)
      }
    }
    app.quit()
  })
}

// ================================================================ запуски

interface Active { stop(): void; projectId: string }
const active = new Map<string, Active>()
const approvals = new Map<string, { chatId: string; answer(a: ApprovalAnswer): void }>()
const autoApprove = new Set<string>() // чаты, где пользователь разрешил всё

const listeners = new Set<(e: RunEvent) => void>()
const unattended = new Map<string, 'auto' | 'deny'>() // чаты без человека у экрана (расписание)
const remote = new Set<string>()                        // чаты из Telegram: разрешения дублируем в телефон

function emit(e: RunEvent) {
  if (win && !win.isDestroyed()) win.webContents.send('run:event', e)
  listeners.forEach((l) => l(e))
  if ((e.type === 'done' || e.type === 'approval') && loadSettings().notifications && win && !win.isDestroyed() && !win.isFocused()) {
    const chat = findChat(e.chatId)
    const n = new Notification({
      title: e.type === 'approval' ? 'Агенту нужно разрешение' : 'Готово',
      body: e.type === 'approval' ? e.title : `${chat?.chat.title || 'Чат'}: задача выполнена`,
      icon: ICON,
    })
    n.on('click', () => {
      win?.show()
      win?.focus()
      if (chat) win?.webContents.send('nav', { projectId: chat.projectId, chatId: e.chatId })
    })
    n.show()
  }
}

function findChat(chatId: string): { projectId: string; chat: Chat } | null {
  for (const p of store.projects()) {
    const chat = store.loadChat(p.id, chatId)
    if (chat) return { projectId: p.id, chat }
  }
  return null
}

// ---------------------------------------------------------------- модели для запусков без интерфейса (Telegram, расписание, помощники)

let modelsCache: { at: number; list: Model[] } = { at: 0, list: [] }
async function textModels(): Promise<Model[]> {
  if (Date.now() - modelsCache.at < 10 * 60_000 && modelsCache.list.length) return modelsCache.list
  try {
    modelsCache = { at: Date.now(), list: await venice().listModels('text') }
  } catch {
    // оставляем старый список
  }
  return modelsCache.list
}
const modelById = (id: string) => modelsCache.list.find((m) => m.id === id)

/** Запуск задачи без интерфейса: новый или указанный чат, ждём окончания, возвращаем ответ. */
async function runHeadless(projectId: string, chatId: string | null, text: string, title?: string, newId?: string, atts: Attachment[] = []): Promise<{ chatId: string; text: string; media: string[] }> {
  const s = loadSettings()
  const list = await textModels()
  const model = list.find((m) => m.id === s.text_model) || list[0]
  if (!model) throw new Error('Не удалось загрузить модели Venice')
  const id = chatId || newId || store.newChat().id
  await send({
    projectId, chatId: id, isNew: !chatId, text, attachments: atts, mode: 'text', model,
    searchModel: model.web_search ? model.id : list.find((m) => m.web_search)?.id ?? null,
    memory: true,
  })
  const chat = store.loadChat(projectId, id)
  if (chat && title && !chatId) {
    chat.title = title
    store.saveChat(projectId, chat)
  }
  const msgs = chat?.messages || []
  const start = msgs.map((m) => m.role === 'user' && !m._hidden).lastIndexOf(true)
  const turn = msgs.slice(start + 1)
  const answer = turn.filter((m) => m.role === 'assistant' && !m._stopped && !m._limit && typeof m.content === 'string' && m.content)
    .map((m) => (m._error ? '⚠️ ' : '') + String(m.content)).join('\n\n')
  const media = turn.flatMap((m) => m._media || []).filter((p) => !/[\\/]browser[\\/]/.test(p))
  const spendStop = turn.some((m) => m._spend)
  return { chatId: id, text: (answer || '(без текстового ответа)') + (spendStop ? '\n\n⚠️ Остановлено лимитом расходов' : ''), media }
}

function titleFrom(text: string) {
  return (text || 'Вложения').split('\n')[0].slice(0, 60)
}

async function send(req: SendRequest) {
  if (active.has(req.chatId)) return
  const settings = loadSettings()
  const project = store.project(req.projectId)
  if (!project) throw new Error('Проект не найден')
  const chat: Chat = (!req.isNew && store.loadChat(project.id, req.chatId)) || { ...store.newChat(), id: req.chatId }
  const save = () => store.saveChat(project.id, chat)
  const push = (m: Message) => {
    chat.messages.push(m)
    save()
    if (m._cost) spend.add(m._cost)
    emit({ type: 'message', chatId: chat.id, message: m })
  }
  const status = (s: string) => emit({ type: 'status', chatId: chat.id, status: s })

  if (req.resume) {
    // продолжаем с места остановки: служебное сообщение, которого нет в ленте
    chat.messages.push({
      role: 'user', _hidden: true,
      content: 'Продолжи задачу с того места, где остановился. Не начинай заново и не повторяй уже сделанные шаги. ' +
        'Если какое-то действие оборвалось на середине — сначала проверь, в каком оно состоянии.',
    })
    save()
    emit({ type: 'start', chatId: chat.id, projectId: project.id, chat })
    return runAgent(req, settings, project, chat, push)
  }

  // правка или повтор: текущее продолжение сохраняем как вариант, начинаем новую ветку
  let fork: Pick<Message, '_alts' | '_alt'> = {}
  if (req.fork) {
    const i = req.fork.index
    const old = chat.messages[i]
    if (!old || old.role !== 'user') throw new Error('Сообщение не найдено')
    const tails = old._alts ? [...old._alts] : [null]
    tails[old._alt ?? 0] = stripTail(chat.messages.slice(i))
    tails.push(null)
    fork = { _alts: tails, _alt: tails.length - 1 }
    chat.messages = chat.messages.slice(0, i)
    if (req.fork.kind === 'regenerate') {
      const { _alts: _a, _alt: _b, ...base } = old
      chat.messages.push({ ...base, ...fork })
      save()
      emit({ type: 'start', chatId: chat.id, projectId: project.id, chat })
      if (req.mode === 'text') return runAgent(req, settings, project, chat, push)
      return runMedia(req, settings, project, chat, push, status)
    }
  }

  // сообщение пользователя
  const label = { text: 'Текст', image: 'Изображение', video: 'Видео', pro: 'Картинка Pro' }[req.mode as Mode]
  let user: Message
  if (req.mode === 'text') {
    const n = attachments.notes(req.attachments)
    // файлы без задачи: агент не должен сам решать, что с ними делать
    const noTask = !req.text.trim() && req.attachments.length
      ? '\n\n[Пользователь прислал файлы без задачи. Не вызывай инструменты и ничего не запускай: ' +
        'коротко опиши, что пришло (по сведениям выше), и спроси, что с этим сделать.]'
      : ''
    let content: Message['content'] = (req.text + (n ? '\n\n' + n : '') + noTask).trim()
    const images = req.attachments.filter((a) => a.kind === 'image')
    if (images.length && req.model.vision) {
      content = [{ type: 'text', text: content }, ...images.map((a) => ({ type: 'image_url' as const, image_url: { url: attachments.dataUrl(a.path) } }))]
    }
    user = { role: 'user', content, _display: req.text }
  } else {
    const shown = Object.entries(req.params || {}).filter(([k]) => !['model', 'prompt', 'image_url', 'video_url', 'reference_image_urls'].includes(k))
    user = {
      role: 'user', content: `[${label} · ${req.model.name}] ${req.text}`, _display: req.text,
      _mode: req.op ? opLabel(req.op) : `${label} · ${req.model.name}` + (shown.length ? ' · ' + shown.map(([k, v]) => `${k}=${v}`).join(', ') : ''),
      ...(req.op ? { _op: req.op } : { _gen: { mode: req.mode, model: req.model.id, params: req.params } }),
    }
  }
  Object.assign(user, fork)
  if (req.attachments.length) user._attachments = req.attachments.map((a) => a.name)
  if (!chat.messages.length) {
    chat.title = titleFrom(req.text || req.attachments.map((a) => a.name).join(', '))
    if (req.memory === false) chat.memory = false
  }
  chat.messages.push(user)
  save()
  emit({ type: 'start', chatId: chat.id, projectId: project.id, chat })

  if (req.mode === 'text') return runAgent(req, settings, project, chat, push)
  return runMedia(req, settings, project, chat, push, status)
}

/** Продолжение ветки для хранения: без вариантов на первом сообщении (они живут на «текущем» сообщении). */
function stripTail(tail: Message[]): Message[] {
  if (!tail.length) return tail
  const { _alts: _a, _alt: _b, ...first } = tail[0]
  return [first, ...tail.slice(1)]
}

function opLabel(op: MediaOp): string {
  if (op.kind === 'upscale') return `Увеличение ×${op.scale}`
  if (op.kind === 'background') return 'Удаление фона'
  if (op.kind === 'combine') return `Объединение ${op.paths.length} картинок · ${op.model}`
  return `Правка картинки · ${op.model}`
}

/** Можно ли тратить дальше: лимиты на чат и на день из настроек. */
function spendBlock(settings: Settings, chat: Chat, ignore?: boolean): 'chat' | 'day' | null {
  if (ignore) return null
  if (settings.limit_chat_usd > 0 && spend.chatTotal(chat) >= settings.limit_chat_usd) return 'chat'
  if (settings.limit_day_usd > 0 && spend.today() >= settings.limit_day_usd) return 'day'
  return null
}

async function runAgent(req: SendRequest, settings: Settings, project: Project, chat: Chat, push: (m: Message) => void) {
  const status = (s: string) => emit({ type: 'status', chatId: chat.id, status: s })
  {
    const run = new AgentRun(settings, project, chat.messages, req.model, {
      spendBlock: () => spendBlock(settings, chat, req.ignoreLimit),
      delta: (text) => emit({ type: 'delta', chatId: chat.id, text }),
      output: (callId, text) => emit({ type: 'output', chatId: chat.id, callId, text }),
      message: push,
      status,
      approve: (title, details, danger) => {
        // опасные действия спрашиваем всегда, даже если в чате разрешено всё
        if (autoApprove.has(chat.id) && !danger) return Promise.resolve(true)
        // задача по расписанию: без человека — разрешаем обычное (если так настроено), опасное — никогда
        const policy = unattended.get(chat.id)
        if (policy) return Promise.resolve(policy === 'auto' && !danger)
        const id = randomBytes(6).toString('hex')
        emit({ type: 'approval', chatId: chat.id, id, title, details, danger })
        if (remote.has(chat.id)) telegram.askApproval(id, title, details, danger)
        return new Promise<boolean>((resolve) => {
          approvals.set(id, {
            chatId: chat.id,
            answer: (answer) => {
              if (answer === 'always' && !danger) autoApprove.add(chat.id)
              resolve(answer !== 'no')
            },
          })
        })
      },
    }, req.searchModel, chat.id, {
      memory: settings.memory_enabled && chat.memory !== false,
      modelById,
    })
    textModels()
    // git: своя ветка на чат; после ответа — коммит файлов, которые менял агент
    const root = store.expand(project.folder)
    // коммитим, только если удалось перейти на ветку задачи — никогда не в текущую ветку пользователя
    const gitOn = settings.git_auto && git.isRepo(root) && !!git.ensureBranch(root, git.branchFor(chat.id, chat.title))
    const before = chat.messages.length
    active.set(chat.id, {
      projectId: project.id,
      stop: () => {
        run.stop()
        // отклоняем ожидающие разрешения этого запуска
        for (const [id, a] of approvals) {
          if (a.chatId !== chat.id) continue
          a.answer('no')
          approvals.delete(id)
        }
      },
    })
    try {
      await run.run()
    } finally {
      if (gitOn) {
        const changed = chat.messages.slice(before).filter((m) => m._change && !m._undone).map((m) => m._change!.path)
        const ask = [...chat.messages].reverse().find((m) => m.role === 'user' && !m._hidden)
        const subject = String(ask?._display ?? ask?.content ?? '').split('\n')[0].slice(0, 72) || chat.title
        if (changed.length) git.commit(root, [...new Set(changed)], `Venice: ${subject}`)
      }
      active.delete(chat.id)
      emit({ type: 'done', chatId: chat.id })
    }
  }
}

async function runMedia(req: SendRequest, settings: Settings, project: Project, chat: Chat, push: (m: Message) => void, status: (s: string) => void) {
  const root = store.expand(project.folder)
  const block = spendBlock(settings, chat, req.ignoreLimit)
  if (block) {
    push({ role: 'assistant', content: '', _spend: block })
    emit({ type: 'done', chatId: chat.id })
    return
  }
  if (req.op) return runOp(req.op, settings, chat, root, push, status)
  if (req.mode === 'pro') return runPro(req, settings, project, chat, push, status)
  // картинка или видео
  const params: Record<string, any> = { model: req.model.id, ...(req.params || {}) }
  if (req.text) params.prompt = req.text
  if (req.mode === 'image') params.safe_mode = !!settings.safe_mode
  else {
    const photos = [...req.attachments.filter((a) => a.kind === 'image').map((a) => a.path), ...(req.refPaths || [])]
    const vid = req.attachments.find((a) => a.kind === 'video')
    // reference-to-video берёт фото как образец внешности (поле reference_image_urls), остальные — как первый кадр
    if (isReferenceModel(req.model)) {
      if (photos.length) params.reference_image_urls = photos.slice(0, MAX_REFERENCE_IMAGES).map((p) => attachments.dataUrl(p))
    } else if (photos[0]) params.image_url = attachments.dataUrl(photos[0])
    if (vid) params.video_url = attachments.dataUrl(vid.path)
  }
  let stopped = false
  active.set(chat.id, { projectId: project.id, stop: () => (stopped = true) })
  try {
    let msg: Message
    if (req.mode === 'image') {
      // картинки — через общий модуль: имя по описанию, seed, метаданные, галерея
      status('Генерирую изображение…')
      try {
        const { model: _m, ...rest } = params
        const r = await images.generate(venice(), req.model, rest, { projectId: project.id, chatId: chat.id, safe: !!settings.safe_mode, dir: join(root, 'generated') })
        msg = { role: 'assistant', content: 'Готово — сохранено в ' + r.paths.map((p) => relative(root, p)).join(', ') +
          (r.fallback ? `\n\n_Модель ${r.fallback.from} отказала на стороне поставщика — сделано на ${r.fallback.to}._` : ''), _media: r.paths }
        if (r.cost != null) msg._cost = r.cost
      } catch (e) {
        msg = { role: 'assistant', content: (e as Error).message, _error: true }
      }
    } else {
      msg = await generateMedia(settings, 'video', req.model, params, join(root, 'generated'), root, status, () => stopped)
      // видео — в галерею; если делали по фото, оно становится «версией» этого фото
      const photo = req.attachments.find((a) => a.kind === 'image')?.path || req.refPaths?.[0]
      for (const p of msg._media || []) {
        gallery.add({ path: p, source: 'video', prompt: req.text, model: req.model.id, params: req.params, cost: msg._cost ?? undefined,
          parent: photo ? gallery.ensure(photo, project.id).id : undefined, projectId: project.id, chatId: chat.id })
      }
    }
    push(msg)
  } finally {
    active.delete(chat.id)
    emit({ type: 'done', chatId: chat.id })
  }
}

/** «Картинка Pro»: свой RunPod Serverless с ComfyUI. */
async function runPro(req: SendRequest, settings: Settings, project: Project, chat: Chat, push: (m: Message) => void, status: (s: string) => void) {
  const key = secrets.get('app:runpod')
  const endpoint = settings.runpod_endpoint
  let stopped = false
  active.set(chat.id, { projectId: project.id, stop: () => (stopped = true) })
  try {
    const p = { ...req.pro!, model: req.model.id, prompt: req.text }
    const m = proModel(p.model)
    const photos = req.attachments.filter((a) => a.kind === 'image').map((a) => a.path)
    const root = store.expand(project.folder)
    let r: runpod.ProResult
    if (isWavespeed(m)) {
      const wsKey = secrets.get('app:wavespeed')
      if (!wsKey) throw new Error('WaveSpeed не настроен: добавьте ключ в Настройки → RunPod / WaveSpeed')
      r = await wavespeed.generate(wsKey, p, photos, join(root, 'generated'), status, () => stopped)
    } else {
      if (!key || !endpoint) throw new Error('RunPod не настроен: добавьте ключ и ID эндпоинта в Настройки → RunPod / WaveSpeed')
      r = await runpod.generate({ key, endpoint }, p, photos, join(root, 'generated'), status, () => stopped)
    }
    const parent = photos[0] ? gallery.ensure(photos[0], project.id).id : undefined
    for (const path of r.paths) {
      gallery.add({ path, source: photos.length ? (m.kind === 'edit' ? 'edit' : 'local') : 'generate', prompt: req.text, model: `${m.name} (${isWavespeed(m) ? 'WaveSpeed' : 'RunPod'})`,
        params: { ...p, prompt: undefined }, seed: p.seed, parent, projectId: project.id, chatId: chat.id })
    }
    push({ role: 'assistant', _media: r.paths,
      content: `Готово на ${isWavespeed(m) ? 'WaveSpeed' : 'RunPod'} (${m.name}) за ${r.seconds} с${r.cold ? ', включая запуск видеокарты' : ''}${r.kept != null ? ` · из генерации взято ${Math.round(r.kept * 100)}% кадра, остальное — исходное фото` : ''} — сохранено в ` + r.paths.map((x) => relative(root, x)).join(', ') })
  } catch (e) {
    push({ role: 'assistant', content: (e as Error).message, _error: true })
  } finally {
    active.delete(chat.id)
    emit({ type: 'done', chatId: chat.id })
  }
}

const proModels = (): Model[] => PRO_MODELS.map((m) => ({
  id: m.id, type: 'pro', name: m.name, description: m.note, uncensored: true, tools: false, vision: false, reasoning: false, web_search: false,
  context: null, constraints: { family: m.family, kind: m.kind, maxRefs: m.maxRefs, fast: !!m.fast, lora: m.lora }, pricing: {},
}))

/** Действия с готовой картинкой: увеличить, убрать фон, изменить по описанию. */
async function runOp(op: MediaOp, settings: Settings, chat: Chat, root: string, push: (m: Message) => void, status: (s: string) => void) {
  const api = venice()
  active.set(chat.id, { projectId: '', stop: () => {} })
  const ctx = { projectId: findChat(chat.id)?.projectId, chatId: chat.id, safe: !!settings.safe_mode, dir: join(root, 'generated') }
  try {
    status({ upscale: 'Увеличиваю…', background: 'Убираю фон…', edit: 'Меняю картинку…', combine: 'Объединяю картинки…' }[op.kind])
    const r = op.kind === 'upscale' ? await images.upscale(api, op.path, op.scale, ctx)
      : op.kind === 'background' ? await images.background(api, op.path, ctx)
      : op.kind === 'edit' ? await images.edit(api, op.path, op.prompt, op.model, ctx)
      : await images.combine(api, op.paths, op.prompt, op.model, ctx)
    const note = r.fallback ? `\n\n_Модель ${r.fallback.from} отказала на стороне поставщика — сделано на ${r.fallback.to}._` : ''
    const msg: Message = { role: 'assistant', content: 'Готово — сохранено в ' + r.paths.map((p) => relative(root, p)).join(', ') + note, _media: r.paths }
    if (r.cost != null) msg._cost = r.cost
    push(msg)
  } catch (e) {
    push({ role: 'assistant', content: (e as Error).message, _error: true })
  } finally {
    active.delete(chat.id)
    emit({ type: 'done', chatId: chat.id })
  }
}

// ================================================================ IPC

function handlers() {
  const h = ipcMain.handle.bind(ipcMain)
  h('settings:get', () => loadSettings())
  h('settings:set', (_e, patch: Partial<Settings>) => {
    const s = saveSettings(patch)
    if (patch.theme) {
      applyTheme(s.theme)
      sendState()
    }
    if (patch.autostart !== undefined) syncAutostart(!!patch.autostart)
    return s
  })
  h('models', async () => {
    const out: any = { text: [], image: [], video: [], pro: proModels(), errors: ''  }
    const errors: string[] = []
    if (!loadSettings().api_key) return { ...out, errors: 'Нет API-ключа' }
    const api = venice()
    await Promise.all((['text', 'image', 'video'] as const).map(async (t) => {
      try {
        out[t] = await api.listModels(t)
      } catch (e) {
        errors.push(`${t}: ${(e as Error).message}`)
      }
    }))
    out.errors = errors.join('; ')
    return out
  })
  h('balance', () => (loadSettings().api_key ? venice().balance().catch(() => null) : null))
  h('video:quote', (_e, params) => venice().videoQuote(params).catch(() => null))

  h('projects:list', () => store.userProjects())
  h('projects:default', () => store.defaultProject())
  h('projects:get', (_e, id: string) => store.project(id))
  h('projects:create', (_e, d: { name: string; description: string; folder?: string }) => store.createProject(d.name, d.description, d.folder))
  h('projects:save', (_e, p) => store.saveProject(p))
  h('projects:remove', (_e, id: string) => store.deleteProject(id))
  h('projects:knowledge', (_e, id: string) => {
    const p = store.project(id)
    return p ? store.knowledgeFiles(p) : []
  })
  h('projects:addFiles', async (_e, id: string, paths?: string[]) => {
    const p = store.project(id)
    if (!p) return []
    if (!paths) {
      const r = await dialog.showOpenDialog(win!, { title: 'Добавить файлы в проект', properties: ['openFile', 'multiSelections'] })
      paths = r.canceled ? [] : r.filePaths
    }
    store.addKnowledge(p, paths)
    return store.knowledgeFiles(p)
  })
  h('projects:removeFile', (_e, id: string, path: string) => {
    const p = store.project(id)
    if (!p) return []
    store.removeKnowledge(p, path)
    return store.knowledgeFiles(p)
  })
  h('projects:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win!, { title: 'Папка проекта', properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })

  h('chats:recent', () => store.allChats())
  h('chats:list', (_e, pid: string) => store.chats(pid))
  h('chats:load', (_e, pid: string, cid: string) => store.loadChat(pid, cid))
  h('chats:create', () => store.newChat())
  h('chats:rename', (_e, pid: string, cid: string, title: string) => {
    const c = store.loadChat(pid, cid)
    if (c) {
      c.title = title
      store.saveChat(pid, c)
    }
  })
  h('chats:remove', (_e, pid: string, cid: string) => {
    active.get(cid)?.stop()
    store.deleteChat(pid, cid)
    rmSync(join(APP_DIR, 'backups', cid), { recursive: true, force: true })
  })
  h('chats:undo', (_e, pid: string, cid: string, callIds: string[]) => {
    // откатываем изменения файлов в обратном порядке: от последнего к первому
    const chat = store.loadChat(pid, cid)
    if (!chat) return null
    const ids = new Set(callIds)
    for (const m of [...chat.messages].reverse()) {
      if (m.role !== 'tool' || !m._change || m._undone || !ids.has(m.tool_call_id || '')) continue
      const { path, backup } = m._change
      if (backup) {
        mkdirSync(dirname(path), { recursive: true })
        copyFileSync(backup, path)
      } else rmSync(path, { force: true })
      m._undone = true
    }
    store.saveChat(pid, chat)
    return chat
  })

  h('chats:switchAlt', (_e, pid: string, cid: string, index: number, alt: number) => {
    // переключение между вариантами: текущее продолжение прячем, выбранное возвращаем в ленту
    if (active.has(cid)) return null
    const chat = store.loadChat(pid, cid)
    const cur = chat?.messages[index]
    if (!chat || !cur?._alts || alt === (cur._alt ?? 0) || !cur._alts[alt]) return chat
    const tails = [...cur._alts]
    tails[cur._alt ?? 0] = stripTail(chat.messages.slice(index))
    const next = tails[alt]!
    tails[alt] = null
    chat.messages = [...chat.messages.slice(0, index), { ...next[0], _alts: tails, _alt: alt }, ...next.slice(1)]
    store.saveChat(pid, chat)
    return chat
  })
  h('chats:search', (_e, q: string) => store.search(q))
  h('chats:changes', (_e, pid: string, cid: string) => {
    // все файлы, которые агент менял в этом чате: самая ранняя копия = «как было до агента»
    const chat = store.loadChat(pid, cid)
    const map = new Map<string, { path: string; backup: string | null; callIds: string[]; undone: boolean }>()
    for (const m of chat?.messages || []) {
      if (m.role !== 'tool' || !m._change) continue
      const e = map.get(m._change.path)
      if (!e) map.set(m._change.path, { path: m._change.path, backup: m._change.backup, callIds: m._undone ? [] : [m.tool_call_id!], undone: !!m._undone })
      else if (!m._undone) {
        e.callIds.push(m.tool_call_id!)
        e.undone = false
      }
    }
    return [...map.values()]
  })
  h('chats:diff', (_e, path: string, backup: string | null) => {
    const read = (p: string | null) => {
      try {
        return p && existsSync(p) ? readFileSync(p, 'utf-8') : ''
      } catch {
        return ''
      }
    }
    return createTwoFilesPatch(path, path, read(backup), read(path), 'было', 'стало', { context: 3 })
  })

  h('secrets:list', () => secrets.list())
  h('secrets:set', (_e, name: string, value: string) => secrets.set(name, value))
  h('secrets:remove', (_e, name: string) => secrets.remove(name))
  h('secrets:available', () => secrets.available())
  h('servers:test', async (_e, server: Server) => {
    try {
      const { opts, env } = sshAuth(server, secrets.get(`server:${server.id}`))
      const r = spawnSync('ssh', [...opts, '-p', String(server.port || 22), `${server.user}@${server.host}`, 'echo ok && uname -a'],
        { encoding: 'utf-8', timeout: 20_000, env: { ...process.env, ...env } })
      if (r.status === 0) return 'ok: ' + r.stdout.trim().split('\n').pop()
      return secrets.mask((r.stderr || r.stdout || String(r.error || 'нет ответа')).trim().slice(-500))
    } catch (e) {
      return (e as Error).message
    }
  })

  h('files:read', (_e, p: string) => {
    try {
      return statSync(p).size > 5_000_000 ? null : readFileSync(p, 'utf-8')
    } catch {
      return null
    }
  })
  h('files:mtime', (_e, p: string) => {
    try {
      return statSync(p).mtimeMs
    } catch {
      return 0
    }
  })
  h('files:artifact', (_e, html: string) => {
    // HTML из ответа — во временный файл: в окне предпросмотра он работает изолированно от приложения
    const dir = join(APP_DIR, 'artifacts')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, createHash('sha1').update(html).digest('hex').slice(0, 16) + '.html')
    writeFileSync(file, html, 'utf-8')
    return file
  })

  h('voice:speak', async (_e, text: string) => {
    const s = loadSettings()
    const dir = join(APP_DIR, 'tts')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, createHash('sha1').update(`${s.tts_model}|${s.tts_voice}|${text}`).digest('hex').slice(0, 16) + '.mp3')
    if (!existsSync(file)) writeFileSync(file, await venice().speech(s.tts_model, s.tts_voice, text))
    return file
  })
  h('voice:transcribe', (_e, bytes: Uint8Array, mime: string) => venice().transcribe(loadSettings().stt_model, bytes, mime))
  h('voice:voices', async (_e, model: string) => {
    const m = (await venice().rawModels('tts').catch(() => [])).find((x: any) => x.id === model)
    return (m?.model_spec?.voices as string[]) || []
  })
  h('voice:models', async () => {
    const api = venice()
    const [tts, stt, edit] = await Promise.all(['tts', 'asr', 'inpaint'].map((t) => api.rawModels(t).catch(() => [])))
    const pick = (l: any[]) => l.map((m) => ({ id: m.id, name: m.model_spec?.name || m.id }))
    return {
      tts: pick(tts), stt: pick(stt),
      edit: edit.map((m: any) => {
        const c = m.model_spec?.constraints || {}
        return { id: m.id, name: m.model_spec?.name || m.id, price: m.model_spec?.pricing?.inpaint?.usd ?? null,
          max: c.maxInputImages ?? (c.combineImages ? 3 : 1), uncensored: !!m.model_spec?.uncensored }
      }),
    }
  })
  h('spend', () => ({ today: spend.today(), limitDay: loadSettings().limit_day_usd }))
  h('install', () => installDesktopEntry())
  // исходные пиксели файла (PNG/JPEG) — без пересжатия
  const copyPng = (png: Buffer) => clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })])
  h('clipboard:image', async (_e, path: string) => {
    // PNG — байты файла как есть; JPEG — те же пиксели, переупакованные в PNG (без потерь)
    if (/\.png$/i.test(path)) return copyPng(readFileSync(path)).then(() => true)
    const img = nativeImage.createFromPath(path)
    if (img.isEmpty()) return false
    await copyPng(img.toPNG())
    return true
  })
  h('clipboard:imageData', (_e, png: Uint8Array) => copyPng(Buffer.from(png)))
  h('update:state', () => updater.getState())
  h('update:check', () => updater.check(true))
  h('update:download', () => updater.download())
  h('update:install', () => updater.install())

  h('jobs:list', () => jobs.listJobs())
  h('jobs:log', (_e, id: string, lines?: number) => jobs.jobLog(id, lines ?? 200))
  h('jobs:stop', (_e, id: string) => {
    jobs.stopJob(id)
  })
  h('jobs:clear', () => jobs.clearFinished())

  const prepareAll = async (pid: string, paths: string[]) => {
    const p = store.project(pid)
    const items = []
    const errors: string[] = []
    for (const path of paths) {
      try {
        items.push(await attachments.prepare(path, store.expand(p!.folder)))
      } catch (e) {
        errors.push(`${path.split('/').pop()}: ${(e as Error).message}`)
      }
    }
    return { items, errors }
  }
  h('attach:pick', async (_e, pid: string) => {
    const r = await dialog.showOpenDialog(win!, { title: 'Прикрепить файлы', properties: ['openFile', 'multiSelections'] })
    if (r.canceled) return []
    return (await prepareAll(pid, r.filePaths)).items
  })
  h('attach:paths', (_e, pid: string, paths: string[]) => prepareAll(pid, paths))
  h('attach:data', async (_e, pid: string, name: string, bytes: Uint8Array) => {
    // файл из буфера обмена: сначала во временную папку, дальше как обычное вложение
    const dir = mkdtempSync(join(tmpdir(), 'venice-paste-'))
    const path = join(dir, basename(name) || 'paste.png')
    writeFileSync(path, Buffer.from(bytes))
    try {
      return await prepareAll(pid, [path])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  h('run:send', (_e, req: SendRequest) => {
    send(req).catch((err) => {
      emit({ type: 'message', chatId: req.chatId, message: { role: 'assistant', content: String(err?.message || err), _error: true } })
      emit({ type: 'done', chatId: req.chatId })
    })
  })
  h('run:stop', (_e, chatId: string) => active.get(chatId)?.stop())
  h('run:active', () => [...active.keys()])
  h('run:approve', (_e, id: string, answer: ApprovalAnswer) => answerApproval(id, answer))

  h('memory:list', () => memory.list())
  h('memory:add', (_e, text: string, pid?: string) => {
    memory.add(text, pid)
  })
  h('memory:update', (_e, id: string, text: string) => memory.update(id, text))
  h('memory:remove', (_e, id: string) => memory.remove(id))

  h('mcp:status', () => mcp.status(loadSettings().mcp_servers || []))
  h('mcp:test', (_e, s: McpServer) => mcp.test(s))

  const gitCtx = (pid: string, cid: string) => {
    const p = store.project(pid)
    const c = store.loadChat(pid, cid)
    return p && c ? { root: store.expand(p.folder), branch: git.branchFor(c.id, c.title) } : null
  }
  h('git:info', (_e, pid: string, cid: string) => {
    const g = gitCtx(pid, cid)
    return g ? git.info(g.root, g.branch) : { repo: false }
  })
  h('git:init', (_e, pid: string) => {
    const p = store.project(pid)
    return p ? git.init(store.expand(p.folder)) : false
  })
  h('git:merge', (_e, pid: string, cid: string) => {
    const g = gitCtx(pid, cid)
    return g ? git.merge(g.root, g.branch) : 'Чат не найден'
  })
  h('git:push', (_e, pid: string, cid: string) => {
    const g = gitCtx(pid, cid)
    return g ? git.push(g.root, g.branch) : { ok: false, text: 'Чат не найден' }
  })

  h('telegram:status', async () => {
    const st = telegram.status()
    let bot: string | undefined
    if (secrets.get('app:telegram')) bot = await telegram.botName().catch(() => undefined)
    return { ...st, bot, code: pairCode }
  })
  h('telegram:setToken', async (_e, token: string) => {
    const name = await telegram.check(token)
    secrets.set('app:telegram', token.trim())
    saveSettings({ telegram: { ...loadSettings().telegram, enabled: true } })
    startTelegram()
    return name
  })
  h('runpod:status', async () => {
    const key = secrets.get('app:runpod')
    const endpoint = loadSettings().runpod_endpoint
    if (!key) return { key: false, endpoint, balance: null, health: null }
    const [bal, hl] = await Promise.all([
      runpod.balance(key).catch(() => null),
      endpoint ? runpod.health({ key, endpoint }).then((h) => ({ ok: h })).catch((e) => ({ err: (e as Error).message })) : Promise.resolve({ ok: null }),
    ])
    return { key: true, endpoint, balance: bal, health: 'ok' in hl ? hl.ok : null, error: 'err' in hl ? hl.err : undefined }
  })
  h('runpod:setKey', async (_e, key: string) => {
    if ((await runpod.balance(key.trim())) === null) throw new Error('Ключ RunPod не подошёл')
    secrets.set('app:runpod', key.trim())
  })
  h('runpod:removeKey', () => secrets.remove('app:runpod'))
  h('runpod:spend', async () => {
    const key = secrets.get('app:runpod')
    if (!key) return null
    const r = await runpod.spend(key)
    // картинок на своём RunPod с начала месяца — для средней цены одной
    const now = new Date()
    const from = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000
    const images = gallery.list().filter((i) => i.created >= from && i.model?.endsWith('(RunPod)')).length
    return { ...r, images }
  })
  h('wavespeed:status', async () => {
    const key = secrets.get('app:wavespeed')
    return { key: !!key, balance: key ? await wavespeed.balance(key) : null }
  })
  h('wavespeed:setKey', async (_e, key: string) => {
    if ((await wavespeed.balance(key.trim())) === null) throw new Error('Ключ WaveSpeed не подошёл')
    secrets.set('app:wavespeed', key.trim())
  })
  h('wavespeed:removeKey', () => secrets.remove('app:wavespeed'))

  h('telegram:unlink', () => {
    telegram.stop()
    secrets.remove('app:telegram')
    saveSettings({ telegram: { enabled: false } })
  })

  h('schedules:run', (_e, id: string) => {
    const s = loadSettings().schedules.find((x) => x.id === id)
    if (s) runSchedule(s)
  })

  h('term:create', (_e, cwd: string, cols: number, rows: number) => terminal.create(store.expand(cwd), cols, rows,
    (id, d) => win?.webContents.send('term:data', id, d), (id) => win?.webContents.send('term:exit', id)))
  ipcMain.on('term:write', (_e, id: string, d: string) => terminal.write(id, d))
  ipcMain.on('term:resize', (_e, id: string, c: number, r: number) => terminal.resize(id, c, r))
  ipcMain.on('term:kill', (_e, id: string) => terminal.kill(id))

  h('fs:tree', (_e, dir: string) => {
    const d = store.expand(dir)
    try {
      return readdirSync(d).filter((n) => !['node_modules', '.git', '__pycache__', '.venv'].includes(n))
        .map((n) => ({ name: n, path: join(d, n), dir: statSync(join(d, n)).isDirectory() }))
        .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
    } catch {
      return []
    }
  })
  h('fs:write', (_e, p: string, text: string) => writeFileSync(p, text, 'utf-8'))

  h('compare', async (_e, text: string, ids: string[]) => {
    const list = await textModels()
    const s = loadSettings()
    return Promise.all(ids.map(async (id) => {
      const m = list.find((x) => x.id === id)
      try {
        const r = await fetch(s.base_url.replace(/\/+$/, '') + '/chat/completions', {
          method: 'POST', headers: { Authorization: `Bearer ${s.api_key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: id, messages: [{ role: 'user', content: text }], venice_parameters: { include_venice_system_prompt: false, strip_thinking_response: true } }),
          signal: AbortSignal.timeout(180_000),
        })
        const data = await r.json()
        if (!r.ok) throw new Error(explain(r.status, data.error ?? data))
        if (data.cost?.usd) spend.add(Number(data.cost.usd))
        return { model: id, name: m?.name || id, text: data.choices?.[0]?.message?.content || '', cost: data.cost?.usd ?? null }
      } catch (e) {
        return { model: id, name: m?.name || id, text: (e as Error).message, cost: null, error: true }
      }
    }))
  })
  // ---------------------------------------------------------------- галерея и фото
  const visionModel = async () => {
    const s = loadSettings()
    const list = await textModels()
    const cur = list.find((m) => m.id === s.text_model)
    return s.vision_model || (cur?.vision ? cur.id : list.filter((m) => m.vision).sort((a, b) => (a.pricing?.input?.usd ?? 9) - (b.pricing?.input?.usd ?? 9))[0]?.id) || s.text_model
  }
  const galleryDir = (pid?: string) => join(store.expand((pid && store.project(pid)) ? store.project(pid)!.folder : store.defaultProject().folder), 'generated')

  h('gallery:list', () => gallery.list())
  h('gallery:update', (_e, id: string, patch) => gallery.update(id, patch))
  h('gallery:remove', (_e, ids: string[], deleteFiles: boolean) => {
    if (deleteFiles) for (const id of ids) {
      const it = gallery.byId(id)
      if (it) rmSync(it.path, { force: true })
    }
    gallery.remove(ids)
  })
  h('gallery:op', async (_e, op: MediaOp | { kind: 'variations'; id: string }, pid?: string) => {
    const api = venice()
    const ctx = { projectId: pid, safe: !!loadSettings().safe_mode, dir: galleryDir(pid) }
    let r: images.ImgResult
    if (op.kind === 'variations') {
      // «ещё похожие»: тот же промпт и модель, 4 варианта с новым seed
      const it = gallery.byId(op.id)
      if (!it?.model || !it.prompt) throw new Error('У этой картинки нет промпта — похожие можно сделать только для сгенерированных')
      const all = await venice().listModels('image')
      const model = all.find((m) => m.id === it.model)
      if (!model) throw new Error('Модель этой картинки больше недоступна')
      r = await images.generate(api, model, { ...(it.params || {}), prompt: it.prompt, variants: 4, seed: undefined }, ctx)
      r.items.forEach((x) => gallery.update(x.id, { parent: it.id }))
    } else if (op.kind === 'upscale') r = await images.upscale(api, op.path, op.scale, ctx)
    else if (op.kind === 'background') r = await images.background(api, op.path, ctx)
    else if (op.kind === 'edit') r = await images.edit(api, op.path, op.prompt, op.model, ctx)
    else r = await images.combine(api, op.paths, op.prompt, op.model, ctx)
    if (r.cost) spend.add(r.cost)
    return { paths: r.paths, cost: r.cost }
  })
  h('gallery:describe', async (_e, path: string, task: string) => {
    const r = await images.describe(venice(), path, task, await visionModel())
    if (r.cost) spend.add(r.cost)
    return r.text
  })
  h('gallery:enhance', async (_e, prompt: string) => {
    const s = loadSettings()
    // основная модель пользователя (обычно без цензуры): быстрая модель с цензурой может отказать на откровенные описания
    const r = await venice().ask(s.text_model || s.fast_model,
      'Ты помогаешь писать промпты для генерации изображений. Перепиши описание пользователя в подробный промпт на русском: ' +
      'объект и действие, окружение и фон, стиль, свет, ракурс и объектив, цветовая гамма, детали и настроение. Сохрани замысел, ' +
      'ничего не добавляй против него. Одним абзацем до 80 слов, без пояснений и кавычек.', prompt)
    if (r.cost) spend.add(r.cost)
    const text = r.text.replace(/^["«]|["»]$/g, '').trim()
    // отказ модели не должен подменять описание пользователя
    if (!text || (text.length < 160 && /не могу|не буду|I can.?t|I cannot|I won.?t|sorry/i.test(text))) {
      throw new Error('Модель отказалась переписывать это описание. Выберите другую основную модель (например, без цензуры) или допишите детали сами.')
    }
    return text
  })
  h('gallery:saveImage', (_e, parentPath: string, bytes: Uint8Array, ext: string) => {
    // результат локального редактора — новой версией рядом с исходной
    const parent = gallery.ensure(parentPath)
    const out = store.freePath(dirname(parentPath), basename(parentPath).replace(/\.[^.]+$/, '').replace(/-red(_\d+)?$/, '') + '-red.' + ext)
    writeFileSync(out, Buffer.from(bytes))
    gallery.add({ path: out, prompt: parent.prompt, source: 'local', parent: parent.id, projectId: parent.projectId, chatId: parent.chatId })
    return out
  })
  h('gallery:saveAs', async (_e, path: string) => {
    const r = await dialog.showSaveDialog(win!, { title: 'Сохранить картинку', defaultPath: join(homedir(), 'Pictures', basename(path)) })
    if (r.canceled || !r.filePath) return null
    copyFileSync(path, r.filePath)
    return r.filePath
  })
  h('gallery:openWith', (_e, path: string) => {
    for (const app of ['gimp', 'krita', 'pinta']) {
      if (which(app)) {
        spawn(app, [path], { detached: !isWin, windowsHide: true, stdio: 'ignore' }).unref()
        return app
      }
    }
    shell.openPath(path)
    return ''
  })
  h('gallery:ensure', (_e, path: string) => gallery.ensure(path))
  h('gallery:saveMask', (_e, bytes: Uint8Array) => {
    const dir = join(APP_DIR, 'masks')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `mask-${Date.now()}.png`)
    writeFileSync(file, Buffer.from(bytes))
    return file
  })
  h('gallery:pickImages', async () => {
    const r = await dialog.showOpenDialog(win!, { title: 'Выберите фото', properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Изображения', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }] })
    return r.canceled ? [] : r.filePaths
  })
  h('batch:start', async (_e, paths: string[], op: BatchOp, pid?: string) => batch.start(venice(), paths, op, galleryDir(pid),
    { projectId: pid, safe: !!loadSettings().safe_mode, vision: await visionModel() },
    (st) => win?.webContents.send('batch:progress', st), (usd) => spend.add(usd)))
  ipcMain.on('batch:cancel', (_e, id: string) => batch.cancel(id))

  ipcMain.on('app:quit', () => {
    quitting = true
    app.quit()
  })

  h('shell:open', (_e, p: string) => shell.openPath(store.expand(p)))
  h('shell:reveal', (_e, p: string) => shell.showItemInFolder(store.expand(p)))
  h('shell:external', (_e, url: string) => (/^https?:/.test(url) ? shell.openExternal(url) : undefined))

  ipcMain.on('win:minimize', () => win?.minimize())
  ipcMain.on('win:toggleMaximize', () => (win?.isMaximized() ? win.unmaximize() : win?.maximize()))
  ipcMain.on('win:close', () => win?.close())
  ipcMain.on('env', (e) => {
    e.returnValue = { platform: process.platform, userName: userInfo().username, version: app.getVersion() }
  })
}

// ---------------------------------------------------------------- Telegram, расписание, фон

const pairCode = String(Math.floor(100000 + Math.random() * 900000))

function answerApproval(id: string, answer: ApprovalAnswer) {
  const a = approvals.get(id)
  if (!a) return
  a.answer(answer)
  approvals.delete(id)
  emit({ type: 'approval_done', chatId: a.chatId, id })
}

// ---------------------------------------------------------------- Telegram: чат и работа с фото

const KEEP_REST = '\n\nИзмени только то, о чём просят. Всё остальное — лицо и черты людей, позу, фон, композицию, свет, цвета, ' +
  'текстуры и детали — оставь точно как на исходном фото.'
let tgPendingEdit: string | null = null // id картинки из галереи, которую ждём описание правки

async function imageModels(): Promise<Model[]> {
  return venice().listModels('image').catch(() => [])
}

/** Параметры генерации по умолчанию для модели (как в приложении). */
function genParams(model: Model, prompt: string): Record<string, any> {
  const c = model.constraints || {}
  const p: Record<string, any> = { prompt, variants: 1 }
  if (c.aspectRatios?.length) p.aspect_ratio = c.defaultAspectRatio || c.aspectRatios[0]
  if (c.resolutions?.length) p.resolution = c.defaultResolution || c.resolutions[0]
  if (c.qualities?.length) p.quality = c.defaultQuality || c.qualities[0]
  return p
}

const imgButtons = (id: string): telegram.Buttons => [
  [{ text: '🔍 ×2 · $0.02', data: `im:x2:${id}` }, { text: '✂️ Убрать фон', data: `im:bg:${id}` }],
  [{ text: '🔁 Ещё вариант', data: `im:var:${id}` }, { text: '✏️ Изменить…', data: `im:ed:${id}` }],
  [{ text: '📎 Файлом без сжатия', data: `im:doc:${id}` }],
]

/** Картинки результата — в Telegram с подписью и кнопками действий. */
async function tgSendImages(paths: string[], caption: string) {
  for (const p of paths) {
    const it = gallery.byPath(p)
    await telegram.sendFile(p, { caption, buttons: it ? imgButtons(it.id) : undefined })
  }
}

function tgSpendBlocked(): string | null {
  const s = loadSettings()
  if (s.limit_day_usd > 0 && spend.today() >= s.limit_day_usd) return `⚠️ Достигнут дневной лимит расходов (${s.limit_day_usd}$). Измените его в настройках приложения.`
  return null
}

/** Чат «📱 Telegram: картинки» в приложении: всё, что делалось с картинками в боте, — с запросами, результатами и ошибками. */
function tgLog(userText: string, label: string, result: Message, inputs: string[] = []) {
  const def = store.defaultProject()
  const tg = loadSettings().telegram
  let chat = tg.imagesChat ? store.loadChat(def.id, tg.imagesChat) : null
  if (!chat) {
    chat = { ...store.newChat(), title: '📱 Telegram: картинки' }
    saveSettings({ telegram: { ...loadSettings().telegram, imagesChat: chat.id } })
  }
  chat.messages.push({ role: 'user', content: userText || label, _display: userText || label, _mode: label,
    ...(inputs.length ? { _attachments: inputs.map((p) => basename(p)) } : {}) }, result)
  store.saveChat(def.id, chat)
  emit({ type: 'done', chatId: chat.id })
}

/** Действие с картинкой из Telegram: общий модуль images — всё попадёт в галерею и в чат «Telegram: картинки». */
async function tgImageOp(fn: (api: Venice, ctx: images.ImgCtx) => Promise<images.ImgResult>, label: string, reply: (t: string) => Promise<void>,
  log: { text?: string; inputs?: string[] } = {}) {
  const blocked = tgSpendBlocked()
  if (blocked) return reply(blocked)
  await reply(`⏳ ${label}…`)
  const def = store.defaultProject()
  try {
    const r = await fn(venice(), { projectId: def.id, safe: !!loadSettings().safe_mode, dir: join(store.expand(def.folder), 'generated') })
    if (r.cost) spend.add(r.cost)
    const first = r.items[0]
    const note = r.fallback ? `⚠️ ${r.fallback.from} отказала — сделано на ${r.fallback.to}` : ''
    await tgSendImages(r.paths, [first?.prompt?.slice(0, 300), first?.model, r.cost != null ? `$${r.cost.toFixed(3)}` : '', note].filter(Boolean).join(' · '))
    tgLog(log.text || '', label, { role: 'assistant', content: 'Готово' + (note ? ` (${note})` : ''), _media: r.paths, ...(r.cost != null ? { _cost: r.cost } : {}) }, log.inputs)
    win?.webContents.send('settings:changed', loadSettings())
  } catch (e) {
    const text = (e as Error).message
    await reply('⚠️ ' + text)
    tgLog(log.text || '', label, { role: 'assistant', content: text, _error: true }, log.inputs)
  }
}

const tgEditModel = () => loadSettings().edit_model || 'qwen-edit-uncensored'

async function tgGenerate(prompt: string, reply: (t: string) => Promise<void>) {
  const s = loadSettings()
  const list = await imageModels()
  const model = list.find((m) => m.id === s.image_model) || list.find((m) => m.id === 'z-image-turbo') || list[0]
  if (!model) return reply('⚠️ Не удалось загрузить модели картинок')
  await tgImageOp((api, ctx) => images.generate(api, model, genParams(model, prompt), ctx), `Рисую (${model.name})`, reply, { text: prompt })
}

function tgSavePhotos(files: { bytes: Uint8Array; ext: string }[]): string[] {
  const dir = join(store.expand(store.defaultProject().folder), 'uploads', 'telegram')
  mkdirSync(dir, { recursive: true })
  return files.map((f, i) => {
    const p = store.freePath(dir, `photo-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}${files.length > 1 ? '-' + (i + 1) : ''}.${f.ext === 'jpeg' ? 'jpg' : f.ext}`)
    writeFileSync(p, Buffer.from(f.bytes))
    return p
  })
}

const HELP = 'Режимы:\n💬 /chat — агент: задачи, вопросы, фото с вопросом («что на фото?»)\n🎨 /image — картинки: текст = новая картинка, фото с подписью = правка этого фото, ' +
  'альбом из нескольких фото с подписью = работа по референсам\n\n/models — сменить модели\n/new — новый чат · /stop — остановить · /status — что выполняется\n' +
  'Голосовые тоже понимаю. Под каждой картинкой — кнопки: увеличить, убрать фон, ещё вариант, изменить.'

async function tgModelList(kind: string, reply: (t: string) => Promise<void>) {
  const s = loadSettings()
  let rows: telegram.Buttons = []
  let title = ''
  if (kind === 'text') {
    const list = (await textModels()).filter((m) => m.tools)
    const pick = [...list.filter((m) => m.uncensored), ...list.filter((m) => /claude|gpt-5|grok-4|gemini-3|deepseek-v4|qwen-3-8|kimi-k3/.test(m.id) && !m.uncensored)].slice(0, 14)
    rows = pick.map((m) => [{ text: (m.id === s.text_model ? '✅ ' : '') + m.name + (m.uncensored ? ' 🔓' : ''), data: `mt:${m.id}`.slice(0, 64) }])
    title = 'Модель чата (🔓 — без цензуры):'
  } else if (kind === 'image') {
    const list = (await imageModels()).map((m) => ({ m, p: imagePrice(m, {}) ?? 9 })).sort((a, b) => a.p - b.p).slice(0, 14)
    rows = list.map(({ m, p }) => [{ text: (m.id === s.image_model ? '✅ ' : '') + `${m.name} · $${p}` + (m.uncensored ? ' 🔓' : ''), data: `mi:${m.id}`.slice(0, 64) }])
    title = 'Модель картинок:'
  } else {
    const list = (await venice().rawModels('inpaint').catch(() => [])).map((m: any) => ({ id: m.id, name: m.model_spec?.name || m.id, p: m.model_spec?.pricing?.inpaint?.usd ?? 9, unc: !!m.model_spec?.uncensored }))
      .sort((a: any, b: any) => a.p - b.p).slice(0, 14)
    rows = list.map((m: any) => [{ text: (m.id === tgEditModel() ? '✅ ' : '') + `${m.name} · $${m.p}` + (m.unc ? ' 🔓' : ''), data: `me:${m.id}`.slice(0, 64) }])
    title = 'Модель правки фото:'
  }
  await telegram.send(title, { reply_markup: telegram.keyboard(rows) })
  void reply
}

function startTelegram() {
  telegram.start({
    token: () => secrets.get('app:telegram'),
    chatId: () => loadSettings().telegram?.chat_id,
    pairCode: () => pairCode,
    pair: (chatId, name) => {
      saveSettings({ telegram: { ...loadSettings().telegram, enabled: true, chat_id: chatId, name } })
      win?.webContents.send('settings:changed', loadSettings())
    },
    transcribe: (bytes, mime) => venice().transcribe(loadSettings().stt_model, bytes, mime),
    onApproval: (id, answer) => answerApproval(id, answer),
    onCommand: async (cmd, args, reply) => {
      const tg = loadSettings().telegram
      if (cmd === 'chat' || cmd === 'image') {
        saveSettings({ telegram: { ...tg, mode: cmd } })
        tgPendingEdit = null
        return reply(cmd === 'chat' ? '💬 Режим чата: пишите задачи агенту, можно с фото.' : '🎨 Режим картинок: опишите картинку — нарисую. Пришлите фото с подписью — поправлю именно его.')
      }
      if (cmd === 'models') {
        return void telegram.send('Какую модель сменить?', { reply_markup: telegram.keyboard([[{ text: '💬 Чат', data: 'ml:text' }, { text: '🎨 Картинки', data: 'ml:image' }, { text: '✏️ Правка фото', data: 'ml:edit' }]]) })
      }
      if (cmd === 'new') {
        saveSettings({ telegram: { ...tg, current: undefined } })
        tgPendingEdit = null
        return reply('🆕 Следующее сообщение начнёт новый чат.')
      }
      if (cmd === 'stop') {
        const id = tg.current?.chatId
        if (id && active.has(id)) {
          active.get(id)!.stop()
          return reply('⏹ Останавливаю.')
        }
        return reply('Сейчас ничего не выполняется.')
      }
      if (cmd === 'status') {
        const running = [...active.keys()].map((id) => findChat(id)?.chat.title || id)
        const mode = tg.mode === 'image' ? '🎨 картинки' : '💬 чат'
        return reply(`Режим: ${mode}\n` + (running.length ? '⏳ Выполняется:\n' + running.map((t) => '• ' + t).join('\n') : '✅ Агент свободен.'))
      }
      if (cmd === 'start' && args) return
      void args
      return reply(HELP)
    },
    onButton: async (data, reply) => {
      const [kind, a, ...rest] = data.split(':')
      const arg = [a, ...rest].join(':')
      if (kind === 'ml') return void tgModelList(a, reply)
      if (kind === 'mt') {
        saveSettings({ text_model: arg })
        win?.webContents.send('settings:changed', loadSettings())
        return 'Модель чата сменена'
      }
      if (kind === 'mi') {
        saveSettings({ image_model: arg })
        win?.webContents.send('settings:changed', loadSettings())
        return 'Модель картинок сменена'
      }
      if (kind === 'me') {
        saveSettings({ edit_model: arg })
        win?.webContents.send('settings:changed', loadSettings())
        return 'Модель правки сменена'
      }
      if (kind === 'im') {
        const id = rest.join(':')
        const it = gallery.byId(id)
        if (!it) return 'Картинка не найдена'
        if (a === 'x2') void tgImageOp((api, ctx) => images.upscale(api, it.path, 2, ctx), 'Увеличиваю ×2', reply)
        else if (a === 'bg') void tgImageOp((api, ctx) => images.background(api, it.path, ctx), 'Убираю фон', reply)
        else if (a === 'doc') void telegram.sendFile(it.path, { asDocument: true, caption: it.path.split('/').pop() })
        else if (a === 'ed') {
          tgPendingEdit = id
          void reply('✏️ Напишите, что поменять на этой картинке (остальное постараюсь не трогать).')
        } else if (a === 'var') {
          if (!it.prompt || !it.model) return 'У этой картинки нет промпта — пришлите описание'
          const model = (await imageModels()).find((m) => m.id === it.model)
          if (!model) return 'Модель недоступна'
          void tgImageOp((api, ctx) => images.generate(api, model, { ...(it.params || {}), prompt: it.prompt, seed: undefined, variants: 1 }, ctx), 'Рисую ещё вариант', reply)
        }
        return ''
      }
    },
    onPhotos: async (files, caption, reply) => {
      const paths = tgSavePhotos(files)
      const tg = loadSettings().telegram
      if (tg.mode === 'image') {
        if (!caption.trim()) {
          // фото без подписи: показываем кнопки, что с ним сделать
          const it = gallery.ensure(paths[0], store.defaultProject().id)
          tgPendingEdit = it.id
          return void telegram.send(`📷 Фото получено${paths.length > 1 ? ` (${paths.length})` : ''}. Напишите, что поменять, или выберите действие:`, { reply_markup: telegram.keyboard(imgButtons(it.id).slice(0, 1)) })
        }
        const prompt = caption.trim() + KEEP_REST
        if (paths.length === 1) return tgImageOp((api, ctx) => images.edit(api, paths[0], prompt, tgEditModel(), ctx), 'Правлю фото', reply, { text: caption.trim(), inputs: paths })
        return tgImageOp((api, ctx) => images.combine(api, paths.slice(0, 6), caption.trim(), tgEditModel(), ctx), `Работаю по ${Math.min(paths.length, 6)} фото`, reply, { text: caption.trim(), inputs: paths })
      }
      // режим чата: фото уходят агенту вместе с вопросом
      await tgAgent(caption, reply, paths)
    },
    onText: async (text, reply) => {
      if (tgPendingEdit) {
        const it = gallery.byId(tgPendingEdit)
        tgPendingEdit = null
        if (it) return tgImageOp((api, ctx) => images.edit(api, it.path, text + KEEP_REST, tgEditModel(), ctx), 'Правлю картинку', reply, { text, inputs: [it.path] })
      }
      if (loadSettings().telegram.mode === 'image') return tgGenerate(text, reply)
      await tgAgent(text, reply)
    },
  })
  telegram.setCommands([
    ['chat', 'Режим чата с агентом'], ['image', 'Режим картинок: генерация и правка фото'], ['models', 'Сменить модели'],
    ['new', 'Новый чат'], ['stop', 'Остановить задачу'], ['status', 'Что выполняется'], ['help', 'Помощь'],
  ])
}

/** Режим чата: задача агенту (с фото — как вложения), ответ и картинки — обратно в Telegram. */
async function tgAgent(text: string, reply: (t: string) => Promise<void>, photos: string[] = []) {
  const tg = loadSettings().telegram
  const cur = tg.current
  if (cur && active.has(cur.chatId)) return reply('⏳ Ещё работаю над прошлой задачей. /stop — остановить.')
  const projectId = cur?.projectId || store.defaultProject().id
  const chatId = cur && store.loadChat(cur.projectId, cur.chatId) ? cur.chatId : null
  await reply('⏳ Принял, работаю…')
  const id = chatId || store.newChat().id
  remote.add(id)
  saveSettings({ telegram: { ...loadSettings().telegram, current: { projectId, chatId: id } } })
  try {
    const root = store.expand(store.project(projectId)!.folder)
    const atts = []
    for (const p of photos) atts.push(await attachments.prepare(p, root))
    const r = await runHeadless(projectId, chatId, text, undefined, id, atts)
    await telegram.send(r.text)
    const imgs = r.media.filter((m) => /\.(png|jpe?g|webp)$/i.test(m))
    await tgSendImages(imgs.slice(0, 5), '')
    for (const m of r.media.filter((x) => !imgs.includes(x)).slice(0, 3)) await telegram.sendFile(m)
  } catch (e) {
    await reply('⚠️ ' + (e as Error).message)
  } finally {
    remote.delete(id)
  }
}

async function runSchedule(s: Schedule) {
  const list = loadSettings().schedules
  saveSettings({ schedules: list.map((x) => (x.id === s.id ? { ...x, last: Date.now() / 1000 } : x)) })
  const projectId = s.projectId && store.project(s.projectId) ? s.projectId : store.defaultProject().id
  const chatId = store.newChat().id
  unattended.set(chatId, s.auto_approve ? 'auto' : 'deny')
  try {
    const when = new Date().toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    const r = await runHeadless(projectId, null, s.prompt, `⏰ ${s.name} · ${when}`, chatId)
    void r
    new Notification({ title: `⏰ ${s.name}`, body: r.text.slice(0, 200), icon: ICON }).show()
    if (s.telegram && loadSettings().telegram?.chat_id) await telegram.send(`⏰ ${s.name}\n\n${r.text}`)
  } catch (e) {
    new Notification({ title: `⏰ ${s.name}: ошибка`, body: (e as Error).message, icon: ICON }).show()
  } finally {
    unattended.delete(chatId)
    win?.webContents.send('settings:changed', loadSettings())
  }
}

/** Запуск вместе с системой: свёрнутым, чтобы работали расписание и Telegram. */
function syncAutostart(on: boolean) {
  if (isWin) return app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'] })
  const dir = join(homedir(), '.config', 'autostart')
  rmSync(join(dir, 'venice-agent.desktop'), { force: true }) // файл под прежним названием
  const file = join(dir, 'mouse-king-pro.desktop')
  if (!on) return rmSync(file, { force: true })
  mkdirSync(dir, { recursive: true })
  const exec = app.isPackaged && process.env.APPIMAGE ? process.env.APPIMAGE : join(__dirname, '../../../run.sh')
  writeFileSync(file, `[Desktop Entry]\nType=Application\nName=Mouse King Pro\nExec="${exec}" --hidden\nIcon=mouse-king-pro\nX-GNOME-Autostart-enabled=true\nNoDisplay=false\n`)
}

let quitting = false

// Внутреннее имя на Linux прежнее: по нему GNOME-связка ключей хранит ключ шифрования секретов
// (токены, пароли серверов). Смена имени сделала бы уже сохранённые секреты нечитаемыми.
app.setName(process.platform === 'win32' ? 'Mouse King Pro' : 'Venice Agent')
if (!process.env.VA_SHOT && !app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', () => {
  // второй запуск из меню — показываем уже открытое окно
  if (win) {
    win.show()
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})
app.whenReady().then(() => {
  telegram.setTokenSource(() => secrets.get('app:telegram'))
  setServerSecrets((s) => secrets.get(`server:${s.id}`))
  // микрофон для голосового ввода
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media' || permission === 'clipboard-sanitized-write'))
  handlers()
  jobs.setJobsListener(() => win && !win.isDestroyed() && win.webContents.send('jobs:changed'))
  createWindow()
  textModels()
  if (secrets.get('app:telegram')) startTelegram()
  scheduler.start(() => loadSettings().schedules || [], runSchedule)
  mcp.setMcpListener(() => win?.webContents.send('settings:changed', loadSettings()))
  // переход со старого названия: обновить пункт меню и автозапуск под именем Mouse King Pro
  const data = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  if (!isWin && existsSync(join(data, 'applications', 'venice-agent.desktop'))) installDesktopEntry()
  if (loadSettings().autostart) syncAutostart(true)
  if (!process.env.VA_SHOT) updater.start((s) => win && !win.isDestroyed() && win.webContents.send('update:state', s))
})
app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => (quitting = true))
app.on('will-quit', () => {
  jobs.stopAll()
  terminal.killAll()
  browser.close()
  mcp.closeAll()
  telegram.stop()
})
