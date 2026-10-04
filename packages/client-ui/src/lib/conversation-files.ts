import type { AgentSessionHistoryContentPart, AgentSessionHistoryItem } from '@agentmux/core'
import { parseAgentMarkdown, type BlockNode, type InlineNode } from './agent-markdown.js'
import { classifyMarkdownLinkHref, splitMarkdownFileReferences, type MarkdownFileReference } from './markdown-file-reference.js'

export type ConversationFile = { reference: MarkdownFileReference; name: string; kind: 'image' | 'document' | 'file' }

/** Only the Provider's recorded final/completed reply qualifies; missing phase stays unknown. */
export function completedNativeReply(item: AgentSessionHistoryItem): boolean {
  return item.kind === 'assistant-message' && item.messagePhase !== 'progress' &&
    (item.messagePhase === 'final' || item.completedAt !== undefined)
}

/** An index of explicit references in this reply, not a claim that the Agent created a file.
 * No filesystem IO: the original host confirms existence and opens the exact destination. */
export function conversationFiles(parts: readonly AgentSessionHistoryContentPart[], workspaceRoot: string, homeDir = ''): ConversationFile[] {
  const files: ConversationFile[] = []
  const seen = new Set<string>()
  function add(reference: MarkdownFileReference | null): void {
    if (!reference) return
    const key = JSON.stringify([reference.path, reference.line ?? null, reference.column ?? null])
    if (seen.has(key)) return
    seen.add(key)
    const name = reference.path.split('/').at(-1) ?? reference.path
    const extension = name.split('.').at(-1)?.toLowerCase()
    files.push({ reference, name, kind: /^(png|jpe?g|gif|webp|svg|avif)$/u.test(extension ?? '') ? 'image'
      : /^(pdf|md|txt|docx?|csv|xlsx?|pptx?)$/u.test(extension ?? '') ? 'document' : 'file' })
  }
  function inline(nodes: readonly InlineNode[]): void {
    for (const node of nodes) {
      if (node.kind === 'link' || node.kind === 'image') add(classifyMarkdownLinkHref(node.href, workspaceRoot, homeDir))
      // Inline code declares a literal path; ordinary prose, quoted examples and code blocks do not.
      else if (node.kind === 'code') for (const segment of splitMarkdownFileReferences(node.text, workspaceRoot, homeDir)) {
        if (segment.kind === 'file') add(segment.reference)
      }
      else if (node.kind === 'strong' || node.kind === 'emphasis') inline(node.children)
    }
  }
  function blocks(nodes: readonly BlockNode[]): void {
    for (const node of nodes) {
      if (node.kind === 'paragraph' || node.kind === 'heading') inline(node.children)
      else if (node.kind === 'list') for (const item of node.items) blocks(item)
      else if (node.kind === 'table') {
        for (const cell of node.header) inline(cell)
        for (const row of node.rows) for (const cell of row) inline(cell)
      }
    }
  }
  for (const part of parts) {
    if (part.kind === 'text') blocks(parseAgentMarkdown(part.text))
    else if (part.kind === 'resource' && (part.resourceType === 'file' || part.resourceType === 'image')) {
      add(classifyMarkdownLinkHref(part.reference, workspaceRoot, homeDir))
    }
  }
  return files
}
