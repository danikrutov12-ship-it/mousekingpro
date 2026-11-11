import { ArrowDown, ImagePlus, RefreshCw, Trash2, UserRound } from 'lucide-react'
import { api } from '../lib/api'
import { fileUrl } from '../lib/format'
import { get, set, useApp } from '../lib/store'
import { toast } from '../lib/actions'

/**
 * Фейсвап: два подписанных слота. Первый — основа, куда вставляем лицо; второй — откуда лицо берём.
 * Слоты держат пути в store (faceBase / faceDonor) и подставляются в начало списка вложений при отправке.
 */
export function FaceSwapSlots() {
  const base = useApp((s) => s.faceBase)
  const donor = useApp((s) => s.faceDonor)

  const pick = async (which: 'base' | 'donor') => {
    const items = await api.attach.pick(get().current?.projectId || '')
    const img = items.find((a) => a.kind === 'image')
    if (!img) {
      if (items.length) toast('Нужна картинка (png, jpg, webp)', 'error')
      return
    }
    set(which === 'base' ? { faceBase: img.path } : { faceDonor: img.path })
  }

  const slot = (which: 'base' | 'donor', path: string | null, title: string, hint: string) => (
    <div className={`fs-slot ${path ? 'filled' : ''}`}>
      <button className="fs-drop" onClick={() => pick(which)} title={path ? 'Заменить фото' : hint}>
        {path
          ? <img src={fileUrl(path)} alt={title} />
          : <><ImagePlus size={22} /><span>{hint}</span></>}
      </button>
      <div className="fs-cap">
        <b>{title}</b>
        {path && (
          <span className="fs-acts">
            <button className="icon-btn sm" title="Другое фото" onClick={() => pick(which)}><RefreshCw size={12} /></button>
            <button className="icon-btn sm" title="Убрать" onClick={() => set(which === 'base' ? { faceBase: null } : { faceDonor: null })}><Trash2 size={12} /></button>
          </span>
        )}
      </div>
    </div>
  )

  return (
    <div className="fs-wrap">
      <div className="fs-row">
        {slot('base', base, 'Фото-основа', 'Куда вставить лицо')}
        <ArrowDown className="fs-arrow" size={16} />
        {slot('donor', donor, 'Лицо-донор', 'Откуда взять лицо')}
      </div>
      <div className="fs-note">
        <UserRound size={13} />
        <span>Лицо берётся с донора и вставляется в основу. Остальное на основе не меняется — тело, поза, одежда и фон остаются как были.</span>
      </div>
    </div>
  )
}
