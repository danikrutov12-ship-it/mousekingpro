import {
  AlertCircle, Archive, Ban, Check, ChevronDown, ChevronLeft, ChevronRight, Download, Eraser, ExternalLink, Eye, FileSearch,
  FileText, Film, FolderOpen, Globe, Hourglass, Link2, ListChecks, Loader2, Maximize2, MoreHorizontal, PauseCircle, PenLine,
  Pencil, Play, RefreshCw, Search, Server, Square, Terminal, Undo2, Upload, Volume2, VolumeX, Wallet, Wand2, Wrench, ZoomIn,
  Brain, Camera, Columns3, Image as ImageIcon, Keyboard, Layers, MousePointerClick, Plug, Sparkles, Users,
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { money } from '@shared/pricing'
import type { Message, ToolCall } from '@shared/types'
import { animate, editMessage, imageOp, openArtifact, regenerate, rememberFact, resume, speak, switchAlt, undoChanges } from '../lib/actions'
import { api } from '../lib/api'
import { fileUrl, tokens, baseName } from '../lib/format'
import { get, set, useApp, type Run } from '../lib/store'
import { Spark } from './Lights'
import { CopyButton, Markdown } from './Markdown'
import { ModelPicker } from './ModelPicker'
import { Popover } from './Popover'

type Kind = 'read' | 'run' | 'edit' | 'web' | 'archive' | 'other'
const TOOLS: Record<string, [string, ReactNode, Kind]> = {
  list_dir: ['Смотрю папку', <FolderOpen size={14} />, 'read'],
  read_file: ['Читаю файл', <FileText size={14} />, 'read'],
  search_files: ['Ищу в файлах', <FileSearch size={14} />, 'read'],
  find_files: ['Ищу файлы', <Search size={14} />, 'read'],
  write_file: ['Записываю файл', <PenLine size={14} />, 'edit'],
  edit_file: ['Правлю файл', <PenLine size={14} />, 'edit'],
  run_command: ['Выполняю команду', <Terminal size={14} />, 'run'],
  start_background: ['Запускаю в фоне', <Play size={14} />, 'run'],
  job_status: ['Проверяю фоновую задачу', <Hourglass size={14} />, 'run'],
  stop_job: ['Останавливаю задачу', <Square size={14} />, 'run'],
  extract_archive: ['Распаковываю архив', <Archive size={14} />, 'archive'],
  web_search: ['Ищу в интернете', <Globe size={14} />, 'web'],
  fetch_url: ['Открываю страницу', <Link2 size={14} />, 'web'],
  download_file: ['Скачиваю файл', <Download size={14} />, 'web'],
  ssh_run: ['Выполняю на сервере', <Server size={14} />, 'run'],
  ssh_upload: ['Загружаю на сервер', <Upload size={14} />, 'run'],
  update_plan: ['Обновляю план', <ListChecks size={14} />, 'other'],
  generate_image: ['Рисую картинку', <ImageIcon size={14} />, 'other'],
  edit_image: ['Меняю картинку', <Wand2 size={14} />, 'other'],
  combine_images: ['Объединяю картинки', <Layers size={14} />, 'other'],
  upscale_image: ['Увеличиваю картинку', <ZoomIn size={14} />, 'other'],
  remove_background: ['Убираю фон', <Eraser size={14} />, 'other'],
  describe_image: ['Смотрю на картинку', <Eye size={14} />, 'read'],
  browser_open: ['Открываю в браузере', <Globe size={14} />, 'web'],
  browser_read: ['Читаю страницу', <Globe size={14} />, 'web'],
  browser_click: ['Нажимаю на странице', <MousePointerClick size={14} />, 'web'],
  browser_type: ['Ввожу текст на странице', <Keyboard size={14} />, 'web'],
  browser_scroll: ['Листаю страницу', <Globe size={14} />, 'web'],
  browser_back: ['Назад в браузере', <Globe size={14} />, 'web'],
  browser_screenshot: ['Делаю скриншот', <Camera size={14} />, 'web'],
  semantic_search: ['Ищу по смыслу в коде', <Sparkles size={14} />, 'read'],
  delegate: ['Помощник', <Users size={14} />, 'other'],
  remember: ['Предлагаю запомнить', <Brain size={14} />, 'other'],
}

/** Подпись шага: свои инструменты из TOOLS, подключения MCP — «Сервис: инструмент». */
function toolInfo(name: string): [string, ReactNode, Kind] {
  if (TOOLS[name]) return TOOLS[name]
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name)
  if (m) return [`${m[1]}: ${m[2].replace(/_/g, ' ')}`, <Plug size={14} />, 'other']
  return [name, <Wrench size={14} />, 'other']
}

const IMAGE = /\.(png|jpe?g|webp|gif|bmp)$/i
const VIDEO = /\.(mp4|webm|mov|mkv)$/i

function plural(n: number, one: string, few: string, many: string) {
  const m10 = n % 10
  const m100 = n % 100
  const w = m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many
  return `${n} ${w}`
}

function textOf(content: Message['content']): string {
  if (Array.isArray(content)) return content.filter((p) => p.type === 'text').map((p: any) => p.text).join('\n')
  return content || ''
}
const stripCalls = (t: string) => t.replace(/<tool_call>[\s\S]*?(<\/tool_call>|$)/g, '').trim()

function summarize(args: string): string {
  try {
    const a = JSON.parse(args || '{}')
    if (!Object.keys(a).length) return ''
    if (a.server && a.command) return `${a.server}: ${a.command.split('\n')[0]}`
    if (a.server && a.local) return `${a.local} → ${a.server}:${a.remote}`
    if (a.label && a.task) return a.label
    if (a.fact) return a.fact
    if (typeof a.index === 'number' && a.text) return `[${a.index}] ${a.text}`
    const v = a.name && a.command ? a.name : a.command ?? a.path ?? a.query ?? a.url ?? a.pattern ?? a.id ?? Object.values(a)[0]
    return typeof v === 'string' ? v.split('\n')[0] : JSON.stringify(a)
  } catch {
    return args.slice(0, 120)
  }
}

function prettyArgs(name: string, args: string): string {
  try {
    const a = JSON.parse(args || '{}')
    if (typeof a.command === 'string') return a.command
    if (name === 'write_file' && typeof a.content === 'string') return `${a.path}\n\n${a.content}`
    return JSON.stringify(a, null, 2)
  } catch {
    return args
  }
}

interface StepData { call: ToolCall; result?: Message }

/** Живой вывод команды: держим прокрутку внизу. */
function LiveOutput({ text }: { text: string }) {
  const ref = useRef<HTMLPreElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [text])
  return <pre ref={ref} className="live-out">{text.slice(-6000)}</pre>
}

const Step = memo(function Step({ step, running, output, latestChange }: {
  step: StepData; running: boolean; output?: string; latestChange: boolean
}) {
  const { call, result } = step
  const name = call.function.name
  const [open, setOpen] = useState(false)
  const [label, icon] = toolInfo(name)
  const text = result ? String(result.content ?? '') : ''
  const halted = !!result && /^(Остановлено|Отменено|Не выполнено)/.test(text.replace(/^Код выхода: \S+\n/, ''))
  const failed = !!result && !halted && (result._denied || /^(Ошибка|Сетевая ошибка)/.test(text))
  const live = !result && running
  return (
    <div className={`step ${open ? 'open' : ''}`}>
      <button className="step-head" onClick={() => setOpen(!open)}>
        <span className="step-icon">{icon}</span>
        <span className="step-label">{result?._denied ? 'Отклонено' : label}</span>
        <span className="step-arg">{summarize(call.function.arguments)}</span>
        {result && !result._undone && /\.(html?|svg)$/i.test(result._change?.path || '') && (
          <span className="step-undo" role="button" title="Открыть предпросмотр"
            onClick={(e) => {
              e.stopPropagation()
              openArtifact({ kind: 'file', path: result._change!.path, title: baseName(result._change!.path) })
            }}><Eye size={13} />Предпросмотр</span>
        )}
        {result?._change && (result._undone
          ? <span className="step-undone">отменено</span>
          : latestChange && (
            <span className="step-undo" role="button" title="Вернуть файл как было до этого шага"
              onClick={(e) => {
                e.stopPropagation()
                undoChanges([call.id])
              }}><Undo2 size={13} />Откатить</span>
          ))}
        <span className={`step-state ${!result ? 'wait' : failed ? 'err' : halted ? 'halt' : 'ok'}`} title={halted ? 'Прервано' : undefined}>
          {!result ? (running ? <Loader2 size={14} className="spin" /> : <Ban size={14} />)
            : result._denied || halted ? <Ban size={14} /> : failed ? <AlertCircle size={14} /> : <Check size={14} />}
        </span>
        <ChevronRight size={14} className="step-chevron" />
      </button>
      {live && output && !open && <div className="step-body-inner"><LiveOutput text={output} /></div>}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div className="step-body" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}>
            <div className="step-body-inner">
              <div className="step-block"><div className="step-block-label">Запрос</div><pre>{prettyArgs(name, call.function.arguments)}</pre></div>
              {live && output && <div className="step-block"><div className="step-block-label">Вывод</div><LiveOutput text={output} /></div>}
              {result && <div className="step-block"><div className="step-block-label">Результат</div><pre>{text}</pre></div>}
              {result?._media?.map((p) => <img key={p} className="shot" src={fileUrl(p)} onClick={() => set({ lightbox: p })} />)}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
})

/** Сводка шагов: «прочитано 3 файла · выполнено 2 команды · изменён 1 файл». */
function summary(steps: StepData[]): string {
  const count: Record<Kind, number> = { read: 0, run: 0, edit: 0, web: 0, archive: 0, other: 0 }
  for (const s of steps) count[toolInfo(s.call.function.name)[2]]++
  const parts: string[] = []
  if (count.read) parts.push(`изучено ${plural(count.read, 'место', 'места', 'мест')}`)
  if (count.run) parts.push(`${plural(count.run, 'команда', 'команды', 'команд')}`)
  if (count.edit) parts.push(`${plural(count.edit, 'правка', 'правки', 'правок')} файлов`)
  if (count.web) parts.push(`веб: ${count.web}`)
  if (count.archive) parts.push(`архивы: ${count.archive}`)
  if (count.other) parts.push(`другое: ${count.other}`)
  return parts.join(' · ')
}

/** Группа подряд идущих шагов: свёрнута в одну строку, раскрывается по клику. Во время работы виден текущий шаг. */
function StepGroup({ steps, live, run, latest }: { steps: StepData[]; live: boolean; run?: Run; latest: Set<string> }) {
  const [open, setOpen] = useState(false)
  const pending = steps.findIndex((s) => !s.result)
  const current = live && pending >= 0 ? pending : -1
  const fails = steps.filter((s) => s.result && (s.result._denied || /^(Ошибка|Сетевая ошибка)/.test(String(s.result.content)))).length
  const row = (s: StepData) => (
    <Step key={s.call.id} step={s} running={live} output={run?.outputs[s.call.id]} latestChange={latest.has(s.call.id)} />
  )
  const shots = steps.flatMap((s) => s.result?._media || []).slice(-3)
  const strip = shots.length > 0 && (
    <div className="shots">{shots.map((p) => <img key={p} src={fileUrl(p)} onClick={() => set(/[\\/]browser[\\/]/.test(p) ? { lightbox: p } : { viewer: p })} />)}</div>
  )
  if (steps.length <= 2) return <div className="steps">{steps.map(row)}{strip}</div>
  return (
    <div className="steps">
      <button className={`group-head ${open ? 'open' : ''}`} onClick={() => setOpen(!open)}>
        <span className="group-count">{steps.length}</span>
        <span className="group-text">{live && current >= 0 ? 'Работаю' : 'Выполнено действий'}<span> · {summary(steps)}</span></span>
        {fails > 0 && <span className="group-fail"><AlertCircle size={13} />{fails}</span>}
        {live && current >= 0 ? <Loader2 size={14} className="spin group-spin" /> : <Check size={14} className="group-ok" />}
        <ChevronRight size={14} className="step-chevron" />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div className="step-body" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}>
            <div className="group-list">{steps.map(row)}</div>
          </motion.div>
        )}
      </AnimatePresence>
      {!open && current >= 0 && <div className="group-current">{row(steps[current])}</div>}
      {strip}
    </div>
  )
}

function Media({ paths }: { paths: string[] }) {
  return (
    <div className={`media-grid ${paths.length === 1 ? 'single' : ''}`}>
      {paths.map((p) => (
        <motion.div key={p} className="media" initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.4, ease: [0.2, 0.8, 0.2, 1] }}>
          {IMAGE.test(p) ? <img src={fileUrl(p)} onClick={() => set({ lightbox: p })} draggable={false} />
            : VIDEO.test(p) ? <video src={fileUrl(p)} controls loop playsInline />
            : <div style={{ padding: 14 }}>{p}</div>}
          <div className="media-actions">
            {IMAGE.test(p) && <button title="Открыть на весь экран" onClick={() => set({ lightbox: p })}><Maximize2 size={14} /></button>}
            <button title="Показать в папке" onClick={() => api.shell.reveal(p)}><FolderOpen size={14} /></button>
            <button title="Открыть" onClick={() => api.shell.open(p)}><ExternalLink size={14} /></button>
            {IMAGE.test(p) && <ImageMenu path={p} />}
          </div>
        </motion.div>
      ))}
    </div>
  )
}

/** Действия с картинкой: увеличить, убрать фон, изменить по описанию, оживить в видео. */
function ImageMenu({ path }: { path: string }) {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const busy = useApp((s) => !!(s.current && s.runs[s.current.chat.id]))
  const run = (fn: () => void) => {
    setOpen(false)
    if (busy) return
    fn()
  }
  return (
    <>
      <button ref={btn} title="Что сделать с картинкой" onClick={() => setOpen(!open)}><MoreHorizontal size={14} /></button>
      <Popover anchor={btn} open={open} onClose={() => setOpen(false)} className="menu" align="end" gap={6}>
        <button className="menu-item" onClick={() => {
          setOpen(false)
          set({ viewer: path })
        }}><Layers size={14} />Версии, сравнение, описание…</button>
        <div className="menu-sep" />
        <button className="menu-item" onClick={() => run(() => imageOp({ kind: 'upscale', path, scale: 2 }))}><ZoomIn size={14} />Увеличить ×2<span className="menu-sub">$0.02</span></button>
        <button className="menu-item" onClick={() => run(() => imageOp({ kind: 'upscale', path, scale: 4 }))}><ZoomIn size={14} />Увеличить ×4<span className="menu-sub">$0.08</span></button>
        <button className="menu-item" onClick={() => run(() => imageOp({ kind: 'background', path }))}><Eraser size={14} />Убрать фон</button>
        <button className="menu-item" onClick={() => {
          setOpen(false)
          setEditing(true)
        }}><Wand2 size={14} />Изменить по описанию…</button>
        <div className="menu-sep" />
        <button className="menu-item" onClick={() => run(() => animate(path))}><Film size={14} />Оживить в видео…</button>
      </Popover>
      {editing && <EditImageDialog path={path} onClose={() => setEditing(false)} />}
    </>
  )
}

function EditImageDialog({ path, onClose }: { path: string; onClose(): void }) {
  const [prompt, setPrompt] = useState('')
  const [models, setModels] = useState<{ id: string; name: string; price: number | null }[]>([])
  const [model, setModel] = useState(get().settings?.edit_model || 'qwen-edit-uncensored')
  useEffect(() => {
    api.voice.models().then((m) => setModels(m.edit))
  }, [])
  const go = () => {
    if (!prompt.trim()) return
    onClose()
    imageOp({ kind: 'edit', path, prompt: prompt.trim(), model })
  }
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <motion.div className="modal" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }}>
        <div className="modal-head"><h2>Изменить картинку</h2></div>
        <div className="modal-body">
          <img src={fileUrl(path)} style={{ width: '100%', maxHeight: 240, objectFit: 'contain', borderRadius: 10, background: 'var(--surface-2)' }} />
          <div className="field" style={{ marginTop: 12 }}>
            <label>Что поменять</label>
            <textarea className="textarea" autoFocus value={prompt} onChange={(e) => setPrompt(e.target.value)}
              placeholder="Например: сделай небо закатным, добавь кота на подоконник"
              onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && go()} />
          </div>
          <div className="field">
            <label>Модель</label>
            <select className="input" value={model} onChange={(e) => setModel(e.target.value)}>
              {(models.length ? models : [{ id: model, name: model, price: null }]).map((m) => (
                <option key={m.id} value={m.id}>{m.name}{m.price != null ? ` — ${money(m.price)}` : ''}{/uncensored/.test(m.id) ? ' (без цензуры)' : ''}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>Отмена</button>
          <button className="btn primary" onClick={go} disabled={!prompt.trim()}><Wand2 size={14} />Изменить</button>
        </div>
      </motion.div>
    </div>
  )
}

type Turn =
  | { kind: 'user'; key: string; msg: Message; index: number }
  | { kind: 'bot'; key: string; msgs: Message[]; userIndex: number }

function group(messages: Message[]): Turn[] {
  const turns: Turn[] = []
  let lastUser = -1
  messages.forEach((m, i) => {
    if (m.role === 'user' && !m._hidden) {
      lastUser = i
      turns.push({ kind: 'user', key: `u${i}`, msg: m, index: i })
    }
    else if (m.role === 'assistant' || m.role === 'tool') {
      const last = turns[turns.length - 1]
      if (last?.kind === 'bot') last.msgs.push(m)
      else turns.push({ kind: 'bot', key: `b${i}`, msgs: [m], userIndex: lastUser })
    }
  })
  return turns
}

const fade = { initial: { opacity: 0, y: 10 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.32, ease: [0.2, 0.8, 0.2, 1] as const } }

function UserTurn({ msg, index, busy }: { msg: Message; index: number; busy: boolean }) {
  const text = msg._display ?? textOf(msg.content)
  // фото и видео показываем картинками, в подписи остаются только прочие файлы
  const photos = msg._photos || []
  const files = (msg._attachments || []).filter((n) => !photos.length || !(IMAGE.test(n) || VIDEO.test(n)))
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(text)
  const alts = msg._alts?.length || 0
  const alt = msg._alt ?? 0
  if (editing) {
    const go = () => {
      if (!draft.trim()) return
      setEditing(false)
      editMessage(index, draft.trim())
    }
    return (
      <motion.div className="turn user-msg" {...fade}>
        <div className="bubble editing">
          <textarea className="edit-area" autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
            rows={Math.min(12, draft.split('\n').length + 1)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                go()
              }
              if (e.key === 'Escape') setEditing(false)
            }} />
          <div className="edit-foot">
            <span>Прежний вариант сохранится — между ними можно будет переключаться.</span>
            <button className="btn ghost" onClick={() => setEditing(false)}>Отмена</button>
            <button className="btn primary" onClick={go} disabled={!draft.trim()}>Отправить</button>
          </div>
        </div>
      </motion.div>
    )
  }
  return (
    <motion.div className="turn user-msg" {...fade}>
      <div className="user-col">
        {!!photos.length && <Media paths={photos} />}
        {(text || files.length || msg._mode) && (
          <div className="bubble selectable">
            {text}
            {(files.length || msg._mode) && (
              <div className="chips">
                {files.map((n) => <span key={n} className="chip"><FileText size={12} />{n}</span>)}
                {msg._mode && <span className="chip">{msg._mode}</span>}
              </div>
            )}
          </div>
        )}
        <div className="user-actions">
          {alts > 1 && (
            <span className="alts">
              <button className="icon-btn sm" disabled={alt === 0 || busy} onClick={() => switchAlt(index, alt - 1)}><ChevronLeft size={14} /></button>
              {alt + 1} / {alts}
              <button className="icon-btn sm" disabled={alt === alts - 1 || busy} onClick={() => switchAlt(index, alt + 1)}><ChevronRight size={14} /></button>
            </span>
          )}
          <CopyButton text={text} label="" className="icon-btn sm" />
          {!msg._gen && <button className="icon-btn sm" title="Сравнить ответы разных моделей" onClick={() => set({ compare: { index } })}><Columns3 size={13} /></button>}
          {!busy && !msg._attachments?.length && (
            <button className="icon-btn sm" title="Изменить сообщение" onClick={() => {
              setDraft(text)
              setEditing(true)
            }}><Pencil size={13} /></button>
          )}
        </div>
      </div>
    </motion.div>
  )
}

type Block =
  | { kind: 'text'; key: string; text: string }
  | { kind: 'error'; key: string; text: string }
  | { kind: 'media'; key: string; paths: string[] }
  | { kind: 'steps'; key: string; steps: StepData[] }
  | { kind: 'remember'; key: string; fact: string }

function blocks(msgs: Message[]): Block[] {
  const results: Record<string, Message> = {}
  for (const m of msgs) if (m.role === 'tool' && m.tool_call_id) results[m.tool_call_id] = m
  const out: Block[] = []
  msgs.forEach((m, i) => {
    if (m.role !== 'assistant' || m._stopped || m._limit || m._spend) return
    const text = stripCalls(textOf(m.content))
    if (m._error) out.push({ kind: 'error', key: `e${i}`, text })
    else if (text) out.push({ kind: 'text', key: `t${i}`, text })
    if (m._media) out.push({ kind: 'media', key: `m${i}`, paths: m._media })
    for (const c of m.tool_calls || []) {
      if (c.function.name !== 'remember') continue
      try {
        out.push({ kind: 'remember', key: `r${c.id}`, fact: String(JSON.parse(c.function.arguments).fact || '') })
      } catch {
        // некорректные аргументы — пропускаем
      }
    }
    const calls = (m.tool_calls || []).filter((c) => c.function.name !== 'update_plan' && c.function.name !== 'remember')
    if (calls.length) {
      const steps = calls.map((call) => ({ call, result: results[call.id] }))
      const last = out[out.length - 1]
      if (last?.kind === 'steps') last.steps.push(...steps)
      else out.push({ kind: 'steps', key: `s${i}`, steps })
    }
  })
  return out
}

function BotTurn({ msgs, live, run, interrupted, userIndex }: {
  msgs: Message[]; live: boolean; run?: Run; interrupted?: Interruption; userIndex: number
}) {
  const list = useMemo(() => blocks(msgs), [msgs])
  // откатить шаг можно, только если после него этот файл больше не меняли
  const { latest, changes } = useMemo(() => {
    const seen = new Set<string>()
    const latest = new Set<string>()
    const changes: string[] = []
    for (const m of [...msgs].reverse()) {
      if (m.role !== 'tool' || !m._change || m._undone) continue
      changes.push(m.tool_call_id!)
      if (!seen.has(m._change.path)) latest.add(m.tool_call_id!)
      seen.add(m._change.path)
    }
    return { latest, changes }
  }, [msgs])
  const files = useMemo(() => new Set(msgs.filter((m) => m._change && !m._undone).map((m) => m._change!.path)).size, [msgs])
  let cost: number | null = null
  const tk = [0, 0]
  const texts: string[] = []
  for (const m of msgs) {
    if (m._cost != null) cost = (cost || 0) + m._cost
    if (m._tokens) {
      tk[0] += m._tokens[0] || 0
      tk[1] += m._tokens[1] || 0
    }
    if (m.role === 'assistant' && !m._error) texts.push(stripCalls(textOf(m.content)))
  }
  const streamText = run?.text ? stripCalls(run.text) : ''
  const userMsg = useApp((s) => (userIndex >= 0 ? s.current?.chat.messages[userIndex] : undefined))
  const isMedia = !!(userMsg?._gen && userMsg._gen.mode !== 'text') || !!userMsg?._op
  const lastSteps = list[list.length - 1]?.kind === 'steps'
  return (
    <motion.div className="turn bot" {...fade}>
      <div className={`bot-mark ${live ? 'spin' : ''}`}><Spark size={20} /></div>
      {list.map((b, i) => {
        if (b.kind === 'text') return <Markdown key={b.key} text={b.text} />
        if (b.kind === 'error') return <div key={b.key} className="error-card selectable"><AlertCircle size={16} /><div>{b.text}</div></div>
        if (b.kind === 'media') return <Media key={b.key} paths={b.paths} />
        if (b.kind === 'remember') return <RememberCard key={b.key} fact={b.fact} />
        return <StepGroup key={b.key} steps={b.steps} live={live && i === list.length - 1} run={run} latest={latest} />
      })}
      {live && (streamText ? <Markdown text={streamText} streaming />
        : !(lastSteps && list[list.length - 1].kind === 'steps' && (list[list.length - 1] as any).steps.some((s: StepData) => !s.result))
          && <div className="thinking"><span className="shimmer">{statusText(run?.status, run?.text)}</span></div>)}
      {!live && (interrupted === 'spend-chat' || interrupted === 'spend-day') && (
        <div className="resume-card">
          <Wallet size={18} />
          <div className="resume-text">
            {interrupted === 'spend-chat' ? `Достигнут лимит расходов на чат (${money(get().settings?.limit_chat_usd || 0)}).`
              : `Достигнут дневной лимит расходов (${money(get().settings?.limit_day_usd || 0)}).`}
            <span> Можно продолжить один раз сверх лимита или изменить лимит в настройках.</span>
          </div>
          <button className="btn" onClick={() => set({ settingsOpen: true })}>Лимиты</button>
          <button className="btn primary" onClick={() => resume(true)}><Play size={14} />Продолжить</button>
        </div>
      )}
      {!live && interrupted === 'error' && isMedia && (
        <div className="resume-card">
          <AlertCircle size={18} />
          <div className="resume-text">Генерация не удалась.<span> Можно повторить тот же запрос или сменить модель внизу.</span></div>
          <button className="btn primary" onClick={() => regenerate(userIndex)}><RefreshCw size={14} />Повторить</button>
        </div>
      )}
      {!live && interrupted && !interrupted.startsWith('spend') && !(interrupted === 'error' && isMedia) && (
        <div className="resume-card">
          <PauseCircle size={18} />
          <div className="resume-text">
            {interrupted === 'stopped' && 'Работа остановлена.'}
            {interrupted === 'limit' && 'Достигнут лимит шагов за один ответ.'}
            {interrupted === 'error' && 'Работа прервалась из-за ошибки.'}
            {interrupted === 'crash' && 'Работа прервалась на середине.'}
            <span> Можно продолжить с этого места — агент не начнёт заново.</span>
          </div>
          <button className="btn primary" onClick={() => resume()}><Play size={14} />Продолжить</button>
        </div>
      )}
      {!live && (
        <div className="meta">
          {(cost != null || tk[0] + tk[1] > 0) && (
            <span className="cost" title={tk[0] + tk[1] ? `вход ${tk[0].toLocaleString('ru')} · ответ ${tk[1].toLocaleString('ru')} токенов` : ''}>
              {[cost != null ? money(cost) : '', tk[0] + tk[1] ? `${tokens(tk[0] + tk[1])} токенов` : ''].filter(Boolean).join(' · ')}
            </span>
          )}
          {texts.join('').trim() && <CopyButton text={texts.filter(Boolean).join('\n\n')} label="" className="icon-btn sm" />}
          {texts.join('').trim() && <SpeakButton text={texts.filter(Boolean).join('\n\n')} />}
          {userIndex >= 0 && <RegenerateButton index={userIndex} />}
          {changes.length > 0 && (
            <button className="meta-btn" title="Вернуть все файлы, изменённые в этом ответе" onClick={() => undoChanges(changes)}>
              <Undo2 size={13} />Откатить изменения ({plural(files, 'файл', 'файла', 'файлов')})
            </button>
          )}
        </div>
      )}
    </motion.div>
  )
}

/** Агент предлагает запомнить факт — сохраняет только пользователь. */
function RememberCard({ fact }: { fact: string }) {
  const saved = useApp((s) => s.memories.some((m) => m.text === fact.trim()))
  const [declined, setDeclined] = useState(false)
  if (!fact || declined) return null
  return (
    <motion.div className="remember" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
      <Brain size={16} />
      <div className="remember-text"><span>{saved ? 'Запомнено:' : 'Запомнить для будущих чатов?'}</span> {fact}</div>
      {!saved && <>
        <button className="btn ghost" onClick={() => setDeclined(true)}>Не надо</button>
        <button className="btn" onClick={() => rememberFact(fact)}><Check size={14} />Запомнить</button>
      </>}
    </motion.div>
  )
}

function SpeakButton({ text }: { text: string }) {
  const [playing, setPlaying] = useState(false)
  return (
    <button className={`icon-btn sm ${playing ? 'active' : ''}`} title={playing ? 'Остановить' : 'Озвучить ответ'}
      onClick={() => speak(text, setPlaying)}>{playing ? <VolumeX size={14} /> : <Volume2 size={14} />}</button>
  )
}

/** «Повторить»: другой ответ на то же сообщение; стрелка — выбрать другую модель. */
function RegenerateButton({ index }: { index: number }) {
  const [picker, setPicker] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const models = useApp((s) => s.models.text)
  const busy = useApp((s) => !!(s.current && s.runs[s.current.chat.id]))
  const msg = useApp((s) => s.current?.chat.messages[index])
  const mode = msg?._gen?.mode || 'text'
  const list = useApp((s) => s.models[mode])
  if (busy) return null
  return (
    <span className="regen">
      <button className="meta-btn" title="Получить другой ответ (прежний сохранится)" onClick={() => regenerate(index)}><RefreshCw size={13} />Повторить</button>
      <button ref={btn} className="meta-btn" style={{ padding: '0 5px' }} title="Повторить другой моделью" onClick={() => setPicker(!picker)}><ChevronDown size={13} /></button>
      <ModelPicker anchor={btn} open={picker} onClose={() => setPicker(false)} models={mode === 'text' ? models : list} mode={mode}
        current={mode === 'text' ? get().settings?.text_model : msg?._gen?.model} onPick={(m) => regenerate(index, m)} />
    </span>
  )
}

function statusText(status?: string, stream?: string): string {
  if (stream?.includes('<tool_call>')) return 'Готовлю действие…'
  if (!status || status === 'Думаю…') return 'Думаю…'
  return TOOLS[status]?.[0] ? TOOLS[status][0] + '…' : status
}

type Interruption = 'stopped' | 'limit' | 'error' | 'crash' | 'spend-chat' | 'spend-day' | null

/** Чем закончился последний ход, если его прервали. */
function interruption(messages: Message[]): Interruption {
  const last = messages[messages.length - 1]
  if (!last) return null
  if (last._spend) return last._spend === 'chat' ? 'spend-chat' : 'spend-day'
  if (last._stopped) return 'stopped'
  if (last._limit) return 'limit'
  if (last._error) return 'error'
  if (last.role === 'tool') return 'crash'
  if (last.role === 'assistant' && last.tool_calls?.length) return 'crash'
  return null
}

/** Лента чата. */
export function Thread({ messages, run }: { messages: Message[]; run?: Run }) {
  const turns = useMemo(() => group(messages), [messages])
  const live = !!run
  const lastBot = turns[turns.length - 1]?.kind === 'bot'
  const interrupted = useMemo(() => interruption(messages), [messages])
  return (
    <div className="thread">
      {turns.map((t, i) => t.kind === 'user'
        ? <UserTurn key={t.key + (t.msg._alt ?? '')} msg={t.msg} index={t.index} busy={live} />
        : <BotTurn key={t.key} msgs={t.msgs} live={live && i === turns.length - 1} run={live && i === turns.length - 1 ? run : undefined}
          interrupted={i === turns.length - 1 ? interrupted : null} userIndex={t.userIndex} />)}
      {live && !lastBot && <BotTurn key={`b${messages.length}`} msgs={[]} live run={run} userIndex={-1} />}
    </div>
  )
}
