import { open, link, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseRendererV8ProfileResult, rendererV8ProfileJSON } from './renderer-v8-profile.js'

/** The output path is local to this CLI; it never crosses the public service. */
export async function writeRendererV8Profile(path: string, result: unknown): Promise<{ path: string; sha256: string; bytes: number }> {
  const body = rpcRecord(result, ['capture'], 'CONTROL_PROTOCOL_ERROR')
  const capture = parseRendererV8ProfileResult(body.capture)
  if (capture.profile === null) throw new AgentMuxError('This capture returned no profile. It was not rerun and no file was written.', 'CONTROL_UNAVAILABLE')
  const text = rendererV8ProfileJSON(capture.profile)
  const sha256 = createHash('sha256').update(text).digest('hex')
  if (sha256 !== capture.sha256) throw new AgentMuxError('The original profile checksum did not match. No file was written.', 'CONTROL_PROTOCOL_ERROR')
  const destination = resolve(path), temporary = join(dirname(destination), `.amux-profile-${randomUUID()}.tmp`)
  let created = false
  try {
    const file = await open(temporary, 'wx', 0o600)
    created = true
    try { await file.writeFile(text, 'utf8'); await file.sync() } finally { await file.close() }
    // Publish a complete new file atomically; existing files and symlinks stay untouched.
    await link(temporary, destination)
    return { path: destination, sha256, bytes: Buffer.byteLength(text) }
  } finally { if (created) await unlink(temporary).catch(() => {}) }
}
