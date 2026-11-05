import { ChevronRight, File, Folder, GitBranch, GitMerge, Loader2, Save, Upload } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { GitInfo } from '@shared/types'
import { toast } from '../lib/actions'
import { api } from '../lib/api'
import { ago, fileUrl, baseName } from '../lib/format'
import { get, set, useApp } from '../lib/store'

const projectFolder = () => {
  const { current, projects, defaultProject } = get()
  const p = projects.find((x) => x.id === current?.projectId) || defaultProject
  return p?.folder || '~'
}

// ---------------------------------------------------------------- терминал

const terms = new Map<string, { id: string; buffer: string }>() // терминал живёт, пока открыто приложение

export function TerminalView() {
  const box = useRef<HTMLDivElement>(null)
  const dark = useApp((s) => s.win.dark)
  useEffect(() => {
    let disposed = false
    let cleanup = () => {}
    ;(async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')])
      await import('@xterm/xterm/css/xterm.css')
      if (disposed || !box.current) return
      const term = new Terminal({
        fontFamily: 'Mono, monospace', fontSize: 13, cursorBlink: true, scrollback: 5000,
        theme: dark ? { background: '#1b1a18', foreground: '#ece9e3', cursor: '#df7a54' } : { background: '#fbfaf7', foreground: '#1f1d1a', cursor: '#c8613c', selectionBackground: '#ead9cf' },
      })
      const fit = new FitAddon()
      term.loadAddon(fit)
      term.open(box.current)
      fit.fit()
      const key = projectFolder()
      let t = terms.get(key)
      if (!t) {
        t = { id: await api.term.create(key, term.cols, term.rows), buffer: '' }
        terms.set(key, t)
      } else term.write(t.buffer)
      const session = t
      const offData = api.term.onData((id, d) => {
        if (id !== session.id) return
        session.buffer = (session.buffer + d).slice(-200_000)
        term.write(d)
      })
      const offExit = api.term.onExit((id) => id === session.id && terms.delete(key))
      const input = term.onData((d) => api.term.write(session.id, d))
      const ro = new ResizeObserver(() => {
        fit.fit()
        api.term.resize(session.id, term.cols, term.rows)
      })
      ro.observe(box.current)
      term.focus()
      cleanup = () => {
        offData()
        offExit()
        input.dispose()
        ro.disconnect()
        term.dispose()
      }
    })()
    return () => {
      disposed = true
      cleanup()
    }
  }, [dark])
  return <div className="term-box" ref={box} />
}

// ---------------------------------------------------------------- файлы и редактор

function Tree({ dir, depth, onOpen, active }: { dir: string; depth: number; onOpen(p: string): void; active?: string }) {
  const [items, setItems] = useState<{ name: string; path: string; dir: boolean }[]>([])
  const [open, setOpen] = useState<Record<string, boolean>>({})
  useEffect(() => {
    api.fs.tree(dir).then(setItems)
  }, [dir])
  return (
    <>
      {items.map((it) => (
        <div key={it.path}>
          <button className={`tree-row ${active === it.path ? 'on' : ''}`} style={{ paddingLeft: 8 + depth * 14 }}
            onClick={() => (it.dir ? setOpen({ ...open, [it.path]: !open[it.path] }) : onOpen(it.path))}>
            {it.dir ? <ChevronRight size={13} style={{ transform: open[it.path] ? 'rotate(90deg)' : undefined, transition: 'transform .15s' }} /> : <span style={{ width: 13 }} />}
            {it.dir ? <Folder size={14} /> : <File size={14} />}
            <span>{it.name}</span>
          </button>
          {it.dir && open[it.path] && <Tree dir={it.path} depth={depth + 1} onOpen={onOpen} active={active} />}
        </div>
      ))}
    </>
  )
}

const IMG = /\.(png|jpe?g|webp|gif|bmp|svg|avif)$/i
const VID = /\.(mp4|webm|mov|mkv)$/i

/** Картинки и видео из файлов проекта: просмотр и те же действия, что в галерее. */
function MediaPreview({ path }: { path: string }) {
  const isImg = IMG.test(path)
  return (
    <div className="file-preview">
      <div className="editor-bar">
        <span className="side-title">{baseName(path)}</span>
        {isImg && !/\.svg$/i.test(path) && <button className="btn" style={{ height: 28 }} onClick={() => set({ viewer: path })}>Версии и действия</button>}
        <button className="btn" style={{ height: 28 }} onClick={() => api.shell.open(path)}>Открыть</button>
      </div>
      <div className="fp-body">
        {isImg ? <img src={fileUrl(path)} onClick={() => set({ lightbox: path })} draggable={false} /> : <video src={fileUrl(path)} controls />}
      </div>
    </div>
  )
}

function Editor({ path }: { path: string }) {
  const dark = useApp((s) => s.win.dark)
  const [text, setText] = useState<string | null>(null)
  const [saved, setSaved] = useState('')
  const [ext, setExt] = useState<any[]>([])
  const [Cm, setCm] = useState<any>(null)
  useEffect(() => {
    api.files.read(path).then((t) => {
      setText(t)
      setSaved(t ?? '')
    })
    ;(async () => {
      const [{ default: CodeMirror }, { languages }] = await Promise.all([import('@uiw/react-codemirror'), import('@codemirror/language-data')])
      setCm(() => CodeMirror)
      const lang = languages.find((l: any) => l.extensions.some((e: string) => path.toLowerCase().endsWith('.' + e)) || l.filename?.test(baseName(path)))
      setExt(lang ? [await lang.load()] : [])
    })()
  }, [path])
  const dirty = text !== null && text !== saved
  const save = async () => {
    if (text === null) return
    await api.fs.write(path, text)
    setSaved(text)
    toast('Сохранено', 'ok')
  }
  if (text === null) return <div className="panel-empty">Файл слишком большой или не текстовый</div>
  return (
    <div className="editor" onKeyDown={(e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        save()
      }
    }}>
      <div className="editor-bar">
        <span className="side-title">{baseName(path)}{dirty ? ' •' : ''}</span>
        <div style={{ flex: 1 }} />
        <button className="btn" style={{ height: 28 }} disabled={!dirty} onClick={save} title="Ctrl+S"><Save size={13} />Сохранить<span className="kbd">Ctrl S</span></button>
      </div>
      {Cm ? <Cm value={text} onChange={setText} theme={dark ? 'dark' : 'light'} extensions={ext} height="100%" style={{ flex: 1, minHeight: 0, overflow: 'auto', fontSize: 13 }}
        basicSetup={{ foldGutter: true, highlightActiveLine: true }} /> : <div className="panel-empty"><Loader2 className="spin" size={18} /></div>}
    </div>
  )
}

export function FilesView() {
  const file = useApp((s) => s.panel?.file)
  const pid = useApp((s) => s.current?.projectId)
  const root = useMemo(projectFolder, [pid])
  const open = (p: string) => set((s) => ({ panel: { ...(s.panel || { tab: 'files' }), tab: 'files', file: p } }))
  return (
    <div className="files">
      <div className="tree"><Tree dir={root} depth={0} onOpen={open} active={file} /></div>
      <div className="files-main">{file ? (IMG.test(file) || VID.test(file) ? <MediaPreview key={file} path={file} /> : <Editor key={file} path={file} />) : <div className="panel-empty">Выберите файл слева — его можно посмотреть и поправить</div>}</div>
    </div>
  )
}

// ---------------------------------------------------------------- git

export function GitView() {
  const current = useApp((s) => s.current)
  const msgs = current?.chat.messages.length
  const [info, setInfo] = useState<GitInfo | null>(null)
  const [busy, setBusy] = useState('')
  const load = () => current && !current.isNew && api.git.info(current.projectId, current.chat.id).then(setInfo)
  useEffect(() => {
    load()
  }, [current?.chat.id, msgs])
  if (!current || current.isNew) return <div className="panel-empty">Начните чат — у него будет своя ветка git</div>
  if (!info) return <div className="panel-empty"><Loader2 className="spin" size={18} /></div>
  if (!info.repo) {
    return (
      <div className="panel-empty">
        Папка проекта — не git-репозиторий.<br />С git у каждого чата будет своя ветка и коммит после каждого ответа агента.
        <br /><br />
        <button className="btn primary" onClick={async () => {
          await api.git.init(current.projectId)
          load()
        }}><GitBranch size={14} />Включить git для проекта</button>
      </div>
    )
  }
  const act = async (name: string, fn: () => Promise<any>) => {
    setBusy(name)
    try {
      const r = await fn()
      if (typeof r === 'string') toast(r, /Конфликт|Не удалось/.test(r) ? 'error' : 'ok')
      else if (r?.url) {
        toast('Ветка отправлена — открываю создание pull request', 'ok')
        api.shell.external(r.url)
      } else if (r) toast(r.text, r.ok ? 'ok' : 'error')
    } finally {
      setBusy('')
      load()
    }
  }
  return (
    <div className="git">
      <div className="git-head">
        <GitBranch size={16} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <b className="mono">{info.branch}</b>
          <div className="sub">от {info.base}{info.current !== info.branch ? ` · сейчас открыта ${info.current}` : ''}{info.dirty ? ` · несохранённых изменений: ${info.dirty}` : ''}</div>
        </div>
      </div>
      <div className="git-actions">
        <button className="btn" disabled={!info.commits?.length || !!busy} onClick={() => act('merge', () => api.git.merge(current.projectId, current.chat.id))}>
          {busy === 'merge' ? <Loader2 size={14} className="spin" /> : <GitMerge size={14} />}Влить в {info.base}
        </button>
        <button className="btn" disabled={!info.remote || !info.exists || !!busy} title={info.remote ? info.remote : 'Нет удалённого репозитория (origin)'}
          onClick={() => act('push', () => api.git.push(current.projectId, current.chat.id))}>
          {busy === 'push' ? <Loader2 size={14} className="spin" /> : <Upload size={14} />}Отправить и создать PR
        </button>
      </div>
      <div className="list-title" style={{ margin: '14px 4px 6px' }}>Коммиты агента в этой ветке</div>
      {!info.commits?.length && <div className="sub" style={{ padding: '0 4px' }}>Пока нет — коммит появится после ответа, в котором агент менял файлы.</div>}
      {info.commits?.map((c) => (
        <div key={c.hash} className="commit"><span className="mono">{c.hash}</span><span className="commit-subj">{c.subject}</span><span className="sub">{ago(Number(c.when))}</span></div>
      ))}
    </div>
  )
}
