import { Crown, FolderKanban, Images, MoreHorizontal, PanelLeftClose, Pencil, Plus, Search, Settings2, Trash2 } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useMemo, useRef, useState } from 'react'
import { money } from '@shared/pricing'
import type { ChatSummary } from '@shared/types'
import { deleteChat, newChat, openChat, renameChat, saveSettings } from '../lib/actions'
import { api } from '../lib/api'
import { dateGroup } from '../lib/format'
import { set, useApp } from '../lib/store'
import { Lights } from './Lights'
import { Popover } from './Popover'
import { UpdateBanner } from './UpdateBanner'

function ChatRow({ c, active, live }: { c: ChatSummary; active: boolean; live: boolean }) {
  const [menu, setMenu] = useState(false)
  const [editing, setEditing] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  if (editing) {
    return (
      <input className="chat-title-input" style={{ width: '100%', height: 34 }} autoFocus defaultValue={c.title}
        onBlur={(e) => {
          renameChat(c.project_id, c.id, e.target.value)
          setEditing(false)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') setEditing(false)
        }} />
    )
  }
  return (
    <div className={`chat-row ${active ? 'active' : ''}`} onClick={() => openChat(c.project_id, c.id)}
      onDoubleClick={() => setEditing(true)}>
      {live && <span className="live" />}
      <span className="title">{c.title || 'Без названия'}</span>
      {c.project_name && <span className="proj">{c.project_name}</span>}
      <button ref={btn} className="icon-btn sm row-act" data-open={menu || undefined}
        onClick={(e) => {
          e.stopPropagation()
          setMenu(!menu)
        }}>
        <MoreHorizontal size={15} />
      </button>
      <Popover anchor={btn} open={menu} onClose={() => setMenu(false)} className="menu" gap={4}>
        <div onClick={(e) => e.stopPropagation()}>
          <button className="menu-item" onClick={() => {
            setMenu(false)
            setEditing(true)
          }}><Pencil size={14} />Переименовать</button>
          <div className="menu-sep" />
          <button className="menu-item danger" onClick={() => {
            setMenu(false)
            deleteChat(c.project_id, c.id)
          }}><Trash2 size={14} />Удалить</button>
        </div>
      </Popover>
    </div>
  )
}

export function Sidebar() {
  const open = useApp((s) => s.settings?.sidebar ?? true)
  const recents = useApp((s) => s.recents)
  const currentId = useApp((s) => s.current?.chat.id)
  const view = useApp((s) => s.view)
  const runs = useApp((s) => s.runs)
  const balance = useApp((s) => s.balance)
  const name = useApp((s) => s.settings?.user_name) || api.userName

  const groups = useMemo(() => {
    const out: [string, ChatSummary[]][] = []
    for (const c of recents) {
      const g = dateGroup(c.updated)
      if (out[out.length - 1]?.[0] !== g) out.push([g, []])
      out[out.length - 1][1].push(c)
    }
    return out
  }, [recents])

  const usd = balance?.USD
  return (
    <motion.aside className="sidebar" initial={false} animate={{ width: open ? 268 : 0, opacity: open ? 1 : 0 }}
      transition={{ type: 'spring', stiffness: 420, damping: 40 }}>
      <div className="sidebar-inner">
        <div className="side-top drag">
          <Lights />
          <button className="icon-btn" title="Скрыть панель (Ctrl+B)" onClick={() => saveSettings({ sidebar: false })}>
            <PanelLeftClose size={18} />
          </button>
        </div>
        <div className="brand"><Crown size={20} className="mark" />Mouse King Pro</div>
        <button className="nav-btn" onClick={() => newChat()}>
          <span className="new-chat-icon"><Plus size={15} strokeWidth={2.5} /></span>
          <span>Новый чат</span><span className="kbd">Ctrl N</span>
        </button>
        <button className="nav-btn" onClick={() => set({ palette: true })}>
          <span className="nav-icon"><Search size={17} /></span><span>Поиск</span><span className="kbd">Ctrl K</span>
        </button>
        <button className={`nav-btn ${view.page === 'projects' || view.page === 'project' ? 'active' : ''}`} onClick={() => set({ view: { page: 'projects' } })}>
          <span className="nav-icon"><FolderKanban size={17} /></span><span>Проекты</span>
        </button>
        <button className={`nav-btn ${view.page === 'gallery' ? 'active' : ''}`} onClick={() => set({ view: { page: 'gallery' } })}>
          <span className="nav-icon"><Images size={17} /></span><span>Галерея</span>
        </button>
        <div className="section-label">Недавние</div>
        <div className="recents">
          <AnimatePresence initial={false}>
            {groups.map(([g, list]) => (
              <motion.div key={g} layout="position">
                <div className="group-label">{g}</div>
                {list.map((c) => (
                  <ChatRow key={c.id} c={c} active={view.page === 'chat' && c.id === currentId} live={!!runs[c.id]} />
                ))}
              </motion.div>
            ))}
          </AnimatePresence>
          {recents.length === 0 && <div className="group-label" style={{ padding: '10px' }}>Здесь появятся ваши чаты</div>}
        </div>
        <UpdateBanner />
        <div className="user-card">
          <div className="avatar">{name.slice(0, 1).toUpperCase()}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="user-name">{name}</div>
            <div className={`balance ${usd != null && usd < 1 ? 'low' : ''}`} title="Остаток на счету Venice API">
              {usd != null ? <><span className="dot" />Баланс {money(usd)}</> : 'Venice API'}
            </div>
          </div>
          <button className="icon-btn" title="Настройки (Ctrl+,)" onClick={() => set({ settingsOpen: true })}><Settings2 size={18} /></button>
        </div>
      </div>
    </motion.aside>
  )
}
