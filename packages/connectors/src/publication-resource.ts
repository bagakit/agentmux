import { createHash } from 'node:crypto'
import type { AgentSessionHistoryContentPart, AgentSessionHistoryResourceReadResult } from '@agentmux/core'
import type { PublicationOperation } from './publication-store.js'
import type { PublicationEffectContext, PreparedPublicationResource } from './publication-wire.js'
import { AgentMuxError } from '@agentmux/core'

/** Exact bytes accepted from the original resource owner, retained by the existing representation. */
export type PublicationImage = Omit<Extract<AgentSessionHistoryResourceReadResult['result'], { status: 'read' }>, 'status'> & { sha256: string }
export type PublicationFile = Omit<Extract<AgentSessionHistoryResourceReadResult['result'], { status: 'file' }>, 'status'> & { sha256: string; displayName: string }
export type ResolvedPublicationPart = AgentSessionHistoryContentPart | { kind: 'image'; image: PublicationImage } | { kind: 'file'; file: PublicationFile } | { kind: 'image-unavailable' | 'file-unavailable' }
export type ImageUploadReceipt = { state: 'confirmed'; imageKey: string } | { state: 'unknown' }
export type FileUploadReceipt = { state: 'confirmed'; fileKey: string } | { state: 'unknown' }
export type ResourceUploadReceipt = ImageUploadReceipt | FileUploadReceipt
export function publicationResourceDescriptor(operation: Readonly<PublicationOperation>): PreparedPublicationResource {
  const payload = operation.payload
  if (payload.kind !== 'image' && payload.kind !== 'file') throw new AgentMuxError('This original operation has no resource.', 'PUBLICATION_RESOURCE_UNCONFIRMED')
  const resource = payload.kind === 'image' ? payload.image : payload.file
  return { resourceId: operation.operationId, sha256: resource.sha256, byteLength: resource.byteLength,
    name: payload.kind === 'file' ? payload.file.displayName : 'image.' + resource.mimeType.split('/')[1], contentType: resource.mimeType }
}
/** Resolves only the already claimed operation. No global resource lookup or mutable source reread. */
export function publicationEffectContext(operation: Readonly<PublicationOperation>): PublicationEffectContext {
  return { readResource(descriptor) {
    const expected = publicationResourceDescriptor(operation), payload = operation.payload
    if (Object.keys(expected).some(key => expected[key as keyof typeof expected] !== descriptor[key as keyof typeof expected]) || payload.kind !== 'image' && payload.kind !== 'file')
      throw new AgentMuxError('The multipart resource does not identify this original operation.', 'PUBLICATION_RESOURCE_UNCONFIRMED')
    const bytes = Buffer.from(payload.kind === 'image' ? payload.image.dataBase64 : payload.file.dataBase64, 'base64')
    if (bytes.length !== expected.byteLength || createHash('sha256').update(bytes).digest('hex') !== expected.sha256)
      throw new AgentMuxError('The original resource bytes are unconfirmed. Its operation is retained.', 'PUBLICATION_RESOURCE_UNCONFIRMED')
    return bytes
  } }
}
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
