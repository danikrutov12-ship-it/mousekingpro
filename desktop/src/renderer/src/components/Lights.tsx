import { api } from '../lib/api'
import { useApp } from '../lib/store'

/** Кнопки окна в стиле macOS. */
export function Lights() {
  const focused = useApp((s) => s.win.focused)
  return (
    <div className={`lights ${focused ? '' : 'blurred'}`}>
      <button className="light close" onClick={() => api.win.close()} aria-label="Закрыть">
        <svg width="6" height="6" viewBox="0 0 6 6"><path d="M.8.8l4.4 4.4M5.2.8L.8 5.2" stroke="#4d0000" strokeWidth="1.1" strokeLinecap="round" /></svg>
      </button>
      <button className="light min" onClick={() => api.win.minimize()} aria-label="Свернуть">
        <svg width="7" height="2" viewBox="0 0 7 2"><path d="M.6 1h5.8" stroke="#5a3a00" strokeWidth="1.2" strokeLinecap="round" /></svg>
      </button>
      <button className="light max" onClick={() => api.win.toggleMaximize()} aria-label="Развернуть">
        <svg width="6" height="6" viewBox="0 0 6 6"><path d="M1 3.6V1h2.6zM5 2.4V5H2.4z" fill="#003a00" /></svg>
      </button>
    </div>
  )
}

/** Фирменный знак: восьмилучевая искра. */
export function Spark({ size = 18, className = '' }: { size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 1.5c.55 4.9 2.7 8.1 6.4 9.6-3.7 1.5-5.85 4.7-6.4 9.6-.55-4.9-2.7-8.1-6.4-9.6 3.7-1.5 5.85-4.7 6.4-9.6z" />
      <path d="M4 4.2l3.3 3.3M20 4.2l-3.3 3.3M4 19.8l3.3-3.3M20 19.8l-3.3-3.3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity=".55" />
    </svg>
  )
}
