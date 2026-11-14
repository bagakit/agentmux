import { createHash } from 'node:crypto'
import { extname } from 'node:path'
import type { CapsuleRecord, CapsuleAssetReadParams, CapsuleAssetReadResult } from './types.js'
import { errorCode, safeFile, CapsuleError } from './storage.js'

const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8', '.pdf': 'application/pdf',
}
export type CapsuleAsset = { status: 200; pathname: string; contentType: string; file: Awaited<ReturnType<typeof safeFile>> }
  | { status: 400 | 403 | 404; message: string }

/** HTTP and RPC resolve the same original files and navigation-shaped SPA paths. */
export async function openCapsuleAsset(record: CapsuleRecord, requestPath: string, accept?: string): Promise<CapsuleAsset> {
  let pathname: string
  try {
    pathname = decodeURIComponent(requestPath.split('?')[0] ?? '/')
    if (!pathname.startsWith('/') || pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').includes('..')) throw Error()
  } catch { return { status: 400, message: 'Invalid Capsule path.' } }
  let relative = pathname.slice(1)
  if (!relative) relative = record.entry
  else if (relative.endsWith('/')) relative += 'index.html'
  try {
    let file: Awaited<ReturnType<typeof safeFile>>
    try { file = await safeFile(record.contentRoot, relative) }
    catch (error) {
      if (errorCode(error) !== 'ENOENT' || record.routing !== 'spa' || extname(relative) || accept && !accept.includes('text/html')) throw error
      relative = record.entry
      file = await safeFile(record.contentRoot, relative)
    }
    return { status: 200, file, pathname, contentType: mime[extname(relative).toLowerCase()] ?? 'application/octet-stream' }
  } catch (error) { return { status: errorCode(error) === 'ENOENT' ? 404 : 403, message: 'Capsule file is unavailable.' } }
}

export async function readCapsuleAsset(record: CapsuleRecord, instanceId: string, input: CapsuleAssetReadParams, signal?: AbortSignal): Promise<CapsuleAssetReadResult> {
  signal?.throwIfAborted()
  const asset = await openCapsuleAsset(record, input.path, input.accept)
  const base = { capsuleId: record.capsuleId, revision: record.revision, instanceId }
  if (asset.status !== 200) {
    const bytes = Buffer.from(asset.message)
    return { ...base, status: asset.status, contentType: 'text/plain; charset=utf-8', totalBytes: bytes.length, offset: 0, bytesBase64: input.head ? '' : bytes.toString('base64'), assetStamp: null, eof: true }
  }
  const { file } = asset
  try {
    const stamp = async () => {
      const s = await file.stat({ bigint: true })
      return { size: Number(s.size), key: createHash('sha256').update([s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':')).digest('hex') }
    }
    const before = await stamp()
    if (!Number.isSafeInteger(before.size) || input.assetStamp !== undefined && input.assetStamp !== before.key)
      throw new CapsuleError('CAPSULE_ASSET_CHANGED', 'The original Capsule asset changed. Reload this exact page; its identity is retained.')
    const wanted = input.head ? 0 : Math.min(input.length, Math.max(0, before.size - input.offset))
    const bytes = Buffer.alloc(wanted)
    let read = 0
    while (read < wanted) {
      signal?.throwIfAborted()
      const result = await file.read(bytes, read, wanted - read, input.offset + read)
      if (!result.bytesRead) break
      read += result.bytesRead
    }
    signal?.throwIfAborted()
    if ((await stamp()).key !== before.key || read !== wanted) throw new CapsuleError('CAPSULE_ASSET_CHANGED', 'The original Capsule asset changed during reading. Reload the same page.')
    return { ...base, status: 200, contentType: asset.contentType, totalBytes: before.size, offset: input.offset,
      bytesBase64: bytes.toString('base64'), assetStamp: before.key, eof: Boolean(input.head) || input.offset + read >= before.size }
  } finally { await file.close() }
}
