import { Brain, CheckCircle2, Clock, Loader2, Pencil, Play, Plug, Plus, Send, ShieldAlert, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { McpServer, McpStatus, Schedule, Settings } from '@shared/types'
import { refreshMemories, saveSettings, toast } from '../lib/actions'
import { api } from '../lib/api'
import { RunpodSpendBlock } from './RunpodSpend'
import { useApp } from '../lib/store'

const newId = () => Math.random().toString(36).slice(2, 10)
const errText = (e: unknown) => String((e as Error)?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

function Switch({ title, sub, on, onChange }: { title: string; sub?: string; on: boolean; onChange(v: boolean): void }) {
  return (
    <div className="toggle-row" onClick={() => onChange(!on)}>
      <div className="t"><b>{title}</b>{sub && <span>{sub}</span>}</div>
      <button className={`switch ${on ? 'on' : ''}`} />
    </div>
  )
}

// ---------------------------------------------------------------- память

export function MemoryTab({ settings }: { settings: Settings }) {
  const items = useApp((s) => s.memories)
  const [text, setText] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  useEffect(() => {
    refreshMemories()
  }, [])
  return (
    <>
      <h3>Память</h3>
      <Switch title="Память между чатами" sub="Агент учитывает эти факты в новых чатах. В каждом чате память можно выключить кнопкой в поле ввода."
        on={settings.memory_enabled} onChange={(v) => saveSettings({ memory_enabled: v })} />
      <div className="hint" style={{ margin: '4px 0 14px', fontSize: 13, color: 'var(--text-2)' }}>
        Агент сам ничего не сохраняет — он только предлагает «Запомнить?», а решаете вы.
      </div>
      {items.map((m) => (
        <div key={m.id} className="list-row">
          <Brain size={15} />
          {editing === m.id ? (
            <input className="input" autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
              onBlur={async () => {
                await api.memory.update(m.id, draft)
                setEditing(null)
                refreshMemories()
              }} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
          ) : <div style={{ flex: 1, fontSize: 13.5 }}>{m.text}</div>}
          <button className="icon-btn sm" title="Изменить" onClick={() => {
            setEditing(m.id)
            setDraft(m.text)
          }}><Pencil size={14} /></button>
          <button className="icon-btn sm" title="Забыть" onClick={async () => {
            await api.memory.remove(m.id)
            refreshMemories()
          }}><Trash2 size={14} /></button>
        </div>
      ))}
      <div className="row-end">
        <input className="input" placeholder="Добавить факт: например, «Мой сервер — Ubuntu 24, сайт на nginx»" value={text}
          onChange={(e) => setText(e.target.value)} onKeyDown={async (e) => {
            if (e.key === 'Enter' && text.trim()) {
              await api.memory.add(text.trim())
              setText('')
              refreshMemories()
            }
          }} />
        <button className="btn" disabled={!text.trim()} onClick={async () => {
          await api.memory.add(text.trim())
          setText('')
          refreshMemories()
        }}><Plus size={15} />Добавить</button>
      </div>
    </>
  )
}

// ---------------------------------------------------------------- подключения MCP

const PRESETS: { name: string; command: string; env?: Record<string, string>; hint: string }[] = [
  { name: 'GitHub', command: 'npx -y @modelcontextprotocol/server-github', env: { GITHUB_PERSONAL_ACCESS_TOKEN: '$GITHUB_TOKEN' }, hint: 'Репозитории, issues, pull request. Нужен секрет GITHUB_TOKEN.' },
  { name: 'SQLite', command: 'npx -y mcp-server-sqlite-npx ~/data.db', hint: 'Запросы к базе SQLite (укажите путь к файлу).' },
  { name: 'PostgreSQL', command: 'npx -y @modelcontextprotocol/server-postgres postgresql://user:pass@localhost/db', hint: 'Запросы к PostgreSQL только на чтение.' },
  { name: 'Память-граф', command: 'npx -y @modelcontextprotocol/server-memory', hint: 'База знаний в виде графа сущностей.' },
  { name: 'Docker', command: 'npx -y docker-mcp', hint: 'Контейнеры, образы, логи.' },
]

function McpForm({ initial, onDone }: { initial: McpServer; onDone(s: McpServer | null): void }) {
  const [s, setS] = useState(initial)
  const [env, setEnv] = useState(Object.entries(initial.env || {}).map(([k, v]) => `${k}=${v}`).join('\n'))
  const [test, setTest] = useState<McpStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const full = (): McpServer => ({ ...s, args: undefined, env: Object.fromEntries(env.split('\n').map((l) => l.trim()).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])) })
  return (
    <div className="side-card server-form">
      <div className="grid2">
        <div className="field"><label>Название</label><input className="input" value={s.name} onChange={(e) => setS({ ...s, name: e.target.value })} /></div>
        <div className="field"><label>Без вопросов</label>
          <Switch title="Доверять" sub="вызовы без окна разрешения" on={!!s.trusted} onChange={(v) => setS({ ...s, trusted: v })} />
        </div>
      </div>
      <div className="field"><label>Команда запуска</label>
        <input className="input mono" value={s.command} placeholder="npx -y @modelcontextprotocol/server-github" onChange={(e) => setS({ ...s, command: e.target.value })} />
      </div>
      <div className="field"><label>Переменные окружения</label>
        <textarea className="textarea mono" style={{ minHeight: 60 }} value={env} placeholder={'API_KEY=$MY_SECRET'} onChange={(e) => setEnv(e.target.value)} />
        <div className="hint">По одной на строку. <code>$ИМЯ</code> — подставить секрет из «Серверы и секреты».</div>
      </div>
      {test && <div className={`test-result ${test.connected ? 'ok' : 'err'}`}>{test.connected ? <CheckCircle2 size={15} /> : <ShieldAlert size={15} />}
        {test.connected ? `Подключено. Инструменты (${test.tools.length}): ${test.tools.slice(0, 12).join(', ')}${test.tools.length > 12 ? '…' : ''}` : test.error}</div>}
      <div className="row-end">
        <button className="btn" disabled={!s.command.trim() || busy} onClick={async () => {
          setBusy(true)
          setTest(await api.mcp.test(full()))
          setBusy(false)
        }}>{busy ? <Loader2 size={14} className="spin" /> : <Plug size={14} />}Проверить</button>
        <div style={{ flex: 1 }} />
        <button className="btn ghost" onClick={() => onDone(null)}>Отмена</button>
        <button className="btn primary" disabled={!s.name.trim() || !s.command.trim()} onClick={() => onDone(full())}>Сохранить</button>
      </div>
    </div>
  )
}

export function McpTab({ settings }: { settings: Settings }) {
  const list = settings.mcp_servers || []
  const [editing, setEditing] = useState<McpServer | null>(null)
  const [status, setStatus] = useState<McpStatus[]>([])
  useEffect(() => {
    api.mcp.status().then(setStatus)
  }, [settings.mcp_servers])
  const save = async (s: McpServer | null) => {
    if (s) await saveSettings({ mcp_servers: list.some((x) => x.id === s.id) ? list.map((x) => (x.id === s.id ? s : x)) : [...list, s] })
    setEditing(null)
  }
  return (
    <>
      <h3>Подключения (MCP)</h3>
      <div className="hint" style={{ marginBottom: 14, fontSize: 13, color: 'var(--text-2)' }}>
        Внешние инструменты по стандарту MCP: агент получает их возможности (GitHub, базы данных, Docker и сотни других).
        Готовые серверы ищите на github.com/modelcontextprotocol/servers.
      </div>
      {list.map((s) => {
        const st = status.find((x) => x.id === s.id)
        return editing?.id === s.id ? <McpForm key={s.id} initial={s} onDone={save} /> : (
          <div key={s.id} className="list-row">
            <Plug size={15} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <b>{s.name}</b>{s.trusted && <span className="tag" style={{ marginLeft: 6 }}>без вопросов</span>}
              <div className="sub" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {st?.error ? `⚠ ${st.error}` : st?.connected ? `подключено · инструментов: ${st.tools.length}` : s.command}
              </div>
            </div>
            <button className={`switch ${s.enabled ? 'on' : ''}`} title={s.enabled ? 'Выключить' : 'Включить'}
              onClick={() => saveSettings({ mcp_servers: list.map((x) => (x.id === s.id ? { ...x, enabled: !x.enabled } : x)) })} />
            <button className="icon-btn sm" onClick={() => setEditing(s)}><Pencil size={14} /></button>
            <button className="icon-btn sm" onClick={() => saveSettings({ mcp_servers: list.filter((x) => x.id !== s.id) })}><Trash2 size={14} /></button>
          </div>
        )
      })}
      {editing && !list.some((x) => x.id === editing.id) && <McpForm initial={editing} onDone={save} />}
      {!editing && (
        <>
          <div className="list-title" style={{ margin: '16px 0 8px' }}>Добавить</div>
          <div className="presets">
            {PRESETS.map((p) => (
              <button key={p.name} className="preset" title={p.hint} onClick={() => setEditing({ id: newId(), name: p.name, command: p.command, env: p.env, enabled: true })}>
                <b>{p.name}</b><span>{p.hint}</span>
              </button>
            ))}
            <button className="preset" onClick={() => setEditing({ id: newId(), name: '', command: '', enabled: true })}><b>Свой сервер</b><span>Любая команда, запускающая MCP-сервер</span></button>
          </div>
        </>
      )}
    </>
  )
}

// ---------------------------------------------------------------- Telegram

export function TelegramTab({ settings }: { settings: Settings }) {
  const [st, setSt] = useState<{ running: boolean; error: string; bot?: string; code: string } | null>(null)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const load = () => api.telegram.status().then(setSt)
  useEffect(() => {
    load()
    const t = setInterval(load, 3000)
    return () => clearInterval(t)
  }, [])
  const tg = settings.telegram || { enabled: false }
  return (
    <>
      <h3>Telegram</h3>
      <div className="hint" style={{ marginBottom: 14, fontSize: 13, color: 'var(--text-2)' }}>
        Пишите агенту задачи с телефона — текстом или голосом. Он выполнит их на этом компьютере, пришлёт ответ, картинки,
        а разрешения на действия спросит кнопками. Компьютер и приложение должны быть включены.
      </div>
      {!st?.bot ? (
        <>
          <ol className="steps-list">
            <li>Откройте в Telegram <b>@BotFather</b>, отправьте <code>/newbot</code> и придумайте имя.</li>
            <li>Скопируйте токен, который он пришлёт, и вставьте сюда:</li>
          </ol>
          <div className="row-end">
            <input className="input mono" type="password" placeholder="1234567890:AA…" value={token} onChange={(e) => setToken(e.target.value)} />
            <button className="btn primary" disabled={!token.trim() || busy} onClick={async () => {
              setBusy(true)
              try {
                const name = await api.telegram.setToken(token)
                toast(`Бот @${name} подключён`, 'ok')
                setToken('')
                load()
              } catch (e) {
                toast(errText(e), 'error')
              }
              setBusy(false)
            }}>{busy ? <Loader2 size={14} className="spin" /> : <Send size={14} />}Подключить</button>
          </div>
        </>
      ) : (
        <div className="side-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Send size={18} style={{ color: 'var(--accent)' }} />
            <div style={{ flex: 1 }}>
              <b>@{st.bot}</b>
              <div className="sub">{st.error ? `⚠ ${st.error}` : st.running ? 'работает' : 'остановлен'}{tg.chat_id ? ` · привязан к ${tg.name || 'вам'}` : ''}</div>
            </div>
            <button className="btn ghost danger" onClick={async () => {
              await api.telegram.unlink()
              load()
            }}>Отключить</button>
          </div>
          {!tg.chat_id && (
            <div className="pair">
              Откройте бота в Telegram и отправьте ему этот код — так он будет слушаться только вас:
              <div className="pair-code">{st.code}</div>
            </div>
          )}
          {tg.chat_id && <div className="sub" style={{ marginTop: 10 }}>Команды в боте: /new — новый чат, /stop — остановить, /status — что выполняется. Голосовые тоже понимает.</div>}
        </div>
      )}
    </>
  )
}

// ---------------------------------------------------------------- расписание

const EVERY: [Schedule['every'], string][] = [['minutes', 'каждые N минут'], ['hour', 'каждый час'], ['day', 'каждый день'], ['week', 'раз в неделю']]
const DAYS = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб']

function ScheduleForm({ initial, onDone }: { initial: Schedule; onDone(s: Schedule | null): void }) {
  const [s, setS] = useState(initial)
  const projects = useApp((st) => st.projects)
  const upd = (p: Partial<Schedule>) => setS({ ...s, ...p })
  return (
    <div className="side-card server-form">
      <div className="field"><label>Название</label><input className="input" value={s.name} placeholder="Проверка сайта" onChange={(e) => upd({ name: e.target.value })} /></div>
      <div className="field"><label>Что сделать</label>
        <textarea className="textarea" value={s.prompt} placeholder="Открой https://мой-сайт.ru, проверь, что он работает и отвечает быстрее 2 секунд. Если нет — опиши проблему."
          onChange={(e) => upd({ prompt: e.target.value })} />
      </div>
      <div className="grid2">
        <div className="field"><label>Когда</label>
          <select className="input" value={s.every} onChange={(e) => upd({ every: e.target.value as Schedule['every'] })}>
            {EVERY.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </div>
        {s.every === 'minutes' && <div className="field"><label>Минут</label><input className="input" type="number" min={5} value={s.minutes || 60} onChange={(e) => upd({ minutes: Math.max(5, Number(e.target.value) || 60) })} /></div>}
        {(s.every === 'day' || s.every === 'week') && <div className="field"><label>Время</label><input className="input" type="time" value={s.time || '09:00'} onChange={(e) => upd({ time: e.target.value })} /></div>}
      </div>
      {s.every === 'week' && (
        <div className="field"><label>День недели</label>
          <div className="seg">{DAYS.map((d, i) => <button key={d} className={(s.weekday ?? 1) === i ? 'on' : ''} onClick={() => upd({ weekday: i })}>{d}</button>)}</div>
        </div>
      )}
      <div className="field"><label>Проект</label>
        <select className="input" value={s.projectId || ''} onChange={(e) => upd({ projectId: e.target.value || undefined })}>
          <option value="">Общий (без проекта)</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      <Switch title="Разрешать действия без вопросов" sub="Иначе всё, что требует разрешения, будет отклонено. Опасные команды не выполняются никогда." on={s.auto_approve} onChange={(v) => upd({ auto_approve: v })} />
      <Switch title="Присылать результат в Telegram" on={s.telegram} onChange={(v) => upd({ telegram: v })} />
      <div className="row-end">
        <div style={{ flex: 1 }} />
        <button className="btn ghost" onClick={() => onDone(null)}>Отмена</button>
        <button className="btn primary" disabled={!s.name.trim() || !s.prompt.trim()} onClick={() => onDone(s)}>Сохранить</button>
      </div>
    </div>
  )
}

function when(s: Schedule) {
  const days = ['воскресенье', 'понедельник', 'вторник', 'среду', 'четверг', 'пятницу', 'субботу']
  if (s.every === 'minutes') return `каждые ${s.minutes || 60} мин`
  if (s.every === 'hour') return 'каждый час'
  if (s.every === 'week') return `каждую ${days[s.weekday ?? 1]} в ${s.time || '09:00'}`
  return `каждый день в ${s.time || '09:00'}`
}

export function SchedulesTab({ settings }: { settings: Settings }) {
  const list = settings.schedules || []
  const [editing, setEditing] = useState<Schedule | null>(null)
  const save = async (s: Schedule | null) => {
    if (s) await saveSettings({ schedules: list.some((x) => x.id === s.id) ? list.map((x) => (x.id === s.id ? s : x)) : [...list, s] })
    setEditing(null)
  }
  return (
    <>
      <h3>Расписание</h3>
      <div className="hint" style={{ marginBottom: 14, fontSize: 13, color: 'var(--text-2)' }}>
        Агент сам выполняет задачи в нужное время: проверки сайтов, отчёты, бэкапы. Каждый запуск — отдельный чат «⏰ …».
        Работает, пока приложение запущено; включите «Работать в фоне» в оформлении, чтобы оно стартовало вместе с системой.
      </div>
      {list.map((s) => editing?.id === s.id ? <ScheduleForm key={s.id} initial={s} onDone={save} /> : (
        <div key={s.id} className="list-row">
          <Clock size={15} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <b>{s.name}</b>
            <div className="sub">{when(s)}{s.last ? ` · последний запуск ${new Date(s.last * 1000).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}{s.telegram ? ' · в Telegram' : ''}</div>
          </div>
          <button className={`switch ${s.enabled ? 'on' : ''}`} onClick={() => saveSettings({ schedules: list.map((x) => (x.id === s.id ? { ...x, enabled: !x.enabled } : x)) })} />
          <button className="icon-btn sm" title="Запустить сейчас" onClick={() => {
            api.schedules.run(s.id)
            toast(`Запускаю «${s.name}»`, 'ok')
          }}><Play size={14} /></button>
          <button className="icon-btn sm" onClick={() => setEditing(s)}><Pencil size={14} /></button>
          <button className="icon-btn sm" onClick={() => saveSettings({ schedules: list.filter((x) => x.id !== s.id) })}><Trash2 size={14} /></button>
        </div>
      ))}
      {editing && !list.some((x) => x.id === editing.id) && <ScheduleForm initial={editing} onDone={save} />}
      {!editing && (
        <button className="btn" onClick={() => setEditing({ id: newId(), name: '', prompt: '', every: 'day', time: '09:00', enabled: true, auto_approve: false, telegram: false, created: Date.now() / 1000 })}>
          <Plus size={15} />Новая задача
        </button>
      )}
    </>
  )
}

// ---------------------------------------------------------------- дополнительные настройки агента

export function AgentExtras({ settings }: { settings: Settings }) {
  const models = useApp((s) => s.models.text)
  return (
    <>
      <div className="field">
        <label>Быстрая модель для помощников и сводок</label>
        <select className="input" value={settings.fast_model} onChange={(e) => saveSettings({ fast_model: e.target.value })}>
          <option value="">та же, что в чате</option>
          {models.filter((m) => m.tools).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        <div className="hint">Помощники изучают части проекта параллельно, а длинный чат сжимается в сводку — дешёвая модель экономит деньги.</div>
      </div>
      <Switch title="Git: ветка на чат и коммит после ответа" sub="Если папка проекта — git-репозиторий. Слить или отправить ветку можно во вкладке Git справа."
        on={settings.git_auto} onChange={(v) => saveSettings({ git_auto: v })} />
      <Switch title="Браузер без вопросов" sub="Клики и ввод текста на сайтах — без окна разрешения" on={settings.browser_auto} onChange={(v) => saveSettings({ browser_auto: v })} />
      <Switch title="Уведомления" sub="Когда задача готова или нужно разрешение, а окно свёрнуто" on={settings.notifications} onChange={(v) => saveSettings({ notifications: v })} />
    </>
  )
}

export function BackgroundSwitch({ settings }: { settings: Settings }) {
  return (
    <>
      <Switch title="Работать в фоне" sub="Запуск вместе с системой; закрытие окна только прячет его — работают расписание и Telegram"
        on={settings.autostart} onChange={(v) => saveSettings({ autostart: v })} />
      {settings.autostart && <button className="btn ghost danger" onClick={() => api.quit()}>Выйти из Mouse King Pro полностью</button>}
    </>
  )
}

/** RunPod: ключ (шифруется), ID эндпоинта, баланс и состояние видеокарт для «Картинки Pro». */
/** Ключ WaveSpeedAI — для Qwen Image 3 Pro в «Картинке Pro». */
function WavespeedBlock() {
  const [st, setSt] = useState<{ key: boolean; balance: number | null } | null>(null)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const load = () => api.wavespeed.status().then(setSt).catch(() => setSt(null))
  useEffect(() => {
    load()
  }, [])
  return (
    <>
      <h3 style={{ marginTop: 26 }}>WaveSpeed</h3>
      <div className="hint" style={{ marginBottom: 14, fontSize: 13, color: 'var(--text-2)' }}>
        Qwen Image 3 Pro (закрытая модель Alibaba) по API: оплата за картинку (~$0.04, 2K — ~$0.08), видеокарта не нужна.
      </div>
      {!st?.key ? (
        <div className="field">
          <label>Ключ API WaveSpeed</label>
          <div className="row-end">
            <input className="input mono" type="password" placeholder="ключ из wavespeed.ai/accesskey" value={key} onChange={(e) => setKey(e.target.value)} />
            <button className="btn primary" disabled={!key.trim() || busy} onClick={async () => {
              setBusy(true)
              try {
                await api.wavespeed.setKey(key)
                setKey('')
                toast('Ключ WaveSpeed сохранён', 'ok')
                load()
              } catch (e) {
                toast(errText(e), 'error')
              }
              setBusy(false)
            }}>{busy ? <Loader2 size={14} className="spin" /> : <CheckCircle2 size={14} />}Сохранить</button>
          </div>
          <div className="hint">wavespeed.ai → Access Keys. Хранится только на этом компьютере, зашифрованным.</div>
        </div>
      ) : (
        <div className="toggle-row">
          <div className="t"><b>Ключ сохранён</b><span>{st.balance != null ? `Баланс WaveSpeed: $${st.balance.toFixed(2)}` : 'Баланс не получен'}</span></div>
          <button className="btn ghost danger" onClick={async () => {
            await api.wavespeed.removeKey()
            load()
          }}><Trash2 size={14} />Удалить ключ</button>
        </div>
      )}
    </>
  )
}

export function RunpodTab({ settings }: { settings: Settings }) {
  const [st, setSt] = useState<Awaited<ReturnType<typeof api.runpod.status>> | null>(null)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(false)
  const load = () => api.runpod.status().then(setSt).catch(() => setSt(null))
  useEffect(() => {
    load()
  }, [settings.runpod_endpoint])
  const check = async () => {
    setChecking(true)
    try {
      const r = await api.runpod.status()
      setSt(r)
      if (!r.key) toast('Сначала сохраните ключ RunPod', 'error')
      else if (!r.endpoint) toast('Укажите ID эндпоинта', 'error')
      else if (r.error) toast(`Эндпоинт не отвечает: ${r.error}`, 'error')
      else toast(`RunPod подключён${r.balance != null ? ` · баланс $${r.balance.toFixed(2)}` : ''}`, 'ok')
    } catch (e) {
      setSt(null)
      toast(errText(e), 'error')
    }
    setChecking(false)
  }
  const w = st?.health?.workers
  const sleeping = !!w && !(w.running || w.idle || w.initializing)
  return (
    <>
      <h3>RunPod</h3>
      <div className="hint" style={{ marginBottom: 14, fontSize: 13, color: 'var(--text-2)' }}>
        Свой сервер с моделями для «Картинки Pro». Видеокарта включается только на время генерации и сама выключается —
        деньги списываются посекундно, без запросов — только хранение моделей на диске.
      </div>
      {!st?.key ? (
        <div className="field">
          <label>Ключ API RunPod</label>
          <div className="row-end">
            <input className="input mono" type="password" placeholder="rpa_…" value={key} onChange={(e) => setKey(e.target.value)} />
            <button className="btn primary" disabled={!key.trim() || busy} onClick={async () => {
              setBusy(true)
              try {
                await api.runpod.setKey(key)
                setKey('')
                toast('Ключ RunPod сохранён', 'ok')
                load()
              } catch (e) {
                toast(errText(e), 'error')
              }
              setBusy(false)
            }}>{busy ? <Loader2 size={14} className="spin" /> : <CheckCircle2 size={14} />}Сохранить</button>
          </div>
          <div className="hint">RunPod → Settings → API Keys. Хранится только на этом компьютере, зашифрованным.</div>
        </div>
      ) : (
        <div className="toggle-row">
          <div className="t"><b>Ключ сохранён</b><span>{st.balance != null ? `Баланс RunPod: $${st.balance.toFixed(2)}` : 'Баланс не получен'}</span></div>
          <button className="btn ghost danger" onClick={async () => {
            await api.runpod.removeKey()
            load()
          }}><Trash2 size={14} />Удалить ключ</button>
        </div>
      )}
      <div className="field">
        <label>ID эндпоинта (Serverless)</label>
        <input className="input mono" placeholder="например, abc123xyz" defaultValue={settings.runpod_endpoint}
          onBlur={(e) => e.target.value.trim() !== settings.runpod_endpoint && saveSettings({ runpod_endpoint: e.target.value.trim() })} />
        <div className="hint">
          {st?.error ? `Ошибка: ${st.error}`
            : sleeping ? '✓ Эндпоинт отвечает. Видеокарты сейчас выключены — это нормально: включатся сами при первом запросе (первый запуск — до 1–2 минут).'
            : w ? `✓ Эндпоинт отвечает. Видеокарты: работают ${w.running ?? 0}, готовы ${w.idle ?? 0}, запускаются ${w.initializing ?? 0} · в очереди ${st?.health?.jobs?.inQueue ?? 0}`
              : 'Serverless → ваш эндпоинт → ID в адресе страницы.'}
        </div>
      </div>
      <button className="btn" disabled={checking} onClick={check}>
        {checking ? <Loader2 size={14} className="spin" /> : <Play size={14} />}{checking ? 'Проверяю…' : 'Проверить подключение'}
      </button>
      {st?.key && <RunpodSpendBlock refresh={st} />}
      <WavespeedBlock />
    </>
  )
}
