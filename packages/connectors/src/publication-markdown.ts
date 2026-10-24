import { createHash } from 'node:crypto'
import { parseProviderSessionHistoryResourceReadResult, type AgentSessionHistoryResourceRequest, type AgentSessionHistoryResourceReadResult } from '@agentmux/core'
import { markdownImageReferences } from '@agentmux/core/session-history-content'
import type { PublicationAdapter } from './publication-adapter.js'
import { publicationImage, type PublicationMarkdown } from './publication-resource.js'

/** Resolve presentation from the exact original text. This layer never opens caller paths. */
export async function publicationMarkdown(text: string, original: Omit<AgentSessionHistoryResourceRequest, 'expectedReference'> & { expectedReference?: string },
  read: (request: AgentSessionHistoryResourceRequest) => Promise<AgentSessionHistoryResourceReadResult>,
  images: PublicationAdapter['images'], signal: AbortSignal): Promise<PublicationMarkdown | undefined> {
  const nodes = markdownImageReferences(text)
  if (!nodes.length) return
  const segments: PublicationMarkdown['segments'] = [], textSha256 = createHash('sha256').update(text).digest('hex')
  const definitions = [...new Map(nodes.flatMap(node => node.definition ? [[node.definition.start, node.definition] as const] : [])).values()].sort((a, b) => a.start - b.start)
  let offset = 0, complete = true
  let definitionIndex = 0
  const appendText = (end: number) => {
    while (definitionIndex < definitions.length && definitions[definitionIndex]!.start < end) {
      const definition = definitions[definitionIndex++]!
      if (definition.start > offset) segments.push({ text: text.slice(offset, definition.start) })
      offset = Math.max(offset, definition.end)
    }
    if (end > offset) segments.push({ text: text.slice(offset, end) })
    offset = end
  }
  for (const node of nodes) {
    appendText(node.start)
    let delivered = false
    if (images) try {
      const request = { ...original, expectedReference: original.expectedReference ?? node.url, representation: 'image' as const,
        maxBytes: images.maxBytes, markdownImage: { index: node.index, textSha256 } }
      const { agentSessionId: _session, ...response } = await read(request)
      const result = parseProviderSessionHistoryResourceReadResult(response, request).result
      if (result.status === 'read') {
        const image = { ...publicationImage(result), ...(node.alt ? { alt: node.alt } : {}) }
        if (images.accepts(image)) { segments.push({ text: '', image }); delivered = true }
      }
    } catch { signal.throwIfAborted() /* Preserve this exact gap and independent content. */ }
    if (!delivered) {
      complete = false
      segments.push({ text: `Image unavailable${node.alt ? `: ${node.alt}` : ''}. See the original conversation.` })
    }
    offset = node.end
  }
  appendText(text.length)
  return { kind: 'markdown', text, segments, complete }
}
