import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { open, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { decodeBase64, encodeBase64 } from './hosted-value.js'
import { fileBytes, imageBytes, unavailable } from './session-history-resource.js'
import type { AgentSessionHistoryContentPart, AgentSessionHistoryItem, AgentSessionHistoryResourceReadOptions, AgentSessionHistoryResourceReadResult } from './types.js'
import { markdownImageReferences } from './markdown-images.js'
import { AgentMuxError } from './errors.js'

/** Called only after the original owner locates the exact record and part. */
export async function readRecordedMarkdownImage(part: AgentSessionHistoryContentPart | undefined, input: AgentSessionHistoryResourceReadOptions,
  maxBytes: number, signal: AbortSignal, originalKind: AgentSessionHistoryItem['kind'] | undefined, signedText = false): Promise<AgentSessionHistoryResourceReadResult['result']> {
  signal.throwIfAborted()
  // Sharing original text does not grant new file IO to paths supplied by a user or a tool.
  if (originalKind !== 'assistant-message' || part?.contentEligibility !== 'public' || part.contentRole === 'tool' || part.contentRole === 'reasoning')
    throw new AgentMuxError('Only the original public assistant text can supply a Markdown image.', 'AGENT_SESSION_HISTORY_RESOURCE_MISMATCH')
  const selector = input.markdownImage
  if (part?.kind !== 'text' || !selector || createHash('sha256').update(part.text).digest('hex') !== selector.textSha256)
    throw new AgentMuxError('The original Markdown text revision changed.', 'AGENT_SESSION_HISTORY_RESOURCE_MISMATCH')
  const image = markdownImageReferences(part.text)[selector.index]
  if (!image || !signedText && image.url !== input.expectedReference)
    throw new AgentMuxError('The original Markdown image node changed.', 'AGENT_SESSION_HISTORY_RESOURCE_MISMATCH')
  return readRecordedImage(image.url, maxBytes, signal)
}

/** Only a located original file part supplies this self-contained reference; paths and URLs never grant IO. */
export async function readRecordedFile(reference: string, maxBytes: number, signal: AbortSignal, label?: string): Promise<AgentSessionHistoryResourceReadResult['result']> {
  signal.throwIfAborted()
  if (!reference.startsWith('data:')) return unavailable('AGENT_SESSION_HISTORY_RESOURCE_REFERENCE_UNSUPPORTED', 'This file has no self-contained recorded bytes. No path or network was read; its reference is kept.')
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/u.exec(reference)
  if (!match) return unavailable('AGENT_SESSION_HISTORY_RESOURCE_FORMAT_UNSUPPORTED', 'This recorded file is not canonical base64. Its reference is kept.')
  const encoded = match[2]!
  if (encoded.length > Math.ceil(maxBytes / 3) * 4) return unavailable('AGENT_SESSION_HISTORY_RESOURCE_TOO_LARGE', 'The recorded file exceeds this read’s byte budget. Its reference is kept.')
  let bytes: Uint8Array
  try { bytes = decodeBase64(encoded) } catch { return unavailable('AGENT_SESSION_HISTORY_RESOURCE_FORMAT_UNSUPPORTED', 'The recorded file base64 is invalid. Its reference is kept.') }
  signal.throwIfAborted()
  const result = fileBytes(bytes, maxBytes, match[1]!, label)
  if (result.status === 'file' && result.dataBase64 !== encoded) return unavailable('AGENT_SESSION_HISTORY_RESOURCE_FORMAT_UNSUPPORTED', 'The recorded file base64 is not canonical. Its reference is kept.')
  return result
}

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
