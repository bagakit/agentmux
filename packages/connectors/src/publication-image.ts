import { createHash } from 'node:crypto'
import type { AgentSessionHistoryContentPart, AgentSessionHistoryResourceReadResult } from '@agentmux/core'

/** Exact bytes accepted from the original resource owner, retained by the existing representation. */
export type PublicationImage = Omit<Extract<AgentSessionHistoryResourceReadResult['result'], { status: 'read' }>, 'status'> & { sha256: string }
export type ResolvedPublicationPart = AgentSessionHistoryContentPart | { kind: 'image'; image: PublicationImage } | { kind: 'image-unavailable' }
export type ImageUploadReceipt = { state: 'confirmed'; imageKey: string } | { state: 'unknown' }
export function publicationImage(result: Extract<AgentSessionHistoryResourceReadResult['result'], { status: 'read' }>): PublicationImage {
  const { status: _status, ...image } = result
  return { ...image, sha256: createHash('sha256').update(Buffer.from(image.dataBase64, 'base64')).digest('hex') }
}
