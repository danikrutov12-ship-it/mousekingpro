// «Убрать текст с видео»: video-subtitle-remover (VSR) на своём RunPod Serverless.
import type { Model } from './types'

export const VSR_MODEL_ID = 'vsr-remove-text'
export const VSR_ENDPOINT = 'mouse-king-vsr'
export const VSR_MAX_SECONDS = 600
/** Без S3-ключа видео идёт прямо в запросе — RunPod принимает до 10 МБ, base64 раздувает на треть */
export const VSR_INLINE_MAX_BYTES = 7 * 1024 * 1024

export type VsrMode = 'sttn-auto' | 'sttn-det' | 'lama' | 'propainter'

export const VSR_MODES: { id: VsrMode; name: string; note: string }[] = [
  { id: 'sttn-auto', name: 'STTN — быстро', note: 'Самый быстрый и дешёвый. Хорош для субтитров без подложки, которые меняются по ходу видео. С подписью на плашке (белый фон, как в TikTok) и с надписью, которая стоит на месте весь ролик, оставляет пятно — для них берите ProPainter.' },
  { id: 'sttn-det', name: 'STTN + поиск текста', note: 'Сам находит текст в рамке или по всему кадру и стирает только буквы. Плашку под текстом не убирает.' },
  { id: 'lama', name: 'LAMA — мультфильмы', note: 'Для мультфильмов, аниме и графики. Сам находит текст и стирает только буквы — плашку под текстом не убирает.' },
  { id: 'propainter', name: 'ProPainter — лучший', note: 'Лучше всего убирает подписи на плашке, надписи на весь ролик и текст поверх движения: восстанавливает фон по соседним кадрам. Медленнее STTN примерно в 3–4 раза и во столько же дороже (около $0.15 за минуту видео 720p).' },
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
