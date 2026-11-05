import { Check, Columns3, Loader2, Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { money, textPrice } from '@shared/pricing'
import type { CompareResult } from '@shared/types'
import { refreshBalance } from '../lib/actions'
import { api } from '../lib/api'
import { set, useApp } from '../lib/store'
import { Markdown } from './Markdown'
import { Modal } from './Modal'

/** Сравнение: один и тот же вопрос нескольким моделям (без инструментов), ответы рядом. */
export function CompareDialog() {
  const req = useApp((s) => s.compare)
  const msg = useApp((s) => (s.compare ? s.current?.chat.messages[s.compare.index] : undefined))
  const models = useApp((s) => s.models.text)
  const current = useApp((s) => s.settings?.text_model)
  const [picked, setPicked] = useState<string[]>([])
  const [q, setQ] = useState('')
  const [results, setResults] = useState<CompareResult[] | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (req) {
      setPicked(current ? [current] : [])
      setResults(null)
      setQ('')
    }
  }, [req])
  const text = msg ? (msg._display ?? (typeof msg.content === 'string' ? msg.content : '')) : ''
  const list = useMemo(() => models.filter((m) => `${m.name} ${m.id}`.toLowerCase().includes(q.toLowerCase())), [models, q])
  const close = () => set({ compare: null })
  const run = async () => {
    setBusy(true)
    setResults(await api.compare(text, picked))
    setBusy(false)
    refreshBalance()
  }
  return (
    <Modal open={!!req} onClose={close} title="Сравнить модели" icon={<Columns3 size={18} />} width={results ? 1100 : 620}
      footer={results ? <button className="btn" onClick={() => setResults(null)}>Выбрать другие модели</button>
        : <><button className="btn ghost" onClick={close}>Отмена</button>
          <button className="btn primary" disabled={picked.length < 2 || busy} onClick={run}>{busy ? <Loader2 size={14} className="spin" /> : <Columns3 size={14} />}Сравнить ({picked.length})</button></>}>
      <div className="modal-body">
        <div className="compare-q">«{text.slice(0, 300)}{text.length > 300 ? '…' : ''}»</div>
        {!results ? (
          <>
            <div className="hint" style={{ marginBottom: 8 }}>Выберите 2–4 модели. Ответят без инструментов — только текстом, чтобы сравнить стиль и качество.</div>
            <div className="search-box" style={{ marginBottom: 8, height: 38 }}><Search size={15} /><input autoFocus placeholder="Найти модель…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
            <div className="compare-list">
              {list.map((m) => {
                const on = picked.includes(m.id)
                const p = textPrice(m)
                return (
                  <button key={m.id} className={`pick ${on ? 'hl' : ''}`} disabled={!on && picked.length >= 4}
                    onClick={() => setPicked(on ? picked.filter((x) => x !== m.id) : [...picked, m.id])}>
                    <div className="pick-main"><div className="pick-name">{m.name}{m.uncensored && <span className="tag accent">без цензуры</span>}</div>
                      {p && <div className="pick-meta">{money(p[0])} / {money(p[1])} за 1М токенов</div>}</div>
                    {on && <Check size={16} className="pick-check" />}
                  </button>
                )
              })}
            </div>
          </>
        ) : (
          <div className="compare-grid" style={{ gridTemplateColumns: `repeat(${results.length}, minmax(0, 1fr))` }}>
            {results.map((r) => (
              <div key={r.model} className="compare-col">
                <div className="compare-head"><b>{r.name}</b>{r.cost != null && <span>{money(r.cost)}</span>}</div>
                {r.error ? <div className="error-card">{r.text}</div> : <Markdown text={r.text} />}
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}
