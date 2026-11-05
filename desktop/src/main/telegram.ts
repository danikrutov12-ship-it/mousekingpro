// Управление агентом из Telegram: задачи текстом или голосом, ответы и кнопки «Разрешить / Отклонить».
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

export interface TgHooks {
  token(): string | undefined
  chatId(): number | undefined
  pair(chatId: number, name: string): void
  pairCode(): string
  onText(text: string, reply: (t: string) => Promise<void>): Promise<void>
  onCommand(cmd: string, args: string, reply: (t: string) => Promise<void>): Promise<void>
  /** фото (одно или альбом) с подписью */
  onPhotos(files: { bytes: Uint8Array; ext: string }[], caption: string, reply: (t: string) => Promise<void>): Promise<void>
  /** нажатие кнопки под сообщением бота (кроме разрешений); вернуть короткий ответ-всплывашку */
  onButton(data: string, reply: (t: string) => Promise<void>): Promise<string | void>
  onApproval(id: string, answer: 'yes' | 'always' | 'no'): void
  transcribe(bytes: Uint8Array, mime: string): Promise<string>
}

// адрес API можно подменить для проверок (локальный имитатор Telegram)
const TG = process.env.VA_TG_API || 'https://api.telegram.org'
let hooks: TgHooks | null = null
// токен нужен и до запуска опроса (проверка при вставке), поэтому берём его отдельно от hooks
let tokenSource: () => string | undefined = () => undefined
export const setTokenSource = (fn: () => string | undefined) => (tokenSource = fn)
let running = false
let offset = 0
let lastError = ''

const api = async (method: string, body?: Record<string, any> | FormData, timeout = 70_000) => {
  const token = tokenSource()
  if (!token) throw new Error('нет токена бота')
  const r = await fetch(`${TG}/bot${token}/${method}`, {
    method: 'POST',
    body: body instanceof FormData ? body : JSON.stringify(body || {}),
    headers: body instanceof FormData ? undefined : { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(timeout),
  })
  const data = await r.json()
  if (!data.ok) throw new Error(data.description || `Telegram: HTTP ${r.status}`)
  return data.result
}

export async function send(text: string, extra: Record<string, any> = {}) {
  const chat = hooks?.chatId()
  if (!chat || !text.trim()) return
  for (let i = 0; i < text.length; i += 4000) {
    await api('sendMessage', { chat_id: chat, text: text.slice(i, i + 4000), disable_web_page_preview: true, ...extra }).catch(() => {})
  }
}

export type Buttons = { text: string; data: string }[][]
export const keyboard = (rows: Buttons) => ({ inline_keyboard: rows.map((r) => r.map((b) => ({ text: b.text, callback_data: b.data }))) })

/** Файл в чат: картинка — фото (или документом без сжатия), видео — видео, остальное — документом. */
export async function sendFile(path: string, opts: { caption?: string; buttons?: Buttons; asDocument?: boolean } = {}) {
  const chat = hooks?.chatId()
  if (!chat) return
  const kind = opts.asDocument ? 'document' : /\.(png|jpe?g|webp)$/i.test(path) ? 'photo' : /\.(mp4|webm|mov)$/i.test(path) ? 'video' : 'document'
  const form = new FormData()
  form.append('chat_id', String(chat))
  form.append(kind, new Blob([readFileSync(path)]), basename(path))
  if (opts.caption) form.append('caption', opts.caption.slice(0, 1000))
  if (opts.buttons) form.append('reply_markup', JSON.stringify(keyboard(opts.buttons)))
  await api(kind === 'photo' ? 'sendPhoto' : kind === 'video' ? 'sendVideo' : 'sendDocument', form, 300_000).catch(() => {})
}

/** Меню команд в Telegram. */
export async function setCommands(list: [string, string][]) {
  await api('setMyCommands', { commands: list.map(([command, description]) => ({ command, description })) }, 15_000).catch(() => {})
}

// альбом приходит отдельными сообщениями с общим media_group_id — собираем их вместе
const albums = new Map<string, { files: { bytes: Uint8Array; ext: string }[]; caption: string; timer: ReturnType<typeof setTimeout>; reply: (t: string) => Promise<void> }>()

async function download(fileId: string): Promise<{ bytes: Uint8Array; ext: string }> {
  const f = await api('getFile', { file_id: fileId })
  const r = await fetch(`${TG}/file/bot${tokenSource()}/${f.file_path}`)
  return { bytes: new Uint8Array(await r.arrayBuffer()), ext: (String(f.file_path).split('.').pop() || 'jpg').toLowerCase() }
}

export async function askApproval(id: string, title: string, details: string, danger?: string) {
  const text = `${danger ? '⚠️ ОПАСНО: ' + danger + '\n\n' : ''}🔐 ${title}\n\n${details.slice(0, 3000)}`
  const rows = [[{ text: '✅ Разрешить', callback_data: `ap:${id}:y` }, { text: '❌ Отклонить', callback_data: `ap:${id}:n` }]]
  // «разрешать всё» — как в приложении: только для обычных действий, опасные спрашиваются каждый раз
  if (!danger) rows.push([{ text: '✅ Разрешать всё в этом чате', callback_data: `ap:${id}:a` }])
  await send(text, { reply_markup: { inline_keyboard: rows } })
}

async function handle(u: any) {
  if (!hooks) return
  if (u.callback_query) {
    const q = u.callback_query
    if (q.message?.chat?.id !== hooks.chatId()) return
    if (!String(q.data).startsWith('ap:')) {
      const note = await hooks.onButton(String(q.data), (t) => send(t)).catch((e) => '⚠️ ' + (e as Error).message)
      await api('answerCallbackQuery', { callback_query_id: q.id, text: note || '' }).catch(() => {})
      return
    }
    const [, id, a] = String(q.data || '').split(':')
    const answer = a === 'a' ? 'always' : a === 'y' ? 'yes' : 'no'
    const label = { yes: '✅ Разрешено', always: '✅ Разрешено — дальше в этом чате без вопросов (кроме опасного)', no: '❌ Отклонено' }[answer]
    hooks.onApproval(id, answer)
    await api('answerCallbackQuery', { callback_query_id: q.id, text: answer === 'no' ? 'Отклонено' : 'Разрешено' }).catch(() => {})
    await api('editMessageReplyMarkup', { chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {})
    await send(label)
    return
  }
  const m = u.message
  if (!m) return
  const chatId = m.chat?.id
  const reply = (t: string) => api('sendMessage', { chat_id: chatId, text: t }).then(() => {}).catch(() => {})
  // привязка: первый, кто пришлёт код из настроек, становится владельцем бота
  if (chatId !== hooks.chatId()) {
    const code = hooks.pairCode()
    if (m.text && code && m.text.includes(code)) {
      hooks.pair(chatId, m.from?.first_name || m.from?.username || 'вы')
      await reply('✅ Готово! Этот чат привязан к Mouse King Pro. Пишите задачи текстом или голосом.\n/new — новый чат, /stop — остановить, /status — что сейчас делается')
    } else await reply('Этот бот приватный. Чтобы привязать его, отправьте код из настроек Mouse King Pro.')
    return
  }
  // фото: сжатое (photo) или файлом без сжатия (document с картинкой)
  const photoId = m.photo?.length ? m.photo[m.photo.length - 1].file_id
    : m.document && /^image\//.test(m.document.mime_type || '') ? m.document.file_id : null
  if (photoId) {
    try {
      const file = await download(photoId)
      if (m.media_group_id) {
        const key = String(m.media_group_id)
        const al = albums.get(key) || { files: [], caption: '', timer: setTimeout(() => {}, 0), reply }
        al.files.push(file)
        if (m.caption) al.caption = m.caption
        clearTimeout(al.timer)
        al.timer = setTimeout(() => {
          albums.delete(key)
          hooks?.onPhotos(al.files, al.caption, al.reply).catch((e) => reply('⚠️ ' + (e as Error).message))
        }, 1500)
        albums.set(key, al)
      } else await hooks.onPhotos([file], m.caption || '', reply)
    } catch (e) {
      await reply('⚠️ Не удалось получить фото: ' + (e as Error).message)
    }
    return
  }
  let text: string = m.text || m.caption || ''
  if (m.voice || m.audio) {
    try {
      const f = await api('getFile', { file_id: (m.voice || m.audio).file_id })
      const r = await fetch(`${TG}/file/bot${tokenSource()}/${f.file_path}`)
      text = await hooks.transcribe(new Uint8Array(await r.arrayBuffer()), m.voice?.mime_type || 'audio/ogg')
      await reply(`🎙 «${text}»`)
    } catch (e) {
      await reply('Не удалось распознать голосовое: ' + (e as Error).message)
      return
    }
  }
  if (!text) return
  if (text.startsWith('/')) {
    const [cmd, ...rest] = text.slice(1).split(/\s+/)
    return hooks.onCommand(cmd.replace(/@.*/, '').toLowerCase(), rest.join(' '), reply)
  }
  await hooks.onText(text, reply)
}

async function loop() {
  while (running) {
    try {
      const updates = await api('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] })
      lastError = ''
      for (const u of updates) {
        offset = u.update_id + 1
        handle(u).catch(() => {})
      }
    } catch (e) {
      lastError = (e as Error).message
      await new Promise((r) => setTimeout(r, 5000))
    }
  }
}

export function start(h: TgHooks) {
  hooks = h
  if (running || !tokenSource()) return
  running = true
  loop()
}

export function stop() {
  running = false
}

export const status = () => ({ running, error: lastError })

/** Проверка токена до сохранения: имя бота или ошибка Telegram. */
export async function check(token: string): Promise<string> {
  const r = await fetch(`${TG}/bot${token.trim()}/getMe`, { signal: AbortSignal.timeout(15_000) })
  const data = await r.json().catch(() => ({}))
  if (!data.ok) throw new Error(data.description === 'Unauthorized' ? 'Telegram не принял токен — проверьте, что скопировали его целиком' : data.description || `HTTP ${r.status}`)
  return data.result.username
}

let cachedName: { token: string; name: string } | null = null
export async function botName(): Promise<string> {
  const token = tokenSource() || ''
  if (cachedName?.token === token) return cachedName.name
  const me = await api('getMe', {}, 15_000)
  cachedName = { token, name: me.username }
  return me.username
}
