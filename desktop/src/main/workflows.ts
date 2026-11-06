// Воркфлоу ComfyUI (формат API) для моделей «Картинки Pro». Без Electron — можно проверять обычным Node.
// Узлы и настройки — по официальным шаблонам ComfyUI (Comfy-Org/workflow_templates).
import { proModel, type ProParams } from '@shared/runpod'

type Node = { class_type: string; inputs: Record<string, any> }
type Graph = Record<string, Node>
type Link = [string, number]

const ASPECTS: Record<string, [number, number]> = {
  '1:1': [1024, 1024], '3:4': [896, 1152], '4:3': [1152, 896], '9:16': [768, 1344], '16:9': [1344, 768], '2:3': [832, 1216], '3:2': [1216, 832],
}

/** Небольшой построитель графа: add() возвращает ссылку на первый выход узла. */
function builder() {
  const g: Graph = {}
  let n = 0
  const add = (class_type: string, inputs: Record<string, any>): Link => {
    const id = String(++n)
    g[id] = { class_type, inputs }
    return [id, 0]
  }
  const out = (l: Link, i: number): Link => [l[0], i]
  return { g, add, out }
}

const seedOf = (p: ProParams) => p.seed ?? Math.floor(Math.random() * 2 ** 48)

/** LoRA пользователя: только на модель (Qwen/Flux/Z-Image) или на модель и CLIP (SDXL). */
function withLoras(b: ReturnType<typeof builder>, model: Link, p: ProParams, clip?: Link): [Link, Link | undefined] {
  for (const l of (p.loras || []).filter((x) => x.name && x.weight)) {
    if (clip) {
      const node = b.add('LoraLoader', { model, clip, lora_name: l.name, strength_model: l.weight, strength_clip: l.weight })
      model = node
      clip = b.out(node, 1)
    } else model = b.add('LoraLoaderModelOnly', { model, lora_name: l.name, strength_model: l.weight })
  }
  return [model, clip]
}

/** Фото как основа (img2img) — масштаб ~1 МП, иначе пустой латент нужного размера. */
function startLatent(b: ReturnType<typeof builder>, p: ProParams, images: string[], vae: Link, sd3 = true): { latent: Link; denoise: number } {
  if (images[0]) {
    const img = b.add('ImageScaleToTotalPixels', { image: b.add('LoadImage', { image: images[0] }), upscale_method: 'lanczos', megapixels: 1, resolution_steps: 8 })
    return { latent: b.add('VAEEncode', { pixels: img, vae }), denoise: Math.min(0.95, Math.max(0.15, p.strength ?? 0.5)) }
  }
  const [width, height] = ASPECTS[p.aspect || '1:1'] || ASPECTS['1:1']
  return { latent: b.add(sd3 ? 'EmptySD3LatentImage' : 'EmptyLatentImage', { width, height, batch_size: 1 }), denoise: 1 }
}

function finish(b: ReturnType<typeof builder>, image: Link, p: ProParams) {
  if (p.upscale) {
    const up = b.add('ImageUpscaleWithModel', { upscale_model: b.add('UpscaleModelLoader', { model_name: '4x-UltraSharp.safetensors' }), image })
    image = b.add('ImageScaleBy', { image: up, upscale_method: 'lanczos', scale_by: 0.5 }) // 4× модели → итог ×2
  }
  b.add('SaveImage', { images: image, filename_prefix: 'mkp' })
}

export function buildWorkflow(p: ProParams, images: string[]): Graph {
  const m = proModel(p.model)
  const b = builder()
  const { add, out } = b
  const seed = seedOf(p)

  switch (m.family) {
    case 'qwen-edit': {
      const fast = !!p.fast
      const clip = add('CLIPLoader', { clip_name: 'qwen_2.5_vl_7b_fp8_scaled.safetensors', type: 'qwen_image', device: 'default' })
      const vae = add('VAELoader', { vae_name: 'qwen_image_vae.safetensors' })
      let model = add('UNETLoader', { unet_name: m.file, weight_dtype: 'default' })
      model = add('ModelSamplingAuraFlow', { model, shift: 3.1 })
      model = add('CFGNorm', { model, strength: 1 })
      if (fast) model = add('LoraLoaderModelOnly', { model, lora_name: 'Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors', strength_model: 1 });
      [model] = withLoras(b, model, p)
      const loaded = images.slice(0, 3).map((name) => add('LoadImage', { image: name }))
      const first = add('FluxKontextImageScale', { image: loaded[0] })
      const refs: Record<string, Link> = { image1: first }
      loaded.slice(1).forEach((l, i) => (refs[`image${i + 2}`] = l))
      const encode = (prompt: string) => add('FluxKontextMultiReferenceLatentMethod', {
        conditioning: add('TextEncodeQwenImageEditPlus', { clip, vae, prompt, ...refs }), reference_latents_method: 'index_timestep_zero',
      })
      const sampled = add('KSampler', {
        model, seed, steps: fast ? 4 : 40, cfg: fast ? 1 : 3, sampler_name: 'euler', scheduler: 'simple', denoise: 1,
        positive: encode(p.prompt), negative: encode(fast ? '' : p.negative || ''), latent_image: add('VAEEncode', { pixels: first, vae }),
      })
      finish(b, add('VAEDecode', { samples: sampled, vae }), p)
      break
    }
    case 'kontext': {
      const clip = add('DualCLIPLoader', { clip_name1: 'clip_l.safetensors', clip_name2: 't5xxl_fp8_e4m3fn_scaled.safetensors', type: 'flux', device: 'default' })
      const vae = add('VAELoader', { vae_name: 'ae.safetensors' })
      let [model] = withLoras(b, add('UNETLoader', { unet_name: m.file, weight_dtype: 'default' }), p)
      const scaled = images.slice(0, 2).map((name) => add('FluxKontextImageScale', { image: add('LoadImage', { image: name }) }))
      const latents = scaled.map((img) => add('VAEEncode', { pixels: img, vae }))
      let cond = add('CLIPTextEncode', { clip, text: p.prompt })
      for (const l of latents) cond = add('ReferenceLatent', { conditioning: cond, latent: l })
      const positive = add('FluxGuidance', { conditioning: cond, guidance: 2.5 })
      const sampled = add('KSampler', {
        model, seed, steps: 20, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1,
        positive, negative: add('ConditioningZeroOut', { conditioning: cond }), latent_image: latents[0],
      })
      finish(b, add('VAEDecode', { samples: sampled, vae }), p)
      break
    }
    case 'qwen-image': {
      const clip = add('CLIPLoader', { clip_name: 'qwen_2.5_vl_7b_fp8_scaled.safetensors', type: 'qwen_image', device: 'default' })
      const vae = add('VAELoader', { vae_name: 'qwen_image_vae.safetensors' })
      let [model] = withLoras(b, add('UNETLoader', { unet_name: m.file, weight_dtype: 'default' }), p)
      model = add('ModelSamplingAuraFlow', { model, shift: 3.1 })
      const { latent, denoise } = startLatent(b, p, images, vae)
      const sampled = add('KSampler', {
        model, seed, steps: 30, cfg: 4, sampler_name: 'euler', scheduler: 'simple', denoise,
        positive: add('CLIPTextEncode', { clip, text: p.prompt }), negative: add('CLIPTextEncode', { clip, text: p.negative || '' }), latent_image: latent,
      })
      finish(b, add('VAEDecode', { samples: sampled, vae }), p)
      break
    }
    case 'chroma': {
      const clip = add('T5TokenizerOptions', { clip: add('CLIPLoader', { clip_name: 't5xxl_fp8_e4m3fn_scaled.safetensors', type: 'chroma', device: 'default' }), min_padding: 0, min_length: 0 })
      const vae = add('VAELoader', { vae_name: 'ae.safetensors' })
      let [model] = withLoras(b, add('UNETLoader', { unet_name: m.file, weight_dtype: 'default' }), p)
      model = add('ModelSamplingAuraFlow', { model, shift: 1 })
      const { latent, denoise } = startLatent(b, p, images, vae)
      const guider = add('CFGGuider', {
        model, cfg: 3.5, positive: add('CLIPTextEncode', { clip, text: p.prompt }),
        negative: add('CLIPTextEncode', { clip, text: p.negative || 'low quality, blurry, deformed, artifacts' }),
      })
      const sampled = add('SamplerCustomAdvanced', {
        noise: add('RandomNoise', { noise_seed: seed }), guider, sampler: add('KSamplerSelect', { sampler_name: 'euler' }),
        sigmas: add('BasicScheduler', { model, scheduler: 'beta', steps: 26, denoise }), latent_image: latent,
      })
      finish(b, add('VAEDecode', { samples: sampled, vae }), p)
      break
    }
    case 'zimage': {
      const clip = add('CLIPLoader', { clip_name: 'qwen_3_4b_fp8_mixed.safetensors', type: 'lumina2', device: 'default' })
      const vae = add('VAELoader', { vae_name: 'ae.safetensors' })
      let [model] = withLoras(b, add('UNETLoader', { unet_name: m.file, weight_dtype: 'default' }), p)
      model = add('ModelSamplingAuraFlow', { model, shift: 3 })
      const { latent, denoise } = startLatent(b, p, images, vae)
      const positive = add('CLIPTextEncode', { clip, text: p.prompt })
      const sampled = add('KSampler', {
        model, seed, steps: 8, cfg: 1, sampler_name: 'res_multistep', scheduler: 'simple', denoise,
        positive, negative: add('ConditioningZeroOut', { conditioning: positive }), latent_image: latent,
      })
      finish(b, add('VAEDecode', { samples: sampled, vae }), p)
      break
    }
    case 'sdxl': {
      const ckpt = add('CheckpointLoaderSimple', { ckpt_name: m.file })
      const [model, clip] = withLoras(b, ckpt, p, out(ckpt, 1))
      const vae = out(ckpt, 2)
      const { latent, denoise } = startLatent(b, p, images, vae, false)
      const sampled = add('KSampler', {
        model, seed, steps: 30, cfg: 5, sampler_name: 'dpmpp_2m', scheduler: 'karras', denoise,
        positive: add('CLIPTextEncode', { clip, text: p.prompt }),
        negative: add('CLIPTextEncode', { clip, text: p.negative || 'lowres, blurry, deformed, bad anatomy, watermark, text' }), latent_image: latent,
      })
      finish(b, add('VAEDecode', { samples: sampled, vae }), p)
      break
    }
  }
  return b.g
}

