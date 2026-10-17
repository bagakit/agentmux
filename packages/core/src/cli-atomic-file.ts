import { open, link, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

export type CliByteWriter = (chunk: Uint8Array) => Promise<void>
/** The producer must await each write and finish its validation before resolving. */
export type CliFileProducer = (write: CliByteWriter) => Promise<void>

/** Publish complete local bytes once; this path never crosses the RPC boundary. */
export async function writeNewCliFile(path: string, content: string | CliFileProducer): Promise<{ path: string; bytes: number }> {
  const destination = resolve(path), temporary = join(dirname(destination), `.amux-capture-${randomUUID()}.tmp`)
  let created = false, bytes = 0
  try {
    const file = await open(temporary, 'wx', 0o600)
    created = true
    try {
      if (typeof content === 'string') { await file.writeFile(content, 'utf8'); bytes = Buffer.byteLength(content) }
      else await content(async chunk => {
        for (let offset = 0; offset < chunk.byteLength;) {
          const written = await file.write(chunk, offset, chunk.byteLength - offset, null)
          if (written.bytesWritten === 0) throw new Error('Local diagnostic output made no write progress.')
          offset += written.bytesWritten; bytes += written.bytesWritten
        }
      })
      await file.sync()
    } finally { await file.close() }
    await link(temporary, destination)
    return { path: destination, bytes }
  } finally { if (created) await unlink(temporary).catch(() => {}) }
}
