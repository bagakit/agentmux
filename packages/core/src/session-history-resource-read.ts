import { constants } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { decodeBase64, encodeBase64 } from './hosted-value.js'
import { imageBytes, unavailable } from './session-history-resource.js'
import type { AgentSessionHistoryResourceReadResult } from './types.js'

/** Only the newly located true part supplies reference. No arbitrary caller path reaches this read. */
export async function readRecordedImage(reference: string, maxBytes: number, signal: AbortSignal): Promise<AgentSessionHistoryResourceReadResult['result']> {
  signal.throwIfAborted()
  if (reference.startsWith('data:')) {
    // Bound encoded length before allocation; accept canonical raster base64 only.
    const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]*={0,2})$/u.exec(reference)
    if (!match) return unavailable('AGENT_SESSION_HISTORY_RESOURCE_FORMAT_UNSUPPORTED', 'This recorded inline image is not canonical raster base64. Its reference is kept.')
    const encoded = match[2]!
    if (encoded.length > Math.ceil(maxBytes / 3) * 4) return unavailable('AGENT_SESSION_HISTORY_RESOURCE_TOO_LARGE', 'The recorded inline image exceeds this read’s byte budget. Its reference is kept.')
    let bytes: Uint8Array
    try { bytes = decodeBase64(encoded) }
    catch { return unavailable('AGENT_SESSION_HISTORY_RESOURCE_FORMAT_UNSUPPORTED', 'This recorded inline image has invalid base64. Its reference is kept.') }
    if (encodeBase64(bytes) !== encoded) return unavailable('AGENT_SESSION_HISTORY_RESOURCE_FORMAT_UNSUPPORTED', 'This recorded inline image has invalid base64. Its reference is kept.')
    return imageBytes(bytes, maxBytes, match[1])
  }
  if (!isAbsolute(reference)) return unavailable('AGENT_SESSION_HISTORY_RESOURCE_REFERENCE_UNSUPPORTED', 'This opaque or remote image reference has no local byte source. No network request was made; its reference is kept.')
  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    // Nonblocking open lets us reject FIFO/device targets before reading; /var symlinks remain valid.
    file = await open(reference, constants.O_RDONLY | constants.O_NONBLOCK)
    const before = await file.stat({ bigint: true })
    if (!before.isFile()) return unavailable('AGENT_SESSION_HISTORY_RESOURCE_NOT_FILE', 'The recorded image path is not a regular file. Its reference is kept.')
    if (before.size < 1n || before.size > BigInt(maxBytes)) return unavailable('AGENT_SESSION_HISTORY_RESOURCE_TOO_LARGE', 'The recorded image is empty or exceeds this read’s byte budget. Its reference is kept.')
    const bytes = new Uint8Array(Number(before.size))
    let offset = 0
    while (offset < bytes.length) {
      signal.throwIfAborted()
      const read = await file.read(bytes, offset, bytes.length - offset, offset)
      if (!read.bytesRead) break
      offset += read.bytesRead
    }
    signal.throwIfAborted()
    const after = await file.stat({ bigint: true }), named = await stat(reference, { bigint: true })
    if (offset !== bytes.length || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => before[key as keyof typeof before] !== after[key as keyof typeof after]) ||
      named.dev !== after.dev || named.ino !== after.ino)
      return unavailable('AGENT_SESSION_HISTORY_RESOURCE_CHANGED', 'The exact recorded file changed during reading. Retry this resource; its reference is kept.')
    return imageBytes(bytes, maxBytes)
  } catch (error) {
    signal.throwIfAborted()
    return unavailable('AGENT_SESSION_HISTORY_RESOURCE_UNAVAILABLE', error instanceof Error ? error.message : String(error))
  } finally { await file?.close() }
}
