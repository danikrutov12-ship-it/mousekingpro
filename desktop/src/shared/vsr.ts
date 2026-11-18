// «Убрать текст с видео»: video-subtitle-remover (VSR) на своём RunPod Serverless.
import type { Model } from './types'

export const VSR_MODEL_ID = 'vsr-remove-text'
export const VSR_ENDPOINT = 'mouse-king-vsr'
/** ProPainter — на эндпоинте с видеокартами 48 ГБ+ */
export const VSR_HQ_ENDPOINT = 'mouse-king-vsr-hq'
export const VSR_MAX_SECONDS = 600
/** Без S3-ключа видео идёт прямо в запросе — RunPod принимает до 10 МБ, base64 раздувает на треть */
export const VSR_INLINE_MAX_BYTES = 7 * 1024 * 1024

export type VsrMode = 'sttn-auto' | 'sttn-det' | 'lama' | 'propainter'

export const VSR_MODES: { id: VsrMode; name: string; note: string; hq?: boolean }[] = [
  { id: 'sttn-auto', name: 'STTN — быстро', note: 'Стирает всё внутри рамки на каждом кадре. Лучше всего для обычного видео и постоянных надписей (логотип, субтитры в одной полосе).' },
  { id: 'sttn-det', name: 'STTN + поиск текста', note: 'Сначала находит текст внутри рамки (или по всему кадру) и стирает только его — фон вокруг остаётся нетронутым.' },
  { id: 'lama', name: 'LAMA — мультфильмы', note: 'Для мультфильмов, аниме и графики. Ищет текст сам, стирает аккуратно, скорость средняя.' },
  { id: 'propainter', name: 'ProPainter — макс. качество', note: 'Чище всего при сильном движении в кадре. Медленный и дороже в 3–5 раз: работает на видеокартах 48 ГБ.', hq: true },
]

export const vsrMode = (id: string | undefined) => VSR_MODES.find((m) => m.id === id) || VSR_MODES[0]

/** Рамка в долях кадра: x0, y0, x1, y1 */
export type VsrArea = [number, number, number, number]

export interface VsrParams { mode: VsrMode; areas: VsrArea[] }

export const isVsr = (m: Model | null | undefined) => m?.id === VSR_MODEL_ID

export const vsrModel = (): Model => ({
  id: VSR_MODEL_ID, type: 'video', name: 'Убрать текст с видео (VSR · RunPod)',
  description: 'Удаляет субтитры, надписи и логотипы с готового видео до 10 минут. Работает на вашем RunPod.',
  uncensored: false, tools: false, vision: false, reasoning: false, web_search: false, context: null,
  constraints: { model_type: 'vsr' }, pricing: {},
})

/** Рамки текущего видео (рамки другого видео не подходят — у него другой кадр). */
const NO_AREAS: VsrArea[] = []
export const vsrAreasFor = (path: string | undefined, s: { vsrFor: string; vsrAreas: VsrArea[] }) => (path && s.vsrFor === path ? s.vsrAreas : NO_AREAS)
