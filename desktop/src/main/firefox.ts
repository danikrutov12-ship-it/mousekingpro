// Связь с Firefox пользователя через расширение «Mouse King Pro для Firefox» (desktop/firefox-extension).
// Приложение слушает WebSocket только на 127.0.0.1; подключаться может лишь расширение (Origin moz-extension://)
// с токеном, выданным при сопряжении: пользователь нажимает «Подключить» в настройках, и в течение 2 минут
// первое обратившееся расширение получает токен. Сайты и чужие программы без токена ничего сделать не могут.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { APP_DIR } from './config'
import type { FirefoxStatus } from '@shared/types'
import * as secrets from './secrets'

export const PORT = 47613
const SECRET = 'app:firefox'
const SHOTS = join(APP_DIR, 'browser')


let server: Server | null = null
let wss: WebSocketServer | null = null
let client: WebSocket | null = null
let clientInfo = ''
let listenError = ''
let pairingUntil = 0
let seq = 0
const waiting = new Map<number, { resolve(v: any): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }>()
let onChange: () => void = () => {}

const tokens = (): string[] => {
  try {
    return JSON.parse(secrets.get(SECRET) || '[]')
  } catch {
    return []
  }
}
const known = (t: unknown) => typeof t === 'string' && tokens().some((x) => x.length === t.length && timingSafeEqual(Buffer.from(x), Buffer.from(t)))

export function status(): FirefoxStatus {
  return {
    listening: !!server?.listening, error: listenError || undefined, connected: !!client, browser: clientInfo || undefined,
    pairingUntil: pairingUntil > Date.now() ? pairingUntil : undefined, paired: tokens().length,
  }
}

/** Разрешить сопряжение на 2 минуты. */
export function pair() {
  pairingUntil = Date.now() + 120_000
  onChange()
  setTimeout(onChange, 120_500)
}

/** Забыть все сопряжённые Firefox и отключить текущий. */
export function unpairAll() {
  secrets.remove(SECRET)
  client?.close(4001, 'unpaired')
  client = null
  clientInfo = ''
  onChange()
}

function attach(ws: WebSocket, info: string) {
  if (client && client !== ws) client.close(4000, 'replaced')
  client = ws
  clientInfo = info
  onChange()
}

export function start(listener: () => void) {
  onChange = listener
  if (server) return
  server = createServer((_req, res) => {
    res.writeHead(404).end()
  })
  wss = new WebSocketServer({
    server, maxPayload: 32 * 1024 * 1024,
    // только расширение Firefox: страницы сайтов приходят с Origin http(s)://, их не пускаем
    verifyClient: ({ origin }: { origin?: string }) => !!origin && origin.startsWith('moz-extension://'),
  })
  wss.on('connection', (ws) => {
    let authed = false
    const hello = setTimeout(() => !authed && ws.close(4003, 'no hello'), 10_000)
    ws.on('message', (raw) => {
      let msg: any
      try {
        msg = JSON.parse(String(raw))
      } catch {
        return
      }
      if (!authed) {
        if (msg.type !== 'hello') return ws.close(4003, 'hello expected')
        const info = `Firefox ${String(msg.browser || '').slice(0, 40)} · расширение ${String(msg.version || '').slice(0, 20)}`
        if (known(msg.token)) {
          authed = true
          clearTimeout(hello)
          ws.send(JSON.stringify({ type: 'ok' }))
          return attach(ws, info)
        }
        if (pairingUntil > Date.now()) {
          const token = randomBytes(24).toString('hex')
          secrets.set(SECRET, JSON.stringify([...tokens(), token].slice(-5)))
          pairingUntil = 0
          authed = true
          clearTimeout(hello)
          ws.send(JSON.stringify({ type: 'paired', token }))
          return attach(ws, info)
        }
        ws.send(JSON.stringify({ type: 'unpaired' }))
        return ws.close(4001, 'unpaired')
      }
      const w = waiting.get(msg.id)
      if (!w) return
      waiting.delete(msg.id)
      clearTimeout(w.timer)
      if (msg.ok) w.resolve(msg.result)
      else w.reject(new Error(String(msg.error || 'ошибка расширения')))
    })
    ws.on('close', () => {
      clearTimeout(hello)
      if (client === ws) {
        client = null
        clientInfo = ''
        for (const [id, w] of waiting) {
          clearTimeout(w.timer)
          w.reject(new Error('Firefox отключился'))
          waiting.delete(id)
        }
        onChange()
      }
    })
  })
  server.on('error', (e: NodeJS.ErrnoException) => {
    listenError = e.code === 'EADDRINUSE' ? `Порт ${PORT} занят (запущена вторая копия Mouse King Pro?)` : e.message
    onChange()
  })
  server.listen(PORT, '127.0.0.1', () => {
    listenError = ''
    onChange()
  })
}

export function stop() {
  client?.close()
  wss?.close()
  server?.close()
  server = wss = client = null
}

export const NOT_CONNECTED = 'Firefox не подключён. Пользователю нужно открыть Firefox с расширением «Mouse King Pro для Firefox» ' +
  '(Настройки → Firefox в приложении). Без него используй свой браузер: browser_open.'

/** Команда расширению; ответ — то, что вернул background.js. */
export function call<T = any>(cmd: string, args: Record<string, unknown> = {}, timeout = 30_000): Promise<T> {
  const ws = client
  if (!ws) return Promise.reject(new Error(NOT_CONNECTED))
  const id = ++seq
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id)
      reject(new Error('Firefox не ответил вовремя'))
    }, timeout)
    waiting.set(id, { resolve, reject, timer })
    ws.send(JSON.stringify({ id, cmd, args }))
  })
}

export const connected = () => !!client

// ---------------------------------------------------------------- для инструментов агента

interface Tab { id: number; windowId: number; active: boolean; title: string; url: string }
interface Snap { title: string; url: string; items: string[]; text: string; scroll: number; height: number; tabId: number }

const fmt = (s: Snap, withText = true) =>
  `Вкладка ${s.tabId}: ${s.title}\nURL: ${s.url}\nПрокрутка: ${s.scroll} из ${s.height}px\n\n` +
  `Элементы (номер — для firefox_click / firefox_type):\n${s.items.join('\n') || '(нет)'}` +
  (withText ? `\n\nТекст страницы:\n${s.text}` : '')

export async function tabs(): Promise<string> {
  const list = await call<Tab[]>('tabs')
  if (!list.length) return 'Открытых вкладок нет'
  return list.map((t) => `${t.active ? '▶' : ' '} [${t.id}] ${t.title || '(без названия)'} — ${t.url}`).join('\n') +
    '\n\n▶ — активная вкладка окна. Номер в скобках — tab_id.'
}

export const read = async (tabId?: number) => fmt(await call<Snap>('read', { tabId }))
export const click = async (tabId: number | undefined, index: number) => fmt(await call<Snap>('click', { tabId, index }), false)
export const type = async (tabId: number | undefined, index: number, text: string, submit: boolean) =>
  fmt(await call<Snap>('type', { tabId, index, text, submit }), false)
export const scroll = async (tabId: number | undefined, direction: 'up' | 'down') => fmt(await call<Snap>('scroll', { tabId, direction }))
export const back = async (tabId?: number) => fmt(await call<Snap>('back', { tabId }))
export const open = async (url: string, newTab: boolean) => fmt(await call<Snap>('open', { url: /^[a-z]+:/i.test(url) ? url : 'https://' + url, newTab }, 45_000))
export const close = async (tabId: number) => (await call('close', { tabId }), `Вкладка ${tabId} закрыта`)

/** Снимок видимой части вкладки (вкладка становится активной). */
export async function screenshot(tabId?: number): Promise<string> {
  const r = await call<{ dataUrl: string }>('screenshot', { tabId })
  const m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(r.dataUrl || '')
  if (!m) throw new Error('Firefox не прислал снимок')
  mkdirSync(SHOTS, { recursive: true })
  const file = join(SHOTS, `firefox-${Date.now()}.${m[1] === 'png' ? 'png' : 'jpg'}`)
  writeFileSync(file, Buffer.from(m[2], 'base64'))
  return file
}
