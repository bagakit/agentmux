import { lstat, readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

/** Load the bundled phone application once; no request-controlled filesystem paths. */
export async function loadMobileAssets(directory: string) {
  if (!directory) throw new Error('The bundled mobile application is unavailable')
  const root = resolve(directory), files = new Map<string, { bytes: Buffer; type: string }>()
  let total = 0
  const load = async (path: string, file: string, type: string) => {
    const info = await lstat(file)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) throw new Error('Invalid mobile asset')
    const bytes = await readFile(file); total += bytes.length
    if (total > 32 * 1024 * 1024) throw new Error('Mobile assets exceed their budget')
    files.set(path, { bytes, type })
  }
  await load('/', join(root, 'index.html'), 'text/html; charset=utf-8')
  for (const name of await readdir(join(root, 'assets'))) {
    if (!/^[A-Za-z0-9_.-]+\.(js|css|woff2?|svg|png)$/u.test(name)) continue
    const extension = name.split('.').pop()!
    const type = ({ js: 'text/javascript', css: 'text/css', woff: 'font/woff', woff2: 'font/woff2', svg: 'image/svg+xml', png: 'image/png' } as Record<string, string>)[extension]!
    await load(`/assets/${name}`, join(root, 'assets', name), type)
  }
  return { route(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const file = files.get(url.pathname === '/index.html' ? '/' : url.pathname)
    if (!file || !['GET','HEAD'].includes(request.method ?? '')) { response.writeHead(404); response.end(); return }
    response.writeHead(200, { 'Content-Type': file.type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'" })
    response.end(request.method === 'HEAD' ? undefined : file.bytes)
  } }
}
