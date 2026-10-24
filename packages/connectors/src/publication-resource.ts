import { createHash } from 'node:crypto'
import type { AgentSessionHistoryContentPart, AgentSessionHistoryResourceReadResult } from '@agentmux/core'
import type { PublicationOperation } from './publication-store.js'
import type { PublicationEffectContext, PreparedPublicationResource } from './publication-wire.js'
import { AgentMuxError } from '@agentmux/core'

/** Exact bytes accepted from the original resource owner, retained by the existing representation. */
export type PublicationImage = Omit<Extract<AgentSessionHistoryResourceReadResult['result'], { status: 'read' }>, 'status'> & {
  sha256: string; alt?: string
  derivation?: { kind: 'mermaid'; textSha256: string; start: number; end: number }
}
export type PublicationFile = Omit<Extract<AgentSessionHistoryResourceReadResult['result'], { status: 'file' }>, 'status'> & { sha256: string; displayName: string }
export type PublicationMarkdown = { kind: 'markdown'; text: string; segments: Array<{ text: string; image?: PublicationImage }>; complete: boolean }
export type ResolvedPublicationPart = AgentSessionHistoryContentPart | PublicationMarkdown | { kind: 'image'; image: PublicationImage } | { kind: 'file'; file: PublicationFile } | { kind: 'image-unavailable' | 'file-unavailable' }
export type ImageUploadReceipt = { state: 'confirmed'; imageKey: string } | { state: 'unknown' }
export type FileUploadReceipt = { state: 'confirmed'; fileKey: string } | { state: 'unknown' }
export type ResourceUploadReceipt = ImageUploadReceipt | FileUploadReceipt
/** Only the already frozen public interaction body, never transport metadata or authority. */
export function publicationInteractionText(operation: Readonly<PublicationOperation>): string {
  const payload = operation.payload
  if (payload.kind === 'question') return [payload.text, ...(payload.answers ?? []).map(answer => answer.answer)].filter(Boolean).join('\n\n')
  if (payload.kind === 'permission' && payload.disclosure === 'shared') return [payload.title, payload.context, ...payload.options.map(option => option.label)].filter(Boolean).join('\n\n')
  throw new AgentMuxError('This original operation has no shared interaction body.', 'PUBLICATION_RESOURCE_UNCONFIRMED')
}
export function publicationResourceDescriptor(operation: Readonly<PublicationOperation>, source?: 'public-interaction-text'): PreparedPublicationResource {
  if (source) {
    const bytes = Buffer.from(publicationInteractionText(operation), 'utf8')
    return { resourceId: operation.operationId, source, sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length, name: 'Original request.txt', contentType: 'text/plain; charset=utf-8' }
  }
  const payload = operation.payload
  if (payload.kind !== 'image' && payload.kind !== 'file') throw new AgentMuxError('This original operation has no resource.', 'PUBLICATION_RESOURCE_UNCONFIRMED')
  const resource = payload.kind === 'image' ? payload.image : payload.file
  return { resourceId: operation.operationId, sha256: resource.sha256, byteLength: resource.byteLength,
    name: payload.kind === 'file' ? payload.file.displayName : 'image.' + resource.mimeType.split('/')[1], contentType: resource.mimeType }
}
/** Resolves only the already claimed operation. No global resource lookup or mutable source reread. */
export function publicationEffectContext(operation: Readonly<PublicationOperation>): PublicationEffectContext {
  return { readResource(descriptor) {
    const expected = publicationResourceDescriptor(operation, descriptor.source), payload = operation.payload
    if (Object.keys(expected).length !== Object.keys(descriptor).length || Object.keys(expected).some(key => expected[key as keyof typeof expected] !== descriptor[key as keyof typeof expected]))
      throw new AgentMuxError('The multipart resource does not identify this original operation.', 'PUBLICATION_RESOURCE_UNCONFIRMED')
    const bytes = descriptor.source === 'public-interaction-text' ? Buffer.from(publicationInteractionText(operation), 'utf8')
      : payload.kind === 'image' ? Buffer.from(payload.image.dataBase64, 'base64') : payload.kind === 'file' ? Buffer.from(payload.file.dataBase64, 'base64')
      : (() => { throw new AgentMuxError('This original operation has no resource.', 'PUBLICATION_RESOURCE_UNCONFIRMED') })()
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
