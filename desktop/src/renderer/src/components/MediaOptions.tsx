import type { Mode, Model } from '@shared/types'
import { Dropdown as Select, Stepper as Num } from './Dropdown'
import { aspectForPhoto, isReferenceModel, LONG_VIDEO_SECONDS, seconds } from '@shared/video'

type Params = Record<string, any>

// разрешение видео по возрастанию цены: 360p < 480p < 720p < 1080p < 2k < 4k
const resRank = (r: string) => {
  const m = /^(\d+)(p|k)$/i.exec(r)
  return m ? (m[2].toLowerCase() === 'k' ? Number(m[1]) * 1000 : Number(m[1])) : 99999
}
/** По умолчанию для видео — 720p или ближайшее более дешёвое, чтобы случайно не заказать дорогой 4k. */
function videoResolution(list: string[]): string {
  if (list.includes('720p')) return '720p'
  const sorted = [...list].sort((a, b) => resRank(a) - resRank(b))
  return [...sorted].reverse().find((r) => resRank(r) <= 720) || sorted[0]
}

/** Значения по умолчанию для параметров модели — по её ограничениям. */
/** photoRatio > 0 — к видео прикреплено фото: пропорции подбираются под него. */
export function defaults(mode: Mode, m: Model | null, photoRatio = 0): Params {
  const c = m?.constraints || {}
  const p: Params = {}
  if (mode === 'image') {
    if (c.aspectRatios?.length) p.aspect_ratio = c.defaultAspectRatio || c.aspectRatios[0]
    else {
      p.width = 1024
      p.height = 1024
    }
    if (c.resolutions?.length) p.resolution = c.defaultResolution || c.resolutions[0]
    if (c.qualities?.length) p.quality = c.defaultQuality || c.qualities[0]
    if (Number(c.steps?.max) > 1) p.steps = Number(c.steps.default || 8)
    p.variants = 1
    p.format = 'png'
    p.hide_watermark = true
  } else if (mode === 'video') {
    if (c.durations?.length) p.duration = c.durations.includes('5s') ? '5s' : c.durations[0]
    if (c.resolutions?.length) p.resolution = videoResolution(c.resolutions)
    if (c.aspect_ratios?.length) {
      p.aspect_ratio = (photoRatio && aspectForPhoto(c.aspect_ratios, photoRatio))
        || (c.aspect_ratios.includes('16:9') ? '16:9' : c.aspect_ratios[0])
    }
    if (c.audio_configurable) p.audio = c.audio ?? true
  }
  return p
}

function Check({ label, value, onChange }: { label: string; value: boolean; onChange(v: boolean): void }) {
  return (
    <button className="opt check" onClick={() => onChange(!value)}>
      <span className={`switch ${value ? 'on' : ''}`} style={{ transform: 'scale(.8)' }} />{label}
    </button>
  )
}

const QUALITY: Record<string, string> = { low: 'низкое', medium: 'среднее', high: 'высокое', auto: 'авто' }
const fmtQuality = (v: any) => QUALITY[v] || String(v)
const fmtDuration = (v: any) => (/^\d+s$/.test(v) ? `${parseInt(v)} с` : v === 'Auto' ? 'авто' : String(v))
const fmtRatio = (v: any) => (v === 'auto' ? 'авто' : v === 'adaptive' ? 'как у фото' : String(v))

const VIDEO_HINTS: Record<string, string> = {
  'image-to-video': 'Модель оживляет картинку: прикрепите изображение.',
  video: 'Модель обрабатывает видео: прикрепите видеофайл.',
  'text-to-video': 'Видео по описанию.',
}

export function MediaOptions({ mode, model, params, onChange, photos = 0 }: { mode: Mode; model: Model | null; params: Params; onChange(p: Params): void; photos?: number }) {
  const c = model?.constraints || {}
  const upd = (k: string) => (v: any) => onChange({ ...params, [k]: v })
  if (mode === 'text' || !model) return null
  if (mode === 'image') {
    const div = Number(c.widthHeightDivisor || 8)
    return (
      <div className="options">
        {c.aspectRatios?.length ? <Select label="Пропорции" value={params.aspect_ratio} options={c.aspectRatios} onChange={upd('aspect_ratio')} format={fmtRatio} />
          : <>
            <Num label="Ширина" value={params.width ?? 1024} min={256} max={1280} step={div} onChange={upd('width')} />
            <Num label="Высота" value={params.height ?? 1024} min={256} max={1280} step={div} onChange={upd('height')} />
          </>}
        {c.resolutions?.length > 0 && <Select label="Разрешение" value={params.resolution} options={c.resolutions} onChange={upd('resolution')} />}
        {c.qualities?.length > 0 && <Select label="Качество" value={params.quality} options={c.qualities} onChange={upd('quality')} format={fmtQuality} />}
        {Number(c.steps?.max) > 1 && <Num label="Шаги" value={params.steps ?? 8} min={1} max={Number(c.steps.max)} onChange={upd('steps')} />}
        <Num label="Вариантов" value={params.variants ?? 1} min={1} max={4} onChange={upd('variants')} />
        <Select label="Формат" value={params.format ?? 'png'} options={['png', 'webp', 'jpeg']} onChange={upd('format')} />
        <div className="opt" title="Одинаковый seed + тот же промпт и модель = та же картинка. Пусто — каждый раз новая.">
          <label>Seed</label>
          <input type="number" placeholder="случайный" style={{ width: 92 }} value={params.seed ?? ''}
            onChange={(e) => onChange({ ...params, seed: e.target.value === '' ? undefined : Number(e.target.value) })} />
        </div>
        <Check label="Без водяного знака" value={params.hide_watermark ?? true} onChange={upd('hide_watermark')} />
        <input className="neg-input" placeholder="Чего не должно быть на картинке (необязательно)" value={params.negative_prompt || ''}
          onChange={(e) => onChange({ ...params, negative_prompt: e.target.value || undefined })} />
      </div>
    )
  }
  return (
    <div className="options">
      {c.durations?.length > 0 && <Select label="Длительность" value={params.duration} options={c.durations} onChange={upd('duration')} format={fmtDuration} />}
      {c.resolutions?.length > 0 && <Select label="Разрешение" value={params.resolution}
        options={[...c.resolutions].sort((a: string, b: string) => resRank(a) - resRank(b))} onChange={upd('resolution')} />}
      {c.aspect_ratios?.length > 0 && <Select label="Пропорции" value={params.aspect_ratio} options={c.aspect_ratios} onChange={upd('aspect_ratio')} format={fmtRatio} />}
      {c.audio_configurable && <Check label="Со звуком" value={!!params.audio} onChange={upd('audio')} />}
      <div className="opt-hint">
        {isReferenceModel(model) ? 'Фото — образец внешности персонажа или предмета (до 30 фото), сцену модель строит сама.' : VIDEO_HINTS[c.model_type] || ''} Генерация занимает от минуты до нескольких минут.
      </div>
      {photos > 0 && c.model_type === 'text-to-video' && (
        <div className="opt-warn">Эта модель делает видео только по тексту и не видит фото — при отправке возьму её вариант «image-to-video».</div>
      )}
      {photos > 0 && params.aspect_ratio && params.aspect_ratio !== 'adaptive' && params.aspect_ratio !== 'auto' && c.aspect_ratios?.includes('adaptive') && (
        <div className="opt-warn">Пропорции отличаются от фото — модели придётся перестроить кадр, и сходство может пострадать. Лучше «как у фото».</div>
      )}
      {photos > 0 && seconds(params.duration) > LONG_VIDEO_SECONDS && (
        <div className="opt-warn">Чем длиннее видео, тем сильнее уходит сходство с фото. Для точного сходства — 5–10 с.</div>
      )}
    </div>
  )
}
