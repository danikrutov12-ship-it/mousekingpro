// Минимальный клиент S3 (подпись AWS SigV4) — для S3-доступа к сетевому диску RunPod.
// Без AWS SDK: нужны только загрузка (с частями для больших файлов), скачивание и удаление.
import { createHash, createHmac } from 'node:crypto'
import { closeSync, createWriteStream, openSync, readSync, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export interface S3Cfg { access: string; secret: string; region: string; bucket: string; endpoint: string }

/** S3 RunPod: бакет = ID сетевого диска, адрес по датацентру диска. */
export const runpodS3 = (access: string, secret: string, volume: string, dc: string): S3Cfg => ({
  access, secret, bucket: volume, region: dc.toLowerCase(), endpoint: `https://s3api-${dc.toLowerCase()}.runpod.io`,
})

const sha = (d: string | Uint8Array) => createHash('sha256').update(d).digest('hex')
const hmac = (k: string | Buffer, d: string) => createHmac('sha256', k).update(d).digest()
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())

async function req(cfg: S3Cfg, method: string, key: string, opts: { query?: Record<string, string>; body?: Uint8Array; timeout?: number } = {}) {
  const url = new URL(cfg.endpoint)
  const path = '/' + [cfg.bucket, ...key.split('/')].map(enc).join('/')
  const q = Object.entries(opts.query || {}).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${enc(k)}=${enc(v)}`).join('&')
  const now = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '')
  const day = now.slice(0, 8)
  const hash = sha(opts.body || '')
  const headers: Record<string, string> = { host: url.host, 'x-amz-content-sha256': hash, 'x-amz-date': now }
  const names = Object.keys(headers).sort()
  const canon = [method, path, q, names.map((n) => `${n}:${headers[n]}\n`).join(''), names.join(';'), hash].join('\n')
  const scope = `${day}/${cfg.region}/s3/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', now, scope, sha(canon)].join('\n')
  const kSign = hmac(hmac(hmac(hmac('AWS4' + cfg.secret, day), cfg.region), 's3'), 'aws4_request')
  const sig = createHmac('sha256', kSign).update(toSign).digest('hex')
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${cfg.access}/${scope}, SignedHeaders=${names.join(';')}, Signature=${sig}`
  delete headers.host
  const r = await fetch(`${cfg.endpoint}${path}${q ? '?' + q : ''}`, {
    method, headers, body: opts.body as BodyInit | undefined, signal: AbortSignal.timeout(opts.timeout ?? 300_000),
  })
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1]
    const hint = r.status === 403 || code === 'SignatureDoesNotMatch' || code === 'InvalidAccessKeyId'
      ? 'S3-ключ RunPod не подошёл — проверьте его в настройках.' : ''
    throw new Error(`RunPod S3 ${r.status}${code ? ' ' + code : ''}${hint ? ': ' + hint : ''}`)
  }
  return r
}

const PART = 32 * 1024 * 1024

/** Загрузить файл. Больше 32 МБ — по частям (multipart), с повтором каждой части. */
export async function upload(cfg: S3Cfg, key: string, file: string, progress: (done: number, total: number) => void, stopped: () => boolean) {
  const size = statSync(file).size
  const fd = openSync(file, 'r')
  const read = (pos: number, len: number) => {
    const b = Buffer.alloc(len)
    readSync(fd, b, 0, len, pos)
    return b
  }
  try {
    if (size <= PART) {
      await req(cfg, 'PUT', key, { body: read(0, size) })
      progress(size, size)
      return
    }
    const init = await (await req(cfg, 'POST', key, { query: { uploads: '' } })).text()
    const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(init)?.[1]
    if (!uploadId) throw new Error('RunPod S3 не начал загрузку по частям')
    const parts: string[] = []
    try {
      for (let n = 1, pos = 0; pos < size; n++, pos += PART) {
        if (stopped()) throw new Error('Остановлено')
        const body = read(pos, Math.min(PART, size - pos))
        let etag = ''
        for (let attempt = 1; ; attempt++) {
          try {
            const r = await req(cfg, 'PUT', key, { query: { partNumber: String(n), uploadId }, body })
            etag = r.headers.get('etag') || ''
            break
          } catch (e) {
            if (attempt >= 3 || stopped()) throw e
            await new Promise((ok) => setTimeout(ok, 2000 * attempt))
          }
        }
        parts.push(`<Part><PartNumber>${n}</PartNumber><ETag>${etag}</ETag></Part>`)
        progress(Math.min(size, pos + PART), size)
      }
      const xml = `<CompleteMultipartUpload>${parts.join('')}</CompleteMultipartUpload>`
      await req(cfg, 'POST', key, { query: { uploadId }, body: Buffer.from(xml) })
    } catch (e) {
      await req(cfg, 'DELETE', key, { query: { uploadId } }).catch(() => {})
      throw e
    }
  } finally {
    closeSync(fd)
  }
}

/** Скачать файл потоком (без загрузки целиком в память). */
export async function download(cfg: S3Cfg, key: string, dest: string) {
  const r = await req(cfg, 'GET', key, { timeout: 1_800_000 })
  if (!r.body) throw new Error('RunPod S3 вернул пустой ответ')
  await pipeline(Readable.fromWeb(r.body as any), createWriteStream(dest))
}

export const remove = (cfg: S3Cfg, key: string) => req(cfg, 'DELETE', key).then(() => {}).catch(() => {})

/** Ключ подходит, если файл читается. */
export const probe = (cfg: S3Cfg, key: string) => req(cfg, 'GET', key, { timeout: 30_000 }).then((r) => r.arrayBuffer()).then(() => {})
