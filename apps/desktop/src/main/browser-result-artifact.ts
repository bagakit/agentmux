import { constants } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { durableWriteFile } from '@agentmux/core'
import {
  BROWSER_RESULT_MAX_BYTES, BROWSER_RESULT_MAX_READ_BYTES,
  type BrowserResultArtifactChunk, type BrowserResultArtifactReference,
  type BrowserResultContext, type BrowserResultCurrentOwner, type BrowserResultReadOptions
} from '../shared/browser-result-artifact.js'

const MAX_STORE_BYTES = 64 * 1024 * 1024
const MAX_ARTIFACTS = 128
const MAX_METADATA_BYTES = 16 * 1024
const CHUNK_BYTES = BROWSER_RESULT_MAX_READ_BYTES
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SCHEMA = 'agentmux.browser-result-artifact'
type Metadata = { schema: string; reference: BrowserResultArtifactReference; chunks: string[] }
const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

function sameReference(a: BrowserResultArtifactReference, b: BrowserResultArtifactReference): boolean {
  return a.kind === b.kind && a.id === b.id && a.workspaceId === b.workspaceId &&
    a.browserId === b.browserId && a.operationId === b.operationId &&
    a.navigationId === b.navigationId && a.format === b.format &&
    a.byteLength === b.byteLength && a.capturedAt === b.capturedAt && a.maxReadBytes === b.maxReadBytes
}

/** Fixed allocation and no symlink following, including when the producer is a script process. */
async function readBounded(path: string, limit: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > limit) throw new Error('Result artifact exceeds its read budget or is not a regular file.')
    const bytes = Buffer.alloc(Math.min(info.size + 1, limit + 1))
    let length = 0
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, length)
      if (!read.bytesRead) break
      length += read.bytesRead
    }
    if (length > limit || length !== info.size) throw new Error('Result artifact changed while being read.')
    return bytes.subarray(0, length)
  } finally { await file.close() }
}

/** One payload store; no script, page action, journal replay or unrelated Session reads. */
export class BrowserResultArtifactStore {
  private tail: Promise<unknown> = Promise.resolve()
  private loaded = false
  private files = new Map<string, { bytes: number; at: number }>()
  private totalBytes = 0

  constructor(private readonly directory: string) {}

  async import(context: BrowserResultContext, sourcePath: string): Promise<BrowserResultArtifactReference> {
    return await this.persist(context, async () => await readBounded(sourcePath, BROWSER_RESULT_MAX_BYTES))
  }

  /** Main-generated observations use the same durable owner, byte limits and continuation reads. */
  async registerJSON(context: BrowserResultContext, value: unknown): Promise<BrowserResultArtifactReference> {
    return await this.persist(context, async () => {
      const text = JSON.stringify(value)
      if (text === undefined || Buffer.byteLength(text) > BROWSER_RESULT_MAX_BYTES) {
        throw new Error('Result artifact exceeds its storage budget or is not JSON.')
      }
      return Buffer.from(text, 'utf8')
    })
  }

  private async persist(context: BrowserResultContext, load: () => Promise<Buffer>): Promise<BrowserResultArtifactReference> {
    if (!context.workspaceId) throw new Error('This Browser has no verified Workspace binding; durable results are unavailable.')
    if (!context.browserId || !context.operationId || !context.navigationId) throw new Error('Result source identity is incomplete.')
    const workspaceId = context.workspaceId
    const source = { workspaceId, browserId: context.browserId, operationId: context.operationId, navigationId: context.navigationId }
    const write = this.tail.catch(() => {}).then(async () => {
      await this.ready()
      const bytes = await load()
      JSON.parse(bytes.toString('utf8')) // A result is JSON, not an arbitrary file transfer.
      const id = randomUUID()
      const reference: BrowserResultArtifactReference = {
        ...source, kind: 'browser-result-artifact', id, format: 'json',
        byteLength: bytes.length, capturedAt: Date.now(), maxReadBytes: BROWSER_RESULT_MAX_READ_BYTES
      }
      const chunks: string[] = []
      for (let start = 0; start < bytes.length; start += CHUNK_BYTES) chunks.push(hash(bytes.subarray(start, start + CHUNK_BYTES)))
      const document = JSON.stringify({ schema: SCHEMA, reference, chunks } satisfies Metadata)
      const size = bytes.length + Buffer.byteLength(document)
      if (Buffer.byteLength(document) > MAX_METADATA_BYTES) throw new Error('Result metadata exceeds its storage budget.')
      // Retention only examines this store's bounded owned index, not Browser/Session state.
      for (const [oldId, old] of [...this.files].sort((a, b) => a[1].at - b[1].at)) {
        if (this.files.size < MAX_ARTIFACTS && this.totalBytes + size <= MAX_STORE_BYTES) break
        await this.remove(oldId)
        this.files.delete(oldId)
        this.totalBytes -= old.bytes
      }
      try {
        await durableWriteFile(join(this.directory, `${id}.data`), bytes)
        await durableWriteFile(join(this.directory, `${id}.json`), document)
      } catch (error) {
        await this.remove(id)
        throw error
      }
      this.files.set(id, { bytes: size, at: reference.capturedAt })
      this.totalBytes += size
      return reference
    })
    this.tail = write
    return await write
  }

  async read(reference: BrowserResultArtifactReference, current: BrowserResultCurrentOwner,
    options: BrowserResultReadOptions = {}): Promise<BrowserResultArtifactChunk> {
    if (!reference || !ID.test(reference.id) || reference.kind !== 'browser-result-artifact' ||
        reference.format !== 'json' || !reference.workspaceId || !current.workspaceId ||
        current.workspaceId !== reference.workspaceId || current.browserId !== reference.browserId) {
      throw new Error('Result artifact does not belong to this Workspace and Browser.')
    }
    const offset = options.offset ?? 0
    const maxBytes = options.maxBytes ?? 16 * 1024
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxBytes) ||
        maxBytes < 1 || maxBytes > BROWSER_RESULT_MAX_READ_BYTES) {
      throw new Error(`Result read requires an integer offset and maxBytes from 1 to ${BROWSER_RESULT_MAX_READ_BYTES}.`)
    }
    const metadataBytes = await readBounded(join(this.directory, `${reference.id}.json`), MAX_METADATA_BYTES)
    const metadata = JSON.parse(metadataBytes.toString('utf8')) as Metadata
    if (metadata.schema !== SCHEMA || !metadata.reference || !sameReference(metadata.reference, reference) ||
        !Number.isSafeInteger(reference.byteLength) || reference.byteLength < 1 || reference.byteLength > BROWSER_RESULT_MAX_BYTES ||
        reference.maxReadBytes !== BROWSER_RESULT_MAX_READ_BYTES || !Array.isArray(metadata.chunks) ||
        metadata.chunks.length !== Math.ceil(reference.byteLength / CHUNK_BYTES)) {
      throw new Error('Result artifact does not match its original operation and source.')
    }
    if (offset > reference.byteLength) throw new Error('Result offset exceeds the stored byte length.')
    const end = Math.min(reference.byteLength, offset + maxBytes)
    const startChunk = Math.floor(offset / CHUNK_BYTES)
    const alignedStart = startChunk * CHUNK_BYTES
    const alignedEnd = Math.min(reference.byteLength, Math.ceil(end / CHUNK_BYTES) * CHUNK_BYTES)
    const file = await open(join(this.directory, `${reference.id}.data`), constants.O_RDONLY | constants.O_NOFOLLOW)
    let payload: Buffer
    try {
      const info = await file.stat()
      if (!info.isFile() || info.size !== reference.byteLength) throw new Error('Result artifact payload is missing or truncated.')
      payload = Buffer.alloc(end === offset ? 0 : alignedEnd - alignedStart)
      let length = 0
      while (length < payload.length) {
        const read = await file.read(payload, length, payload.length - length, alignedStart + length)
        if (!read.bytesRead) throw new Error('Result artifact payload is truncated.')
        length += read.bytesRead
      }
      for (let start = 0; start < payload.length; start += CHUNK_BYTES) {
        if (hash(payload.subarray(start, start + CHUNK_BYTES)) !== metadata.chunks[startChunk + start / CHUNK_BYTES]) {
          throw new Error('Result artifact payload integrity check failed.')
        }
      }
    } finally { await file.close() }
    const bytes = payload.subarray(offset - alignedStart, offset - alignedStart + end - offset)
    return {
      reference, encoding: 'base64', data: bytes.toString('base64'), offset, returnedBytes: bytes.length,
      totalBytes: reference.byteLength, nextOffset: end < reference.byteLength ? end : null,
      readCost: { metadataBytes: metadataBytes.length, payloadBytes: payload.length }
    }
  }

  private async remove(id: string): Promise<void> {
    await rm(join(this.directory, `${id}.json`), { force: true })
    await rm(join(this.directory, `${id}.data`), { force: true })
  }

  private async ready(): Promise<void> {
    if (this.loaded) return
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    // Startup index scan is store-local. Segment reads never scan the directory.
    const names = await readdir(this.directory)
    const present = new Set(names)
    for (const name of names) {
      const payloadId = name.replace(/\.data$/, '')
      if (name === `${payloadId}.data` && ID.test(payloadId) && !present.has(`${payloadId}.json`)) {
        await rm(join(this.directory, name), { force: true }) // Interrupted publish; never a durable reference.
        continue
      }
      const id = name.replace(/\.json$/, '')
      if (name !== `${id}.json` || !ID.test(id)) continue
      try {
        const metadata = await stat(join(this.directory, name))
        const payload = await stat(join(this.directory, `${id}.data`))
        if (!metadata.isFile() || !payload.isFile()) continue
        const bytes = metadata.size + payload.size
        this.files.set(id, { bytes, at: metadata.mtimeMs })
        this.totalBytes += bytes
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        await this.remove(id)
      }
    }
    this.loaded = true
  }
}

export async function readBrowserResultArtifact(store: BrowserResultArtifactStore,
  reference: BrowserResultArtifactReference, current: BrowserResultCurrentOwner,
  options?: BrowserResultReadOptions): Promise<BrowserResultArtifactChunk> {
  return await store.read(reference, current, options)
}
