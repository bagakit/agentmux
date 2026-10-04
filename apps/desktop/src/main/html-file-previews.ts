import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { posix } from 'node:path'
import type { WorkspaceRecord } from '../shared/contracts.js'
import { WORKSPACE_FILE_MAX_BYTES } from '../shared/workspace-file-bytes.js'
import type { WorkspaceFiles } from './workspace-files.js'

type Preview = { workspace: WorkspaceRecord; path: string; content: Buffer }

const mimeTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.mp4': 'video/mp4',
  '.webm': 'video/webm', '.pdf': 'application/pdf', '.wasm': 'application/wasm'
}

// The header also protects a preview URL opened outside the editor's sandboxed iframe.
// External resources are useful in standalone HTML; none receives a host or parent capability.
const previewCsp = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' http: https:; style-src 'unsafe-inline' http: https:; img-src http: https: data: blob:; font-src http: https: data:; media-src http: https: data: blob:; connect-src http: https:; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'"

function relativePath(path: string): string {
  if (!path || path.includes('\\') || path.includes('\0') || posix.isAbsolute(path)) throw new Error('Preview requires a Workspace-relative file path.')
  const normalized = posix.normalize(path)
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.endsWith('/')) throw new Error('Preview path escapes its Workspace or has no filename.')
  return normalized
}

/** Visible editor-owned draft snapshots, with assets read only through the existing file owner. */
export class HtmlFilePreviews {
  private readonly previews = new Map<string, Preview>()
  private server: Server | null = null
  private origin: string | null = null
  private starting: Promise<string> | null = null
  private disposed = false
  private generation = 0

  constructor(private readonly files: Pick<WorkspaceFiles, 'snapshotBytes'>,
    private readonly currentWorkspace: (id: string) => WorkspaceRecord | undefined) {}

  async open(workspace: WorkspaceRecord, path: string, content: string): Promise<{ id: string; url: string }> {
    if (this.disposed) throw new Error('HTML preview service is closed.')
    const generation = this.generation
    const preview: Preview = { workspace: { ...workspace }, path: relativePath(path), content: Buffer.alloc(0) }
    if (!this.workspaceMatches(preview)) throw new Error('The preview Workspace resource changed. Reopen preview to retry.')
    if (Buffer.byteLength(content, 'utf8') > WORKSPACE_FILE_MAX_BYTES) throw new Error('HTML preview exceeds the 16 MiB document budget. The original source is still available.')
    preview.content = Buffer.from(content, 'utf8')
    const origin = await this.start()
    if (this.disposed || generation !== this.generation) throw new Error('HTML preview was released. Reopen preview to retry.')
    if (!this.workspaceMatches(preview)) throw new Error('The preview Workspace resource changed. Reopen preview to retry.')
    const id = randomBytes(32).toString('base64url')
    this.previews.set(id, preview)
    return { id, url: `${origin}/${id}/${preview.path.split('/').map(encodeURIComponent).join('/')}` }
  }

  release(id: string): void { this.previews.delete(id) }

  /** The original Renderer ended; its pending opens cannot create new leases after this point. */
  releaseAll(): void { ++this.generation; this.previews.clear() }

  async dispose(): Promise<void> {
    this.disposed = true
    this.releaseAll()
    try { await this.starting } catch { /* A concurrent start observes disposal and closes its listener. */ }
    const server = this.server
    this.server = null
    this.origin = null
    if (!server) return
    await new Promise<void>((resolve, reject) => {
      server.close(error => {
        if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error)
        else resolve()
      })
      server.closeAllConnections()
    })
  }

  private workspaceMatches(preview: Preview): boolean {
    const original = preview.workspace, current = this.currentWorkspace(original.id)
    return current?.id === original.id && current.hostId === original.hostId && current.path === original.path && current.kind === original.kind
  }

  private current(id: string, preview: Preview): boolean {
    return !this.disposed && this.previews.get(id) === preview && this.workspaceMatches(preview)
  }

  private async start(): Promise<string> {
    if (this.origin) return this.origin
    if (this.starting) return await this.starting
    const server = createServer((request, response) => { void this.respond(request, response) })
    this.server = server
    this.starting = new Promise<string>((resolve, reject) => {
      server.once('error', error => {
        if (this.server === server) { this.server = null; this.origin = null }
        server.close()
        reject(error)
      })
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (this.disposed || !address || typeof address === 'string') {
          server.close()
          reject(new Error('HTML preview listener is unavailable. Reopen preview to retry.'))
          return
        }
        this.origin = `http://127.0.0.1:${address.port}`
        resolve(this.origin)
      })
    })
    try { return await this.starting } finally { this.starting = null }
  }

  private async respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Access-Control-Allow-Origin', '*')
    response.setHeader('Content-Security-Policy', previewCsp)
    const fail = (status: number, message: string): void => {
      response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end(request.method === 'HEAD' ? undefined : message)
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      request.resume()
      response.setHeader('Allow', 'GET, HEAD')
      fail(405, 'HTML previews are read-only.')
      return
    }
    const match = /^\/([A-Za-z0-9_-]+)\/(.*)$/.exec((request.url ?? '').split('?')[0]!)
    const id = match?.[1], preview = id ? this.previews.get(id) : undefined
    if (!match || !id || !preview || request.headers.host !== this.origin?.slice('http://'.length)) {
      fail(404, 'Preview resource not found.')
      return
    }
    try {
      if (!this.current(id, preview)) { fail(410, 'The preview resource changed. Reopen preview to retry.'); return }
      const path = relativePath(match[2]!.split('/').map(segment => {
        const decoded = decodeURIComponent(segment)
        if (decoded.includes('/')) throw new Error('Encoded path separator is unavailable.')
        return decoded
      }).join('/'))
      let bytes: Uint8Array = preview.content
      if (path !== preview.path) {
        const snapshot = await this.files.snapshotBytes(preview.workspace, path)
        // Both the lease and original resource must still own these bytes after the asynchronous read.
        if (!this.current(id, preview)) { fail(410, 'The preview resource changed. Reopen preview to retry.'); return }
        if (snapshot.totalBytes > WORKSPACE_FILE_MAX_BYTES) { fail(413, 'Preview resource exceeds the 16 MiB transfer budget.'); return }
        if (snapshot.offset !== 0 || snapshot.nextOffset !== null || snapshot.returnedBytes !== snapshot.totalBytes || snapshot.bytes.byteLength !== snapshot.totalBytes) {
          fail(422, 'A complete preview resource snapshot is unavailable. Reload preview to retry.')
          return
        }
        bytes = snapshot.bytes
      }
      response.writeHead(200, {
        'Content-Type': path === preview.path ? 'text/html; charset=utf-8' : mimeTypes[posix.extname(path).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': bytes.byteLength
      })
      response.end(request.method === 'HEAD' ? undefined : bytes)
    } catch (error) {
      if (!this.current(id, preview)) fail(410, 'The preview resource changed. Reopen preview to retry.')
      else if ((error as { code?: string } | null)?.code === 'WORKSPACE_FILE_BYTE_LIMIT') fail(413, 'Preview resource exceeds the 16 MiB transfer budget.')
      else fail(404, 'Preview resource is unavailable. Reload preview to retry.')
    }
  }
}
