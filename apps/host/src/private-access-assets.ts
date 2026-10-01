import { createHash } from 'node:crypto'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'

/** Load one explicit Vite build once. Requests can only read these immutable bytes. */
export async function loadPrivateMobileAssets(directory: string, origin: string): Promise<{
  readonly buildDigest: string
  route(request: Request): Response | null
}> {
  const url = new URL(origin), root = resolve(directory)
  if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) throw new Error('Mobile assets need the exact private HTTPS origin.')
  const rootInfo = await lstat(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Mobile build directory is unavailable or is a symbolic link.')
  const files = new Map<string, { bytes: Buffer; type: string }>()
  let totalBytes = 0
  const load = async (path: string, file: string, type: string) => {
    const info = await lstat(file)
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 16 * 1024 * 1024) throw new Error('Mobile build contains an unavailable, symbolic or oversized asset.')
    const bytes = await readFile(file)
    totalBytes += bytes.byteLength
    if (totalBytes > 16 * 1024 * 1024) throw new Error('Mobile build exceeds the static asset reading bound.')
    files.set(path, { bytes, type })
  }
  await load('/index.html', join(root, 'index.html'), 'text/html; charset=utf-8')
  const assetDirectory = join(root, 'assets'), assetInfo = await lstat(assetDirectory)
  if (!assetInfo.isDirectory() || assetInfo.isSymbolicLink()) throw new Error('Mobile asset directory is unavailable or is a symbolic link.')
  for (const name of (await readdir(assetDirectory)).sort()) {
    if (!/^[A-Za-z0-9_-]+\.(js|css)$/u.test(name)) throw new Error('Mobile build contains a file outside its finite JavaScript/CSS assets.')
    await load(`/assets/${name}`, join(assetDirectory, name), name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8')
  }
  const html = files.get('/index.html')!.bytes.toString('utf8')
  const references = [...html.matchAll(/(?:src|href)="\.?(\/assets\/[A-Za-z0-9_-]+\.(?:js|css))"/gu)].map(value => value[1]!)
  if (!references.some(path => path.endsWith('.js')) || references.some(path => !files.has(path))) throw new Error('Mobile index does not reference its complete built assets.')
  const digest = createHash('sha256')
  for (const [path, file] of files) { digest.update(path); digest.update('\0'); digest.update(createHash('sha256').update(file.bytes).digest()) }
  // This digest identifies actual artifact bytes, not a claim about its source commit.
  const buildDigest = digest.digest('hex')
  return { buildDigest, route(request) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return null
    const target = new URL(request.url)
    if (target.origin !== origin || target.search || target.hash || target.username || target.password
      || request.headers.get('host')?.toLowerCase() !== url.host.toLowerCase()) return null
    const file = files.get(target.pathname === '/' ? '/index.html' : target.pathname)
    if (!file) return null
    return new Response(request.method === 'HEAD' ? null : new Uint8Array(file.bytes), { headers: {
      'Content-Type': file.type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self'; connect-src 'self' https:; object-src 'none'; base-uri 'self'; frame-src 'none'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer'
    } })
  } }
}
