import { Check, ChevronDown, Minus, Plus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Popover } from './Popover'

/** Выпадающий список в стиле приложения (вместо системного <select>). */
export function Dropdown<T extends string | number>({ label, value, options, onChange, format }: {
  label: string; value: T; options: T[]; onChange(v: T): void; format?(v: T): string
}) {
  const [open, setOpen] = useState(false)
  const [hl, setHl] = useState(0)
  const btn = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const show = (v: T) => (format ? format(v) : String(v))

  useEffect(() => {
    if (!open) return
    setHl(Math.max(0, options.indexOf(value)))
    requestAnimationFrame(() => list.current?.querySelector('.dd-item.on')?.scrollIntoView({ block: 'center' }))
  }, [open])

  const pick = (v: T) => {
    onChange(v)
    setOpen(false)
  }

  return (
    <>
      <button ref={btn} className={`opt dd ${open ? 'open' : ''}`} onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault()
            setOpen(true)
          } else if (open) {
            if (e.key === 'ArrowDown') setHl((h) => Math.min(h + 1, options.length - 1))
            else if (e.key === 'ArrowUp') setHl((h) => Math.max(h - 1, 0))
            else if (e.key === 'Enter') pick(options[hl])
            else return
            e.preventDefault()
          }
        }}>
        <label>{label}</label>
        <b>{show(value)}</b>
        <ChevronDown size={13} className="dd-chev" />
      </button>
      <Popover anchor={btn} open={open} onClose={() => setOpen(false)} className="menu dd-menu" gap={6}>
        <div ref={list} className="dd-list">
          {options.map((o, i) => (
            <button key={String(o)} className={`dd-item ${o === value ? 'on' : ''} ${i === hl ? 'hl' : ''}`}
              onMouseMove={() => setHl(i)} onClick={() => pick(o)}>
              <span>{show(o)}</span>
              {o === value && <Check size={14} />}
            </button>
          ))}
        </div>
      </Popover>
    </>
  )
}

/** Число с кнопками «−» и «+» (вместо системного поля со стрелками). */
export function Stepper({ label, value, min, max, step = 1, onChange }: {
  label: string; value: number; min: number; max: number; step?: number; onChange(v: number): void
}) {
  const clamp = (v: number) => Math.max(min, Math.min(max, v))
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  const commit = () => {
    const n = Number(text)
    if (Number.isFinite(n)) onChange(clamp(Math.round(n / step) * step))
    else setText(String(value))
  }
  return (
    <div className="opt stepper">
      <label>{label}</label>
      <button className="step-btn" onClick={() => onChange(clamp(value - step))} disabled={value <= min}><Minus size={12} /></button>
      <input value={text} inputMode="numeric" onChange={(e) => setText(e.target.value.replace(/[^\d]/g, ''))}
        onBlur={commit} onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'ArrowUp') { e.preventDefault(); onChange(clamp(value + step)) }
          if (e.key === 'ArrowDown') { e.preventDefault(); onChange(clamp(value - step)) }
        }} style={{ width: `${Math.max(2, text.length) + 1}ch` }} />
      <button className="step-btn" onClick={() => onChange(clamp(value + step))} disabled={value >= max}><Plus size={12} /></button>
    </div>
  )
}
