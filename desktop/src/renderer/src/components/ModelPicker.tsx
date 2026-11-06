import { Check, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { imageFrom, money, textPrice } from '@shared/pricing'
import type { Mode, Model } from '@shared/types'
import { Popover } from './Popover'

const VIDEO_TYPES: Record<string, string> = { 'text-to-video': 'текст → видео', 'image-to-video': 'картинка → видео', video: 'видео → видео' }

function features(m: Model, mode: Mode): string[] {
  const out: string[] = []
  if (mode === 'text') {
    if (m.tools) out.push('инструменты')
    if (m.vision) out.push('зрение')
    if (m.reasoning) out.push('рассуждение')
    if (m.context) out.push(`${Math.round(m.context / 1000)}K контекст`)
  } else if (mode === 'video') {
    const t = m.constraints?.model_type
    out.push(VIDEO_TYPES[t] || t || 'видео')
  }
  return out
}

function price(m: Model, mode: Mode): string {
  if (mode === 'text') {
    const p = textPrice(m)
    return p ? `${money(p[0])} / ${money(p[1])} за 1М токенов` : ''
  }
  if (mode === 'image') {
    const p = imageFrom(m)
    return p != null ? `от ${money(p)} за картинку` : ''
  }
  return ''
}

const FILTERS: Record<Mode, [string, string, (m: Model) => boolean][]> = {
  text: [['all', 'Все', () => true], ['unc', 'Без цензуры', (m) => m.uncensored], ['tools', 'Инструменты', (m) => m.tools],
    ['vision', 'Зрение', (m) => m.vision], ['reason', 'Рассуждение', (m) => m.reasoning]],
  image: [['all', 'Все', () => true], ['unc', 'Без цензуры', (m) => m.uncensored]],
  video: [['all', 'Все', () => true], ['t2v', 'Из текста', (m) => m.constraints?.model_type === 'text-to-video'],
    ['i2v', 'Из картинки', (m) => m.constraints?.model_type === 'image-to-video'], ['v2v', 'Из видео', (m) => m.constraints?.model_type === 'video']],
  pro: [['all', 'Все', () => true], ['edit', 'Правка по фото', (m) => m.constraints?.kind === 'edit'], ['gen', 'Генерация и img2img', (m) => m.constraints?.kind === 'gen']],
}

export function ModelPicker({ anchor, open, onClose, models, mode, current, onPick }: {
  anchor: RefObject<HTMLElement | null>; open: boolean; onClose(): void
  models: Model[]; mode: Mode; current?: string; onPick(m: Model): void
}) {
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState('all')
  const [hl, setHl] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) {
      setQ('')
      setFilter('all')
    }
  }, [open, mode])

  const list = useMemo(() => {
    const f = FILTERS[mode].find(([k]) => k === filter)?.[2] || (() => true)
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    return models.filter((m) => f(m) && words.every((w) => `${m.name} ${m.id} ${m.description}`.toLowerCase().includes(w)))
  }, [models, q, filter, mode])

  useEffect(() => {
    const i = list.findIndex((m) => m.id === current)
    setHl(i >= 0 ? i : 0)
  }, [list, current])

  useEffect(() => {
    listRef.current?.querySelector('.pick.hl')?.scrollIntoView({ block: 'nearest' })
  }, [hl])
  useEffect(() => {
    if (!open) return
    const id = requestAnimationFrame(() => listRef.current?.querySelector('.pick.hl')?.scrollIntoView({ block: 'center' }))
    return () => cancelAnimationFrame(id)
  }, [open])

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') setHl((h) => Math.min(h + 1, list.length - 1))
    else if (e.key === 'ArrowUp') setHl((h) => Math.max(h - 1, 0))
    else if (e.key === 'Enter' && list[hl]) {
      onPick(list[hl])
      onClose()
    } else return
    e.preventDefault()
  }

  return (
    <Popover anchor={anchor} open={open} onClose={onClose} className="picker" align="end">
      <div className="picker-search">
        <Search size={16} />
        <input autoFocus placeholder={`Найти модель среди ${models.length}…`} value={q}
          onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} />
      </div>
      <div className="picker-filters">
        {FILTERS[mode].map(([k, label]) => (
          <button key={k} className={`filter ${filter === k ? 'on' : ''}`} onClick={() => setFilter(k)}>{label}</button>
        ))}
      </div>
      <div className="picker-list" ref={listRef}>
        {list.length === 0 && <div className="picker-empty">Ничего не найдено</div>}
        {list.map((m, i) => {
          const p = price(m, mode)
          return (
            <button key={m.id} className={`pick ${i === hl ? 'hl' : ''}`} onMouseMove={() => setHl(i)}
              onClick={() => {
                onPick(m)
                onClose()
              }}>
              <div className="pick-main">
                <div className="pick-name">
                  {m.name}
                  {m.uncensored && <span className="tag accent">без цензуры</span>}
                </div>
                <div className="pick-meta">{[p, ...features(m, mode)].filter(Boolean).join('  ·  ')}</div>
                <div className="pick-desc" title={m.description}>{m.description || m.id}</div>
              </div>
              {m.id === current && <Check size={16} className="pick-check" />}
            </button>
          )
        })}
      </div>
    </Popover>
  )
}
