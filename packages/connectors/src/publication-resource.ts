import { createHash } from 'node:crypto'
import type { AgentSessionHistoryContentPart, AgentSessionHistoryResourceReadResult } from '@agentmux/core'

/** Exact bytes accepted from the original resource owner, retained by the existing representation. */
export type PublicationImage = Omit<Extract<AgentSessionHistoryResourceReadResult['result'], { status: 'read' }>, 'status'> & { sha256: string }
export type PublicationFile = Omit<Extract<AgentSessionHistoryResourceReadResult['result'], { status: 'file' }>, 'status'> & { sha256: string; displayName: string }
export type ResolvedPublicationPart = AgentSessionHistoryContentPart | { kind: 'image'; image: PublicationImage } | { kind: 'file'; file: PublicationFile } | { kind: 'image-unavailable' | 'file-unavailable' }
export type ImageUploadReceipt = { state: 'confirmed'; imageKey: string } | { state: 'unknown' }
export type FileUploadReceipt = { state: 'confirmed'; fileKey: string } | { state: 'unknown' }
export type ResourceUploadReceipt = ImageUploadReceipt | FileUploadReceipt
export function publicationImage(result: Extract<AgentSessionHistoryResourceReadResult['result'], { status: 'read' }>): PublicationImage {
  const { status: _status, ...image } = result
  return { ...image, sha256: createHash('sha256').update(Buffer.from(image.dataBase64, 'base64')).digest('hex') }
}

/** A transfer name does not invent the missing original name or a verified format. */
export function publicationFile(result: Extract<AgentSessionHistoryResourceReadResult['result'], { status: 'file' }>): PublicationFile {
  const { status: _status, ...file } = result
  return { ...file, displayName: file.label?.trim() ? file.label : 'Attachment (original name unavailable).bin',
    sha256: createHash('sha256').update(Buffer.from(file.dataBase64, 'base64')).digest('hex') }
}
