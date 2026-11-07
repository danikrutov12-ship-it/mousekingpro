// Расходы своего RunPod: коротко — над параметрами «Картинки Pro», подробно — в Настройки → RunPod.
import { Wallet } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { RunpodSpendInfo } from '@shared/types'
import { api } from '../lib/api'

const $ = (n: number) => `$${n < 10 ? n.toFixed(2) : n.toFixed(1)}`
const mins = (sec: number) => (sec < 90 ? `${Math.round(sec)} с` : `${Math.round(sec / 60)} мин`)

// общий кэш на минуту: панель «Картинки Pro» открывается часто, а биллинг RunPod обновляется не мгновенно
let cache: { at: number; data: RunpodSpendInfo | null } | null = null
let pending: Promise<RunpodSpendInfo | null> | null = null
function load(force = false): Promise<RunpodSpendInfo | null> {
  if (!force && cache && Date.now() - cache.at < 60_000) return Promise.resolve(cache.data)
  pending ??= api.runpod.spend()
    .then((data) => ((cache = { at: Date.now(), data }), data))
    .finally(() => (pending = null))
  return pending
}

function useSpend(refresh?: unknown) {
  const [s, setS] = useState<RunpodSpendInfo | null>(cache?.data ?? null)
  const [err, setErr] = useState(false)
  useEffect(() => {
    let alive = true
    load(refresh !== undefined).then((d) => alive && (setS(d), setErr(false))).catch(() => alive && setErr(true))
    return () => {
      alive = false
    }
  }, [refresh])
  return { s, err }
}

/** Одна строка: сегодня · месяц · средняя цена картинки · баланс. */
export function RunpodSpendLine() {
  const { s } = useSpend()
  if (!s) return null
  const avg = s.images ? s.month / s.images : null
  return (
    <div className="pro-spend" title="Расход видеокарт RunPod (UTC). Хранение моделей на диске считается отдельно — см. Настройки → RunPod">
      <Wallet size={12} />
      RunPod: сегодня {$(s.today)} · за месяц {$(s.month)}{avg != null && ` · ≈${$(avg)} за картинку`}
      {s.balance != null && ` · баланс ${$(s.balance)}`}
    </div>
  )
}

/** Подробно: по видеокартам, диск, ставка сейчас. */
export function RunpodSpendBlock({ refresh }: { refresh?: unknown }) {
  const { s, err } = useSpend(refresh)
  if (err) return <div className="hint">Не удалось получить расходы RunPod.</div>
  if (!s) return null
  const avg = s.images ? s.month / s.images : null
  return (
    <div className="field">
      <label>Расходы с начала месяца</label>
      <div className="rp-spend">
        <div><span>Видеокарты сегодня</span><b>{$(s.today)}</b></div>
        <div><span>Видеокарты за месяц</span><b>{$(s.month)}</b></div>
        <div><span>Диск с моделями за месяц</span><b>{$(s.disk)}</b></div>
        {avg != null && <div><span>В среднем за картинку ({s.images} шт.)</span><b>{$(avg)}</b></div>}
        {s.perHour != null && <div><span>Списывается сейчас</span><b>{$(s.perHour)}/ч</b></div>}
        {s.gpus.map((g) => (
          <div key={g.name} className="gpu"><span>{g.name} — {mins(g.sec)}</span><b>{$(g.usd)} · {$(g.sec ? (g.usd / g.sec) * 3600 : 0)}/ч</b></div>
        ))}
      </div>
      <div className="hint">
        Деньги за видеокарту идут, пока она включена: запуск, генерация и ожидание следующего запроса (Idle Timeout в настройках эндпоинта).
        В простое платится только диск. «Макс. качество» считается на видеокартах 96 ГБ — заметно дороже.
      </div>
    </div>
  )
}
