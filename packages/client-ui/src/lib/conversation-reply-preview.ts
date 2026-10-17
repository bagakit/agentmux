import { parseAgentMarkdown, type BlockNode, type InlineNode } from './agent-markdown.js'

function inline(nodes: readonly InlineNode[]): string {
  return nodes.map(node => 'children' in node ? inline(node.children) : 'text' in node ? node.text
    : node.kind === 'image' ? node.alt : node.kind === 'break' ? ' ' : '').join('')
}

function text(block: BlockNode): string {
  switch (block.kind) {
    case 'heading': case 'paragraph': return inline(block.children)
    case 'code': case 'math': return block.text
    case 'quote': return first(block.children)
    case 'list': return first(block.items[0] ?? [])
    case 'table': return block.header.map(inline).join(' · ')
    case 'footnotes': case 'rule': return ''
  }
}

function first(blocks: readonly BlockNode[]): string {
  for (const block of blocks) { const value = text(block).trim(); if (value) return value }
  return ''
}

/** Disposable reading summary, never a message body or association key. Parse only a small prefix. */
export function conversationReplyPreview(source: string): string {
  return first(parseAgentMarkdown(source.slice(0, 2048))).replace(/\s+/gu, ' ').trim()
}
