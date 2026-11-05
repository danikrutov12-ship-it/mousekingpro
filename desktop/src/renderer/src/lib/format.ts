// Форматирование дат, размеров, путей к файлам.

/** file:// адрес для пути Linux (/home/…) и Windows (C:\\Users\\…). */
export function fileUrl(path: string): string {
  const parts = path.split(/[\\/]/)
  const drive = /^[A-Za-z]:$/.test(parts[0]) ? parts.shift()! + '/' : ''
  return 'file://' + (drive ? '/' + drive : '') + parts.map(encodeURIComponent).join('/')
}

/** Имя файла без папок — понимает оба разделителя. */
export const baseName = (path: string) => path.split(/[\\/]/).pop() || path

export function humanSize(n: number): string {
  const units = ['Б', 'КБ', 'МБ', 'ГБ']
  for (const u of units) {
    if (n < 1024) return u === 'Б' ? `${n} ${u}` : `${n.toFixed(1)} ${u}`
    n /= 1024
  }
  return `${n.toFixed(1)} ТБ`
}

const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few
  return many
}

export const chatsWord = (n: number) => `${n} ${plural(n, 'чат', 'чата', 'чатов')}`

export function ago(ts: number): string {
  const s = Date.now() / 1000 - ts
  if (s < 60) return 'только что'
  if (s < 3600) return `${Math.floor(s / 60)} мин назад`
  if (s < 86400) return `${Math.floor(s / 3600)} ч назад`
  const d = Math.floor(s / 86400)
  if (d === 1) return 'вчера'
  if (d < 30) return `${d} ${plural(d, 'день', 'дня', 'дней')} назад`
  return new Date(ts * 1000).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })
}

export function dateGroup(ts: number): string {
  const d = new Date(ts * 1000)
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000
  if (ts >= start) return 'Сегодня'
  if (ts >= start - 86400) return 'Вчера'
  if (ts >= start - 7 * 86400) return 'Последние 7 дней'
  if (ts >= start - 30 * 86400) return 'Последние 30 дней'
  return d.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })
}

export function greeting(name: string): string {
  const h = new Date().getHours()
  const part = h < 5 ? 'Доброй ночи' : h < 12 ? 'Доброе утро' : h < 18 ? 'Добрый день' : 'Добрый вечер'
  return `${part}, ${name}`
}

export function tokens(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1).replace('.', ',').replace(',0', '')} тыс.`
}

const PALETTE = ['#c8613c', '#5b7fd6', '#3f9b74', '#a364c7', '#d08a2e', '#c2506f', '#3c94a8', '#7a7f3a']
export function colorFor(text: string): string {
  let h = 0
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return PALETTE[h % PALETTE.length]
}
