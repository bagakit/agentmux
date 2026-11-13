import { spawn } from 'node:child_process'
import { existsSync, read as readDescriptor } from 'node:fs'
import { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'
import { extract } from 'tar-stream'
import type { WorkspaceComicArchiveEntry, WorkspaceFileSourceFailure } from '../shared/workspace-file-source'

interface DescriptorSource {
  withDescriptor<T>(caller: number, source: string, operation: string, consume: (fd: number, signal: AbortSignal) => Promise<T>): Promise<{ status: 'read'; value: T } | WorkspaceFileSourceFailure>
}
const image = /\.(?:jpe?g|png|webp|gif|bmp|avif)$/i
const error = (message: string) => Object.assign(new Error(message), { code: 'WORKSPACE_COMIC_ARCHIVE_UNAVAILABLE' })

/**
 * libarchive decodes the pinned original fd into a PAX stream, never a temporary extraction directory.
 * tar-stream owns binary header/PAX/checksum parsing; display listings and glob patterns grant no identity.
 * CBR is sequential: revisiting a late page can rescan preceding compressed entries. JS retains only that page.
 */
export class WorkspaceCbrArchives {
  constructor(private readonly sources: DescriptorSource) {}

  entries(caller: number, source: string, operation: string) {
    return this.sources.withDescriptor(caller, source, operation, (fd, signal) => readArchive(fd, signal))
  }

  readEntry(caller: number, source: string, operation: string, path: string) {
    if (typeof path !== 'string' || !image.test(path)) return Promise.resolve({ status: 'unavailable' as const, code: 'INVALID_COMIC_ARCHIVE_ENTRY', message: 'Name one image page in this comic archive.' })
    return this.sources.withDescriptor(caller, source, operation, (fd, signal) => readArchive(fd, signal, path))
  }
}

function readArchive(fd: number, signal: AbortSignal): Promise<WorkspaceComicArchiveEntry[]>
function readArchive(fd: number, signal: AbortSignal, selected: string): Promise<Uint8Array>
function readArchive(fd: number, signal: AbortSignal, selected?: string): Promise<WorkspaceComicArchiveEntry[] | Uint8Array> {
  signal.throwIfAborted()
  const executable = ['/usr/bin/bsdtar', '/bin/bsdtar', '/usr/bin/tar'].find(path => existsSync(path))
  if (!executable) return Promise.reject(error('A libarchive-compatible bsdtar is unavailable on this Host. The original file remains available.'))
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]!]))
    const child = spawn(executable, ['-cf', '-', '--format=pax', '@-'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...env, COPYFILE_DISABLE: '1' } })
    // Explicit positions read the original descriptor. /dev/fd duplicates share a mutable offset.
    const input = Readable.from((async function* () {
      let position = 0
      while (!signal.aborted) {
        const bytes = Buffer.alloc(64 * 1024)
        const length = await new Promise<number>((resolve, reject) => readDescriptor(fd, bytes, 0, bytes.length, position,
          (error, length) => error ? reject(error) : resolve(length)))
        signal.throwIfAborted()
        if (!length) return
        position += length
        yield bytes.subarray(0, length)
      }
      signal.throwIfAborted()
    })(), { objectMode: false, highWaterMark: 64 * 1024 })
    const archive = extract()
    const entries: WorkspaceComicArchiveEntry[] = [], names = new Set<string>()
    let chunks: Buffer[] = [], received = 0, complete: Uint8Array | undefined
    let failure: unknown, intentionalStop = false, stderr = '', parsed = false
    // destroy() on fs.createReadStream can close even an autoClose:false borrowed fd.
    // This stream borrows read only; its owner closes after this operation settles.
    const inputClosed = finished(input, { cleanup: true }).catch(reason => { if (!intentionalStop && !signal.aborted) failure ??= reason })
    const stop = (reason?: unknown) => {
      failure ??= reason
      input.destroy(); child.stdin.destroy(); archive.destroy()
      child.kill('SIGKILL')
    }
    const abort = () => stop(new DOMException('The comic page read was cancelled.', 'AbortError'))
    signal.addEventListener('abort', abort, { once: true })
    input.on('error', stop)
    child.on('error', stop)
    child.stdin.on('error', err => { if (!intentionalStop && !failure) stop(err) })
    child.stderr.on('data', (bytes: Buffer) => { if (stderr.length < 4096) stderr += bytes.toString('utf8').slice(0, 4096 - stderr.length) })
    archive.on('error', stop)
    archive.on('finish', () => { parsed = true })
    archive.on('entry', (header, stream, next) => {
      const path = header.name
      if (header.type !== 'file' || !image.test(path)) { stream.resume(); stream.on('end', next); return }
      // PAX is UTF-8. Replacement characters cannot name the original byte path unambiguously.
      if (path.includes('\0') || path.includes('\uFFFD') || !Number.isSafeInteger(header.size) || header.size! < 0 || names.has(path)) {
        stop(error('This comic archive has ambiguous image entry names or invalid page sizes.')); return
      }
      names.add(path)
      if (selected === undefined) {
        entries.push({ path, size: header.size! }); stream.resume(); stream.on('end', next); return
      }
      if (path !== selected) { stream.resume(); stream.on('end', next); return }
      chunks = []; received = 0
      stream.on('data', (value: unknown) => {
        if (!(value instanceof Uint8Array)) { stop(error('The comic decoder returned a non-byte page payload.')); return }
        const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength)
        received += bytes.length
        if (received > header.size!) { stop(error('The comic image exceeded its declared entry size.')); return }
        chunks.push(bytes)
      })
      stream.on('end', () => {
        if (received !== header.size) { stop(error('The comic image ended before its declared entry size.')); return }
        complete = Buffer.concat(chunks, received); chunks = []
        intentionalStop = true; stop()
      })
    })
    child.on('close', async code => {
      signal.removeEventListener('abort', abort)
      input.destroy(); child.stdin.destroy(); archive.destroy()
      await inputClosed
      if (failure) reject(failure)
      else if (intentionalStop && complete) resolve(complete)
      else if (code !== 0 || !parsed || stderr.trim()) reject(error(`This Host could not decode the comic archive${stderr ? `: ${stderr.trim()}` : '.'}`))
      else if (selected !== undefined) reject(error('The selected comic page is no longer present in the archive.'))
      else resolve(entries)
    })
    input.pipe(child.stdin)
    child.stdout.pipe(archive)
    if (signal.aborted) abort()
  })
}
