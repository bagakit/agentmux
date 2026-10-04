import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { parseFileUploadIdentity, parseFileUploadParams, parseFileUploadResult, type AgentMuxRpcFileUploadsOwner,
  type FileUploadIdentity, type FileUploadParams, type FileUploadResult } from '@agentmux/core/files'

const digest = (bytes: Uint8Array) => 'sha256:' + createHash('sha256').update(bytes).digest('hex')
const failure = (identity: FileUploadIdentity, error: unknown): FileUploadResult => ({ ...identity, status: 'unknown',
  code: 'FILE_UPLOAD_UNCONFIRMED', message: error instanceof Error ? error.message : String(error) })
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT'
const same = (a: FileUploadIdentity, b: FileUploadIdentity) => JSON.stringify(a) === JSON.stringify(b)
function identityOf(input: FileUploadIdentity): FileUploadIdentity {
  return parseFileUploadIdentity({ hostId: input.hostId, agentSessionId: input.agentSessionId,
    expectedRun: { runId: input.expectedRun.runId }, operationId: input.operationId, name: input.name,
    mimeType: input.mimeType, byteLength: input.byteLength, revision: input.revision })
}
function extension(input: FileUploadIdentity): string {
  const image = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' }[input.mimeType]
  if (image) return image
  const suffix = extname(input.name).toLowerCase()
  return /^\.[a-z0-9]{1,12}$/u.test(suffix) ? suffix : '.bin'
}
async function syncedExclusive(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
}
async function readBounded(path: string, max: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size > max) throw new Error('The original upload file is not a bounded ordinary file.')
    const bytes = Buffer.alloc(before.size)
    let offset = 0
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (!read.bytesRead) throw new Error('The original upload changed while being read.')
      offset += read.bytesRead
    }
    const after = await handle.stat()
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('The original upload changed while being read.')
    return bytes
  } finally { await handle.close() }
}

/** The Host owns the private destination, immutable upload intent and actual file bytes.
 * A receipt is reconstructed by reading the same file; it is never a second message queue. */
export class FileUploadOwner implements AgentMuxRpcFileUploadsOwner {
  private readonly tails = new Map<string, Promise<unknown>>()
  constructor(private readonly directory: string) {}
  private address(identity: FileUploadIdentity) {
    return join(this.directory, createHash('sha256').update(identity.operationId).digest('hex'))
  }
  private async original(identity: FileUploadIdentity): Promise<{ identity: FileUploadIdentity; path: string } | null> {
    let root
    try { root = await lstat(this.directory) } catch (error) { if (missing(error)) return null; throw error }
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('The original Host upload directory is unavailable.')
    const directory = this.address(identity)
    let info
    try { info = await lstat(directory) } catch (error) { if (missing(error)) return null; throw error }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('The original upload directory is unavailable.')
    const retained = identityOf(JSON.parse((await readBounded(join(directory, 'intent.json'), 8192)).toString('utf8')))
    if (!same(retained, identity)) throw new Error('This operation belongs to another original target or file. Its retained bytes were not changed.')
    return { identity: retained, path: join(await realpath(directory), 'attachment' + extension(identity)) }
  }
  async inspect(input: FileUploadIdentity): Promise<FileUploadResult> {
    const identity = identityOf(input)
    try {
      const original = await this.original(identity)
      if (!original) return { ...identity, status: 'missing' }
      const bytes = await readBounded(original.path, identity.byteLength)
      if (bytes.byteLength !== identity.byteLength || digest(bytes) !== identity.revision) throw new Error('The original upload bytes are incomplete or changed. Keep the original operation; no file was overwritten.')
      return parseFileUploadResult({ ...identity, status: 'uploaded', path: original.path }, identity)
    } catch (error) { return failure(identity, error) }
  }
  async upload(input: FileUploadParams): Promise<FileUploadResult> {
    const params = parseFileUploadParams(input), identity = identityOf(params)
    const previous = this.tails.get(identity.operationId) ?? Promise.resolve()
    const work = previous.catch(() => {}).then(async (): Promise<FileUploadResult> => {
      const bytes = Buffer.from(params.dataBase64, 'base64')
      if (bytes.byteLength !== identity.byteLength || bytes.toString('base64') !== params.dataBase64 || digest(bytes) !== identity.revision) {
        return { ...identity, status: 'error', code: 'FILE_UPLOAD_CONTENT_MISMATCH', message: 'The selected bytes do not match their original file revision. Nothing was written.' }
      }
      try {
        await mkdir(this.directory, { recursive: true, mode: 0o700 })
        const root = await lstat(this.directory)
        if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('The Host upload directory is not an original private directory.')
        const directory = this.address(identity)
        try { await mkdir(directory, { mode: 0o700 }) }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return await this.inspect(identity); throw error }
        const rootHandle = await open(this.directory, constants.O_RDONLY)
        try { await rootHandle.sync() } finally { await rootHandle.close() }
        await syncedExclusive(join(directory, 'intent.json'), Buffer.from(JSON.stringify(identity) + '\n'))
        const folder = await open(directory, constants.O_RDONLY)
        try {
          await folder.sync()
          await syncedExclusive(join(directory, 'attachment' + extension(identity)), bytes)
          await folder.sync()
        } finally { await folder.close() }
        return await this.inspect(identity)
      } catch (error) { return failure(identity, error) }
    })
    this.tails.set(identity.operationId, work)
    try { return await work } finally { if (this.tails.get(identity.operationId) === work) this.tails.delete(identity.operationId) }
  }
}
