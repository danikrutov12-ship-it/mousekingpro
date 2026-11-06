// «Картинка Pro»: модели на своём RunPod Serverless (ComfyUI). Каталог общий для интерфейса и основного процесса.

export type ProFamily = 'qwen-edit' | 'kontext' | 'qwen-image' | 'chroma' | 'zimage' | 'sdxl'

export interface ProModel {
  id: string
  name: string
  family: ProFamily
  /** edit — инструкция по фото (фото обязательно); gen — по тексту, фото по желанию как основа (img2img) */
  kind: 'edit' | 'gen'
  maxRefs: number
  /** есть ли быстрый режим (Lightning / Turbo) */
  fast?: boolean
  /** работает ли негатив: в быстром режиме у Qwen Edit его нет */
  negative: (fast: boolean) => boolean
  lora: boolean
  note: string
  /** файл модели на сетевом диске (для проверки и SDXL-чекпоинтов) */
  file: string
}

export const PRO_MODELS: ProModel[] = [
  {
    id: 'qwen-edit-2511', name: 'Qwen Edit 2511', family: 'qwen-edit', kind: 'edit', maxRefs: 3, fast: true,
    negative: (fast) => !fast, lora: true, file: 'qwen_image_edit_2511_fp8mixed.safetensors',
    note: 'Правка по 1–3 фото: одежда, фон, поза, свет — человек остаётся тем же. Главная модель.',
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

export const proModel = (id?: string) => PRO_MODELS.find((m) => m.id === id) || PRO_MODELS[0]

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
  /** увеличить результат ×2 (4x-UltraSharp) */
  upscale?: boolean
}

/** Что скачать на сетевой диск: [папка ComfyUI, имя файла, ссылка]. */
export const MODEL_FILES: [string, string, string][] = [
  ['diffusion_models', 'qwen_image_edit_2511_fp8mixed.safetensors', 'https://huggingface.co/Comfy-Org/Qwen-Image-Edit_ComfyUI/resolve/main/split_files/diffusion_models/qwen_image_edit_2511_fp8mixed.safetensors'],
  ['loras', 'Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors', 'https://huggingface.co/lightx2v/Qwen-Image-Edit-2511-Lightning/resolve/main/Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors'],
  ['text_encoders', 'qwen_2.5_vl_7b_fp8_scaled.safetensors', 'https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors'],
  ['vae', 'qwen_image_vae.safetensors', 'https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/vae/qwen_image_vae.safetensors'],
  ['diffusion_models', 'qwen_image_2512_fp8_e4m3fn.safetensors', 'https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/diffusion_models/qwen_image_2512_fp8_e4m3fn.safetensors'],
  ['diffusion_models', 'flux1-dev-kontext_fp8_scaled.safetensors', 'https://huggingface.co/Comfy-Org/flux1-kontext-dev_ComfyUI/resolve/main/split_files/diffusion_models/flux1-dev-kontext_fp8_scaled.safetensors'],
  ['text_encoders', 'clip_l.safetensors', 'https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/clip_l.safetensors'],
  ['text_encoders', 't5xxl_fp8_e4m3fn_scaled.safetensors', 'https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp8_e4m3fn_scaled.safetensors'],
  ['vae', 'ae.safetensors', 'https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors'],
  ['diffusion_models', 'Chroma1-HD-fp8mixed.safetensors', 'https://huggingface.co/Comfy-Org/Chroma1-HD_repackaged/resolve/main/split_files/diffusion_models/Chroma1-HD-fp8mixed.safetensors'],
  ['diffusion_models', 'z_image_turbo_bf16.safetensors', 'https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/diffusion_models/z_image_turbo_bf16.safetensors'],
  ['text_encoders', 'qwen_3_4b_fp8_mixed.safetensors', 'https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/text_encoders/qwen_3_4b_fp8_mixed.safetensors'],
  ['checkpoints', 'RealVisXL_V5.0_fp16.safetensors', 'https://huggingface.co/SG161222/RealVisXL_V5.0/resolve/main/RealVisXL_V5.0_fp16.safetensors'],
  ['checkpoints', 'Juggernaut-XI-byRunDiffusion.safetensors', 'https://huggingface.co/RunDiffusion/Juggernaut-XI-v11/resolve/main/Juggernaut-XI-byRunDiffusion.safetensors'],
  ['upscale_models', '4x-UltraSharp.safetensors', 'https://huggingface.co/Kim2091/UltraSharp/resolve/main/4x-UltraSharp.safetensors'],
]
