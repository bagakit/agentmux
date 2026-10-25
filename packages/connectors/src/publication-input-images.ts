import { inputImageMatches, parseAgentInputResourceResult, type AgentTimelineItem } from '@agentmux/core'
import type { ConversationRef } from '@agentmux/core/conversation'
import { splitPastedImageReferences } from '@agentmux/core/pasted-images'
import { FILE_UPLOAD_MAX_BYTES, fileUploadRevision } from '@agentmux/core/files'
import type { PublicationConversationPort } from './publication-host.js'
import type { PublicationAdapter } from './publication-adapter.js'
import { publicationImage, type PublicationMarkdown } from './publication-resource.js'

const unavailable = '[Image not shared]'
/** Display redaction only: a body string never becomes a filesystem read request. */
function withoutLocalReferences(text: string): string {
  return splitPastedImageReferences(text).map(segment => segment.kind === 'image' ? unavailable : segment.text).join('')
}
/** Original Input membership reuses the same frozen publication segments and resource effects. */
export async function publicationInputImages(item: AgentTimelineItem, reference: ConversationRef,
  read: PublicationConversationPort['inputResource'], images: PublicationAdapter['images'], signal: AbortSignal): Promise<PublicationMarkdown | undefined> {
  const body = item.content
  if (body === undefined) return undefined
  const key = item.inputRef, selected = item.inputImages ?? []
  const parts: PublicationMarkdown['segments'] = []
  let offset = 0, complete = true
  const redact = (value: string) => { const text = withoutLocalReferences(value); if (text !== value) complete = false; return text }
  const bodyRevision = selected.length ? fileUploadRevision(new TextEncoder().encode(body)) : undefined
  for (let index = 0; index < selected.length; index++) {
    const image = selected[index]!
    if (!key || image.start < offset || !inputImageMatches(image, key, body, bodyRevision)) continue
    parts.push({ text: redact(body.slice(offset, image.start)) })
    let resolved = false
    if (images && read) try {
      signal.throwIfAborted()
      const request = { key, index, revision: image.upload.revision, maxBytes: Math.min(images.maxBytes, FILE_UPLOAD_MAX_BYTES) }
      const response = parseAgentInputResourceResult(await read(reference, request, signal), request)
      if (response.status === 'available') {
        const value = publicationImage({ status: 'read', mimeType: response.mimeType, dataBase64: response.dataBase64,
          byteLength: response.byteLength, width: response.width, height: response.height })
        if (images.accepts(value)) { parts.push({ text: '', image: value }); resolved = true }
      }
    } catch { signal.throwIfAborted() /* Original text remains publishable independently. */ }
    if (!resolved) { parts.push({ text: unavailable }); complete = false }
    offset = image.end
  }
  parts.push({ text: redact(body.slice(offset)) })
  const text = parts.map(part => part.text).join('')
  if (!selected.length && text === body) return undefined
  return { kind: 'markdown', text, segments: parts.filter(part => part.text || part.image), complete }
}
