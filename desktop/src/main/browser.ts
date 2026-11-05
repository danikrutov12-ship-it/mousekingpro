// Браузер агента: скрытое окно Chromium со своим профилем (входы на сайты сохраняются между запусками).
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, session } from 'electron'
import { APP_DIR } from './config'

let win: BrowserWindow | null = null
const SHOTS = join(APP_DIR, 'browser')

function view(): BrowserWindow {
  if (win && !win.isDestroyed()) return win
  win = new BrowserWindow({
    width: 1280, height: 860, show: false,
    webPreferences: { session: session.fromPartition('persist:agent-browser'), offscreen: true, sandbox: true, contextIsolation: true },
  })
  win.webContents.setAudioMuted(true)
  win.webContents.setWindowOpenHandler(({ url }) => {
    win?.loadURL(url) // новые вкладки открываем в том же окне
    return { action: 'deny' }
  })
  return win
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function settle(w: BrowserWindow, ms = 800) {
  const until = Date.now() + 15_000
  while (w.webContents.isLoading() && Date.now() < until) await sleep(150)
  await sleep(ms)
}

// В странице: нумеруем видимые интерактивные элементы и собираем текст.
const SNAPSHOT_JS = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none' && r.bottom > 0 && r.top < innerHeight * 3 }
  const sel = 'a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[contenteditable=true],[onclick]'
  document.querySelectorAll('[data-va]').forEach((e) => e.removeAttribute('data-va'))
  const items = []
  let n = 0
  for (const el of document.querySelectorAll(sel)) {
    if (!vis(el) || n >= 150) continue
    n++
    el.setAttribute('data-va', n)
    const tag = el.tagName.toLowerCase()
    const type = el.getAttribute('type') || el.getAttribute('role') || ''
    const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || el.getAttribute('href') || '').replace(/\\s+/g, ' ').trim().slice(0, 80)
    items.push('[' + n + '] ' + tag + (type ? '(' + type + ')' : '') + ' ' + JSON.stringify(label))
  }
  const text = (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 12000)
  return { title: document.title, url: location.href, items, text, scroll: Math.round(scrollY), height: document.body ? document.body.scrollHeight : 0 }
})()`

async function snapshot(w: BrowserWindow, withText = true): Promise<string> {
  const s = await w.webContents.executeJavaScript(SNAPSHOT_JS, true)
  return `Страница: ${s.title}\nURL: ${s.url}\nПрокрутка: ${s.scroll} из ${s.height}px\n\n` +
    `Элементы (используй номер в browser_click / browser_type):\n${s.items.join('\n') || '(нет)'}` +
    (withText ? `\n\nТекст страницы:\n${s.text}` : '')
}

export async function open(url: string): Promise<string> {
  const w = view()
  if (!/^[a-z]+:/i.test(url)) url = 'https://' + url
  try {
    await w.loadURL(url, { userAgent: w.webContents.getUserAgent().replace(/Electron\/\S+\s?/, '') })
  } catch (e) {
    // ERR_ABORTED при редиректах — не ошибка, страница всё равно грузится
    if (!/ERR_ABORTED/.test(String(e))) throw e
  }
  await settle(w)
  return snapshot(w)
}

export async function click(index: number): Promise<string> {
  const w = view()
  const ok = await w.webContents.executeJavaScript(`(() => { const el = document.querySelector('[data-va="${Number(index)}"]');
    if (!el) return false; el.scrollIntoView({ block: 'center' }); el.focus(); el.click(); return true })()`, true)
  if (!ok) return `Элемент [${index}] не найден — сначала обнови список через browser_read`
  await settle(w, 1000)
  return snapshot(w, false) + '\n\n(Текст страницы — через browser_read)'
}

export async function type(index: number, text: string, submit: boolean): Promise<string> {
  const w = view()
  const ok = await w.webContents.executeJavaScript(`(() => { const el = document.querySelector('[data-va="${Number(index)}"]');
    if (!el) return false; el.scrollIntoView({ block: 'center' }); el.focus();
    if ('value' in el) { const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ''); el.dispatchEvent(new Event('input', { bubbles: true })) }
    return true })()`, true)
  if (!ok) return `Элемент [${index}] не найден`
  await w.webContents.insertText(text)
  if (submit) {
    w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
    w.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
    w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
    await settle(w, 1200)
  }
  return snapshot(w, false)
}

export async function scroll(direction: 'down' | 'up'): Promise<string> {
  const w = view()
  await w.webContents.executeJavaScript(`scrollBy(0, ${direction === 'up' ? -1 : 1} * innerHeight * 0.85)`, true)
  await sleep(500)
  return snapshot(w)
}

export async function back(): Promise<string> {
  const w = view()
  if (w.webContents.navigationHistory.canGoBack()) w.webContents.navigationHistory.goBack()
  await settle(w)
  return snapshot(w)
}

export const read = () => snapshot(view())

/** Скриншот видимой части страницы: файл PNG для ленты и для модели со зрением. */
export async function screenshot(): Promise<string> {
  const w = view()
  const img = await w.webContents.capturePage()
  mkdirSync(SHOTS, { recursive: true })
  const file = join(SHOTS, `shot-${Date.now()}.png`)
  writeFileSync(file, img.resize({ width: 1280 }).toPNG())
  return file
}

export function close() {
  win?.destroy()
  win = null
}
