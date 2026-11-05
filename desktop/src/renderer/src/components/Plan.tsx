import { CheckCircle2, ChevronDown, Circle, ListChecks, Loader2 } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useMemo, useState } from 'react'
import type { Message } from '@shared/types'

interface Step { title: string; status: 'pending' | 'in_progress' | 'done' }

/** Последний план, который агент показал через update_plan. */
export function latestPlan(messages: Message[]): Step[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'user' && !m._hidden) return null // план относится к последней задаче
    const call = [...(m.tool_calls || [])].reverse().find((c) => c.function.name === 'update_plan')
    if (call) {
      try {
        const steps = JSON.parse(call.function.arguments).steps
        return Array.isArray(steps) ? steps : null
      } catch {
        return null
      }
    }
  }
  return null
}

/** Карточка плана над полем ввода: что сделано, что сейчас, что осталось. */
export function PlanCard({ messages, live }: { messages: Message[]; live: boolean }) {
  const plan = useMemo(() => latestPlan(messages), [messages])
  const [open, setOpen] = useState(true)
  if (!plan?.length) return null
  const done = plan.filter((s) => s.status === 'done').length
  if (!live && done === plan.length) return null
  const current = plan.find((s) => s.status === 'in_progress')
  return (
    <motion.div className="plan" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
      <button className="plan-head" onClick={() => setOpen(!open)}>
        <ListChecks size={15} />
        <span className="plan-title">План · {done} из {plan.length}{!open && current ? <span> — {current.title}</span> : null}</span>
        <span className="plan-bar"><span style={{ width: `${(done / plan.length) * 100}%` }} /></span>
        <ChevronDown size={14} style={{ transform: open ? 'rotate(180deg)' : undefined, transition: 'transform .2s' }} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.ol className="plan-list" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}>
            {plan.map((s, i) => (
              <li key={i} className={s.status}>
                {s.status === 'done' ? <CheckCircle2 size={15} /> : s.status === 'in_progress'
                  ? (live ? <Loader2 size={15} className="spin" /> : <Circle size={15} />) : <Circle size={15} />}
                <span>{s.title}</span>
              </li>
            ))}
          </motion.ol>
        )}
      </AnimatePresence>
    </motion.div>
  )
}
