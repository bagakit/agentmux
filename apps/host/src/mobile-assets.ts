import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { parseMobileAssetManifest } from '@agentmux/core/mobile-web-codec'
import type { MobileAssetRelease } from '@agentmux/core/mobile-web'

export const MOBILE_ASSET_LIMITS = Object.freeze({ candidateBytes: 32 * 1024 * 1024, fileBytes: 16 * 1024 * 1024,
  manifestBytes: 256 * 1024, totalPayloadBytes: 96 * 1024 * 1024, retained: 2, operations: 64, clients: 32, responses: 8, chunk: 64 * 1024 })
export type MobileAsset = { bytes: Buffer; type: string }
export type MobileSnapshot = { release: MobileAssetRelease; files: Map<string, MobileAsset> }
export class MobileAssetCapacityError extends Error {}
export const mobileDigest = (value: Buffer | string) => 'sha256:' + createHash('sha256').update(value).digest('hex')
const inside = (root: string, path: string) => { const r = relative(root, path); return !isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep) }
const typeOf = (path: string): string => path === 'index.html' ? 'text/html; charset=utf-8'
  : ({ js: 'text/javascript', css: 'text/css', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
    svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', ico: 'image/x-icon' } as Record<string, string>)[path.split('.').at(-1)!]!

/** Bounded file allocation stays bounded even when the original file grows during IO. */
async function bytesAt(path: string, max: number, expected?: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > max || expected !== undefined && info.size !== expected) throw Error('Invalid mobile asset size')
    const bytes = Buffer.alloc(info.size), extra = Buffer.alloc(1)
    let offset = 0
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (!read.bytesRead) throw Error('Mobile asset changed during read')
      offset += read.bytesRead
    }
    if ((await handle.read(extra, 0, 1, offset)).bytesRead) throw Error('Mobile asset grew during read')
    return bytes
  } finally { await handle.close() }
}
export async function mobileCandidateDirectory(root: string, candidatePath: string): Promise<string> {
  let current = root
  for (const part of candidatePath.split('/')) {
    if (!part || part === '.' || part === '..' || part.includes('\\')) throw Error('Invalid candidate component')
    current = join(current, part)
    const info = await lstat(current)
    if (!info.isDirectory() || info.isSymbolicLink()) throw Error('Candidate directory must be original')
  }
  const actual = await realpath(current)
  if (!inside(root, actual)) throw Error('Candidate is outside the original execution Workspace')
  return actual
}

/** Validate the whole immutable candidate before its bytes can enter HTTP service. */
export async function loadMobileSnapshot(directory: string, candidateDigest?: string, remainingBytes = MOBILE_ASSET_LIMITS.candidateBytes): Promise<MobileSnapshot> {
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) throw Error('Invalid mobile candidate directory')
  const root = await realpath(directory)
  const manifestPath = join(root, 'mobile-release.json')
  if ((await lstat(manifestPath)).size > remainingBytes) throw new MobileAssetCapacityError('The current candidate exceeds the remaining payload budget')
  const manifestBytes = await bytesAt(manifestPath, Math.min(MOBILE_ASSET_LIMITS.manifestBytes, remainingBytes))
  const manifest = parseMobileAssetManifest(JSON.parse(manifestBytes.toString('utf8')))
  const canonical = { schema: manifest.schema, buildId: manifest.buildId,
    files: [...manifest.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) }
  if (mobileDigest(JSON.stringify(canonical)) !== manifest.digest || candidateDigest !== undefined && manifest.digest !== candidateDigest) throw Error('Mobile manifest digest mismatch')
  const total = manifestBytes.length + manifest.files.reduce((sum, file) => sum + file.bytes, 0)
  if (total > MOBILE_ASSET_LIMITS.candidateBytes) throw Error('Complete mobile candidate exceeds its budget')
  if (total > remainingBytes) throw new MobileAssetCapacityError('The current complete candidate exceeds the remaining payload budget')
  const files = new Map<string, MobileAsset>()
  if (manifest.files.some(file => file.path.startsWith('assets/'))) {
    const folder = await lstat(join(root, 'assets'))
    if (!folder.isDirectory() || folder.isSymbolicLink()) throw Error('Invalid asset folder')
  }
  for (const file of manifest.files) {
    const path = join(root, file.path), original = await lstat(path)
    if (!original.isFile() || original.isSymbolicLink() || !inside(root, await realpath(path))) throw Error('Invalid original asset file')
    const bytes = await bytesAt(path, MOBILE_ASSET_LIMITS.fileBytes, file.bytes)
    if (mobileDigest(bytes) !== file.digest || !inside(root, await realpath(path))) throw Error('Original mobile bytes changed')
    files.set(file.path, { bytes, type: typeOf(file.path) })
  }
  if (await realpath(directory) !== root) throw Error('Original candidate directory changed')
  return { release: { buildId: manifest.buildId, digest: manifest.digest, bytes: total, fileCount: files.size }, files }
}
