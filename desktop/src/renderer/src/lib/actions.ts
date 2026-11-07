// Действия интерфейса: загрузка данных, чаты, отправка, события агента.
import type { Attachment, Chat, EditModel, MediaOp, Message, Mode, Model, RunEvent, SendRequest, Settings } from '@shared/types'
import { api } from './api'
import { get, set, type Artifact, type PanelTab } from './store'
import { baseName, fileUrl } from './format'
import { aspectForPhoto, isReferenceModel, photoProblem, photoSibling } from '@shared/video'
import { proModel } from '@shared/runpod'

let toastId = 0
export function toast(text: string, kind?: 'error' | 'ok') {
  const id = ++toastId
  set((s) => ({ toasts: [...s.toasts, { id, text, kind }] }))
  setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 6000 : 3200)
}

// ---------------------------------------------------------------- загрузка

export async function init() {
  const [settings, defaultProject] = await Promise.all([api.settings.get(), api.projects.default()])
  set({ settings, defaultProject, ready: true })
  api.win.onState((w) => {
    document.documentElement.classList.toggle('dark', w.dark)
    set({ win: w })
  })
  api.run.onEvent(onRunEvent)
  api.onNav((to) => openChat(to.projectId, to.chatId))
  api.onSettings((s) => set({ settings: s }))
  api.update.onState((u) => set({ update: u }))
  api.update.state().then((u) => set({ update: u }))
  refreshMemories()
  const loadJobs = async () => set({ jobs: await api.jobs.list() })
  api.jobs.onChange(loadJobs)
  loadJobs()
  await newChat()
  refreshRecents()
  refreshProjects()
  if (settings.api_key) {
    loadModels()
    refreshBalance()
  } else set({ settingsOpen: true })
}

export async function loadModels() {
  set({ modelsLoading: true })
  const models = await api.models()
  set({ models, modelsLoading: false })
  if (models.errors) toast('Не все модели загрузились: ' + models.errors, 'error')
}

export const refreshBalance = async () => set({ balance: await api.balance() })
export const refreshRecents = async () => set({ recents: await api.chats.recent() })
export const refreshProjects = async () => set({ projects: await api.projects.list() })

export async function saveSettings(patch: Partial<Settings>) {
  const before = get().settings
  if (patch.theme) {
    document.documentElement.classList.add('theme-anim')
    setTimeout(() => document.documentElement.classList.remove('theme-anim'), 400)
  }
  const settings = await api.settings.set(patch)
  set({ settings })
  if (patch.api_key !== undefined && patch.api_key !== before?.api_key && settings.api_key) {
    loadModels()
    refreshBalance()
  }
}

// ---------------------------------------------------------------- модели

export function modelFor(mode: Mode): Model | null {
  const { models, settings } = get()
  const list = models[mode]
  const id = settings?.[`${mode}_model` as const]
  return list.find((m) => m.id === id) || list[0] || null
}

export function pickModel(mode: Mode, model: Model) {
  saveSettings({ [`${mode}_model`]: model.id } as Partial<Settings>)
}

// ---------------------------------------------------------------- чаты

export async function newChat(projectId?: string) {
  const chat = await api.chats.create()
  const pid = projectId || get().defaultProject!.id
  set({ current: { projectId: pid, chat, isNew: true }, view: { page: 'chat' }, memoryOn: get().settings?.memory_enabled ?? true })
}

export const refreshMemories = async () => set({ memories: await api.memory.list() })

export async function rememberFact(text: string) {
  await api.memory.add(text)
  await refreshMemories()
  toast('Запомнил', 'ok')
}

/** Панель справа: вкладка (повторный клик по той же — закрыть). */
export function togglePanel(tab: PanelTab) {
  set((s) => (s.panel?.tab === tab ? { panel: null } : { panel: { tab, artifact: s.panel?.artifact } }))
}

export async function openChat(projectId: string, chatId: string) {
  const chat = await api.chats.load(projectId, chatId)
  if (!chat) {
    toast('Чат не найден', 'error')
    refreshRecents()
    return
  }
  set({ current: { projectId, chat, isNew: false }, view: { page: 'chat' }, memoryOn: chat.memory !== false && (get().settings?.memory_enabled ?? true) })
}

export async function deleteChat(projectId: string, chatId: string) {
  await api.chats.remove(projectId, chatId)
  if (get().current?.chat.id === chatId) await newChat()
  refreshRecents()
  refreshProjects()
}

export async function renameChat(projectId: string, chatId: string, title: string) {
  title = title.trim()
  if (!title) return
  await api.chats.rename(projectId, chatId, title)
  set((s) => (s.current?.chat.id === chatId ? { current: { ...s.current, chat: { ...s.current.chat, title } } } : {}))
  refreshRecents()
}

// ---------------------------------------------------------------- отправка

export async function send(text: string, attachments: Attachment[], params?: Record<string, any>,
  extra: Omit<Partial<SendRequest>, 'mode' | 'model'> & { mode?: Mode; model?: Model | null } = {}): Promise<boolean> {
  const { current, models, settings } = get()
  const mode = extra.mode || get().mode
  if (!current || get().runs[current.chat.id]) return false
  if (!settings?.api_key) {
    set({ settingsOpen: true })
    return false
  }
  let model = extra.model || modelFor(mode)
  if (!model) {
    toast('Модели ещё загружаются', 'error')
    return false
  }
  // картинка + прикреплённые фото или набор референсов = правка по фото, а не генерация с нуля
  if (mode === 'image' && !extra.op && !extra.fork) {
    const set_ = get().settings?.ref_sets.find((r) => r.id === get().refSet)
    const refs = [...attachments.filter((a) => a.kind === 'image').map((a) => a.path), ...(set_?.paths || [])]
    if (refs.length) {
      if (!text) {
        toast('Напишите, что сделать с фото', 'error')
        return false
      }
      const editModel = get().settings?.edit_model || 'qwen-edit-uncensored'
      const max = editMax(editModel)
      const prompt = text + avoidPart(get().avoid) + (get().keepRest ? KEEP_REST : '') + (set_ && refs.length > 1 ? `\n\nНа референсах (${set_.name}) — тот же человек/предмет: сохрани его внешность и черты точно.` : '')
      const op: MediaOp = refs.length === 1 ? { kind: 'edit', path: refs[0], prompt, model: editModel }
        : { kind: 'combine', paths: refs.slice(0, max), prompt, model: editModel }
      if (refs.length > max) toast(`Модель принимает до ${max} фото — лишние не отправлены`, 'error')
      return send(text, attachments, undefined, { ...extra, op, mode: 'image', model: modelFor('image') })
    }
  }
  if (mode === 'pro') {
    const s = get().settings!
    if (!s.runpod_endpoint) {
      toast('Подключите RunPod: Настройки → RunPod', 'error')
      set({ settingsOpen: true })
      return false
    }
    const m = proModel(model.id)
    const photos = attachments.filter((a) => a.kind === 'image').length
    if (m.kind === 'edit' && !photos) {
      toast(`${m.name} правит фото — прикрепите хотя бы одно`, 'error')
      return false
    }
    if (!text) {
      toast(photos ? 'Напишите, что сделать с фото' : 'Опишите картинку', 'error')
      return false
    }
    const o = s.pro_opts || {}
    const fast = !!(m.fast && o.fast)
    const negative = get().proNegative.trim()
    if (negative && !m.negative(fast)) toast(`${m.name}${fast ? ' в быстром режиме' : ''} не учитывает негатив — отправляю без него`, 'ok')
    extra = { ...extra, pro: {
      model: m.id, prompt: text, fast, negative: m.negative(fast) ? negative : undefined, strength: o.strength, aspect: o.aspect as any,
      upscale: o.upscale, hires: m.kind === 'edit' && (o.hires ?? true), detail: m.family !== 'zimage' && (o.detail ?? m.kind === 'edit'),
      maxq: !!m.quality && o.maxq, keep: m.kind === 'edit' ? o.keep !== false : undefined, loras: (o.loras || []).filter((l) => l.name && m.lora),
    } }
    params = undefined
  }
  if (mode === 'image' && !text && !extra.op) {
    toast('Опишите изображение', 'error')
    return false
  }
  if (mode === 'video') {
    const photos = attachments.filter((a) => a.kind === 'image')
    // фото к модели «только по тексту» — она его не увидит; берём её вариант для фото из той же серии
    if (photos.length && model.constraints?.model_type === 'text-to-video') {
      const sib = photoSibling(model, models.video)
      if (!sib) {
        toast(`${model.name} делает видео только по тексту и не увидит фото — выберите модель «image-to-video»`, 'error')
        return false
      }
      toast(`${model.name} не видит фото — отправляю в ${sib.name}`, 'ok')
      model = sib
      if (params) {
        const ratio = await imageSize(photos[0].path).then((s) => s.w / s.h).catch(() => 1)
        const fit = (k: string, list?: string[]) => list?.length && !list.includes(params![k]) ? list[0] : params![k]
        const c = sib.constraints || {}
        params = { ...params, duration: fit('duration', c.durations), resolution: fit('resolution', c.resolutions),
          aspect_ratio: aspectForPhoto(c.aspect_ratios, ratio) ?? undefined }
      }
    }
    // размер и пропорции фото — проверяем до отправки, а не после ошибки поставщика
    if (model.constraints?.model_type === 'image-to-video') {
      for (const p of photos) {
        const s = await imageSize(p.path).catch(() => null)
        const problem = s && photoProblem(model, s.w, s.h)
        if (problem) {
          toast(problem, 'error')
          return false
        }
      }
    }
    if (isReferenceModel(model)) {
      const set_ = get().settings?.ref_sets.find((r) => r.id === get().refSet)
      if (set_) extra = { ...extra, refPaths: set_.paths }
      if (!photos.length && !set_) {
        toast('Эта модель делает видео по образцу: прикрепите 1–30 фото человека или предмета', 'error')
        return false
      }
    }
    const mtype = model.constraints?.model_type
    if (mtype === 'image-to-video' && !isReferenceModel(model) && !attachments.some((a) => a.kind === 'image')) {
      toast('Эта модель оживляет картинку — прикрепите изображение', 'error')
      return false
    }
    if (mtype === 'video' && !attachments.some((a) => a.kind === 'video')) {
      toast('Эта модель обрабатывает видео — прикрепите видеофайл', 'error')
      return false
    }
  }
  // только параметры, которые понимает этот тип модели (не тащим картиночные в видео и наоборот)
  if (params) {
    const allow = mode === 'video' ? ['duration', 'resolution', 'aspect_ratio', 'audio']
      : ['aspect_ratio', 'width', 'height', 'resolution', 'quality', 'steps', 'variants', 'format', 'hide_watermark', 'negative_prompt', 'seed']
    params = Object.fromEntries(Object.entries(params).filter(([k, v]) => allow.includes(k) && v !== undefined && v !== ''))
  }
  const searchModel = mode === 'text'
    ? (model.web_search ? model.id : models.text.find((m) => m.web_search)?.id ?? null)
    : null
  set((s) => ({ runs: { ...s.runs, [current.chat.id]: { text: '', status: '', outputs: {} } }, view: { page: 'chat' } }))
  await api.run.send({
    projectId: current.projectId, chatId: current.chat.id, isNew: current.isNew,
    text, attachments, mode, model, params, searchModel, memory: get().memoryOn, ...extra,
  } as SendRequest)
  return true
}

/** У правки по фото нет поля негативного промпта в Venice — передаём запреты текстом. */
export const avoidPart = (avoid: string) => avoid.trim()
  ? `\n\nНе должно быть на результате (avoid, do NOT add or show): ${avoid.trim().replace(/[.\s]+$/, '')}.`
  : ''

/** Копирование картинки в буфер: сам файл без пересжатия, а webp и прочее — через холст в PNG без потерь. */
/** Размер картинки в пикселях. */
export function imageSize(path: string): Promise<{ w: number; h: number }> {
  return new Promise((ok, fail) => {
    const img = new Image()
    img.onload = () => ok({ w: img.naturalWidth, h: img.naturalHeight })
    img.onerror = () => fail(new Error('не удалось прочитать картинку'))
    img.src = fileUrl(path)
  })
}

export async function copyImage(path: string) {
  try {
    if (!(await api.clipboardImage(path))) {
      const img = new Image()
      img.src = fileUrl(path)
      await img.decode()
      const c = document.createElement('canvas')
      c.width = img.naturalWidth
      c.height = img.naturalHeight
      c.getContext('2d')!.drawImage(img, 0, 0)
      const blob: Blob = await new Promise((ok) => c.toBlob((b) => ok(b!), 'image/png'))
      await api.clipboardImageData(new Uint8Array(await blob.arrayBuffer()))
    }
    toast('Картинка скопирована — вставьте Ctrl+V', 'ok')
  } catch (e) {
    toast(`Не удалось скопировать: ${(e as Error).message}`, 'error')
  }
}

/** Ctrl+C в просмотре картинки — если пользователь не выделил текст и не печатает в поле. */
export function isCopyKey(e: KeyboardEvent) {
  const t = e.target as HTMLElement
  return (e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'c' || e.key.toLowerCase() === 'с') && !e.shiftKey
    && !/^(INPUT|TEXTAREA)$/.test(t.tagName) && !t.isContentEditable && !window.getSelection()?.toString()
}

export const KEEP_REST = '\n\nИзмени только то, о чём просят. Всё остальное — лицо и черты людей, позу, фон, композицию, свет, цвета, ' +
  'текстуры и детали — оставь точно как на исходном фото.'

let editModels: EditModel[] = []
export async function loadEditModels() {
  if (!editModels.length) editModels = (await api.voice.models()).edit
  return editModels
}
export const editMax = (id: string) => editModels.find((m) => m.id === id)?.max ?? 3

// ---------------------------------------------------------------- правка, повтор, варианты

const textOfMsg = (m: Message) => m._display ?? (Array.isArray(m.content) ? m.content.map((p: any) => p.text || '').join('\n') : m.content || '')

/** Изменить своё сообщение: старое продолжение остаётся вариантом, с этого места — новая ветка. */
export async function editMessage(index: number, text: string) {
  const msg = get().current?.chat.messages[index]
  if (!msg) return
  const g = msg._gen
  if (g) {
    const model = get().models[g.mode].find((m) => m.id === g.model) || modelFor(g.mode)
    return send(text, [], g.params, { fork: { index, kind: 'edit' }, mode: g.mode, model })
  }
  return send(text, [], undefined, { fork: { index, kind: 'edit' }, mode: 'text' })
}

/** Получить другой ответ на то же сообщение (можно другой моделью). */
export async function regenerate(index: number, model?: Model) {
  const msg = get().current?.chat.messages[index]
  if (!msg) return
  if (msg._op) return send(textOfMsg(msg), [], undefined, { fork: { index, kind: 'regenerate' }, op: msg._op, mode: 'image', model: modelFor('image') })
  const g = msg._gen
  if (g) {
    const m = model || get().models[g.mode].find((x) => x.id === g.model) || modelFor(g.mode)
    return send(textOfMsg(msg), [], g.params, { fork: { index, kind: 'regenerate' }, mode: g.mode, model: m })
  }
  return send(textOfMsg(msg), [], undefined, { fork: { index, kind: 'regenerate' }, mode: 'text', model: model || modelFor('text') })
}

export async function switchAlt(index: number, alt: number) {
  const { current } = get()
  if (!current) return
  const chat = await api.chats.switchAlt(current.projectId, current.chat.id, index, alt)
  if (chat) set((s) => (s.current?.chat.id === chat.id ? { current: { ...s.current, chat } } : {}))
}

// ---------------------------------------------------------------- картинки

export function imageOp(op: MediaOp) {
  return send('', [], undefined, { op, mode: 'image', model: modelFor('image') })
}

/** «Оживить»: режим видео, модель «картинка → видео», картинка уже прикреплена. */
/** Новый чат с этой картинкой во вложениях (режим «Картинка» — сразу можно просить правку). */
export async function toNewChat(path: string) {
  await newChat()
  set({ mode: 'image', attachments: [], viewer: null, lightbox: null })
  await attachPaths([path])
  set((s) => ({ focusTick: s.focusTick + 1 }))
}

export async function animate(path: string) {
  const { models, settings } = get()
  const i2v = (m: Model) => m.constraints?.model_type === 'image-to-video'
  const saved = models.video.find((m) => m.id === settings?.video_model)
  const model = saved && i2v(saved) ? saved : models.video.find((m) => i2v(m) && /grok-imagine-1-5-lite|seedance-2-0-fast|wan/.test(m.id)) || models.video.find(i2v)
  if (model) await saveSettings({ video_model: model.id })
  set({ mode: 'video', attachments: [] })
  await attachPaths([path])
  set((s) => ({ draft: s.draft || 'Оживи эту картинку: плавное естественное движение', focusTick: s.focusTick + 1 }))
}

// ---------------------------------------------------------------- голос

let audio: HTMLAudioElement | null = null
export async function speak(text: string, onState?: (playing: boolean) => void) {
  if (audio) {
    audio.pause()
    audio = null
    onState?.(false)
    return
  }
  const clean = text.replace(/```[\s\S]*?```/g, ' (код пропущен) ').replace(/[#*_`>|]/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').slice(0, 4000)
  onState?.(true)
  try {
    const file = await api.voice.speak(clean)
    audio = new Audio(fileUrl(file))
    audio.onended = () => {
      audio = null
      onState?.(false)
    }
    await audio.play()
  } catch (e) {
    audio = null
    onState?.(false)
    toast('Не удалось озвучить: ' + (e as Error).message, 'error')
  }
}

// ---------------------------------------------------------------- панель справа

export const openArtifact = (artifact: Artifact) => set({ panel: { tab: 'preview', artifact } })
export const openChanges = () => set((s) => ({ panel: { tab: 'changes', artifact: s.panel?.artifact } }))
export const openFile = (file: string) => set((s) => ({ panel: { tab: 'files', artifact: s.panel?.artifact, file } }))
export const closePanel = () => set({ panel: null })

/** Продолжить прерванную задачу с места остановки. */
export async function resume(ignoreLimit = false) {
  const { current, models, settings } = get()
  if (!current || get().runs[current.chat.id]) return
  if (!settings?.api_key) return set({ settingsOpen: true })
  const model = modelFor('text')
  if (!model) return toast('Модели ещё загружаются', 'error')
  const searchModel = model.web_search ? model.id : models.text.find((m) => m.web_search)?.id ?? null
  set((s) => ({ runs: { ...s.runs, [current.chat.id]: { text: '', status: '', outputs: {} } } }))
  await api.run.send({
    projectId: current.projectId, chatId: current.chat.id, isNew: false,
    text: '', attachments: [], mode: 'text', model, searchModel, resume: true, ignoreLimit,
  })
}

/** Откатить изменения файлов, сделанные шагами callIds. */
export async function undoChanges(callIds: string[]) {
  const { current } = get()
  if (!current) return
  const chat = await api.chats.undo(current.projectId, current.chat.id, callIds)
  if (chat) {
    set((s) => (s.current?.chat.id === chat.id ? { current: { ...s.current, chat } } : {}))
    toast(callIds.length > 1 ? 'Изменения отменены' : 'Изменение отменено', 'ok')
  }
}

export function stop() {
  const id = get().current?.chat.id
  if (id) api.run.stop(id)
}

// дельты стрима копим и отдаём интерфейсу раз в кадр
const pending: Record<string, string> = {}
let frame = 0
function flushDeltas() {
  frame = 0
  set((s) => {
    const runs = { ...s.runs }
    for (const [id, text] of Object.entries(pending)) {
      if (runs[id]) runs[id] = { ...runs[id], text: runs[id].text + text }
      delete pending[id]
    }
    return { runs }
  })
}

function patchChat(chatId: string, fn: (c: Chat) => Chat) {
  set((s) => (s.current?.chat.id === chatId ? { current: { ...s.current, chat: fn(s.current.chat) } } : {}))
}

function onRunEvent(e: RunEvent) {
  switch (e.type) {
    case 'start':
      set((s) => ({
        runs: { ...s.runs, [e.chatId]: s.runs[e.chatId] || { text: '', status: '', outputs: {} } },
        current: s.current?.chat.id === e.chatId ? { projectId: e.projectId, chat: e.chat, isNew: false } : s.current,
      }))
      refreshRecents()
      break
    case 'delta':
      pending[e.chatId] = (pending[e.chatId] || '') + e.text
      if (!frame) frame = requestAnimationFrame(flushDeltas)
      break
    case 'message':
      if (e.message.role === 'assistant') {
        delete pending[e.chatId]
        set((s) => (s.runs[e.chatId] ? { runs: { ...s.runs, [e.chatId]: { ...s.runs[e.chatId], text: '' } } } : {}))
      }
      patchChat(e.chatId, (c) => ({ ...c, messages: [...c.messages, e.message] }))
      break
    case 'output':
      set((s) => {
        const run = s.runs[e.chatId]
        if (!run) return {}
        const prev = run.outputs[e.callId] || ''
        const text = (prev + e.text).slice(-20_000)
        return { runs: { ...s.runs, [e.chatId]: { ...run, outputs: { ...run.outputs, [e.callId]: text } } } }
      })
      break
    case 'status':
      set((s) => (s.runs[e.chatId] ? { runs: { ...s.runs, [e.chatId]: { ...s.runs[e.chatId], status: e.status } } } : {}))
      break
    case 'approval':
      set((s) => ({ approvals: [...s.approvals, { id: e.id, chatId: e.chatId, title: e.title, details: e.details, danger: e.danger }] }))
      break
    case 'approval_done':
      set((s) => ({ approvals: s.approvals.filter((a) => a.id !== e.id) }))
      break
    case 'done':
      delete pending[e.chatId]
      set((s) => {
        const runs = { ...s.runs }
        delete runs[e.chatId]
        return { runs, approvals: s.approvals.filter((a) => a.chatId !== e.chatId) }
      })
      refreshRecents()
      refreshProjects()
      refreshBalance()
      autoPreview(e.chatId)
      break
  }
}

/** Агент сделал страницу или схему — сразу показываем её справа, как артефакт в Claude. */
function autoPreview(chatId: string) {
  const chat = get().current?.chat
  if (!chat || chat.id !== chatId) return
  const msgs = chat.messages
  const start = msgs.map((m) => m.role === 'user' && !m._hidden).lastIndexOf(true)
  const turn = msgs.slice(start + 1)
  const file = [...turn].reverse().find((m) => m._change && !m._undone && /\.(html?|svg)$/i.test(m._change.path))
  if (file) return openArtifact({ kind: 'file', path: file._change!.path, title: baseName(file._change!.path) })
  const last = [...turn].reverse().find((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content)
  const block = last && /```(html|svg|mermaid)\n([\s\S]{120,}?)```/i.exec(String(last.content))
  if (block) {
    const kind = block[1].toLowerCase() as 'html' | 'svg' | 'mermaid'
    openArtifact({ kind, code: block[2], title: kind === 'mermaid' ? 'Схема' : kind === 'svg' ? 'Рисунок SVG' : (/<title>([^<]{1,60})<\/title>/i.exec(block[2])?.[1] || 'Страница HTML') })
  }
}

export function answerApproval(id: string, answer: 'yes' | 'always' | 'no') {
  api.run.approve(id, answer)
  set((s) => ({ approvals: s.approvals.filter((a) => a.id !== id) }))
}

// ---------------------------------------------------------------- вложения

function attachProject(): string {
  const { view, current, defaultProject } = get()
  return view.page === 'project' ? view.projectId : current?.projectId || defaultProject!.id
}

export async function pickAttachments() {
  set({ attaching: true })
  try {
    const items = await api.attach.pick(attachProject())
    set((s) => ({ attachments: [...s.attachments, ...items] }))
  } finally {
    set({ attaching: false, focusTick: get().focusTick + 1 })
  }
}

export async function attachPaths(paths: string[]) {
  if (!paths.length) return
  set({ attaching: true })
  try {
    const { items, errors } = await api.attach.paths(attachProject(), paths)
    set((s) => ({ attachments: [...s.attachments, ...items] }))
    errors.forEach((e) => toast(e, 'error'))
  } finally {
    set({ attaching: false, focusTick: get().focusTick + 1 })
  }
}

export async function attachFiles(files: File[]) {
  const withPath = files.map((f) => [f, api.attach.pathFor(f)] as const)
  attachPaths(withPath.filter(([, p]) => p).map(([, p]) => p))
  const raw = withPath.filter(([, p]) => !p).map(([f]) => f)
  if (!raw.length) return
  set({ attaching: true })
  try {
    for (const f of raw) {
      const ext = f.type.split('/')[1]?.replace('jpeg', 'jpg') || 'bin'
      const name = f.name && f.name !== 'image.png' ? f.name : `скриншот-${new Date().toLocaleTimeString('ru-RU').replace(/:/g, '-')}.${ext}`
      const { items, errors } = await api.attach.data(attachProject(), name, new Uint8Array(await f.arrayBuffer()))
      set((s) => ({ attachments: [...s.attachments, ...items] }))
      errors.forEach((e) => toast(e, 'error'))
    }
  } finally {
    set({ attaching: false, focusTick: get().focusTick + 1 })
  }
}

export function applySuggestion(text: string) {
  set((s) => ({ draft: text, focusTick: s.focusTick + 1 }))
}

// ---------------------------------------------------------------- проекты

export async function openProject(projectId: string) {
  const chat = await api.chats.create()
  set({ view: { page: 'project', projectId }, current: { projectId, chat, isNew: true } })
}
