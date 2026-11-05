import { ExternalLink, FileDiff, FolderOpen, RefreshCw, Undo2, X } from 'lucide-react'
import { motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import type { ChangeSummary } from '@shared/types'
import { closePanel, undoChanges } from '../lib/actions'
import { FilesView, GitView, TerminalView } from './Workbench'
import { api } from '../lib/api'
import { fileUrl, baseName } from '../lib/format'
import { set, useApp, type Artifact } from '../lib/store'

// ---------------------------------------------------------------- предпросмотр

let mermaidReady: Promise<any> | null = null
async function renderMermaid(code: string, dark: boolean): Promise<string> {
  mermaidReady ||= import('mermaid').then((m) => m.default)
  const mermaid = await mermaidReady
  mermaid.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'default', securityLevel: 'strict', fontFamily: 'Inter' })
  const { svg } = await mermaid.render('m' + Math.random().toString(36).slice(2), code)
  return svg
}

function Preview({ a }: { a: Artifact }) {
  const dark = useApp((s) => s.win.dark)
  const [src, setSrc] = useState<string | null>(null)
  const [svg, setSvg] = useState('')
  const [error, setError] = useState('')
  const [stamp, setStamp] = useState(0)
  const frame = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    setError('')
    if (a.kind === 'html' && a.code) api.files.artifact(a.code).then(setSrc)
    else if (a.kind === 'file' && a.path) setSrc(a.path)
    else if (a.kind === 'svg' && a.code) setSrc(null)
    else if (a.kind === 'mermaid' && a.code) renderMermaid(a.code, dark).then(setSvg).catch((e) => setError(String(e?.message || e)))
  }, [a, dark])

  // файл, который пишет агент: обновляем предпросмотр, как только файл меняется
  useEffect(() => {
    if (a.kind !== 'file' || !a.path) return
    let last = 0
    const t = setInterval(async () => {
      const m = await api.files.mtime(a.path!)
      if (last && m !== last) setStamp(Date.now())
      last = m
    }, 1200)
    return () => clearInterval(t)
  }, [a])

  if (error) return <div className="panel-empty">Не получилось построить схему:<pre>{error}</pre></div>
  if (a.kind === 'svg') {
    return <div className="svg-view"><img src={'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(a.code || '')} /></div>
  }
  if (a.kind === 'mermaid') return <div className="svg-view" dangerouslySetInnerHTML={{ __html: svg }} />
  if (!src) return <div className="panel-empty">Готовлю предпросмотр…</div>
  if (a.kind === 'file' && /\.svg$/i.test(src)) return <div className="svg-view"><img src={fileUrl(src) + '?' + stamp} /></div>
  return (
    <iframe ref={frame} key={src + stamp} className="artifact-frame" src={fileUrl(src)}
      sandbox="allow-scripts allow-forms allow-modals allow-popups" title={a.title} />
  )
}

// ---------------------------------------------------------------- изменения

function DiffLines({ text }: { text: string }) {
  const all = text.split('\n')
  const lines = all.slice(Math.max(0, all.findIndex((l) => l.startsWith('@@')))) // без служебной шапки diff
  if (!lines.some((l) => l.startsWith('@@'))) return <div className="panel-empty">Файл не отличается от исходного</div>
  return (
    <div className="diff side">
      {lines.map((l, i) => {
        const cls = l.startsWith('@@') ? 'hunk' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : ''
        return <div key={i} className={cls}>{l || ' '}</div>
      })}
    </div>
  )
}

function Changes() {
  const current = useApp((s) => s.current)
  const messages = current?.chat.messages
  const [list, setList] = useState<ChangeSummary[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const [diff, setDiff] = useState('')
  useEffect(() => {
    if (current) api.chats.changes(current.projectId, current.chat.id).then(setList)
  }, [current?.chat.id, messages?.length, messages])
  useEffect(() => {
    const c = list.find((x) => x.path === open)
    if (c) api.chats.diff(c.path, c.backup).then(setDiff)
  }, [open, list])
  const live = list.filter((c) => !c.undone && c.callIds.length)
  if (!list.length) return <div className="panel-empty">В этом чате агент пока не менял файлы.<br />Здесь появятся все правки с разницей «было / стало».</div>
  return (
    <div className="changes">
      <div className="changes-head">
        {live.length ? `Изменено файлов: ${live.length}` : 'Все изменения отменены'}
        {live.length > 1 && (
          <button className="meta-btn" onClick={() => undoChanges(live.flatMap((c) => c.callIds))}><Undo2 size={13} />Откатить всё</button>
        )}
      </div>
      {list.map((c) => (
        <div key={c.path} className={`change ${open === c.path ? 'open' : ''}`}>
          <button className="change-row" onClick={() => setOpen(open === c.path ? null : c.path)}>
            <FileDiff size={15} />
            <span className="change-name" title={c.path}>{baseName(c.path)}<span>{c.path.split(/[\\/]/).slice(-3, -1).join('/')}</span></span>
            <span className={`change-tag ${c.undone ? 'undone' : c.backup ? 'mod' : 'new'}`}>{c.undone ? 'отменено' : c.backup ? 'изменён' : 'новый'}</span>
          </button>
          {open === c.path && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
              <div className="change-actions">
                {!c.undone && <button className="meta-btn" onClick={() => undoChanges(c.callIds)}><Undo2 size={13} />Вернуть как было</button>}
                <button className="meta-btn" onClick={() => api.shell.open(c.path)}><ExternalLink size={13} />Открыть</button>
                <button className="meta-btn" onClick={() => api.shell.reveal(c.path)}><FolderOpen size={13} />В папке</button>
              </div>
              <DiffLines text={diff} />
            </motion.div>
          )}
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- панель

export function SidePanel() {
  const panel = useApp((s) => s.panel)
  const [width, setWidth] = useState(() => Number(localStorage.getItem('panelWidth')) || 560)
  const drag = useRef<{ x: number; w: number } | null>(null)
  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!drag.current) return
      const w = Math.max(360, Math.min(window.innerWidth - 520, drag.current.w + drag.current.x - e.clientX))
      setWidth(w)
    }
    const up = () => {
      if (drag.current) localStorage.setItem('panelWidth', String(width))
      drag.current = null
      document.body.style.cursor = ''
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [width])
  if (!panel) return null
  const a = panel.tab === 'preview' ? panel.artifact : panel.artifact
  return (
    <motion.aside className="side-panel" style={{ width }} initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }}
      transition={{ type: 'spring', stiffness: 420, damping: 38 }}>
      <div className="resizer" onMouseDown={(e) => {
        drag.current = { x: e.clientX, w: width }
        document.body.style.cursor = 'col-resize'
      }} />
      <div className="side-head drag">
        <div className="seg">
          {a && <button className={panel.tab === 'preview' ? 'on' : ''} onClick={() => set({ panel: { ...panel, tab: 'preview' } })}>Предпросмотр</button>}
          <button className={panel.tab === 'changes' ? 'on' : ''} onClick={() => set({ panel: { ...panel, tab: 'changes' } })}>Изменения</button>
          <button className={panel.tab === 'files' ? 'on' : ''} onClick={() => set({ panel: { ...panel, tab: 'files' } })}>Файлы</button>
          <button className={panel.tab === 'terminal' ? 'on' : ''} onClick={() => set({ panel: { ...panel, tab: 'terminal' } })}>Терминал</button>
          <button className={panel.tab === 'git' ? 'on' : ''} onClick={() => set({ panel: { ...panel, tab: 'git' } })}>Git</button>
        </div>
        {panel.tab === 'preview' && a && <span className="side-title" title={a.path || a.title}>{a.title}</span>}
        <div style={{ flex: 1 }} />
        {panel.tab === 'preview' && a && (a.kind === 'html' || a.kind === 'file') && (
          <>
            <button className="icon-btn" title="Обновить" onClick={() => set({ panel: { ...panel, artifact: { ...a } } })}><RefreshCw size={16} /></button>
            <button className="icon-btn" title="Открыть в браузере" onClick={async () => api.shell.open(a.path || await api.files.artifact(a.code || ''))}><ExternalLink size={16} /></button>
          </>
        )}
        <button className="icon-btn" title="Закрыть" onClick={closePanel}><X size={16} /></button>
      </div>
      <div className="side-body">
        {panel.tab === 'preview' && a ? <Preview a={a} />
          : panel.tab === 'terminal' ? <TerminalView />
          : panel.tab === 'files' ? <FilesView />
          : panel.tab === 'git' ? <GitView />
          : <Changes />}
      </div>
    </motion.aside>
  )
}
