import {
  CheckCircle2, Cpu, Download, ExternalLink, Eye, EyeOff, FileText, FolderKanban, KeyRound, MessageSquare,
  Brain, Clock, LogOut, Plug, Send, SquareTerminal,
  Mic, Moon, Palette as PaletteIcon, Plus, Search, Server as ServerIcon, Settings2, ShieldAlert, ShieldCheck, Sun, Terminal, UserPen, Wallet, X, Copy, Crown,
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { money } from '@shared/pricing'
import type { SearchHit, Settings } from '@shared/types'
import { answerApproval, copyImage, isCopyKey, newChat, openChat, openProject, saveSettings } from '../lib/actions'
import { api } from '../lib/api'
import { ago, fileUrl } from '../lib/format'
import { set, useApp } from '../lib/store'
import { Modal, spring } from './Modal'
import { InstallButton, UpdateRow, LimitsTab, SafeCommands, ServersTab, VoiceTab } from './SettingsExtra'
import { AgentExtras, BackgroundSwitch, McpTab, MemoryTab, RunpodTab, SchedulesTab, TelegramTab } from './SettingsMore'

// ================================================================ настройки

function Toggle({ title, sub, on, onChange }: { title: string; sub?: string; on: boolean; onChange(v: boolean): void }) {
  return (
    <div className="toggle-row" onClick={() => onChange(!on)}>
      <div className="t"><b>{title}</b>{sub && <span>{sub}</span>}</div>
      <button className={`switch ${on ? 'on' : ''}`} aria-pressed={on} />
    </div>
  )
}

function Seg<T extends string>({ value, options, onChange }: { value: T; options: [T, ReactNode][]; onChange(v: T): void }) {
  return (
    <div className="seg">
      {options.map(([k, label]) => (
        <button key={k} className={value === k ? 'on' : ''} onClick={() => onChange(k)}>
          {value === k && <motion.span layoutId={`seg-${options.map((o) => o[0]).join()}`} className="mode-pill" transition={{ type: 'spring', stiffness: 500, damping: 36 }} />}
          {label}
        </button>
      ))}
    </div>
  )
}

function ThemePreview({ dark }: { dark: boolean }) {
  const c = dark ? { s: '#131210', m: '#1b1a18', l: '#3a3834', a: '#df7a54' } : { s: '#ece9e2', m: '#fbfaf7', l: '#ddd8ce', a: '#c8613c' }
  return (
    <div className="theme-prev" style={{ background: c.m }}>
      <div className="s" style={{ background: c.s }} />
      <div className="m">
        <div className="l" style={{ background: c.a, width: '40%' }} />
        <div className="l" style={{ background: c.l, width: '85%' }} />
        <div className="l" style={{ background: c.l, width: '65%' }} />
      </div>
    </div>
  )
}

export function SettingsDialog() {
  const open = useApp((s) => s.settingsOpen)
  const settings = useApp((s) => s.settings)
  const balance = useApp((s) => s.balance)
  const models = useApp((s) => s.models)
  const [tab, setTab] = useState('account')
  const [key, setKey] = useState('')
  const [show, setShow] = useState(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => {
    if (open) setKey(settings?.api_key || '')
  }, [open])
  if (!settings) return null
  const upd = (patch: Partial<Settings>) => saveSettings(patch)
  const close = () => {
    if (key !== settings.api_key) upd({ api_key: key.trim() })
    set({ settingsOpen: false })
  }
  const total = models.text.length + models.image.length + models.video.length
  const tabs: [string, string, ReactNode][] = [
    ['account', 'Аккаунт', <KeyRound size={16} />], ['instructions', 'Ваши инструкции', <UserPen size={16} />],
    ['look', 'Оформление', <PaletteIcon size={16} />],
    ['agent', 'Агент', <Cpu size={16} />], ['safety', 'Безопасность', <ShieldCheck size={16} />],
    ['servers', 'Серверы и секреты', <ServerIcon size={16} />], ['limits', 'Расходы', <Wallet size={16} />],
    ['voice', 'Голос', <Mic size={16} />], ['memory', 'Память', <Brain size={16} />],
    ['mcp', 'Подключения (MCP)', <Plug size={16} />], ['telegram', 'Telegram', <Send size={16} />], ['runpod', 'RunPod / WaveSpeed', <Crown size={16} />],
    ['schedules', 'Расписание', <Clock size={16} />],
  ]
  return (
    <Modal open={open} onClose={close} className="wide" title="Настройки">
      <div className="settings">
        <div className="settings-nav">
          {tabs.map(([k, label, icon]) => (
            <button key={k} className={`nav-btn ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>
              <span className="nav-icon">{icon}</span>{label}
            </button>
          ))}
        </div>
        <div className="settings-main">
          <AnimatePresence mode="wait">
            <motion.div key={tab} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -8 }} transition={{ duration: 0.15 }}>
              {tab === 'account' && <>
                <h3>Аккаунт Venice</h3>
                <div className="field">
                  <label>API-ключ</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input className="input" type={show ? 'text' : 'password'} value={key} placeholder="VENICE_INFERENCE_KEY_…"
                      onChange={(e) => setKey(e.target.value)} onBlur={() => key !== settings.api_key && upd({ api_key: key.trim() })} />
                    <button className="btn" onClick={() => setShow(!show)}>{show ? <EyeOff size={15} /> : <Eye size={15} />}</button>
                  </div>
                  <div className="hint">Ключ хранится только на этом компьютере. Получить: venice.ai/settings/api</div>
                </div>
                <div className="field">
                  <label>Как к вам обращаться</label>
                  <input className="input" defaultValue={settings.user_name || ''} placeholder={api.userName}
                    onBlur={(e) => upd({ user_name: e.target.value.trim() || undefined })} />
                </div>
                <div className="side-card" style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, color: 'var(--muted)' }}>Баланс API</div>
                    <div style={{ font: '600 24px var(--sans)' }}>{balance?.USD != null ? money(balance.USD) : '—'}</div>
                    <div style={{ fontSize: 12, color: 'var(--muted)' }}>{total ? `Доступно ${total} моделей` : 'Модели не загружены'}</div>
                  </div>
                  <button className="btn" onClick={() => api.shell.external('https://venice.ai/settings/api')}><ExternalLink size={14} />Пополнить</button>
                </div>
              </>}
              {tab === 'instructions' && <>
                <h3>Ваши инструкции</h3>
                <div className="hint" style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 12 }}>
                  Что агенту стоит знать о вас и как отвечать. Учитывается во всех чатах. Если у проекта есть свои
                  инструкции, они добавляются к этим и в спорных местах важнее.
                </div>
                <textarea className="textarea" style={{ minHeight: 280 }} defaultValue={settings.user_instructions || ''}
                  placeholder={'Например:\n— Отвечай на русском, коротко и по делу.\n— Я пишу на Python и TypeScript, работаю в Ubuntu.\n— Код комментируй по-русски, без лишних объяснений очевидного.'}
                  onChange={(e) => {
                    const value = e.target.value
                    clearTimeout(saveTimer.current)
                    saveTimer.current = setTimeout(() => upd({ user_instructions: value }), 500)
                  }} />
                <div className="hint">Сохраняется автоматически.</div>
              </>}
              {tab === 'servers' && <ServersTab settings={settings} />}
              {tab === 'limits' && <LimitsTab settings={settings} />}
              {tab === 'voice' && <VoiceTab settings={settings} />}
              {tab === 'memory' && <MemoryTab settings={settings} />}
              {tab === 'mcp' && <McpTab settings={settings} />}
              {tab === 'telegram' && <TelegramTab settings={settings} />}
              {tab === 'runpod' && <RunpodTab settings={settings} />}
              {tab === 'schedules' && <SchedulesTab settings={settings} />}
              {tab === 'look' && <>
                <h3>Оформление</h3>
                <div className="field">
                  <label>Тема</label>
                  <div className="theme-cards">
                    {([['light', 'Светлая'], ['dark', 'Тёмная'], ['system', 'Как в системе']] as const).map(([k, label]) => (
                      <button key={k} className={`theme-card ${settings.theme === k ? 'on' : ''}`} onClick={() => upd({ theme: k })}>
                        {k === 'system'
                          ? <div className="theme-prev" style={{ border: 0 }}><div style={{ flex: 1 }}><ThemePreview dark={false} /></div><div style={{ flex: 1 }}><ThemePreview dark /></div></div>
                          : <ThemePreview dark={k === 'dark'} />}
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <Toggle title="Боковая панель" sub="Ctrl+B — показать или скрыть" on={settings.sidebar} onChange={(v) => upd({ sidebar: v })} />
                <InstallButton />
                <UpdateRow />
                <BackgroundSwitch settings={settings} />
              </>}
              {tab === 'agent' && <>
                <h3>Агент</h3>
                <div className="field">
                  <label>Креативность: {settings.temperature.toFixed(1)}</label>
                  <input type="range" className="range" min={0} max={1.5} step={0.1} value={settings.temperature}
                    onChange={(e) => upd({ temperature: Number(e.target.value) })} />
                  <div className="hint">Ниже — точнее и предсказуемее, выше — разнообразнее.</div>
                </div>
                <div className="field">
                  <label>Максимум шагов за один ответ</label>
                  <input className="input" type="number" min={1} max={200} style={{ width: 120 }} value={settings.max_steps}
                    onChange={(e) => upd({ max_steps: Math.max(1, Number(e.target.value) || 1) })} />
                </div>
                <div className="field">
                  <label>Бюджет контекста</label>
                  <Seg value={String(settings.context_budget || 200000)} onChange={(v) => upd({ context_budget: Number(v) })}
                    options={[['64000', '64 тыс.'], ['128000', '128 тыс.'], ['200000', '200 тыс.'], ['500000', '500 тыс.']]} />
                  <div className="hint">Сколько истории агент отправляет модели на каждом шаге. Если больше — старые результаты команд и
                    файлов сокращаются. Больше бюджет — агент помнит больше деталей, но каждый шаг дороже.</div>
                </div>
                <div className="field">
                  <label>Вызов инструментов</label>
                  <Seg value={settings.tool_mode} onChange={(v) => upd({ tool_mode: v })}
                    options={[['auto', 'Авто'], ['native', 'Нативно'], ['text', 'Текстом']]} />
                  <div className="hint">«Авто» использует нативные вызовы, если модель их поддерживает.</div>
                </div>
                <div className="field">
                  <label>Встроенный веб-поиск Venice</label>
                  <Seg value={settings.venice_web_search} onChange={(v) => upd({ venice_web_search: v })}
                    options={[['off', 'Выкл'], ['auto', 'Авто'], ['on', 'Всегда']]} />
                  <div className="hint">Агент и без этого умеет искать в интернете своим инструментом.</div>
                </div>
                <AgentExtras settings={settings} />
                <Toggle title="Системный промпт Venice" sub="Добавлять стандартные инструкции Venice к нашим"
                  on={settings.venice_system_prompt} onChange={(v) => upd({ venice_system_prompt: v })} />
              </>}
              {tab === 'safety' && <>
                <h3>Безопасность</h3>
                <div className="side-card" style={{ display: 'flex', gap: 12 }}>
                  <ShieldAlert size={20} style={{ color: 'var(--accent)', flex: 'none' }} />
                  <div style={{ fontSize: 13, color: 'var(--text-2)' }}>
                    Перед записью файлов, запуском команд, распаковкой и скачиванием агент спрашивает разрешение.
                    В окне запроса можно разрешить всё до конца текущего чата.
                  </div>
                </div>
                <Toggle title="Безопасный режим картинок" sub="Venice размывает изображения 18+" on={settings.safe_mode} onChange={(v) => upd({ safe_mode: v })} />
                <SafeCommands settings={settings} />
              </>}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </Modal>
  )
}

// ================================================================ разрешение

function DiffView({ text, command }: { text: string; command: boolean }) {
  if (command) return <div className="diff cmd">{text.split('\n').map((l, i) => <div key={i}>{l}</div>)}</div>
  const isDiff = /^(---|\+\+\+|@@)/m.test(text)
  return (
    <div className="diff">
      {text.split('\n').map((l, i) => {
        const cls = !isDiff ? '' : l.startsWith('@@') ? 'hunk' : l.startsWith('+') && !l.startsWith('+++') ? 'add'
          : l.startsWith('-') && !l.startsWith('---') ? 'del' : ''
        return <div key={i} className={cls}>{l || ' '}</div>
      })}
    </div>
  )
}

export function ApprovalSheet() {
  const req = useApp((s) => s.approvals[0])
  const title = req?.title || ''
  const [kind, path] = title.includes(': ') ? [title.slice(0, title.indexOf(': ')), title.slice(title.indexOf(': ') + 2)] : [title, '']
  const command = title.startsWith('Выполнить команду')
  const icon = command ? <Terminal size={18} /> : title.startsWith('Скачать') ? <Download size={18} /> : <FileText size={18} />
  useEffect(() => {
    if (!req) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !req.danger) answerApproval(req.id, 'yes')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [req?.id])
  return (
    <Modal open={!!req} onClose={() => req && answerApproval(req.id, 'no')} className="approval"
      footer={<>
        <button className="btn ghost" onClick={() => answerApproval(req!.id, 'no')}>Отклонить</button>
        {!req?.danger && <button className="btn" onClick={() => answerApproval(req!.id, 'always')}>Разрешать всё в этом чате</button>}
        {req?.danger
          ? <button className="btn danger-solid" onClick={() => answerApproval(req!.id, 'yes')}><ShieldAlert size={15} />Всё равно выполнить</button>
          : <button className="btn primary" onClick={() => answerApproval(req!.id, 'yes')}><CheckCircle2 size={15} />Разрешить <span className="kbd" style={{ color: 'rgba(255,255,255,.75)', borderColor: 'rgba(255,255,255,.35)' }}>Ctrl ↵</span></button>}
      </>}>
      {req && <>
        <div className="modal-head" style={{ alignItems: 'flex-start' }}>
          <div className={`approval-icon ${req.danger ? 'danger' : ''}`}>{req.danger ? <ShieldAlert size={18} /> : icon}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="approval-title">{kind}</div>
            {path && <div className="approval-sub selectable">{path}</div>}
          </div>
        </div>
        <div className="modal-body">
          {req.danger && (
            <div className="danger-banner">
              <ShieldAlert size={18} />
              <div><b>Опасная команда: {req.danger}.</b><br />
                Она может повредить систему или стереть данные. Выполняйте, только если вы сами об этом просили
                и понимаете, что произойдёт.</div>
            </div>
          )}
          <DiffView text={req.details} command={command} />
        </div>
      </>}
    </Modal>
  )
}

// ================================================================ палитра команд

interface Item { key: string; group: string; icon: ReactNode; label: string; sub?: string; run(): void }

export function Palette() {
  const open = useApp((s) => s.palette)
  const recents = useApp((s) => s.recents)
  const projects = useApp((s) => s.projects)
  const dark = useApp((s) => s.win.dark)
  const [q, setQ] = useState('')
  const [hl, setHl] = useState(0)
  const [hits, setHits] = useState<SearchHit[]>([])
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (q.trim().length < 2) return setHits([])
    let alive = true
    const t = setTimeout(() => api.chats.search(q).then((h) => alive && setHits(h)), 200)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [q])
  useEffect(() => {
    if (open) {
      setQ('')
      setHl(0)
    }
  }, [open])
  const close = () => set({ palette: false })
  const items = useMemo<Item[]>(() => {
    const actions: Item[] = [
      { key: 'new', group: 'Действия', icon: <Plus size={16} />, label: 'Новый чат', sub: 'Ctrl N', run: () => newChat() },
      { key: 'projects', group: 'Действия', icon: <FolderKanban size={16} />, label: 'Проекты', run: () => set({ view: { page: 'projects' } }) },
      { key: 'theme', group: 'Действия', icon: dark ? <Sun size={16} /> : <Moon size={16} />, label: dark ? 'Светлая тема' : 'Тёмная тема', run: () => saveSettings({ theme: dark ? 'light' : 'dark' }) },
      { key: 'settings', group: 'Действия', icon: <Settings2 size={16} />, label: 'Настройки', sub: 'Ctrl ,', run: () => set({ settingsOpen: true }) },
      { key: 'term', group: 'Действия', icon: <SquareTerminal size={16} />, label: 'Терминал', sub: 'Ctrl `', run: () => set((s) => ({ view: { page: 'chat' }, panel: { tab: 'terminal', artifact: s.panel?.artifact } })) },
      { key: 'quit', group: 'Действия', icon: <LogOut size={16} />, label: 'Выйти из Mouse King Pro', run: () => api.quit() },
    ]
    const proj: Item[] = projects.map((p) => ({ key: 'p' + p.id, group: 'Проекты', icon: <FolderKanban size={16} />, label: p.name, run: () => openProject(p.id) }))
    const chats: Item[] = recents.map((c) => ({
      key: 'c' + c.id, group: 'Чаты', icon: <MessageSquare size={16} />, label: c.title || 'Без названия',
      sub: [c.project_name, ago(c.updated)].filter(Boolean).join(' · '), run: () => openChat(c.project_id, c.id),
    }))
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    const match = (i: Item) => words.every((w) => `${i.label} ${i.sub || ''}`.toLowerCase().includes(w))
    const byTitle = chats.filter(match).slice(0, 60)
    const seen = new Set(byTitle.map((c) => c.key))
    const inText: Item[] = hits.filter((h) => !seen.has('c' + h.chat_id)).map((h) => ({
      key: 't' + h.chat_id, group: 'Найдено в тексте чатов', icon: <Search size={16} />, label: h.title || 'Без названия',
      sub: h.snippet, run: () => openChat(h.project_id, h.chat_id),
    }))
    return [...actions.filter(match), ...proj.filter(match), ...byTitle, ...inText]
  }, [q, recents, projects, dark, hits])
  useEffect(() => setHl(0), [q])
  useEffect(() => {
    list.current?.querySelector('.pal-item.hl')?.scrollIntoView({ block: 'nearest' })
  }, [hl])
  const run = (i: Item) => {
    close()
    i.run()
  }
  let lastGroup = ''
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}
          onMouseDown={(e) => e.target === e.currentTarget && close()}>
          <motion.div className="popover palette" style={{ position: 'relative', maxHeight: '60vh' }}
            initial={{ opacity: 0, scale: 0.96, y: -10 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.98 }} transition={spring}>
            <div className="picker-search">
              <Search size={18} />
              <input autoFocus placeholder="Искать чаты, проекты, действия…" value={q} onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') setHl((h) => Math.min(h + 1, items.length - 1))
                  else if (e.key === 'ArrowUp') setHl((h) => Math.max(h - 1, 0))
                  else if (e.key === 'Enter' && items[hl]) run(items[hl])
                  else if (e.key === 'Escape') close()
                  else return
                  e.preventDefault()
                }} />
              <span className="kbd">Esc</span>
            </div>
            <div className="picker-list" ref={list}>
              {items.length === 0 && <div className="picker-empty">Ничего не найдено</div>}
              {items.map((it, i) => {
                const head = it.group !== lastGroup ? <div className="pal-group">{it.group}</div> : null
                lastGroup = it.group
                return (
                  <div key={it.key}>
                    {head}
                    <button className={`pal-item ${i === hl ? 'hl' : ''}`} onMouseMove={() => setHl(i)} onClick={() => run(it)}>
                      {it.icon}<span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.label}</span>
                      {it.sub && <span className="sub">{it.sub}</span>}
                    </button>
                  </div>
                )
              })}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

// ================================================================ лайтбокс и уведомления

export function Lightbox() {
  const src = useApp((s) => s.lightbox)
  useEffect(() => {
    if (!src) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') set({ lightbox: null })
      else if (isCopyKey(e)) {
        e.preventDefault()
        copyImage(src)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [src])
  return (
    <AnimatePresence>
      {src && (
        <motion.div className="lightbox" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => set({ lightbox: null })}>
          <motion.img src={fileUrl(src)} initial={{ scale: 0.92, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }}
            transition={spring} onClick={(e) => e.stopPropagation()} />
          <div className="tools">
            <button title="Копировать картинку (Ctrl+C)" onClick={(e) => {
              e.stopPropagation()
              copyImage(src)
            }}><Copy size={18} /></button>
            <button title="Показать в папке" onClick={(e) => {
              e.stopPropagation()
              api.shell.reveal(src)
            }}><FolderKanban size={18} /></button>
            <button title="Закрыть" onClick={() => set({ lightbox: null })}><X size={18} /></button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts)
  return (
    <div className="toasts">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div key={t.id} className="toast" layout initial={{ opacity: 0, y: 16, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }} transition={spring}>
            {t.kind === 'error' ? <ShieldAlert size={16} style={{ color: 'var(--danger)' }} /> : <CheckCircle2 size={16} />}
            {t.text}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}


