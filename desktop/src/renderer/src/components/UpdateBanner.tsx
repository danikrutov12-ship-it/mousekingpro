import { AlertCircle, ArrowDownToLine, Loader2, RotateCw, Sparkles, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'
import { api } from '../lib/api'
import { set, useApp } from '../lib/store'
import { Markdown } from './Markdown'

/** Плашка «Доступно обновление» внизу боковой панели: скачать → прогресс → перезапустить. */
export function UpdateBanner() {
  const u = useApp((s) => s.update)
  const hidden = useApp((s) => s.updateHidden)
  const [notes, setNotes] = useState(false)
  const show = !!u && ['available', 'downloading', 'ready'].includes(u.status) || (u?.status === 'error' && !!u.version)
  const visible = show && !(u!.status === 'available' && hidden === u!.version)

  return (
    <AnimatePresence>
      {visible && u && (
        <motion.div className={`update-card ${u.status}`} initial={{ opacity: 0, y: 16, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 12, scale: 0.97 }} transition={{ type: 'spring', stiffness: 380, damping: 30 }}>
          <div className="update-glow" />
          <div className="update-head">
            <span className="update-icon">
              {u.status === 'downloading' ? <Loader2 size={16} className="spin" /> : u.status === 'error' ? <AlertCircle size={16} /> : <Sparkles size={16} />}
            </span>
            <div className="update-text">
              <b>{u.status === 'ready' ? 'Обновление готово' : u.status === 'downloading' ? 'Загружаю обновление' : u.status === 'error' ? 'Не удалось обновить' : 'Доступно обновление'}</b>
              <span>
                {u.status === 'error' ? u.error : <>Версия {u.version}{u.notes && u.status === 'available' && <> · <a onClick={() => setNotes(!notes)}>{notes ? 'скрыть' : 'что нового'}</a></>}</>}
              </span>
            </div>
            {u.status === 'available' && (
              <button className="icon-btn sm" title="Напомнить позже" onClick={() => set({ updateHidden: u.version || '' })}><X size={14} /></button>
            )}
          </div>
          <AnimatePresence>
            {notes && u.notes && u.status === 'available' && (
              <motion.div className="update-notes" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}>
                <Markdown text={u.notes} />
              </motion.div>
            )}
          </AnimatePresence>
          {u.status === 'downloading' && (
            <div className="update-bar"><motion.i animate={{ width: `${Math.max(4, u.percent || 0)}%` }} /></div>
          )}
          {u.status === 'available' && (
            <button className="update-btn" onClick={() => api.update.download()}>
              <ArrowDownToLine size={15} />{u.mode === 'manual' ? 'Открыть страницу загрузки' : 'Скачать'}
            </button>
          )}
          {u.status === 'error' && (
            <button className="update-btn" onClick={() => api.update.download()}><RotateCw size={15} />Повторить</button>
          )}
          {u.status === 'ready' && (
            <button className="update-btn" onClick={() => api.update.install()}><RotateCw size={15} />Перезапустить и обновить</button>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
