import { open, link, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Publish complete local bytes once; this path never crosses the RPC boundary. */
export async function writeNewCliFile(path: string, text: string): Promise<{ path: string; bytes: number }> {
  const destination = resolve(path), temporary = join(dirname(destination), `.amux-capture-${randomUUID()}.tmp`)
  let created = false
  try {
    const file = await open(temporary, 'wx', 0o600)
    created = true
    try { await file.writeFile(text, 'utf8'); await file.sync() } finally { await file.close() }
    await link(temporary, destination)
    return { path: destination, bytes: Buffer.byteLength(text) }
  } finally { if (created) await unlink(temporary).catch(() => {}) }
}
