import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { WorkspaceRecord } from '../shared/contracts.js'
import type { FileHandle } from 'node:fs/promises'
import { workspaceFileExtension, workspaceFilePreviewFormat } from '../shared/workspace-file-preview.js'
import { WORKSPACE_MEDIA_PLAYLIST_EXTENSION, type WorkspaceMediaStreamFact, type WorkspaceMediaStreamOpenResult } from '../shared/workspace-media-stream.js'
import { previewRelativePath, previewRequestPath, previewUrlPath } from './preview-paths.js'
import type { WorkspaceFiles, WorkspaceMediaHandle } from './workspace-files.js'

type LeaseBase = {
  workspace: WorkspaceRecord
  path: string
  mimeType: string
  fact: WorkspaceMediaStreamFact
  responses: Set<ServerResponse>
  released: boolean
}
/** One pinned file object for its whole lifetime. */
type FileLease = LeaseBase & { kind: 'audio' | 'video'; media: WorkspaceMediaHandle }
/**
 * A root playlist and everything a playlist it served has referenced. Playlists are re-read per
 * request (encoders replace them by rename); segments open per request (live windows delete them).
 * Its fact explains the latest refused resource and never closes the lease: a sibling variant or
 * the next live reload may still play, and a clean serve of that same path clears it.
 */
type PlaylistLease = LeaseBase & {
  kind: 'playlist'
  referenced: Set<string>
  served: Map<string, { body: Buffer; at: number }>
}
type Lease = FileLease | PlaylistLease

type MediaFiles = Pick<WorkspaceFiles, 'openMediaHandle' | 'readMediaPlaylist'>
type Range = { start: number; end: number }
type Fail = (status: number, message: string, headers?: Record<string, string>) => void

/** Resources a playlist lease serves, by extension. A playlist may name others; only those requests are refused. */
const PLAYLIST_RESOURCE_TYPES: Readonly<Record<string, string>> = {
  [WORKSPACE_MEDIA_PLAYLIST_EXTENSION]: 'application/vnd.apple.mpegurl',
  ts: 'video/mp2t', m4s: 'video/iso.segment', mp4: 'video/mp4', m4a: 'audio/mp4',
  aac: 'audio/aac', mp3: 'audio/mpeg', vtt: 'text/vtt'
}
/** RFC 8216 tags whose URI attribute a client may fetch. */
const URI_ATTRIBUTE_TAGS = new Set(['EXT-X-MAP', 'EXT-X-MEDIA', 'EXT-X-KEY', 'EXT-X-SESSION-KEY', 'EXT-X-I-FRAME-STREAM-INF',
  'EXT-X-PART', 'EXT-X-PRELOAD-HINT', 'EXT-X-RENDITION-REPORT'])
/** An unchanged live playlist is re-checked at this interval while its reply is held. */
const LIVE_PLAYLIST_RECHECK_MS = 250
/** Never answer an unchanged live reload sooner than this after the previous reply. */
const LIVE_PLAYLIST_MIN_HOLD_MS = 1000

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

/** Every URI line and fetchable URI attribute of one playlist body, as written. */
export function playlistReferences(text: string): string[] {
  const references: string[] = []
  // A lone CR also ends a line here, so no reading of the body hides a URI inside a longer line.
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (!line.startsWith('#')) { references.push(line); continue }
    const colon = line.indexOf(':')
    if (colon < 0 || !URI_ATTRIBUTE_TAGS.has(line.slice(1, colon).trim().toUpperCase())) continue
    // Attribute-list tokens (RFC 8216 §4.2): a quoted value may itself contain text like ',URI='.
    for (const match of line.slice(colon + 1).matchAll(/([^=,]+)=("[^"]*"|[^,]*)/g)) {
      if (match[1]!.trim().toUpperCase() === 'URI') references.push(match[2]!.startsWith('"') ? match[2]!.slice(1, -1) : match[2]!)
    }
  }
  return references
}

/**
 * Resolve one reference exactly as the player will: relative to the playlist's own served URL,
 * by the WHATWG URL parser, then the one Workspace-relative request-path rule. A refusal names the playlist.
 */
export function resolvePlaylistReference(reference: string, playlistPath: string): string | WorkspaceMediaStreamFact {
  // The URL parser drops these before reading a scheme; the scan must see the same reference the player sees.
  const stripped = reference.replace(/[\t\n\r]/g, '').replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '')
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(stripped) || /^[/\\]/.test(stripped)) return { state: 'external-reference', path: playlistPath }
  // A player that substitutes EXT-X-DEFINE variables could turn this into any address; it cannot be resolved here.
  if (stripped.includes('{$')) return { state: 'unsupported-resource', path: playlistPath }
  // A path-relative reference keeps the origin; only its path can climb. Under two different roots, a
  // reference that stays inside resolves to the same remainder; one that climbs out cannot keep both.
  const [left, right] = ['/a/', '/b/'].map(root => {
    const { pathname } = new URL(stripped, `http://lease.invalid${root}${previewUrlPath(playlistPath)}`)
    return pathname.startsWith(root) ? pathname.slice(root.length) : null
  })
  if (left === null || left === undefined || left !== right) return { state: 'outside-workspace', path: playlistPath }
  let path: string
  try { return previewRequestPath(left) }
  catch { return { state: 'unsupported-resource', path: playlistPath } }
}

/**
 * A media playlist without an end tag may still grow (RFC 8216 §6.3.4): hold an unchanged reload for
 * half a target duration. Every media playlist carries EXT-X-TARGETDURATION (§4.3.3.1); a master one never grows.
 */
export function livePlaylistHoldMs(text: string): number | null {
  if (/^#EXT-X-ENDLIST[ \t]*$/m.test(text)) return null
  const target = /^#EXT-X-TARGETDURATION:[ \t]*(\d+)[ \t]*$/m.exec(text)
  return target ? Math.max(LIVE_PLAYLIST_MIN_HOLD_MS, Number(target[1]) * 1000 / 2) : null
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
    // A playlist is an editable text File whose preview plays; other media come from the media format table.
    const playlist = workspaceFileExtension(path) === WORKSPACE_MEDIA_PLAYLIST_EXTENSION
    const table = playlist ? null : workspaceFilePreviewFormat(path)
    const fileKind = table?.kind === 'audio' || table?.kind === 'video' ? table.kind : null
    if (!playlist && !fileKind) return { status: 'unsupported', message: 'This file format has no built-in media playback.' }
    const mimeType = playlist ? PLAYLIST_RESOURCE_TYPES[WORKSPACE_MEDIA_PLAYLIST_EXTENSION]! : table!.mimeType
    let media: WorkspaceMediaHandle | null = null, byteLength: number
    try {
      // A playlist is confirmed readable here and re-read per request; a single file is pinned once.
      if (playlist) byteLength = (await this.files.readMediaPlaylist(workspace, path)).byteLength
      else ({ byteLength } = media = await this.files.openMediaHandle(workspace, path))
    } catch (error) {
      const code = errorCode(error), message = error instanceof Error ? error.message : String(error)
      if (code === 'ENOENT' || code === 'ENOTDIR') return { status: 'deleted', message: 'This file no longer exists.' }
      if (code === 'EISDIR') return { status: 'directory' }
      return { status: 'unavailable', code, message }
    }
    const base: LeaseBase = { workspace: { ...workspace }, path, mimeType, fact: { state: 'active' }, responses: new Set(), released: false }
    const lease: Lease = media && fileKind ? { ...base, kind: fileKind, media }
      : { ...base, kind: 'playlist', referenced: new Set([path]), served: new Map() }
    try {
      const origin = await this.start()
      if (this.disposed || generation !== this.generation || !this.workspaceMatches(lease)) throw Object.assign(new Error('Media playback was released before it started. Reopen the file to retry.'), { code: 'WORKSPACE_MEDIA_RELEASED' })
      const id = randomBytes(32).toString('base64url')
      this.leases.set(id, lease)
      return { status: 'ready', id, url: `${origin}/${id}/${previewUrlPath(path)}`, kind: lease.kind, mimeType: lease.mimeType, byteLength }
    } catch (error) {
      await media?.handle.close().catch(() => {})
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
    if (lease.kind !== 'playlist') void lease.media.handle.close().catch(() => {})
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
    const fail: Fail = (status, message, headers = {}) => {
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
      // A probe for anything a served playlist never named is this request's 404 only; the lease keeps playing.
      if (lease.kind === 'playlist' ? !lease.referenced.has(path) : path !== lease.path) { fail(404, 'Media resource not found.'); return }
      if (lease.kind !== 'playlist' && lease.fact.state !== 'active') { fail(410, 'This media lease is no longer serving bytes. Reload to play the current file.'); return }
      if (!this.workspaceMatches(lease)) {
        lease.fact = { state: 'changed', path }
        fail(410, 'The original Workspace changed. Reload to play the current file.')
        return
      }
      if (lease.kind === 'playlist') {
        if (workspaceFileExtension(path) === WORKSPACE_MEDIA_PLAYLIST_EXTENSION) await this.respondPlaylist(lease, path, request, response, fail)
        else await this.respondSegment(lease, path, request, response, fail)
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
      await this.serveBytes(lease, path, lease.media.handle, lease.media.byteLength, lease.mimeType, request, response, fail)
    } catch (error) {
      // An unexpected failure is recorded as unknown-but-retryable, never left looking like a served lease.
      const lease = this.leases.get(/^\/([A-Za-z0-9_-]{43})\//.exec(request.url ?? '')?.[1] ?? '')
      if (lease && !lease.released) lease.fact = { state: 'transient', path: lease.path, code: errorCode(error) }
      fail(500, 'Media resource is unavailable. Reload to retry.')
    }
  }

  /**
   * Positional reads from the pinned handle. A FileHandle stream closes its handle when the
   * response is destroyed on seek, which would end every later range of the same lease.
   */
  private async pump(lease: Lease, path: string, handle: FileHandle, response: ServerResponse, start: number, end: number): Promise<boolean> {
    const chunk = Buffer.allocUnsafe(256 * 1024)
    for (let position = start; position <= end && !response.destroyed && !lease.released;) {
      let bytesRead: number
      try { ({ bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, end - position + 1), position)) }
      catch (error) {
        if (!lease.released) lease.fact = { state: 'read-error', path, code: errorCode(error) }
        response.destroy()
        return false
      }
      // A file shorter than its opened length was changed underneath this response.
      if (bytesRead === 0) { if (!lease.released) lease.fact = { state: 'changed', path }; response.destroy(); return false }
      position += bytesRead
      const more = response.write(Buffer.from(chunk.subarray(0, bytesRead)))
      if (!more && !response.destroyed) await new Promise<void>(resolve => {
        const done = () => { response.off('drain', done); response.off('close', done); resolve() }
        response.once('drain', done); response.once('close', done)
      })
    }
    if (response.destroyed) return false
    response.end()
    return true
  }

  /** The resource a playlist lease's fact names played again; nothing it explained is failing now. */
  /** A clean reply clears that path's fact; any clean reply clears a transient one, since it explained a moment, not a file. */
  private clear(lease: PlaylistLease, path: string): void {
    if (lease.fact.state === 'transient' || ('path' in lease.fact && lease.fact.path === path)) lease.fact = { state: 'active' }
  }

  /** Range headers and positional bytes for one opened file object. */
  private async serveBytes(lease: Lease, path: string, handle: FileHandle, size: number, mimeType: string,
    request: IncomingMessage, response: ServerResponse, fail: Fail): Promise<boolean> {
    const range = parseByteRange(request.headers.range as string | undefined, size)
    if (range === 'unsatisfiable') { fail(416, 'Requested range is not available.', { 'Content-Range': `bytes */${size}` }); return false }
    const start = range?.start ?? 0, end = range?.end ?? size - 1, length = size === 0 ? 0 : end - start + 1
    response.writeHead(range ? 206 : 200, {
      'Content-Type': mimeType, 'Accept-Ranges': 'bytes', 'Content-Length': String(length),
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {})
    })
    if (request.method === 'HEAD' || length === 0) { response.end(); return true }
    lease.responses.add(response)
    response.once('close', () => lease.responses.delete(response))
    return await this.pump(lease, path, handle, response, start, end)
  }

  /** A served playlist's segment, opened for this request only through the same confinement. */
  private async respondSegment(lease: PlaylistLease, path: string, request: IncomingMessage, response: ServerResponse, fail: Fail): Promise<void> {
    // The playlist may name a key, a caption or a rendition this player does not serve; refuse only that resource.
    const mimeType = PLAYLIST_RESOURCE_TYPES[workspaceFileExtension(path)]
    if (!mimeType) { lease.fact = { state: 'unsupported-resource', path }; fail(422, 'This playlist resource is not a media type that plays here.'); return }
    let media: WorkspaceMediaHandle
    try { media = await this.files.openMediaHandle(lease.workspace, path) }
    catch (error) {
      const code = errorCode(error)
      if (lease.released) { fail(410, 'This media lease was released.'); return }
      // A live window deletes old segments: a missing one fails this request, never the playback lease.
      if (code === 'ENOENT' || code === 'ENOTDIR') { lease.fact = { state: 'transient', path, code }; fail(404, 'This segment no longer exists.'); return }
      // Replaced between open and its identity check; the next request opens the new object.
      if (code === 'WORKSPACE_FILE_CHANGED_WHILE_READING') { lease.fact = { state: 'transient', path, code }; fail(503, 'This segment changed while it was opened. Retry.', { 'Retry-After': '1' }); return }
      lease.fact = code === 'WORKSPACE_PATH_ESCAPE' ? { state: 'outside-workspace', path }
        : code === 'EISDIR' || code === 'WORKSPACE_MEDIA_NOT_REGULAR' ? { state: 'unsupported-resource', path } : { state: 'read-error', path, code }
      fail(lease.fact.state === 'outside-workspace' ? 403 : lease.fact.state === 'unsupported-resource' ? 422 : 500,
        lease.fact.state === 'outside-workspace' ? 'This segment leaves the Workspace.' : 'This segment cannot be played.')
      return
    }
    try {
      if (lease.released) { fail(410, 'This media lease was released.'); return }
      if (await this.serveBytes(lease, path, media.handle, media.byteLength, mimeType, request, response, fail)) this.clear(lease, path)
    } finally { await media.handle.close().catch(() => {}) }
  }

  /**
   * Re-read the playlist, refuse it if it names anything outside the Workspace or the playable set,
   * and admit what it names. An unchanged live reload is held so the player does not spin on it.
   */
  private async respondPlaylist(lease: PlaylistLease, path: string, request: IncomingMessage, response: ServerResponse, fail: Fail): Promise<void> {
    let body = await this.readPlaylist(lease, path, fail)
    if (!body) return
    const previous = lease.served.get(path), hold = livePlaylistHoldMs(body.toString('utf8'))
    if (previous && hold !== null && previous.body.equals(body)) {
      lease.responses.add(response)
      response.once('close', () => lease.responses.delete(response))
      for (const deadline = previous.at + hold; Date.now() < deadline;) {
        if (!await this.pause(lease, response, Math.min(LIVE_PLAYLIST_RECHECK_MS, deadline - Date.now()))) { fail(410, 'This media lease was released.'); return }
        const next = await this.readPlaylist(lease, path, fail)
        if (!next) return
        if (!next.equals(body)) { body = next; break }
      }
    }
    const admitted: string[] = []
    for (const reference of playlistReferences(body.toString('utf8'))) {
      const resolved = resolvePlaylistReference(reference, path)
      if (typeof resolved !== 'string') {
        lease.fact = resolved
        fail(resolved.state === 'outside-workspace' ? 403 : 422, resolved.state === 'external-reference'
          ? 'This playlist names media outside the Workspace by an absolute address.' : 'This playlist names a resource that cannot play here.')
        return
      }
      admitted.push(resolved)
    }
    for (const reference of admitted) lease.referenced.add(reference)
    lease.served.set(path, { body, at: Date.now() })
    this.clear(lease, path)
    response.writeHead(200, { 'Content-Type': lease.mimeType, 'Content-Length': String(body.byteLength) })
    response.end(request.method === 'HEAD' ? undefined : body)
  }

  /** One bounded read through the byte owner. A failure is recorded and answered here; null means answered. */
  private async readPlaylist(lease: PlaylistLease, path: string, fail: Fail): Promise<Buffer | null> {
    let body: Buffer | null = null, code = ''
    try { body = await this.files.readMediaPlaylist(lease.workspace, path) } catch (error) { code = errorCode(error) }
    if (lease.released) { fail(410, 'This media lease was released.'); return null }
    if (body) return body
    // An encoder rewrote it in place during every retry; the player's next reload reads it again.
    if (code === 'WORKSPACE_FILE_CHANGED_WHILE_READING') { lease.fact = { state: 'transient', path, code }; fail(503, 'This playlist changed while it was read. Retry.', { 'Retry-After': '1' }); return null }
    lease.fact = code === 'ENOENT' || code === 'ENOTDIR' ? { state: 'deleted', path }
      : code === 'WORKSPACE_PATH_ESCAPE' ? { state: 'outside-workspace', path } : { state: 'read-error', path, code }
    fail(lease.fact.state === 'deleted' ? 404 : lease.fact.state === 'outside-workspace' ? 403 : code === 'WORKSPACE_FILE_BYTE_LIMIT' ? 413 : 500,
      lease.fact.state === 'deleted' ? 'This playlist no longer exists.' : 'This playlist cannot be read.')
    return null
  }

  /**
   * Wait while holding a reply; false once the reply closed or the lease was released.
   * A held reply is in the lease's responses, so release destroys it and its close clears this timer.
   */
  private pause(lease: PlaylistLease, response: ServerResponse, ms: number): Promise<boolean> {
    if (response.destroyed || lease.released) return Promise.resolve(false)
    return new Promise(resolve => {
      const done = (proceed: boolean) => {
        clearTimeout(timer)
        response.off('close', stop)
        resolve(proceed && !response.destroyed && !lease.released)
      }
      const stop = () => done(false), timer = setTimeout(() => done(true), ms)
      response.once('close', stop)
    })
  }
}
