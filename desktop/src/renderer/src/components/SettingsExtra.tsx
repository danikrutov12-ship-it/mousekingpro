import { CheckCircle2, KeyRound, Loader2, Pencil, Plus, RefreshCw, Server as ServerIcon, ShieldAlert, Trash2, Wifi } from 'lucide-react'
import { useEffect, useState } from 'react'
import { money } from '@shared/pricing'
import type { Secret, Server, Settings } from '@shared/types'
import { saveSettings, toast } from '../lib/actions'
import { api } from '../lib/api'
import { set, useApp } from '../lib/store'

const newId = () => Math.random().toString(36).slice(2, 10)

// ---------------------------------------------------------------- серверы

function ServerForm({ initial, onDone }: { initial: Server; onDone(s: Server | null, password?: string): void }) {
  const [s, setS] = useState<Server>(initial)
  const [password, setPassword] = useState('')
  const [test, setTest] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const upd = (patch: Partial<Server>) => setS({ ...s, ...patch })
  const valid = s.name.trim() && s.host.trim() && s.user.trim()
  const runTest = async () => {
    setTesting(true)
    setTest(null)
    if (s.auth === 'password' && password) await api.secrets.set(`server:${s.id}`, password)
    setTest(await api.servers.test(s))
    setTesting(false)
  }
  return (
    <div className="side-card server-form">
      <div className="grid2">
        <div className="field"><label>Название</label><input className="input" value={s.name} placeholder="prod" onChange={(e) => upd({ name: e.target.value })} /></div>
        <div className="field"><label>Адрес</label><input className="input" value={s.host} placeholder="203.0.113.10 или example.com" onChange={(e) => upd({ host: e.target.value.trim() })} /></div>
        <div className="field"><label>Пользователь</label><input className="input" value={s.user} placeholder="root" onChange={(e) => upd({ user: e.target.value.trim() })} /></div>
        <div className="field"><label>Порт</label><input className="input" type="number" value={s.port} onChange={(e) => upd({ port: Number(e.target.value) || 22 })} /></div>
      </div>
      <div className="field">
        <label>Вход</label>
        <div className="seg">
          <button className={s.auth === 'key' ? 'on' : ''} onClick={() => upd({ auth: 'key' })}>SSH-ключ</button>
          <button className={s.auth === 'password' ? 'on' : ''} onClick={() => upd({ auth: 'password' })}>Пароль</button>
        </div>
      </div>
      {s.auth === 'key' ? (
        <div className="field"><label>Файл ключа</label>
          <input className="input" value={s.key_path || ''} placeholder="~/.ssh/id_ed25519 (пусто — ключ по умолчанию)" onChange={(e) => upd({ key_path: e.target.value })} />
        </div>
      ) : (
        <div className="field"><label>Пароль</label>
          <input className="input" type="password" value={password} placeholder={initial.host ? 'оставьте пустым, чтобы не менять' : ''} onChange={(e) => setPassword(e.target.value)} />
          <div className="hint">Хранится зашифрованным, агент его не видит — приложение подставляет пароль само.</div>
        </div>
      )}
      <div className="field"><label>Папка деплоя</label><input className="input" value={s.deploy_path || ''} placeholder="/var/www/site" onChange={(e) => upd({ deploy_path: e.target.value })} /></div>
      <div className="field"><label>Заметки для агента</label>
        <textarea className="textarea" style={{ minHeight: 60 }} value={s.notes || ''} placeholder="Например: сайт на nginx, перезапуск — systemctl reload nginx" onChange={(e) => upd({ notes: e.target.value })} />
      </div>
      {test && <div className={`test-result ${test.startsWith('ok') ? 'ok' : 'err'}`}>{test.startsWith('ok') ? <CheckCircle2 size={15} /> : <ShieldAlert size={15} />}{test}</div>}
      <div className="row-end">
        <button className="btn" onClick={runTest} disabled={!valid || testing}>{testing ? <Loader2 size={14} className="spin" /> : <Wifi size={14} />}Проверить подключение</button>
        <div style={{ flex: 1 }} />
        <button className="btn ghost" onClick={() => onDone(null)}>Отмена</button>
        <button className="btn primary" disabled={!valid} onClick={() => onDone({ ...s, name: s.name.trim() }, password)}>Сохранить</button>
      </div>
    </div>
  )
}

export function ServersTab({ settings }: { settings: Settings }) {
  const [editing, setEditing] = useState<Server | null>(null)
  const servers = settings.servers || []
  const save = async (s: Server | null, password?: string) => {
    if (s) {
      if (s.auth === 'password' && password) await api.secrets.set(`server:${s.id}`, password)
      const list = servers.some((x) => x.id === s.id) ? servers.map((x) => (x.id === s.id ? s : x)) : [...servers, s]
      await saveSettings({ servers: list })
      toast(`Сервер «${s.name}» сохранён`, 'ok')
    }
    setEditing(null)
  }
  const remove = async (s: Server) => {
    await api.secrets.remove(`server:${s.id}`)
    await saveSettings({ servers: servers.filter((x) => x.id !== s.id) })
  }
  return (
    <>
      <h3>Серверы</h3>
      <div className="hint" style={{ marginBottom: 14, fontSize: 13, color: 'var(--text-2)' }}>
        Агент сможет выполнять команды на этих серверах и загружать файлы — например, «задеплой сайт на prod».
        Каждое действие на сервере он спрашивает, опасные — с красным предупреждением.
      </div>
      {servers.map((s) => (
        editing?.id === s.id ? <ServerForm key={s.id} initial={editing} onDone={save} /> : (
          <div key={s.id} className="list-row">
            <ServerIcon size={16} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <b>{s.name}</b>
              <div className="sub">{s.user}@{s.host}:{s.port || 22} · {s.auth === 'key' ? 'ключ' : 'пароль'}{s.deploy_path ? ` · ${s.deploy_path}` : ''}</div>
            </div>
            <button className="icon-btn sm" title="Изменить" onClick={() => setEditing(s)}><Pencil size={14} /></button>
            <button className="icon-btn sm" title="Удалить" onClick={() => remove(s)}><Trash2 size={14} /></button>
          </div>
        )
      ))}
      {editing && !servers.some((s) => s.id === editing.id) && <ServerForm initial={editing} onDone={save} />}
      {!editing && (
        <button className="btn" onClick={() => setEditing({ id: newId(), name: '', host: '', port: 22, user: 'root', auth: 'key' })}>
          <Plus size={15} />Добавить сервер
        </button>
      )}
      <SecretsSection />
    </>
  )
}

function SecretsSection() {
  const [list, setList] = useState<Secret[]>([])
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [safe, setSafe] = useState(true)
  const load = () => api.secrets.list().then(setList)
  useEffect(() => {
    load()
    api.secrets.available().then(setSafe)
  }, [])
  const add = async () => {
    try {
      await api.secrets.set(name.trim(), value)
      setName('')
      setValue('')
      load()
    } catch (e) {
      toast((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error')
    }
  }
  return (
    <>
      <h3 style={{ marginTop: 28 }}>Секреты</h3>
      <div className="hint" style={{ marginBottom: 12, fontSize: 13, color: 'var(--text-2)' }}>
        Токены и ключи для команд (например, DEPLOY_TOKEN). Агент видит только имена и использует их как
        переменные окружения <code>$ИМЯ</code>; значения в выводе команд заменяются на ••••••.
        {!safe && <><br /><b style={{ color: 'var(--danger)' }}>Системное хранилище ключей недоступно — секреты будут защищены слабее.</b></>}
      </div>
      {list.map((s) => (
        <div key={s.name} className="list-row">
          <KeyRound size={15} />
          <div style={{ flex: 1 }}><b className="mono">${s.name}</b><div className="sub">{s.preview}</div></div>
          <button className="icon-btn sm" title="Удалить" onClick={async () => {
            await api.secrets.remove(s.name)
            load()
          }}><Trash2 size={14} /></button>
        </div>
      ))}
      <div className="row-end" style={{ gap: 8 }}>
        <input className="input mono" style={{ width: 200 }} placeholder="ИМЯ" value={name} onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))} />
        <input className="input" type="password" placeholder="значение" value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name && value && add()} />
        <button className="btn" disabled={!name || !value} onClick={add}><Plus size={15} />Добавить</button>
      </div>
    </>
  )
}

// ---------------------------------------------------------------- расходы

export function LimitsTab({ settings }: { settings: Settings }) {
  const [today, setToday] = useState(0)
  useEffect(() => {
    api.spend().then((s) => setToday(s.today))
  }, [])
  const field = (key: 'limit_chat_usd' | 'limit_day_usd', label: string, hint: string) => (
    <div className="field">
      <label>{label}</label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span>$</span>
        <input className="input" type="number" min={0} step={0.5} style={{ width: 120 }} defaultValue={settings[key] || ''} placeholder="без лимита"
          onBlur={(e) => saveSettings({ [key]: Math.max(0, Number(e.target.value) || 0) } as Partial<Settings>)} />
      </div>
      <div className="hint">{hint}</div>
    </div>
  )
  return (
    <>
      <h3>Расходы</h3>
      <div className="side-card" style={{ display: 'flex', gap: 24 }}>
        <div><div className="sub">Потрачено сегодня</div><div style={{ font: '600 22px var(--sans)' }}>{money(today)}</div></div>
        {settings.limit_day_usd > 0 && <div><div className="sub">Дневной лимит</div><div style={{ font: '600 22px var(--sans)' }}>{money(settings.limit_day_usd)}</div></div>}
      </div>
      {field('limit_chat_usd', 'Лимит на один чат', 'Когда расходы чата достигнут лимита, агент остановится и спросит, продолжать ли. Пусто — без лимита.')}
      {field('limit_day_usd', 'Лимит в день', 'Общий лимит на все чаты, картинки и видео за сегодня. Пусто — без лимита.')}
    </>
  )
}

// ---------------------------------------------------------------- голос

export function VoiceTab({ settings }: { settings: Settings }) {
  const [models, setModels] = useState<{ tts: { id: string; name: string }[]; stt: { id: string; name: string }[] } | null>(null)
  const [voices, setVoices] = useState<string[]>([])
  useEffect(() => {
    api.voice.models().then(setModels)
  }, [])
  useEffect(() => {
    api.voice.voices(settings.tts_model).then(setVoices)
  }, [settings.tts_model])
  return (
    <>
      <h3>Голос</h3>
      <div className="field">
        <label>Озвучка ответов</label>
        <select className="input" value={settings.tts_model} onChange={(e) => saveSettings({ tts_model: e.target.value, tts_voice: '' })}>
          {(models?.tts || [{ id: settings.tts_model, name: settings.tts_model }]).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        <div className="hint">По-русски хорошо говорят xAI, ElevenLabs, Gemini и MiniMax. Kokoro дешевле, но русского не знает.</div>
      </div>
      <div className="field">
        <label>Голос</label>
        <select className="input" value={settings.tts_voice} onChange={(e) => saveSettings({ tts_voice: e.target.value })}>
          <option value="">по умолчанию</option>
          {voices.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
      </div>
      <div className="field">
        <label>Распознавание речи (кнопка микрофона)</label>
        <select className="input" value={settings.stt_model} onChange={(e) => saveSettings({ stt_model: e.target.value })}>
          {(models?.stt || [{ id: settings.stt_model, name: settings.stt_model }]).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        <div className="hint">Около $0.006 за минуту записи.</div>
      </div>
    </>
  )
}

// ---------------------------------------------------------------- безопасные команды

export function SafeCommands({ settings }: { settings: Settings }) {
  const [text, setText] = useState((settings.allowed_commands || []).join('\n'))
  return (
    <>
      <div className="toggle-row" onClick={() => saveSettings({ auto_safe_commands: !settings.auto_safe_commands })}>
        <div className="t"><b>Не спрашивать для команд только для чтения</b>
          <span>ls, cat, grep, find, git status/log/diff и подобные выполняются сразу — без окна разрешения</span></div>
        <button className={`switch ${settings.auto_safe_commands ? 'on' : ''}`} />
      </div>
      <div className="field">
        <label>Свои команды без вопроса</label>
        <textarea className="textarea mono" style={{ minHeight: 90 }} value={text} placeholder={'npm test\npytest\nnpm run build'}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => saveSettings({ allowed_commands: text.split('\n').map((l) => l.trim()).filter(Boolean) })} />
        <div className="hint">По одной на строку; разрешается всё, что начинается с этих слов (без цепочек через ; && |). Опасные команды всё равно спрашиваются.</div>
      </div>
    </>
  )
}

export function InstallButton() {
  const [done, setDone] = useState('')
  // на Windows ярлыки в «Пуске» и на рабочем столе создаёт установщик
  if (api.platform === 'win32') return null
  return (
    <div className="toggle-row">
      <div className="t"><b>Mouse King Pro в меню приложений</b><span>{done ? 'Готово — ищите «Mouse King Pro» в меню приложений' : 'Значок и запуск без терминала'}</span></div>
      <button className="btn" onClick={async () => setDone(await api.install())}>{done ? <CheckCircle2 size={15} /> : <Plus size={15} />}{done ? 'Добавлено' : 'Добавить'}</button>
    </div>
  )
}

export function UpdateRow() {
  const u = useApp((s) => s.update)
  const busy = u?.status === 'checking' || u?.status === 'downloading'
  const sub = !u ? '' : u.status === 'checking' ? 'Проверяю…'
    : u.status === 'latest' ? 'Установлена последняя версия'
    : u.status === 'available' ? `Доступна версия ${u.version} — кнопка «Скачать» внизу слева`
    : u.status === 'downloading' ? `Загрузка ${u.percent ?? 0}%`
    : u.status === 'ready' ? 'Готово — перезапустите программу'
    : u.status === 'error' ? `Ошибка: ${u.error}` : 'Проверяется при запуске и каждые 6 часов'
  return (
    <div className="toggle-row">
      <div className="t"><b>Mouse King Pro {api.version}</b><span>{sub}</span></div>
      <button className="btn" disabled={busy} onClick={() => {
        set({ updateHidden: '' })
        api.update.check()
      }}>{busy ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}Проверить обновления</button>
    </div>
  )
}
