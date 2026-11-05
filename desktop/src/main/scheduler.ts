// Задачи по расписанию: агент сам запускается в нужное время (пока приложение открыто или работает в фоне).
import type { Schedule } from '@shared/types'

/** Пора ли запускать задачу (now и last — секунды). */
export function due(s: Schedule, now: number): boolean {
  if (!s.enabled) return false
  const last = s.last || s.created || 0
  const d = new Date(now * 1000)
  if (s.every === 'minutes') return now - last >= Math.max(5, s.minutes || 60) * 60
  if (s.every === 'hour') return now - last >= 3600
  const [h, m] = (s.time || '09:00').split(':').map(Number)
  const slot = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime() / 1000
  if (now < slot || last >= slot) return false
  if (s.every === 'week') return d.getDay() === (s.weekday ?? 1)
  return true // каждый день
}

export function describe(s: Schedule): string {
  const days = ['воскресенье', 'понедельник', 'вторник', 'среду', 'четверг', 'пятницу', 'субботу']
  if (s.every === 'minutes') return `каждые ${s.minutes || 60} мин`
  if (s.every === 'hour') return 'каждый час'
  if (s.every === 'week') return `каждую ${days[s.weekday ?? 1]} в ${s.time || '09:00'}`
  return `каждый день в ${s.time || '09:00'}`
}

export function start(get: () => Schedule[], run: (s: Schedule) => void) {
  setInterval(() => {
    const now = Date.now() / 1000
    for (const s of get()) if (due(s, now)) run(s)
  }, 30_000)
}
