// Видео по фото: как передавать фото разным типам моделей Venice и какие настройки не мешают сходству.
import type { Model } from './types'

/** reference-to-video: фото — образец внешности персонажа (поле reference_image_urls), а не первый кадр. */
export const isReferenceModel = (m: Model | null | undefined) => !!m && /reference-to-video/.test(m.id)

/** Сколько фото принимает reference-модель (по документации Venice — до 30). */
export const MAX_REFERENCE_IMAGES = 30

/** Длительность, после которой сходство с фото заметно «плывёт». */
export const LONG_VIDEO_SECONDS = 10

export const seconds = (d: unknown) => parseFloat(String(d ?? '')) || 0

const ratioOf = (r: string) => {
  const [w, h] = r.split(':').map(Number)
  return w > 0 && h > 0 ? w / h : 0
}

/**
 * Пропорции видео под фото: «adaptive» (как у фото), если модель умеет,
 * иначе ближайшее значение из списка. null — у модели нет выбора пропорций (берёт кадр фото сама).
 */
export function aspectForPhoto(options: string[] | undefined, photoRatio: number): string | null {
  if (!options?.length) return null
  for (const auto of ['adaptive', 'auto']) if (options.includes(auto)) return auto
  let best: string | null = null
  let diff = Infinity
  for (const o of options) {
    const r = ratioOf(o)
    if (!r) continue
    const d = Math.abs(Math.log(r / photoRatio))
    if (d < diff) [best, diff] = [o, d]
  }
  return best
}

/** Для text-to-video модели — её вариант, который принимает фото (тот же семейный id). */
export function photoSibling(m: Model, all: Model[]): Model | null {
  if (m.constraints?.model_type !== 'text-to-video') return null
  const ids = [m.id.replace('text-to-video', 'image-to-video'), m.id.replace('text-to-video', 'reference-to-video')]
  for (const id of ids) {
    const found = all.find((x) => x.id === id)
    if (found) return found
  }
  return null
}

/** Подходит ли фото модели по размеру и пропорциям; текст ошибки или null. */
export function photoProblem(m: Model, w: number, h: number): string | null {
  const c = m.constraints || {}
  const minSide = Number(c.reference_image_min_short_side_pixels) || 0
  if (minSide && Math.min(w, h) < minSide) {
    return `Фото слишком маленькое (${w}×${h}): ${m.name} нужно не меньше ${minSide} px по короткой стороне.`
  }
  const r = w / h
  const lo = Number(c.reference_image_min_aspect_ratio) || 0
  const hi = Number(c.reference_image_max_aspect_ratio) || 0
  if ((lo && r < lo) || (hi && r > hi)) {
    return `Фото слишком вытянутое (${w}×${h}): ${m.name} принимает соотношение сторон от ${lo} до ${hi}. Обрежьте его в редакторе.`
  }
  return null
}
