// «Сохранять исходник» для правок по фото: из генерации берётся только то, что действительно изменилось
// (одежда, предмет), остальное — пиксели оригинала. Модели правки слегка перерисовывают всё фото:
// сглаживают кожу, сдвигают свет и цвет — здесь это отменяется. Без Electron: пиксели BGRA на входе и выходе.

export interface Px { data: Uint8Array; width: number; height: number }

const SMALL = 256

/** Уменьшение усреднением: [r, g, b] на клетку сетки sw×sh. */
function shrink(p: Px, sw: number, sh: number): Float32Array {
  const out = new Float32Array(sw * sh * 3)
  const cnt = new Float32Array(sw * sh)
  for (let y = 0; y < p.height; y++) {
    const sy = Math.min(sh - 1, Math.floor((y * sh) / p.height))
    for (let x = 0; x < p.width; x++) {
      const sx = Math.min(sw - 1, Math.floor((x * sw) / p.width))
      const i = (y * p.width + x) * 4
      const j = sy * sw + sx
      out[j * 3] += p.data[i + 2]
      out[j * 3 + 1] += p.data[i + 1]
      out[j * 3 + 2] += p.data[i]
      cnt[j]++
    }
  }
  for (let j = 0; j < sw * sh; j++) for (let c = 0; c < 3; c++) out[j * 3 + c] /= cnt[j] || 1
  return out
}

/** Подгонка цвета генерации к оригиналу (по каналу: gen·a + b) по пикселям из списка. */
function fit(o: Float32Array, g: Float32Array, use: (j: number) => boolean, n: number) {
  const res: [number, number][] = []
  for (let c = 0; c < 3; c++) {
    let so = 0, sg = 0, so2 = 0, sg2 = 0, k = 0
    for (let j = 0; j < n; j++) {
      if (!use(j)) continue
      const a = o[j * 3 + c], b = g[j * 3 + c]
      so += a; sg += b; so2 += a * a; sg2 += b * b; k++
    }
    if (k < 50) { res.push([1, 0]); continue }
    const mo = so / k, mg = sg / k
    const dO = Math.sqrt(Math.max(1, so2 / k - mo * mo)), dG = Math.sqrt(Math.max(1, sg2 / k - mg * mg))
    const a = Math.min(1.4, Math.max(0.7, dO / dG))
    res.push([a, mo - a * mg])
  }
  return res
}

/** Расширение (макс-фильтр) и размытие маски квадратным окном радиуса r. */
function dilate(m: Float32Array, w: number, h: number, r: number) {
  const t = new Float32Array(m.length), out = new Float32Array(m.length)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 0
    for (let d = -r; d <= r; d++) { const xx = x + d; if (xx >= 0 && xx < w) v = Math.max(v, m[y * w + xx]) }
    t[y * w + x] = v
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 0
    for (let d = -r; d <= r; d++) { const yy = y + d; if (yy >= 0 && yy < h) v = Math.max(v, t[yy * w + x]) }
    out[y * w + x] = v
  }
  return out
}
function blur(m: Float32Array, w: number, h: number, r: number) {
  const t = new Float32Array(m.length), out = new Float32Array(m.length)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, k = 0
    for (let d = -r; d <= r; d++) { const xx = x + d; if (xx >= 0 && xx < w) { s += m[y * w + xx]; k++ } }
    t[y * w + x] = s / k
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, k = 0
    for (let d = -r; d <= r; d++) { const yy = y + d; if (yy >= 0 && yy < h) { s += t[yy * w + x]; k++ } }
    out[y * w + x] = s / k
  }
  return out
}

/** Яркость уменьшенной копии (для поиска сдвига). */
function gray(p: Px, long: number) {
  const k = long / Math.max(p.width, p.height)
  const w = Math.max(8, Math.round(p.width * k)), h = Math.max(8, Math.round(p.height * k))
  const c = shrink(p, w, h), g = new Float32Array(w * h)
  for (let j = 0; j < w * h; j++) g[j] = 0.299 * c[j * 3] + 0.587 * c[j * 3 + 1] + 0.114 * c[j * 3 + 2]
  return { g, w, h }
}

/** Ошибка совмещения: gen, сдвинутый (масштаб s от центра, сдвиг tx/ty в долях кадра), против оригинала. */
type Shift = { sx: number; sy: number; tx: number; ty: number }

function cost(o: Float32Array, g: Float32Array, w: number, h: number, t: Shift, step: number) {
  let sum = 0, k = 0
  const cx = w / 2, cy = h / 2
  for (let y = 0; y < h; y += step) {
    const gy = cy + (y - cy) * t.sy + t.ty * h
    const yi = Math.round(gy)
    if (yi < 0 || yi >= h) continue
    for (let x = 0; x < w; x += step) {
      const xi = Math.round(cx + (x - cx) * t.sx + t.tx * w)
      if (xi < 0 || xi >= w) continue
      sum += Math.min(40, Math.abs(o[y * w + x] - g[yi * w + xi])); k++
    }
  }
  return k > (w * h) / (step * step) / 2 ? sum / k : Infinity
}

/** Найти масштаб (по каждой оси) и сдвиг генерации относительно оригинала: модели правки иногда чуть сдвигают
 *  и растягивают кадр. Грубо перебором на 96 px, затем уточнение покоординатным спуском на 256 px. */
export function align(orig: Px, gen: Px): Shift {
  let best: Shift = { sx: 1, sy: 1, tx: 0, ty: 0 }
  {
    const o = gray(orig, 96), g = gray(gen, 96)
    let bc = Infinity
    for (let s = 0.9; s <= 1.1001; s += 0.01)
      for (let dx = -8; dx <= 8; dx++) for (let dy = -8; dy <= 8; dy++) {
        const t = { sx: s, sy: s, tx: dx / o.w, ty: dy / o.h }
        const c = cost(o.g, g.g, o.w, o.h, t, 1)
        if (c < bc) [bc, best] = [c, t]
      }
  }
  const o = gray(orig, 256), g = gray(gen, 256)
  let bc = cost(o.g, g.g, o.w, o.h, best, 1)
  const steps: Record<keyof Shift, number> = { sx: 0.008, sy: 0.008, tx: 2 / o.w, ty: 2 / o.h }
  for (let round = 0; round < 8; round++) {
    for (const key of ['sx', 'sy', 'tx', 'ty'] as (keyof Shift)[]) {
      for (let moved = true, n = 0; moved && n < 20; n++) {
        moved = false
        for (const dir of [1, -1]) {
          const t = { ...best, [key]: best[key] + dir * steps[key] }
          const c = cost(o.g, g.g, o.w, o.h, t, 1)
          if (c < bc) { [bc, best] = [c, t]; moved = true; break }
        }
      }
    }
    for (const key in steps) steps[key as keyof Shift] /= 2
  }
  return best
}

/** Перенести генерацию в кадр оригинала по найденному сдвигу (билинейно). Вне кадра — пиксели оригинала. */
function warp(orig: Px, gen: Px, t: Shift): Px {
  const { width: W, height: H } = orig
  if (Math.abs(t.sx - 1) * W < 0.25 && Math.abs(t.sy - 1) * H < 0.25 && Math.abs(t.tx * W) < 0.25 && Math.abs(t.ty * H) < 0.25) return gen
  const out = new Uint8Array(W * H * 4)
  const cx = W / 2, cy = H / 2
  for (let y = 0; y < H; y++) {
    const gy = cy + (y + 0.5 - cy) * t.sy + t.ty * H - 0.5
    const y0 = Math.floor(gy), fy = gy - y0
    for (let x = 0; x < W; x++) {
      const gx = cx + (x + 0.5 - cx) * t.sx + t.tx * W - 0.5
      const x0 = Math.floor(gx), fx = gx - x0
      const i = (y * W + x) * 4
      if (x0 < 0 || y0 < 0 || x0 + 1 >= W || y0 + 1 >= H) {
        for (let c = 0; c < 4; c++) out[i + c] = orig.data[i + c]
        continue
      }
      const a = (y0 * W + x0) * 4, b = a + 4, c2 = a + W * 4, d = c2 + 4
      for (let c = 0; c < 3; c++) {
        out[i + c] = Math.round((gen.data[a + c] * (1 - fx) + gen.data[b + c] * fx) * (1 - fy) + (gen.data[c2 + c] * (1 - fx) + gen.data[d + c] * fx) * fy)
      }
      out[i + 3] = 255
    }
  }
  return { data: out, width: W, height: H }
}

/**
 * Собрать итог: оригинал + изменённые места из генерации (кадр совмещён, цвет подогнан под оригинал).
 * Оба изображения одного размера. null — изменилось почти всё (поза, ракурс): оставить генерацию как есть.
 */
export function keepOriginal(orig: Px, gen0: Px): { out: Px; changed: number; shift: Shift } | null {
  const { width: W, height: H } = orig
  const shift = align(orig, gen0)
  const gen = warp(orig, gen0, shift)
  const k = SMALL / Math.max(W, H)
  const sw = Math.max(8, Math.round(W * k)), sh = Math.max(8, Math.round(H * k)), n = sw * sh
  const o = shrink(orig, sw, sh), g = shrink(gen, sw, sh)

  // Цвет: сначала по всему кадру, потом только по пикселям, которые явно не менялись.
  const diff = (cf: [number, number][]) => {
    const d = new Float32Array(n)
    for (let j = 0; j < n; j++) {
      let s = 0
      for (let c = 0; c < 3; c++) s += Math.abs(o[j * 3 + c] - (g[j * 3 + c] * cf[c][0] + cf[c][1]))
      d[j] = s / 3
    }
    return d
  }
  let cf = fit(o, g, () => true, n)
  let d = diff(cf)
  const cut = Float32Array.from(d).sort()[Math.floor(n * 0.4)]
  cf = fit(o, g, (j) => d[j] <= cut, n)
  d = diff(cf)

  // Маска изменений: плавный порог, расширение (чтобы захватить края), растушёвка.
  let m = new Float32Array(n)
  for (let j = 0; j < n; j++) m[j] = Math.min(1, Math.max(0, (d[j] - 14) / 22))
  m = blur(m, sw, sh, 2)
  for (let j = 0; j < n; j++) m[j] = m[j] > 0.45 ? 1 : 0
  m = dilate(m, sw, sh, 3)
  m = blur(blur(m, sw, sh, 2), sw, sh, 2)
  let changed = 0
  for (let j = 0; j < n; j++) changed += m[j] > 0.5 ? 1 : 0
  changed /= n
  if (changed > 0.7) return null

  // Сборка в полном разрешении: маска билинейно.
  const out = new Uint8Array(W * H * 4)
  const lut = cf.map(([a, b]) => Uint8Array.from({ length: 256 }, (_, v) => Math.max(0, Math.min(255, Math.round(v * a + b)))))
  for (let y = 0; y < H; y++) {
    const fy = Math.min(sh - 1, Math.max(0, ((y + 0.5) * sh) / H - 0.5)), y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0
    for (let x = 0; x < W; x++) {
      const fx = Math.min(sw - 1, Math.max(0, ((x + 0.5) * sw) / W - 0.5)), x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0
      const a = (m[y0 * sw + x0] * (1 - tx) + m[y0 * sw + x1] * tx) * (1 - ty) + (m[y1 * sw + x0] * (1 - tx) + m[y1 * sw + x1] * tx) * ty
      const i = (y * W + x) * 4
      // BGRA: каналы B=0, G=1, R=2; lut по RGB
      out[i] = Math.round(orig.data[i] * (1 - a) + lut[2][gen.data[i]] * a)
      out[i + 1] = Math.round(orig.data[i + 1] * (1 - a) + lut[1][gen.data[i + 1]] * a)
      out[i + 2] = Math.round(orig.data[i + 2] * (1 - a) + lut[0][gen.data[i + 2]] * a)
      out[i + 3] = 255
    }
  }
  return { out: { data: out, width: W, height: H }, changed, shift }
}
