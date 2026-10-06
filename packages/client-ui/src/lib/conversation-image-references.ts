import type { BlockNode, InlineNode } from './agent-markdown.js'
import { splitObjectLinkReferences } from './object-link-reference.js'
import { splitPastedImageReferences } from './pasted-image-reference.js'

export type ConversationImageReference = { path: string; text: string; label?: string }

export function uniqueImageReferences(references: readonly ConversationImageReference[]): ConversationImageReference[] {
  const seen = new Set<string>()
  return references.filter(reference => {
    if (seen.has(reference.path)) return false
    seen.add(reference.path)
    return true
  })
}

/** Follow the same rendered text branches as AgentMarkdown; handled link labels, fenced code and math stay inert. */
export function markdownImageReferences(content: string, blocks: readonly BlockNode[] | undefined, objectLinks: boolean, plainLink: (node: Extract<InlineNode, { kind: 'link' }>) => boolean): ConversationImageReference[] {
  const references: ConversationImageReference[] = []
  const text = (value: string, objects: boolean) => {
    const segments = objects ? splitObjectLinkReferences(value).filter(segment => segment.kind === 'text').map(segment => segment.text) : [value]
    for (const segment of segments) for (const part of splitPastedImageReferences(segment)) if (part.kind === 'image') references.push(part)
  }
  const inline = (nodes: readonly InlineNode[]) => {
    for (const node of nodes) {
      if (node.kind === 'text' || node.kind === 'code') text(node.text, node.kind === 'text' && objectLinks)
      else if (node.kind === 'link' && plainLink(node)) inline(node.children)
      else if (node.kind === 'strong' || node.kind === 'emphasis' || node.kind === 'strike') inline(node.children)
    }
  }
  const visit = (nodes: readonly BlockNode[]) => {
    for (const node of nodes) {
      if (node.kind === 'heading' || node.kind === 'paragraph') inline(node.children)
      else if (node.kind === 'list') node.items.forEach(visit)
      else if (node.kind === 'quote') visit(node.children)
      else if (node.kind === 'table') [...node.header, ...node.rows.flat()].forEach(inline)
      else if (node.kind === 'footnotes') node.items.forEach(note => visit(note.children))
    }
  }
  if (blocks) visit(blocks)
  else text(content, objectLinks)
  return uniqueImageReferences(references)
}
