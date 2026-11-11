// «Картинка Pro»: модели на своём RunPod Serverless (ComfyUI). Каталог общий для интерфейса и основного процесса.

export type ProFamily = 'qwen-edit' | 'qwen-rapid' | 'kontext' | 'qwen-image' | 'chroma' | 'zimage' | 'sdxl' | 'qwen3-pro' | 'faceswap'

export interface ProModel {
  id: string
  name: string
  family: ProFamily
  /** edit — инструкция по фото (фото обязательно); gen — по тексту, фото по желанию как основа (img2img);
   *  faceswap — подмена лица: фото 1 — основа, фото 2 — откуда берётся лицо */
  kind: 'edit' | 'gen' | 'faceswap'
  maxRefs: number
  /** есть ли быстрый режим (Lightning / Turbo) */
  fast?: boolean
  /** работает ли негатив: в быстром режиме у Qwen Edit его нет */
  negative: (fast: boolean) => boolean
  lora: boolean
  /** где считается: свой RunPod (по умолчанию) или WaveSpeedAI по API (file — путь модели в их API) */
  provider?: 'runpod' | 'wavespeed'
  /** доступно «Макс. качество» — полная bf16-модель на видеокарте 48 ГБ+ */
  quality?: boolean
  note: string
  /** файл модели на сетевом диске (для проверки и SDXL-чекпоинтов) */
  file: string
}

export const PRO_MODELS: ProModel[] = [
  {
    id: 'faceswap', name: 'Фейсвап (ReActor)', family: 'faceswap', kind: 'faceswap', maxRefs: 2, quality: true,
    negative: () => false, lora: false, file: 'inswapper_128.onnx',
    note: 'Подмена лица: фото 1 — основа (куда вставлять), фото 2 — откуда взять лицо. Без цензуры, работает на ню. Своя модель на твоём RunPod.',
  },
  {
    id: 'ws-qwen3-pro-edit', name: 'Qwen Image 3 Pro Edit', family: 'qwen3-pro', kind: 'edit', maxRefs: 3, provider: 'wavespeed',
    negative: () => false, lora: false, file: 'alibaba/qwen-image-3.0-pro/edit',
    note: 'Закрытая модель Alibaba через WaveSpeed: правка по 1–3 фото, лучшая кожа и детали. ~$0.04 (2K — ~$0.08) за картинку.',
  },
  {
    id: 'ws-qwen3-pro', name: 'Qwen Image 3 Pro', family: 'qwen3-pro', kind: 'gen', maxRefs: 0, provider: 'wavespeed',
    negative: () => false, lora: false, file: 'alibaba/qwen-image-3.0-pro/text-to-image',
    note: 'Закрытая модель Alibaba через WaveSpeed: картинка по тексту. ~$0.04 (2K — ~$0.075).',
  },
  {
    id: 'qwen-edit-2511', name: 'Qwen Edit 2511', family: 'qwen-edit', kind: 'edit', maxRefs: 3, fast: true,
    negative: (fast) => !fast, lora: true, quality: true, file: 'qwen_image_edit_2511_fp8mixed.safetensors',
    note: 'Правка по 1–3 фото: одежда, фон, поза, свет — человек остаётся тем же. Главная модель.',
  },
  {
    id: 'qwen-rapid', name: 'Qwen Rapid', family: 'qwen-rapid', kind: 'edit', maxRefs: 3, fast: true,
    negative: () => false, lora: true, file: 'Qwen-Rapid-v23.safetensors',
    note: 'Раздевание и ню: правка по 1–3 фото, человек остаётся тем же. Своя модель на твоём RunPod, без цензуры. Обычный режим — 8 шагов (так лучше), «Быстро» — 4 шага, грубее.',
  },
  {
    id: 'kontext-dev', name: 'Flux Kontext dev', family: 'kontext', kind: 'edit', maxRefs: 2,
    negative: () => false, lora: true, file: 'flux1-dev-kontext_fp8_scaled.safetensors',
    note: 'Правка по фото: лучше всего меняет ровно одну вещь, остальное почти не трогает. Лицензия некоммерческая.',
  },
  {
    id: 'qwen-image-2512', name: 'Qwen Image 2512', family: 'qwen-image', kind: 'gen', maxRefs: 1,
    negative: () => true, lora: true, file: 'qwen_image_2512_fp8_e4m3fn.safetensors',
    note: 'Фотореализм и надписи на картинке. С фото — перерисовывает его (img2img).',
  },
  {
    id: 'chroma-hd', name: 'Chroma HD', family: 'chroma', kind: 'gen', maxRefs: 1,
    negative: () => true, lora: true, file: 'Chroma1-HD-fp8mixed.safetensors',
    note: 'Без цензуры, гибкая по стилям. С фото — перерисовывает его (img2img).',
  },
  {
    id: 'z-image-turbo', name: 'Z-Image Turbo', family: 'zimage', kind: 'gen', maxRefs: 1,
    negative: () => false, lora: true, file: 'z_image_turbo_bf16.safetensors',
    note: 'Очень быстрая (8 шагов), хороший фотореализм. Негатив не поддерживает.',
  },
  {
    id: 'realvis-xl', name: 'RealVisXL V5', family: 'sdxl', kind: 'gen', maxRefs: 1,
    negative: () => true, lora: true, file: 'RealVisXL_V5.0_fp16.safetensors',
    note: 'SDXL-фотореализм: лёгкая и дешёвая, огромный выбор LoRA. С фото — img2img.',
  },
  {
    id: 'juggernaut-xi', name: 'Juggernaut XI', family: 'sdxl', kind: 'gen', maxRefs: 1,
    negative: () => true, lora: true, file: 'Juggernaut-XI-byRunDiffusion.safetensors',
    note: 'SDXL: кинематографичный фотореализм, LoRA. С фото — img2img.',
  },
]

/** Имя эндпоинта для «Макс. качества» — программа находит его в аккаунте RunPod сама. */
export const HQ_ENDPOINT_NAME = 'mouse-king-pro-hq'

export const proModel = (id?: string) => PRO_MODELS.find((m) => m.id === id) || PRO_MODELS.find((m) => m.id === 'qwen-edit-2511')!
export const isWavespeed = (m: ProModel) => m.provider === 'wavespeed'

export interface ProLora { name: string; weight: number }

export interface ProParams {
  model: string
  prompt: string
  negative?: string
  /** быстрый режим (Qwen Edit: Lightning 4 шага, без негатива) */
  fast?: boolean
  /** img2img: насколько менять фото, 0.2–0.9 */
  strength?: number
  /** без фото: размер */
  aspect?: '1:1' | '3:4' | '4:3' | '9:16' | '16:9' | '2:3' | '3:2'
  seed?: number
  loras?: ProLora[]
  /** правка по фото: из генерации взять только изменённое, остальное — пиксели оригинала (main/blend.ts) */
  keep?: boolean
  /** правка: фото в ~1.6 МП вместо 1 МП — больше деталей, ~1.7× дольше */
  hires?: boolean
  /** правка: второй проход Z-Image Turbo на малой силе — возвращает текстуру кожи и ткани */
  detail?: boolean
  /** Qwen Edit: полная bf16-модель (отдельный эндпоинт с видеокартами 48 ГБ+) */
  maxq?: boolean
  /** увеличить результат ×2 (4x-UltraSharp) */
  upscale?: boolean
  /** фейсвап: восстановление лица (CodeFormer/GFPGAN) — возвращает резкость и кожу */
  restore?: boolean
  /** фейсвап: сила восстановления 0.3–1 (ниже — больше похожести на донора, выше — чище кожа) */
  restoreWeight?: number
  /** фейсвап: какое лицо менять на основе (0 — самое крупное в кадре) */
  faceIndex?: number
  /** фейсвап: менять все лица в кадре */
  allFaces?: boolean
  /** фейсвап: модель свопа (inswapper_128 / hyperswap_256) */
  swapModel?: string
}

/** Что скачать на сетевой диск: [папка в models/, имя файла, ссылка]. Папки — как в worker-comfyui (unet, clip), а не diffusion_models/text_encoders. */
export const MODEL_FILES: [string, string, string][] = [
  ['unet', 'qwen_image_edit_2511_fp8mixed.safetensors', 'https://huggingface.co/Comfy-Org/Qwen-Image-Edit_ComfyUI/resolve/main/split_files/diffusion_models/qwen_image_edit_2511_fp8mixed.safetensors'],
  ['loras', 'Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors', 'https://huggingface.co/lightx2v/Qwen-Image-Edit-2511-Lightning/resolve/main/Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors'],
  ['clip', 'qwen_2.5_vl_7b_fp8_scaled.safetensors', 'https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors'],
  ['vae', 'qwen_image_vae.safetensors', 'https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/vae/qwen_image_vae.safetensors'],
  ['unet', 'qwen_image_2512_fp8_e4m3fn.safetensors', 'https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/diffusion_models/qwen_image_2512_fp8_e4m3fn.safetensors'],
  ['unet', 'flux1-dev-kontext_fp8_scaled.safetensors', 'https://huggingface.co/Comfy-Org/flux1-kontext-dev_ComfyUI/resolve/main/split_files/diffusion_models/flux1-dev-kontext_fp8_scaled.safetensors'],
  ['clip', 'clip_l.safetensors', 'https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/clip_l.safetensors'],
  ['clip', 't5xxl_fp8_e4m3fn_scaled.safetensors', 'https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp8_e4m3fn_scaled.safetensors'],
  ['vae', 'ae.safetensors', 'https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors'],
  ['unet', 'Chroma1-HD-fp8mixed.safetensors', 'https://huggingface.co/Comfy-Org/Chroma1-HD_repackaged/resolve/main/split_files/diffusion_models/Chroma1-HD-fp8mixed.safetensors'],
  ['unet', 'z_image_turbo_bf16.safetensors', 'https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/diffusion_models/z_image_turbo_bf16.safetensors'],
  ['clip', 'qwen_3_4b_fp8_mixed.safetensors', 'https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/text_encoders/qwen_3_4b_fp8_mixed.safetensors'],
  ['checkpoints', 'RealVisXL_V5.0_fp16.safetensors', 'https://huggingface.co/SG161222/RealVisXL_V5.0/resolve/main/RealVisXL_V5.0_fp16.safetensors'],
  ['checkpoints', 'Juggernaut-XI-byRunDiffusion.safetensors', 'https://huggingface.co/RunDiffusion/Juggernaut-XI-v11/resolve/main/Juggernaut-XI-byRunDiffusion.safetensors'],
  ['unet', 'qwen_image_edit_2511_bf16.safetensors', 'https://huggingface.co/Comfy-Org/Qwen-Image-Edit_ComfyUI/resolve/main/split_files/diffusion_models/qwen_image_edit_2511_bf16.safetensors'],
  ['upscale_models', '4x-UltraSharp.safetensors', 'https://huggingface.co/Kim2091/UltraSharp/resolve/main/4x-UltraSharp.safetensors'],
  ['checkpoints', 'Qwen-Rapid-v23.safetensors', 'https://huggingface.co/Phr00t/Qwen-Image-Edit-Rapid-AIO/resolve/main/v23/Qwen-Rapid-AIO-NSFW-v23.safetensors'],
  ['insightface', 'inswapper_128.onnx', 'https://huggingface.co/datasets/Gourieff/ReActor/resolve/main/models/inswapper_128.onnx'],
  ['facerestore_models', 'codeformer-v0.1.0.pth', 'https://huggingface.co/datasets/Gourieff/ReActor/resolve/main/models/facerestore_models/codeformer-v0.1.0.pth'],
  ['facerestore_models', 'GFPGANv1.4.pth', 'https://huggingface.co/datasets/Gourieff/ReActor/resolve/main/models/facerestore_models/GFPGANv1.4.pth'],
]
