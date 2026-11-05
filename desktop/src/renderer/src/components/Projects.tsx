import { ChevronLeft, FolderKanban, FolderOpen, MoreHorizontal, Pencil, Plus, Search, Settings2, Trash2, Upload } from 'lucide-react'
import { motion } from 'motion/react'
import { useEffect, useMemo, useState } from 'react'
import type { ChatSummary, KnowledgeFile, Project } from '@shared/types'
import { openChat, openProject, refreshProjects, refreshRecents, toast } from '../lib/actions'
import { api } from '../lib/api'
import { ago, chatsWord, colorFor, humanSize } from '../lib/format'
import { set, useApp } from '../lib/store'
import { Header } from './ChatPage'
import { Composer } from './Composer'
import { Modal } from './Modal'

function ProjectIcon({ p, size = 38 }: { p: Project; size?: number }) {
  const c = colorFor(p.name)
  return (
    <div className="card-icon" style={{ width: size, height: size, background: `linear-gradient(135deg, ${c}, color-mix(in srgb, ${c} 70%, #000))` }}>
      {p.name.slice(0, 1).toUpperCase()}
    </div>
  )
}

export function ProjectDialog({ open, onClose, project }: { open: boolean; onClose(): void; project?: Project | null }) {
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [folder, setFolder] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  useEffect(() => {
    if (!open) return
    setName(project?.name || '')
    setDesc(project?.description || '')
    setFolder(null)
    setConfirmDelete(false)
  }, [open, project])

  const save = async () => {
    if (!name.trim()) return
    if (project) {
      await api.projects.save({ ...project, name: name.trim(), description: desc.trim() })
      refreshProjects()
      refreshRecents()
      onClose()
    } else {
      const p = await api.projects.create({ name: name.trim(), description: desc.trim(), folder: folder || undefined })
      await refreshProjects()
      onClose()
      openProject(p.id)
    }
  }
  const remove = async () => {
    if (!project) return
    await api.projects.remove(project.id)
    refreshProjects()
    refreshRecents()
    onClose()
    toast(`Проект «${project.name}» удалён. Папка с файлами осталась на диске.`)
    set({ view: { page: 'projects' } })
  }

  return (
    <Modal open={open} onClose={onClose} title={project ? 'Настройки проекта' : 'Новый проект'}
      footer={<>
        {project && (confirmDelete
          ? <button className="btn danger" onClick={remove} style={{ marginRight: 'auto' }}><Trash2 size={15} />Точно удалить?</button>
          : <button className="btn ghost danger" onClick={() => setConfirmDelete(true)} style={{ marginRight: 'auto' }}><Trash2 size={15} />Удалить</button>)}
        <button className="btn ghost" onClick={onClose}>Отмена</button>
        <button className="btn primary" onClick={save} disabled={!name.trim()}>{project ? 'Сохранить' : 'Создать проект'}</button>
      </>}>
      <div className="modal-body">
        <div className="field">
          <label>Над чем вы работаете?</label>
          <input className="input" autoFocus placeholder="Название проекта" value={name} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && save()} />
        </div>
        <div className="field">
          <label>Чего вы хотите добиться?</label>
          <textarea className="textarea" placeholder="Опишите проект, цели, тему…" value={desc} onChange={(e) => setDesc(e.target.value)} />
        </div>
        {!project && (
          <div className="field">
            <div className="hint" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {folder ? <>Папка: <b style={{ color: 'var(--text)' }}>{folder}</b></> : 'Файлы проекта будут храниться в общей папке проектов.'}
              <button className="btn ghost" style={{ height: 26, padding: '0 8px', fontSize: 12 }}
                onClick={async () => setFolder(await api.projects.pickFolder())}>
                <FolderOpen size={13} />{folder ? 'Другая' : 'Выбрать свою папку'}
              </button>
            </div>
          </div>
        )}
        {project && <div className="hint" style={{ marginBottom: 12 }}>Папка: {project.folder}</div>}
      </div>
    </Modal>
  )
}

export function ProjectsPage() {
  const projects = useApp((s) => s.projects)
  const [q, setQ] = useState('')
  const [creating, setCreating] = useState(false)
  const list = useMemo(() => projects.filter((p) => `${p.name} ${p.description}`.toLowerCase().includes(q.toLowerCase())), [projects, q])
  useEffect(() => {
    refreshProjects()
  }, [])
  return (
    <>
      <Header><div /></Header>
      <div className="page">
        <div className="page-inner">
          <div className="page-head">
            <h1>Проекты</h1>
            <button className="btn primary" onClick={() => setCreating(true)}><Plus size={16} />Новый проект</button>
          </div>
          {projects.length > 0 && (
            <div className="search-box"><Search size={16} />
              <input placeholder="Найти проект…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
          )}
          {projects.length === 0 ? (
            <motion.div className="empty-state" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
              <div className="big"><FolderKanban size={30} /></div>
              <h3>Создайте первый проект</h3>
              <p>Проект собирает чаты, инструкции и файлы по одной теме —<br />агент учитывает их в каждом разговоре.</p>
              <button className="btn primary" style={{ marginTop: 12 }} onClick={() => setCreating(true)}><Plus size={16} />Новый проект</button>
            </motion.div>
          ) : (
            <div className="cards">
              {list.map((p, i) => (
                <motion.button key={p.id} className="card" onClick={() => openProject(p.id)}
                  initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.03, duration: 0.3 }}>
                  <ProjectIcon p={p} />
                  <h3>{p.name}</h3>
                  {p.description && <p>{p.description}</p>}
                  <div className="foot">{chatsWord(p.chat_count || 0)} · {ago(p.updated || p.created)}</div>
                </motion.button>
              ))}
            </div>
          )}
        </div>
      </div>
      <ProjectDialog open={creating} onClose={() => setCreating(false)} />
    </>
  )
}

export function ProjectPage({ projectId }: { projectId: string }) {
  const projects = useApp((s) => s.projects)
  const project = projects.find((p) => p.id === projectId)
  const [chats, setChats] = useState<ChatSummary[]>([])
  const [files, setFiles] = useState<KnowledgeFile[]>([])
  const [editing, setEditing] = useState(false)
  const [instr, setInstr] = useState<string | null>(null)
  const [over, setOver] = useState(false)

  useEffect(() => {
    api.chats.list(projectId).then(setChats)
    api.projects.knowledge(projectId).then(setFiles)
  }, [projectId])

  if (!project) return <><Header><div /></Header><div className="empty-state">Проект не найден</div></>

  const saveInstr = async () => {
    await api.projects.save({ ...project, instructions: instr || '' })
    setInstr(null)
    refreshProjects()
  }
  const dropFiles = async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setOver(false)
    const paths = [...e.dataTransfer.files].map((f) => api.attach.pathFor(f)).filter(Boolean)
    if (paths.length) setFiles(await api.projects.addFiles(projectId, paths))
  }

  return (
    <>
      <Header><div /></Header>
      <div className="page">
        <div className="page-inner">
          <button className="back-link" onClick={() => set({ view: { page: 'projects' } })}><ChevronLeft size={16} />Все проекты</button>
          <div className="proj-layout">
            <div>
              <div className="proj-title">
                <ProjectIcon p={project} size={42} />
                <h1>{project.name}</h1>
                <button className="icon-btn" title="Настройки проекта" onClick={() => setEditing(true)}><MoreHorizontal size={18} /></button>
              </div>
              {project.description ? <p className="proj-desc">{project.description}</p> : <div style={{ height: 14 }} />}
              <Composer placement="bottom" />
              <div className="list-title">Чаты проекта</div>
              {chats.length === 0 && <div style={{ color: 'var(--muted)', padding: '6px 2px' }}>Пока нет чатов — напишите что-нибудь выше.</div>}
              {chats.map((c) => (
                <button key={c.id} className="proj-chat" onClick={() => openChat(projectId, c.id)}>
                  <span className="t">{c.title}</span><span className="d">{ago(c.updated)}</span>
                </button>
              ))}
            </div>
            <div>
              <div className="side-card">
                <div className="side-card-head">
                  <b>Инструкции</b>
                  <button className="icon-btn sm" title="Изменить" onClick={() => setInstr(project.instructions || '')}><Pencil size={14} /></button>
                </div>
                {project.instructions
                  ? <div className="clamp">{project.instructions}</div>
                  : <div className="muted">Как агенту вести себя в этом проекте: стиль, язык, правила.</div>}
              </div>
              <div className="side-card" onDragOver={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setOver(true)
              }} onDragLeave={() => setOver(false)} onDrop={dropFiles}>
                <div className="side-card-head">
                  <b>Файлы проекта</b>
                  <button className="icon-btn sm" title="Добавить файлы" onClick={async () => setFiles(await api.projects.addFiles(projectId))}><Plus size={15} /></button>
                </div>
                {files.map((f) => (
                  <div key={f.path} className="kfile">
                    <span className="kfile-icon">{(f.name.split('.').pop() || '').slice(0, 4)}</span>
                    <div style={{ flex: 1, minWidth: 0 }} onDoubleClick={() => api.shell.open(f.path)}>
                      <div className="n">{f.name}</div>
                      <div className="s">{humanSize(f.size)}</div>
                    </div>
                    <button className="icon-btn sm" title="Убрать из проекта"
                      onClick={async () => setFiles(await api.projects.removeFile(projectId, f.path))}><Trash2 size={14} /></button>
                  </div>
                ))}
                <div className={`drop-hint ${over ? 'over' : ''}`}>
                  <Upload size={16} style={{ marginBottom: 4 }} /><br />
                  {files.length ? 'Перетащите ещё файлы' : 'Перетащите сюда документы, код, тексты — агент будет видеть их в каждом чате проекта'}
                </div>
              </div>
              <button className="btn ghost" style={{ width: '100%', justifyContent: 'center' }} onClick={() => api.shell.open(project.folder)}>
                <FolderOpen size={15} />Открыть папку проекта
              </button>
              <button className="btn ghost" style={{ width: '100%', justifyContent: 'center', marginTop: 4 }} onClick={() => setEditing(true)}>
                <Settings2 size={15} />Настройки проекта
              </button>
            </div>
          </div>
        </div>
      </div>
      <ProjectDialog open={editing} onClose={() => setEditing(false)} project={project} />
      <Modal open={instr !== null} onClose={() => setInstr(null)} title="Инструкции проекта" width={620}
        footer={<><button className="btn ghost" onClick={() => setInstr(null)}>Отмена</button><button className="btn primary" onClick={saveInstr}>Сохранить</button></>}>
        <div className="modal-body">
          <div className="hint" style={{ marginBottom: 10, fontSize: 13, color: 'var(--text-2)' }}>
            Агент получает эти инструкции в каждом чате проекта.
          </div>
          <textarea className="textarea" style={{ minHeight: 260 }} autoFocus value={instr || ''} onChange={(e) => setInstr(e.target.value)}
            placeholder="Например: отвечай кратко, код пиши на TypeScript, комментарии на русском…" />
        </div>
      </Modal>
    </>
  )
}

