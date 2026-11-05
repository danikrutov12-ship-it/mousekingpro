import { Archive, Code2, FileDiff, FolderOpen, FolderTree, GitBranch, Globe, Image, Moon, PanelLeftOpen, Plus, SquareTerminal, Sun, Video } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { Mode } from '@shared/types'
import { applySuggestion, closePanel, newChat, openChanges, openProject, renameChat, saveSettings, togglePanel } from '../lib/actions'
import { api } from '../lib/api'
import { greeting } from '../lib/format'
import { useApp } from '../lib/store'
import { Composer, ModeSwitch } from './Composer'
import { JobsButton } from './Jobs'
import { PlanCard } from './Plan'
import { Lights, Spark } from './Lights'
import { Thread } from './Thread'

const SUGGESTIONS: Record<Mode, [ReactNode, string, string][]> = {
  text: [
    [<FolderOpen size={15} />, 'Разбери проект', 'Разбери структуру этого проекта и кратко опиши, что где лежит'],
    [<Code2 size={15} />, 'Напиши скрипт', 'Напиши скрипт на Python, который '],
    [<Globe size={15} />, 'Найди в интернете', 'Найди в интернете '],
    [<Archive size={15} />, 'Изучи архив', 'Изучи прикреплённый архив и расскажи, что внутри'],
  ],
  image: [
    [<Image size={15} />, 'Закат над Венецией', 'Закат над каналами Венеции, гондолы, масляная живопись'],
    [<Image size={15} />, 'Кофейня в изометрии', 'Уютная кофейня в изометрии, мягкий свет, 3D-рендер'],
    [<Image size={15} />, 'Кот-астронавт', 'Портрет кота-астронавта, кинематографичный свет, 85 мм'],
  ],
  video: [
    [<Video size={15} />, 'Гондола на рассвете', 'Гондола медленно плывёт по каналу на рассвете, туман'],
    [<Video size={15} />, 'Дождь на стекле', 'Капли дождя стекают по стеклу, макросъёмка, огни города'],
    [<Video size={15} />, 'Пролёт над горами', 'Камера пролетает над горными вершинами в облаках'],
  ],
}

/** Кнопка «Изменения (N)»: сколько файлов агент поменял в этом чате. */
function ChangesButton() {
  const count = useApp((s) => new Set((s.current?.chat.messages || []).filter((m) => m._change && !m._undone).map((m) => m._change!.path)).size)
  const open = useApp((s) => s.panel?.tab === 'changes')
  if (!count) return null
  return (
    <button className={`jobs-btn ${open ? 'on' : ''}`} title="Файлы, изменённые в этом чате" onClick={() => (open ? closePanel() : openChanges())}>
      <FileDiff size={14} />Изменения: {count}
    </button>
  )
}

/** Быстрые кнопки правой панели: файлы, терминал, git. */
function PanelButtons() {
  const tab = useApp((s) => s.panel?.tab)
  return (
    <>
      <button className={`icon-btn ${tab === 'files' ? 'active' : ''}`} title="Файлы проекта" onClick={() => togglePanel('files')}><FolderTree size={17} /></button>
      <button className={`icon-btn ${tab === 'terminal' ? 'active' : ''}`} title="Терминал (Ctrl+`)" onClick={() => togglePanel('terminal')}><SquareTerminal size={17} /></button>
      <button className={`icon-btn ${tab === 'git' ? 'active' : ''}`} title="Git" onClick={() => togglePanel('git')}><GitBranch size={17} /></button>
    </>
  )
}

export function ThemeButton() {
  const dark = useApp((s) => s.win.dark)
  return (
    <button className="icon-btn" title={dark ? 'Светлая тема' : 'Тёмная тема'}
      onClick={() => saveSettings({ theme: dark ? 'light' : 'dark' })}>
      <AnimatePresence mode="wait" initial={false}>
        <motion.span key={dark ? 'sun' : 'moon'} style={{ display: 'grid' }}
          initial={{ rotate: -60, opacity: 0, scale: 0.6 }} animate={{ rotate: 0, opacity: 1, scale: 1 }}
          exit={{ rotate: 60, opacity: 0, scale: 0.6 }} transition={{ duration: 0.2 }}>
          {dark ? <Sun size={17} /> : <Moon size={17} />}
        </motion.span>
      </AnimatePresence>
    </button>
  )
}

/** Левая часть шапки, когда боковая панель скрыта: кнопки окна, открыть панель, новый чат. */
export function CollapsedControls() {
  const open = useApp((s) => s.settings?.sidebar ?? true)
  if (open) return null
  return (
    <motion.div style={{ display: 'flex', alignItems: 'center', gap: 6, marginRight: 6 }} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}>
      <Lights />
      <button className="icon-btn" title="Показать панель (Ctrl+B)" onClick={() => saveSettings({ sidebar: true })}><PanelLeftOpen size={18} /></button>
      <button className="icon-btn" title="Новый чат (Ctrl+N)" onClick={() => newChat()}><Plus size={18} /></button>
    </motion.div>
  )
}

function Title() {
  const current = useApp((s) => s.current)
  const projects = useApp((s) => s.projects)
  const defaultId = useApp((s) => s.defaultProject?.id)
  const [editing, setEditing] = useState(false)
  if (!current || current.isNew) return null
  const project = current.projectId !== defaultId ? projects.find((p) => p.id === current.projectId) : null
  return (
    <div className="crumbs">
      {project && <>
        <button className="crumb" onClick={() => openProject(project.id)}>{project.name}</button>
        <span className="crumb-sep">/</span>
      </>}
      {editing ? (
        <input className="chat-title-input" autoFocus defaultValue={current.chat.title}
          onBlur={(e) => {
            renameChat(current.projectId, current.chat.id, e.target.value)
            setEditing(false)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') setEditing(false)
          }} />
      ) : (
        <button className="chat-title" title="Переименовать" onClick={() => setEditing(true)}>{current.chat.title}</button>
      )}
    </div>
  )
}

export function Header({ children }: { children?: ReactNode }) {
  return (
    <div className="header drag">
      <CollapsedControls />
      {children ?? <Title />}
      <div style={{ flex: 1 }} />
      <ChangesButton />
      <JobsButton />
      <PanelButtons />
      <ThemeButton />
    </div>
  )
}

function Empty() {
  const mode = useApp((s) => s.mode)
  const name = useApp((s) => s.settings?.user_name) || api.userName
  const project = useApp((s) => (s.current && s.current.projectId !== s.defaultProject?.id ? s.projects.find((p) => p.id === s.current!.projectId) : null))
  const pretty = name.charAt(0).toUpperCase() + name.slice(1)
  return (
    <div className="empty">
      <div style={{ maxWidth: 760, width: '100%', margin: '0 auto', position: 'relative' }}>
        <motion.div className="greeting" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: [0.2, 0.8, 0.2, 1] }}>
          <motion.span className="star" animate={{ rotate: [0, 90] }} transition={{ duration: 1.2, ease: [0.3, 1.4, 0.4, 1] }}>
            <Spark size={34} />
          </motion.span>
          <h1>{project ? project.name : greeting(pretty)}</h1>
        </motion.div>
        <motion.div initial={{ opacity: 0, y: 18, scale: 0.985 }} animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.5, delay: 0.08, ease: [0.2, 0.8, 0.2, 1] }}>
          <Composer placement="center" />
        </motion.div>
        <motion.div style={{ display: 'flex', justifyContent: 'center', marginTop: 16 }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.2 }}>
          <ModeSwitch />
        </motion.div>
        <div className="suggestions">
          <AnimatePresence mode="popLayout">
            {SUGGESTIONS[mode].map(([icon, label, prompt], i) => (
              <motion.button key={mode + label} className="suggestion" onClick={() => applySuggestion(prompt)}
                initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0, transition: { delay: 0.25 + i * 0.05 } }}
                exit={{ opacity: 0, transition: { duration: 0.1 } }}>
                {icon}{label}
              </motion.button>
            ))}
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}

export function ChatPage() {
  const current = useApp((s) => s.current)
  const run = useApp((s) => (s.current ? s.runs[s.current.chat.id] : undefined))
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const chatId = current?.chat.id
  const count = current?.chat.messages.length || 0

  // при открытии чата — вниз; дальше прилипаем к низу, если пользователь не прокрутил вверх
  useLayoutEffect(() => {
    stick.current = true
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chatId])
  useEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTo({ top: el.scrollHeight, behavior: count > 0 && !run?.text ? 'smooth' : 'auto' })
  }, [count, run?.text, run?.status])

  const empty = !current || (current.chat.messages.length === 0 && !run)
  return (
    <>
      <Header />
      {empty ? <Empty /> : (
        <>
          <div className="header-fade" />
          <div className="scroll" ref={scroller} onScroll={(e) => {
            const el = e.currentTarget
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
          }}>
            <Thread messages={current!.chat.messages} run={run} />
          </div>
          <div className="composer-wrap bottom">
            <PlanCard messages={current!.chat.messages} live={!!run} />
            <Composer placement="bottom" />
            <div className="disclaimer">Модели могут ошибаться — проверяйте важное.</div>
          </div>
        </>
      )}
    </>
  )
}
