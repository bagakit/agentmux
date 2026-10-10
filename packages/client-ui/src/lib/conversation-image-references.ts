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

/** A Markdown image may use the same app-pasted reader only for one complete narrow reference. */
export function pastedMarkdownImageReference(href: string, label?: string): ConversationImageReference | undefined {
  const parts = splitPastedImageReferences(href)
  const image = parts.length === 1 && parts[0]?.kind === 'image' && parts[0].path === href ? parts[0] : undefined
  return image ? { path: image.path, text: href, ...(label ? { label } : {}) } : undefined
}

/** Follow the same rendered text branches as AgentMarkdown; handled link labels, fenced code and math stay inert. */
export function markdownImageReferences(content: string, blocks: readonly BlockNode[] | undefined, objectLinks: boolean, plainLink: (node: Extract<InlineNode, { kind: 'link' }>) => boolean, options: { readOnlyImages?: boolean } = {}): ConversationImageReference[] {
  const references: ConversationImageReference[] = []
  const text = (value: string, objects: boolean) => {
    const segments = objects ? splitObjectLinkReferences(value).filter(segment => segment.kind === 'text').map(segment => segment.text) : [value]
    for (const segment of segments) for (const part of splitPastedImageReferences(segment)) if (part.kind === 'image') references.push(part)
  }
  const inline = (nodes: readonly InlineNode[], inLink = false) => {
    for (const node of nodes) {
      if ((node.kind === 'text' || node.kind === 'code') && !inLink) text(node.text, node.kind === 'text' && objectLinks)
      else if (node.kind === 'image' && options.readOnlyImages) {
        const reference = pastedMarkdownImageReference(node.href, node.alt)
        if (reference) references.push(reference)
      }
      else if (node.kind === 'link' && (options.readOnlyImages || plainLink(node))) inline(node.children, Boolean(options.readOnlyImages))
      else if (node.kind === 'strong' || node.kind === 'emphasis' || node.kind === 'strike') inline(node.children, inLink)
    }
  }
  const visit = (nodes: readonly BlockNode[]) => {
    for (const node of nodes) {
      if (node.kind === 'heading' || node.kind === 'paragraph') inline(node.children)
      else if (node.kind === 'list') node.items.forEach(visit)
      else if (node.kind === 'quote') visit(node.children)
      else if (node.kind === 'table') [...node.header, ...node.rows.flat()].forEach(nodes => inline(nodes))
      else if (node.kind === 'footnotes') node.items.forEach(note => visit(note.children))
    }
  }
  if (blocks) visit(blocks)
  else text(content, objectLinks)
  return uniqueImageReferences(references)
}
