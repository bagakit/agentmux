import { open, link, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AGENTMUX_CONTROL_MAX_MESSAGE_BYTES } from './control.js'
import { AgentMuxError } from './errors.js'
import { settingsResourceRecord } from './settings-resource-json.js'

/** Write only the original owner's opaque document. No client schema or filesystem path crosses the service. */
export async function writeCliResourceDocument(path: string, result: unknown): Promise<{ path: string }> {
  const source = settingsResourceRecord(result, 'CONTROL_PROTOCOL_ERROR')
  const item = settingsResourceRecord(source.item, 'CONTROL_PROTOCOL_ERROR')
  const document = settingsResourceRecord(item.document, 'CONTROL_PROTOCOL_ERROR')
  if (typeof item.id !== 'string' || document.id !== item.id) throw new AgentMuxError('Resource document belongs to another identity. No file was written.', 'CONTROL_PROTOCOL_ERROR')
  const text = JSON.stringify(document, null, 2) + '\n'
  if (new TextEncoder().encode(text).byteLength > AGENTMUX_CONTROL_MAX_MESSAGE_BYTES) throw new AgentMuxError('Resource document output exceeds its byte boundary. No file was written.', 'CONTROL_PROTOCOL_ERROR')
  const destination = resolve(path), temporary = join(dirname(destination), `.amux-document-${randomUUID()}.tmp`)
  let created = false
  try {
    const file = await open(temporary, 'wx', 0o600)
    created = true
    try { await file.writeFile(text, 'utf8'); await file.sync() } finally { await file.close() }
    // Linking a complete synced temporary file atomically creates the exact new target, without replacing an existing file or symlink.
    await link(temporary, destination)
    return { path: destination }
  } finally { if (created) await unlink(temporary).catch(() => {}) }
}
