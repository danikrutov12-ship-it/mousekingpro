import { AnimatePresence, motion } from 'motion/react'
import { X } from 'lucide-react'
import { useEffect, type ReactNode } from 'react'

export const spring = { type: 'spring' as const, stiffness: 520, damping: 34, mass: 0.8 }

/** Модальное окно с размытой подложкой и пружинным появлением. */
export function Modal({ open, onClose, title, icon, children, footer, className = '', width }: {
  open: boolean; onClose(): void; title?: ReactNode; icon?: ReactNode; children: ReactNode
  footer?: ReactNode; className?: string; width?: number
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
          <motion.div className={`modal ${className}`} style={width ? { width } : undefined}
            initial={{ opacity: 0, scale: 0.96, y: -8 }} animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: -6, transition: { duration: 0.12 } }} transition={spring}>
            {title !== undefined && (
              <div className="modal-head">
                {icon}
                <h2>{title}</h2>
                <button className="icon-btn sm" onClick={onClose} aria-label="Закрыть"><X size={16} /></button>
              </div>
            )}
            {children}
            {footer && <div className="modal-foot">{footer}</div>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
