import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

/** Всплывающая панель у элемента-якоря: открывается вверх или вниз, где больше места. */
export function Popover({ anchor, open, onClose, children, className = '', align = 'start', gap = 8 }: {
  anchor: RefObject<HTMLElement | null>; open: boolean; onClose(): void; children: ReactNode
  className?: string; align?: 'start' | 'end'; gap?: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number; up: boolean; max: number } | null>(null)

  useLayoutEffect(() => {
    if (!open || !anchor.current) return
    const r = anchor.current.getBoundingClientRect()
    const up = r.top > window.innerHeight - r.bottom
    const width = ref.current?.offsetWidth || 0
    let left = align === 'end' ? r.right - width : r.left
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8))
    const max = (up ? r.top : window.innerHeight - r.bottom) - gap - 12
    setPos(up ? { left, bottom: window.innerHeight - r.top + gap, up, max } : { left, top: r.bottom + gap, up, max })
  }, [open, anchor, align, gap])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node) && !anchor.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onClose, anchor])

  // через портал: панель не обрезается и не сдвигается родителями с overflow/transform (карточки картинок и т.п.)
  return createPortal(
    <AnimatePresence onExitComplete={() => setPos(null)}>
      {open && (
        <motion.div ref={ref} className={`popover ${className}`}
          style={{ left: pos?.left ?? -9999, top: pos?.top, bottom: pos?.bottom, maxHeight: pos?.max, transformOrigin: pos?.up ? 'bottom left' : 'top left' }}
          initial={{ opacity: 0, scale: 0.96, y: pos?.up ? 6 : -6 }} animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.1 } }}
          transition={{ type: 'spring', stiffness: 600, damping: 36 }}>
          {children}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
