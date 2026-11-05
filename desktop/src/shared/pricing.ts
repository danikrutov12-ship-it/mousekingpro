// Цены Venice: общие для основного процесса и интерфейса.
import type { Model } from './types'

export const usd = (price: any): number | null =>
  price && typeof price === 'object' && 'usd' in price ? Number(price.usd) : null

/** Стоимость картинки по прайсу модели: разрешение, качество, число вариантов. */
export function imagePrice(model: Model, params: Record<string, any>): number | null {
  const pricing = model.pricing || {}
  const { resolution: res, quality } = params
  let one: number | null = null
  if (res && quality) one = usd(pricing.quality?.[res]?.[quality])
  if (one == null && res) one = usd(pricing.resolutions?.[res])
  if (one == null) one = usd(pricing.generation)
  return one == null ? null : one * Number(params.variants || 1)
}

/** Минимальная цена картинки у модели (для списка моделей). */
export function imageFrom(model: Model): number | null {
  const all = [imagePrice(model, {}), ...Object.values(model.pricing?.resolutions || {}).map(usd)]
  const nums = all.filter((x): x is number => x != null)
  return nums.length ? Math.min(...nums) : null
}

/** Цена текстовой модели за 1 млн токенов: [вход, ответ]. */
export function textPrice(model: Model): [number, number] | null {
  const i = usd(model.pricing?.input)
  const o = usd(model.pricing?.output)
  return i != null && o != null ? [i, o] : null
}

/** $0.0031 для копеечных сумм, $0.12 / $9.85 для обычных. */
export function money(v: number): string {
  if (v === 0) return '$0'
  if (v < 0.01) return '$' + v.toFixed(4).replace(/0+$/, '')
  return '$' + v.toFixed(2)
}
