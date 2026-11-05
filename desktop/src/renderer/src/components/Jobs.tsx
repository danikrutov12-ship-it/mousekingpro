import { Square, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { Job } from '@shared/types'
import { api } from '../lib/api'
import { tokens } from '../lib/format'
import { useApp } from '../lib/store'
import { Popover } from './Popover'

const STATUS: Record<Job['status'], string> = { running: 'идёт', done: 'готово', failed: 'ошибка', stopped: 'остановлено' }

function elapsed(job: Job) {
  const s = Math.round(((job.ended || Date.now()) - job.started) / 1000)
  return s < 60 ? `${s} с` : `${Math.floor(s / 60)} мин ${s % 60} с`
}

function JobRow({ job }: { job: Job }) {
  const [log, setLog] = useState('')
  const ref = useRef<HTMLPreElement>(null)
  useEffect(() => {
    let alive = true
    const load = () => api.jobs.log(job.id, 200).then((l) => alive && setLog(l || ''))
    load()
    const t = job.status === 'running' ? setInterval(load, 1000) : undefined
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [job.id, job.status])
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [log])
  return (
    <div className="job">
      <div className="job-head">
        <span className="job-name">{job.name}</span>
        <span className={`job-status ${job.status}`}>{STATUS[job.status]}{job.code != null && job.status !== 'done' ? ` · код ${job.code}` : ''} · {elapsed(job)}</span>
        {job.status === 'running' && <button className="icon-btn sm" title="Остановить" onClick={() => api.jobs.stop(job.id)}><Square size={13} /></button>}
      </div>
      <div className="job-cmd">{job.command}</div>
      {log && <pre ref={ref} className="live-out">{log}</pre>}
    </div>
  )
}

/** Кнопка в шапке: фоновые задачи (деплой, сборка, сервер) с живым выводом. */
export function JobsButton() {
  const jobs = useApp((s) => s.jobs)
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  if (!jobs.length) return null
  const running = jobs.filter((j) => j.status === 'running').length
  return (
    <>
      <button ref={btn} className="jobs-btn" onClick={() => setOpen(!open)} title="Фоновые задачи">
        {running > 0 && <span className="dot" />}
        {running > 0 ? `В фоне: ${running}` : `Фоновые задачи: ${jobs.length}`}
      </button>
      <Popover anchor={btn} open={open} onClose={() => setOpen(false)} className="jobs-pop" align="end">
        <div className="picker-search" style={{ justifyContent: 'space-between', color: 'var(--text)' }}>
          <b style={{ fontWeight: 600 }}>Фоновые задачи</b>
          {jobs.some((j) => j.status !== 'running') && (
            <button className="btn ghost" style={{ height: 28, fontSize: 12 }} onClick={() => api.jobs.clear()}><Trash2 size={13} />Убрать завершённые</button>
          )}
        </div>
        <div style={{ overflowY: 'auto' }}>{jobs.map((j) => <JobRow key={j.id} job={j} />)}</div>
      </Popover>
    </>
  )
}

/** Кольцо заполненности контекста: сколько истории уходит модели на каждом шаге. */
export function ContextRing({ used, budget, window }: { used: number; budget: number; window: number | null }) {
  const limit = Math.min(budget, window ? Math.floor(window * 0.7) : budget)
  const p = Math.min(1, used / limit)
  const r = 8
  const c = 2 * Math.PI * r
  const color = p > 0.9 ? "var(--danger)" : p > 0.7 ? "#d08a2e" : "var(--accent)"
  return (
    <span className="ctx-ring" title={`Контекст: ${tokens(used)} из ${tokens(limit)} токенов (${Math.round(p * 100)}%).\n` +
      'Когда история не помещается, старые результаты команд и файлов сокращаются автоматически.' +
      (window ? `\nОкно модели: ${tokens(window)}.` : '')}>
      <svg width="20" height="20" viewBox="0 0 20 20">
        <circle cx="10" cy="10" r={r} fill="none" stroke="var(--border-strong)" strokeWidth="2.2" />
        <circle cx="10" cy="10" r={r} fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round"
          strokeDasharray={`${c * p} ${c}`} transform="rotate(-90 10 10)" style={{ transition: 'stroke-dasharray .4s' }} />
      </svg>
    </span>
  )
}
