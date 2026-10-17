import { constants } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { PASTED_IMAGE_EXTENSIONS, PASTED_IMAGE_MAX_BYTES } from '@agentmux/client-ui/pasted-images'
import { pastedDirectory } from './pasted-directory.js'

const extensions = new Set<string>(PASTED_IMAGE_EXTENSIONS)
export type PastedImageWriteReceipt = { path: string; sha256: string; byteLength: number; diskDurability: 'confirmed' }

/** Verify the original object, including on retry. A hash-shaped filename is not a receipt. */
async function confirm(path: string, bytes: Buffer): Promise<void> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat()
    if (!before.isFile() || before.size !== bytes.length) throw new Error('The retained pasted image differs from the original bytes.')
    const actual = Buffer.alloc(bytes.length + 1)
    let offset = 0
    while (offset < actual.length) {
      const read = await file.read(actual, offset, actual.length - offset, offset)
      if (!read.bytesRead) break
      offset += read.bytesRead
    }
    const after = await file.stat()
    if (offset !== bytes.length || !actual.subarray(0, offset).equals(bytes) ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error('The retained pasted image differs from the original bytes.')
    }
    await file.sync()
    const named = await lstat(path)
    if (!named.isFile() || named.dev !== after.dev || named.ino !== after.ino) throw new Error('The retained pasted image changed during confirmation.')
  } finally { await file.close() }
}

async function syncDirectory(path: string): Promise<void> {
  const file = await open(path, 'r')
  try { await file.sync() } finally { await file.close() }
}

/** The original pasted owner stores bytes, not decoded pixels or Browser provenance.
 * Identical bytes/extension ensure the same immutable resource, including after a lost reply.
 * No successful receipt is returned before both its bytes and directory entries are synced. */
export async function savePastedImage(home: string, input: { bytes: Uint8Array; extension: string }): Promise<PastedImageWriteReceipt> {
  const bytes = Buffer.from(input.bytes)
  if (bytes.byteLength === 0) throw new Error('Pasted image is empty.')
  if (bytes.byteLength > PASTED_IMAGE_MAX_BYTES) throw new Error('Pasted image exceeds the size limit.')
  const extension = extensions.has(input.extension) ? input.extension : 'png'
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const directory = pastedDirectory(home), path = join(directory, `${sha256}.${extension}`)
  const temporary = join(directory, `.${sha256}.${randomUUID()}.partial`)
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const file = await open(temporary, 'wx', 0o600)
    try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
    try { await link(temporary, path) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    await confirm(path, bytes)
    await syncDirectory(directory)
    // Also persist newly created pasted/.agentmux directory entries. A later same-byte retry
    // performs these syncs too; it does not infer a prior successful receipt from existence.
    await syncDirectory(dirname(directory))
    await syncDirectory(home)
    return { path, sha256, byteLength: bytes.length, diskDurability: 'confirmed' }
  } catch (cause) {
    throw new Error(`Pasted image save is unconfirmed: ${cause instanceof Error ? cause.message : String(cause)} Keep the original image and draft; retry the same image to confirm its original file.`, { cause })
  } finally {
    // Never remove the shared content object, even when publication or its reply is unknown.
    await unlink(temporary).catch(() => {})
  }
}
