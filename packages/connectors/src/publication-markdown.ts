import { createHash } from 'node:crypto'
import { parseProviderSessionHistoryResourceReadResult, type AgentSessionHistoryResourceRequest, type AgentSessionHistoryResourceReadResult } from '@agentmux/core'
import { markdownImageReferences } from '@agentmux/core/session-history-content'
import type { PublicationAdapter } from './publication-adapter.js'
import { publicationImage, type PublicationImage, type PublicationMarkdown } from './publication-resource.js'
import { markdownDiagrams } from './markdown-diagrams.js'

/** Resolve presentation from the exact original text. This layer never opens caller paths. */
export async function publicationMarkdown(text: string, original: Omit<AgentSessionHistoryResourceRequest, 'expectedReference'> & { expectedReference?: string },
  read: (request: AgentSessionHistoryResourceRequest) => Promise<AgentSessionHistoryResourceReadResult>,
  images: PublicationAdapter['images'], signal: AbortSignal,
  retainedDiagram?: (textSha256: string, start: number, end: number) => PublicationImage | undefined): Promise<PublicationMarkdown | undefined> {
  const imageNodes = markdownImageReferences(text)
  const nodes = [...imageNodes, ...markdownDiagrams(text)].sort((a, b) => a.start - b.start)
  if (!nodes.length) return
  const segments: PublicationMarkdown['segments'] = [], textSha256 = createHash('sha256').update(text).digest('hex')
  const definitions = [...new Map(imageNodes.flatMap(node => node.definition ? [[node.definition.start, node.definition] as const] : [])).values()].sort((a, b) => a.start - b.start)
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
    if ('source' in node) {
      let reason = 'This channel cannot deliver diagram images.'
      if (images) try {
        const retained = retainedDiagram?.(textSha256, node.start, node.end)
        const image = { ...(retained ?? await (await import('./mermaid-renderer.js')).renderMermaidDiagram(node.source, { signal, maxBytes: images.maxBytes })),
          alt: 'Mermaid diagram. Source is kept in the original conversation.',
          derivation: { kind: 'mermaid' as const, textSha256, start: node.start, end: node.end } }
        if (images.accepts(image)) { segments.push({ text: '', image }); delivered = true }
        else reason = 'The diagram exceeds this channel’s image limits.'
      } catch (error) {
        signal.throwIfAborted()
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
        reason = code === 'MERMAID_BROWSER_UNAVAILABLE' ? 'The Host diagram browser is unavailable.'
          : code === 'MERMAID_RESOURCE_UNAVAILABLE' ? 'The diagram requires a resource the Host renderer cannot load.'
          : code === 'MERMAID_RENDER_UNCONFIRMED' ? 'The Host has not confirmed this render; check the original diagram again.'
          : code === 'MERMAID_IMAGE_UNAVAILABLE' ? 'The diagram exceeds the image delivery limits.' : 'The Host could not render this diagram.'
      }
      if (!delivered) {
        complete = false
        segments.push({ text: 'Diagram image unavailable. ' + reason + '\n\nOriginal source:\n\n' + text.slice(node.start, node.end) })
      }
      offset = node.end
      continue
    }
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
