// Mouse King Pro — Браузер (расширение для Firefox): связь с приложением на этом компьютере (ws://127.0.0.1:47613).
// Приложение присылает команды {id, cmd, args}, расширение отвечает {id, ok, result | error}.
// Подключение принимается только с токеном, выданным приложением при сопряжении.
'use strict'

const URL_WS = 'ws://127.0.0.1:47613'
let ws = null
let token = null
let state = 'offline' // offline | unpaired | connected

function setState(s) {
  state = s
  browser.browserAction.setBadgeText({ text: s === 'connected' ? '' : s === 'unpaired' ? '?' : '!' })
  browser.browserAction.setBadgeBackgroundColor({ color: s === 'unpaired' ? '#d97706' : '#9ca3af' })
  browser.runtime.sendMessage({ type: 'state', state: s }).catch(() => {})
}

function connect() {
  try {
    ws = new WebSocket(URL_WS)
  } catch {
    return setTimeout(connect, 3000)
  }
  ws.onopen = async () => {
    const info = await browser.runtime.getBrowserInfo()
    ws.send(JSON.stringify({ type: 'hello', token, version: browser.runtime.getManifest().version, browser: info.version }))
  }
  ws.onmessage = async (e) => {
    let m
    try {
      m = JSON.parse(e.data)
    } catch {
      return
    }
    if (m.type === 'paired') {
      token = m.token
      await browser.storage.local.set({ token })
      setState('connected')
    } else if (m.type === 'ok') setState('connected')
    else if (m.type === 'unpaired') {
      token = null
      await browser.storage.local.remove('token')
      setState('unpaired')
    } else if (m.id) {
      try {
        const result = await handle(m.cmd, m.args || {})
        ws.send(JSON.stringify({ id: m.id, ok: true, result }))
      } catch (err) {
        ws.send(JSON.stringify({ id: m.id, ok: false, error: friendly(err) }))
      }
    }
  }
  ws.onclose = () => {
    ws = null
    if (state !== 'unpaired') setState('offline')
    setTimeout(connect, 3000)
  }
}

function friendly(err) {
  const t = String((err && err.message) || err)
  if (/Missing host permission|cannot access|about:|moz-extension|privileged/i.test(t))
    return 'Firefox не даёт расширениям доступ к этой странице (служебные страницы, about:, магазин дополнений). ' + t
  return t
}

// ---------------------------------------------------------------- вкладки

async function tabOf(tabId) {
  if (tabId != null) return browser.tabs.get(Number(tabId))
  const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true })
  if (!tab) throw new Error('Нет активной вкладки')
  return tab
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Дождаться загрузки вкладки (до 15 с) и ещё немного — на скрипты страницы. */
async function settle(tabId, extra = 800) {
  await sleep(300)
  const until = Date.now() + 15000
  while (Date.now() < until) {
    const t = await browser.tabs.get(tabId).catch(() => null)
    if (!t || t.status === 'complete') break
    await sleep(200)
  }
  await sleep(extra)
}

async function run(tabId, code) {
  const [r] = await browser.tabs.executeScript(tabId, { code, runAt: 'document_idle' })
  return r
}

// В странице: нумеруем видимые интерактивные элементы и собираем текст (как браузер агента в приложении).
const SNAPSHOT = `(() => {
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

async function snapshot(tabId) {
  const s = await run(tabId, SNAPSHOT)
  return { ...s, tabId }
}

const CLICK = (i) => `(() => { const el = document.querySelector('[data-va="${Number(i)}"]');
  if (!el) return false; el.scrollIntoView({ block: 'center' }); el.focus(); el.click(); return true })()`

const TYPE = (i, text, submit) => `(() => { const el = document.querySelector('[data-va="${Number(i)}"]');
  if (!el) return false; el.scrollIntoView({ block: 'center' }); el.focus();
  const text = ${JSON.stringify(String(text))};
  if (el.isContentEditable) { el.textContent = text; el.dispatchEvent(new InputEvent('input', { bubbles: true })) }
  else if ('value' in el) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  if (${submit ? 'true' : 'false'}) {
    const o = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    const go = el.dispatchEvent(new KeyboardEvent('keydown', o)); el.dispatchEvent(new KeyboardEvent('keypress', o)); el.dispatchEvent(new KeyboardEvent('keyup', o));
    if (go && el.form) { el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit() }
  }
  return true })()`

async function handle(cmd, a) {
  switch (cmd) {
    case 'tabs': {
      const [focused] = await browser.tabs.query({ active: true, lastFocusedWindow: true })
      const list = await browser.tabs.query({})
      list.sort((x, y) => (y.id === focused?.id) - (x.id === focused?.id))
      return list.map((t) => ({ id: t.id, windowId: t.windowId, active: t.active, title: t.title, url: t.url }))
    }
    case 'read':
      return snapshot((await tabOf(a.tabId)).id)
    case 'click': {
      const tab = await tabOf(a.tabId)
      if (!(await run(tab.id, CLICK(a.index)))) throw new Error(`Элемент [${a.index}] не найден — сначала обнови список через firefox_read`)
      await settle(tab.id, 1000)
      return snapshot(tab.id)
    }
    case 'type': {
      const tab = await tabOf(a.tabId)
      if (!(await run(tab.id, TYPE(a.index, a.text, a.submit)))) throw new Error(`Поле [${a.index}] не найдено — сначала обнови список через firefox_read`)
      await settle(tab.id, a.submit ? 1200 : 300)
      return snapshot(tab.id)
    }
    case 'scroll': {
      const tab = await tabOf(a.tabId)
      await run(tab.id, `scrollBy(0, ${a.direction === 'up' ? -1 : 1} * innerHeight * 0.85)`)
      await sleep(500)
      return snapshot(tab.id)
    }
    case 'back': {
      const tab = await tabOf(a.tabId)
      await browser.tabs.goBack(tab.id)
      await settle(tab.id)
      return snapshot(tab.id)
    }
    case 'open': {
      const tab = a.newTab ? await browser.tabs.create({ url: a.url, active: true }) : await browser.tabs.update((await tabOf()).id, { url: a.url })
      await settle(tab.id)
      return snapshot(tab.id)
    }
    case 'close':
      await browser.tabs.remove(Number(a.tabId))
      return true
    case 'screenshot': {
      const tab = await tabOf(a.tabId)
      if (!tab.active) {
        await browser.tabs.update(tab.id, { active: true })
        await sleep(400)
      }
      const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 88 })
      return { dataUrl }
    }
    default:
      throw new Error('Неизвестная команда: ' + cmd)
  }
}

browser.runtime.onMessage.addListener((m) => {
  if (m && m.type === 'getState') return Promise.resolve({ state })
})

browser.storage.local.get('token').then((r) => {
  token = r.token || null
  setState('offline')
  connect()
})
