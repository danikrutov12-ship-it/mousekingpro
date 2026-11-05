import { Paperclip } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { attachFiles, init, newChat, saveSettings } from './lib/actions'
import { get, set, useApp } from './lib/store'
import { ChatPage } from './components/ChatPage'
import { ApprovalSheet, Lightbox, Palette, SettingsDialog, Toasts } from './components/Dialogs'
import { CompareDialog } from './components/Compare'
import { ProjectPage, ProjectsPage } from './components/Projects'
import { GalleryPage, ViewerHost } from './components/Gallery'
import { SidePanel } from './components/SidePanel'
import { Sidebar } from './components/Sidebar'

export function App() {
  const ready = useApp((s) => s.ready)
  const view = useApp((s) => s.view)
  const sidebar = useApp((s) => s.settings?.sidebar ?? true)
  const maximized = useApp((s) => s.win.maximized)
  const [dragging, setDragging] = useState(false)
  const depth = useRef(0)

  useEffect(() => {
    init()
  }, [])

  // горячие клавиши
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (!mod) return
      const k = e.key.toLowerCase()
      if (k === 'n' || k === 'т') newChat()
      else if (k === 'k' || k === 'л') set({ palette: !get().palette })
      else if (k === 'b' || k === 'и') saveSettings({ sidebar: !get().settings?.sidebar })
      else if (k === ',' || k === 'б') set({ settingsOpen: true })
      else if (k === '`' || k === 'ё') set((s) => ({ view: { page: 'chat' }, panel: s.panel?.tab === 'terminal' ? null : { tab: 'terminal', artifact: s.panel?.artifact } }))
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // перетаскивание файлов в окно — прикрепить к сообщению
  const hasFiles = (e: React.DragEvent) => e.dataTransfer.types.includes('Files')
  const onDragEnter = (e: React.DragEvent) => {
    if (!hasFiles(e)) return
    depth.current++
    setDragging(true)
  }
  const onDragLeave = (e: React.DragEvent) => {
    if (!hasFiles(e)) return
    depth.current = Math.max(0, depth.current - 1)
    if (!depth.current) setDragging(false)
  }
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    depth.current = 0
    setDragging(false)
    const files = [...e.dataTransfer.files]
    if (files.length) {
      if (get().view.page === 'projects') set({ view: { page: 'chat' } })
      attachFiles(files)
    }
  }

  if (!ready) return <div className="app" />
  return (
    <div className={`app ${sidebar ? 'with-sidebar' : 'no-sidebar'} ${maximized ? 'maximized' : ''}`}
      onDragEnter={onDragEnter} onDragLeave={onDragLeave} onDragOver={(e) => hasFiles(e) && e.preventDefault()} onDrop={onDrop}>
      <Sidebar />
      <main className="panel">
        <div className="panel-row">
        <div className="panel-main">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={view.page === 'project' ? 'project-' + view.projectId : view.page}
            style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.14 }}>
            {view.page === 'chat' && <ChatPage />}
            {view.page === 'projects' && <ProjectsPage />}
            {view.page === 'gallery' && <GalleryPage />}
            {view.page === 'project' && <ProjectPage projectId={view.projectId} />}
          </motion.div>
        </AnimatePresence>
        </div>
        <AnimatePresence>{view.page === 'chat' && <SidePanel />}</AnimatePresence>
        </div>
        <AnimatePresence>
          {dragging && (
            <motion.div className="drop-zone" initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}>
              <div className="inner"><Paperclip size={28} /><div>Отпустите, чтобы прикрепить</div>
                <div style={{ fontSize: 13, fontWeight: 400, color: 'var(--muted)', marginTop: 4 }}>Файлы, папки, архивы, картинки</div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
      <SettingsDialog />
      <ApprovalSheet />
      <Palette />
      <Lightbox />
      <Toasts />
      <CompareDialog />
      <ViewerHost />
    </div>
  )
}
