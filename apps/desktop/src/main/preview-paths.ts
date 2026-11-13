import { posix } from 'node:path'

/** One Workspace-relative path rule for every loopback preview owner. */
export function previewRelativePath(path: string): string {
  if (!path || path.includes('\\') || path.includes('\0') || posix.isAbsolute(path)) throw new Error('Preview requires a Workspace-relative file path.')
  const normalized = posix.normalize(path)
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.endsWith('/')) throw new Error('Preview path escapes its Workspace or has no filename.')
  return normalized
}

/** Decode a request path once per segment; an encoded separator never becomes a path boundary. */
export function previewRequestPath(encoded: string): string {
  return previewRelativePath(encoded.split('/').map(segment => {
    const decoded = decodeURIComponent(segment)
    if (decoded.includes('/')) throw new Error('Encoded path separator is unavailable.')
    return decoded
  }).join('/'))
}

export function previewUrlPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}
