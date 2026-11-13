import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { WorkspaceRecord } from '../shared/contracts.js'
import { workspaceFilePreviewFormat } from '../shared/workspace-file-preview.js'
import type { WorkspaceMediaStreamFact, WorkspaceMediaStreamKind, WorkspaceMediaStreamOpenResult } from '../shared/workspace-media-stream.js'
import { previewRelativePath, previewRequestPath, previewUrlPath } from './preview-paths.js'
import type { WorkspaceFiles, WorkspaceMediaHandle } from './workspace-files.js'

type Lease = {
  workspace: WorkspaceRecord
  path: string
  kind: WorkspaceMediaStreamKind
  mimeType: string
  media: WorkspaceMediaHandle
  fact: WorkspaceMediaStreamFact
  responses: Set<ServerResponse>
  released: boolean
}

type MediaFiles = Pick<WorkspaceFiles, 'openMediaHandle'>
type Range = { start: number; end: number }

// The bytes never reach a script: no CORS grant, no sniffing, and an inert document if opened directly.
const STREAM_HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox"
} as const

/** Parse one RFC 9110 byte range. Multiple ranges are refused: media elements never send them. */
export function parseByteRange(header: string | undefined, size: number): Range | 'unsatisfiable' | null {
  if (header === undefined) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match || (!match[1] && !match[2])) return 'unsatisfiable'
  const first = match[1] ? Number(match[1]) : null, last = match[2] ? Number(match[2]) : null
  if ((first !== null && !Number.isSafeInteger(first)) || (last !== null && !Number.isSafeInteger(last))) return 'unsatisfiable'
  if (first === null) {
    if (!last || size === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - last), end: size - 1 }
  }
  if (first >= size || (last !== null && last < first)) return 'unsatisfiable'
  return { start: first, end: last === null ? size - 1 : Math.min(last, size - 1) }
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : 'WORKSPACE_MEDIA_UNAVAILABLE'
}

/** Visible-view playback leases. Main owns every byte; a released or failed lease records why. */
export class WorkspaceMediaStreams {
  private readonly leases = new Map<string, Lease>()
  private server: Server | null = null
  private origin: string | null = null
  private starting: Promise<string> | null = null
  private disposed = false
  private generation = 0

  constructor(private readonly files: MediaFiles,
    private readonly currentWorkspace: (id: string) => WorkspaceRecord | undefined) {}

  async open(workspace: WorkspaceRecord, requestedPath: string): Promise<WorkspaceMediaStreamOpenResult> {
    if (this.disposed) return { status: 'unavailable', code: 'WORKSPACE_MEDIA_CLOSED', message: 'Media playback is closed. Reopen the file to retry.' }
    const generation = this.generation
    let path: string
    try { path = previewRelativePath(requestedPath) }
    catch (error) { return { status: 'unavailable', code: 'WORKSPACE_PATH_ESCAPE', message: error instanceof Error ? error.message : String(error) } }
    const format = workspaceFilePreviewFormat(path)
    if (!format || (format.kind !== 'audio' && format.kind !== 'video')) return { status: 'unsupported', message: 'This file format has no built-in media playback.' }
    let media: WorkspaceMediaHandle
    try { media = await this.files.openMediaHandle(workspace, path) }
    catch (error) {
      const code = errorCode(error), message = error instanceof Error ? error.message : String(error)
      if (code === 'ENOENT' || code === 'ENOTDIR') return { status: 'deleted', message: 'This file no longer exists.' }
      if (code === 'EISDIR') return { status: 'directory' }
      return { status: 'unavailable', code, message }
    }
    const lease: Lease = { workspace: { ...workspace }, path, kind: format.kind, mimeType: format.mimeType, media,
      fact: { state: 'active' }, responses: new Set(), released: false }
    try {
      const origin = await this.start()
      if (this.disposed || generation !== this.generation || !this.workspaceMatches(lease)) throw Object.assign(new Error('Media playback was released before it started. Reopen the file to retry.'), { code: 'WORKSPACE_MEDIA_RELEASED' })
      const id = randomBytes(32).toString('base64url')
      this.leases.set(id, lease)
      return { status: 'ready', id, url: `${origin}/${id}/${previewUrlPath(path)}`, kind: lease.kind, mimeType: lease.mimeType, byteLength: media.byteLength }
    } catch (error) {
      await media.handle.close().catch(() => {})
      return { status: 'unavailable', code: errorCode(error), message: error instanceof Error ? error.message : String(error) }
    }
  }

  /** The lease owner's record. An unknown id was never issued or is already gone; say so. */
  status(id: string): WorkspaceMediaStreamFact {
    return this.leases.get(id)?.fact ?? { state: 'released' }
  }

  release(id: string): void {
    const lease = this.leases.get(id)
    if (!lease) return
    this.leases.delete(id)
    lease.released = true
    lease.fact = { state: 'released' }
    for (const response of lease.responses) response.destroy()
    lease.responses.clear()
    void lease.media.handle.close().catch(() => {})
  }

  /** The original Renderer ended or navigated; pending opens cannot mint leases after this point. */
  releaseAll(): void {
    ++this.generation
    for (const id of [...this.leases.keys()]) this.release(id)
  }

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

  private workspaceMatches(lease: Lease): boolean {
    const original = lease.workspace, current = this.currentWorkspace(original.id)
    return current?.id === original.id && current.hostId === original.hostId && current.path === original.path && current.kind === original.kind
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
          reject(Object.assign(new Error('The media playback listener is unavailable. Reopen the file to retry.'), { code: 'WORKSPACE_MEDIA_LISTENER_UNAVAILABLE' }))
          return
        }
        this.origin = `http://127.0.0.1:${address.port}`
        resolve(this.origin)
      })
    })
    try { return await this.starting } finally { this.starting = null }
  }

  private async respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
    for (const [name, value] of Object.entries(STREAM_HEADERS)) response.setHeader(name, value)
    const fail = (status: number, message: string, headers: Record<string, string> = {}): void => {
      if (response.destroyed || response.headersSent) { response.destroy(); return }
      response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers })
      response.end(request.method === 'HEAD' ? undefined : message)
    }
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        request.resume()
        fail(405, 'Media playback is read-only.', { Allow: 'GET, HEAD' })
        return
      }
      const match = /^\/([A-Za-z0-9_-]{43})\/(.+)$/.exec((request.url ?? '').split('?')[0]!)
      const id = match?.[1], lease = id ? this.leases.get(id) : undefined
      // A media element never sends Origin; a page script or a rebinding host does.
      const destination = request.headers['sec-fetch-dest']
      if (!match || !id || !lease || request.headers.host !== this.origin?.slice('http://'.length) ||
        request.headers.origin !== undefined || (destination !== undefined && destination !== 'audio' && destination !== 'video')) {
        fail(404, 'Media resource not found.')
        return
      }
      let path: string
      try { path = previewRequestPath(match[2]!) } catch { fail(404, 'Media resource not found.'); return }
      if (path !== lease.path) { fail(404, 'Media resource not found.'); return }
      if (lease.fact.state !== 'active') { fail(410, 'This media lease is no longer serving bytes. Reload to play the current file.'); return }
      if (!this.workspaceMatches(lease)) {
        lease.fact = { state: 'changed', path }
        fail(410, 'The original Workspace changed. Reload to play the current file.')
        return
      }
      let visible
      try { visible = await lease.media.current() }
      catch (error) {
        if (lease.released) { fail(410, 'This media lease was released.'); return }
        lease.fact = { state: 'read-error', path, code: errorCode(error) }
        fail(500, 'This media resource cannot be read.')
        return
      }
      if (lease.released) { fail(410, 'This media lease was released.'); return }
      if (visible !== 'same') {
        lease.fact = { state: visible, path }
        fail(visible === 'deleted' ? 404 : visible === 'outside-workspace' ? 403 : 410,
          visible === 'deleted' ? 'This file no longer exists.' : visible === 'outside-workspace' ? 'This path now leaves the Workspace.' : 'This file changed. Reload to play the current file.')
        return
      }
      const size = lease.media.byteLength
      const range = parseByteRange(request.headers.range as string | undefined, size)
      if (range === 'unsatisfiable') { fail(416, 'Requested range is not available.', { 'Content-Range': `bytes */${size}` }); return }
      const start = range?.start ?? 0, end = range?.end ?? size - 1, length = size === 0 ? 0 : end - start + 1
      response.writeHead(range ? 206 : 200, {
        'Content-Type': lease.mimeType, 'Accept-Ranges': 'bytes', 'Content-Length': String(length),
        ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {})
      })
      if (request.method === 'HEAD' || length === 0) { response.end(); return }
      lease.responses.add(response)
      response.once('close', () => lease.responses.delete(response))
      await this.pump(lease, path, response, start, end)
    } catch (error) {
      fail(500, 'Media resource is unavailable. Reload to retry.')
      void error
    }
  }

  /**
   * Positional reads from the pinned handle. A FileHandle stream closes its handle when the
   * response is destroyed on seek, which would end every later range of the same lease.
   */
  private async pump(lease: Lease, path: string, response: ServerResponse, start: number, end: number): Promise<void> {
    const chunk = Buffer.allocUnsafe(256 * 1024)
    for (let position = start; position <= end && !response.destroyed && !lease.released;) {
      let bytesRead: number
      try { ({ bytesRead } = await lease.media.handle.read(chunk, 0, Math.min(chunk.length, end - position + 1), position)) }
      catch (error) {
        if (!lease.released) lease.fact = { state: 'read-error', path, code: errorCode(error) }
        response.destroy()
        return
      }
      // A shorter file than its pinned length was changed underneath this lease.
      if (bytesRead === 0) { if (!lease.released) lease.fact = { state: 'changed', path }; response.destroy(); return }
      position += bytesRead
      const more = response.write(Buffer.from(chunk.subarray(0, bytesRead)))
      if (!more && !response.destroyed) await new Promise<void>(resolve => {
        const done = () => { response.off('drain', done); response.off('close', done); resolve() }
        response.once('drain', done); response.once('close', done)
      })
    }
    if (!response.destroyed) response.end()
  }
}
