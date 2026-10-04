import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkMath from 'remark-math'
import { unified } from 'unified'
import type { Definition, FootnoteDefinition, Root, RootContent, PhrasingContent } from 'mdast'

/** remark owns the grammar. This projection retains semantics as data, never executable HTML. */
export type InlineNode =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'math'; text: string; source: string }
  | { kind: 'break' }
  | { kind: 'strong'; children: InlineNode[] }
  | { kind: 'emphasis'; children: InlineNode[] }
  | { kind: 'strike'; children: InlineNode[] }
  | { kind: 'link'; href: string; children: InlineNode[] }
  | { kind: 'image'; href: string; alt: string }
  | { kind: 'footnote-reference'; identifier: string; number: number; occurrence: number }

export type TableAlign = 'left' | 'center' | 'right' | null
export type MarkdownFootnote = { identifier: string; number: number; references: number; children: BlockNode[] }

export type BlockNode =
  | { kind: 'heading'; level: number; anchor: string; sourceMarker?: string; children: InlineNode[] }
  | { kind: 'paragraph'; children: InlineNode[] }
  | { kind: 'code'; language: string | null; text: string }
  | { kind: 'math'; text: string; source: string }
  | { kind: 'list'; ordered: boolean; start?: number; checked?: (boolean | null)[]; items: BlockNode[][] }
  | { kind: 'quote'; children: BlockNode[] }
  | { kind: 'rule' }
  | { kind: 'table'; align: TableAlign[]; header: InlineNode[][]; rows: InlineNode[][][] }
  | { kind: 'footnotes'; items: MarkdownFootnote[] }

export type MarkdownHeading = Extract<BlockNode, { kind: 'heading' }>
export type MarkdownDocument = { blocks: BlockNode[]; headings: MarkdownHeading[] }

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkMath)
type ParseContext = {
  source: string
  definitions: Map<string, Definition>
  footnotes: Map<string, FootnoteDefinition>
  references: Map<string, { number: number; count: number }>
  anchors: Set<string>
  headings: MarkdownHeading[] | null
}

/** Definitions can occur in a quote or list; CommonMark uses the first definition. */
function collectDefinitions(node: Root | RootContent, context: ParseContext): void {
  if (node.type === 'definition' && !context.definitions.has(node.identifier)) context.definitions.set(node.identifier, node)
  if (node.type === 'footnoteDefinition' && !context.footnotes.has(node.identifier)) context.footnotes.set(node.identifier, node)
  if ('children' in node) for (const child of node.children) collectDefinitions(child as RootContent, context)
}

function originalText(node: PhrasingContent, context: ParseContext): Extract<InlineNode, { kind: 'text' }> {
  const start = node.position?.start.offset, end = node.position?.end.offset
  return { kind: 'text', text: start !== undefined && end !== undefined ? context.source.slice(start, end) : '' }
}

function inlineFrom(nodes: readonly PhrasingContent[], context: ParseContext): InlineNode[] {
  const out: InlineNode[] = []
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
      case 'html':
        out.push({ kind: 'text', text: node.value })
        break
      case 'inlineCode':
        out.push({ kind: 'code', text: node.value })
        break
      case 'inlineMath':
        out.push({ kind: 'math', text: node.value, source: originalText(node, context).text })
        break
      case 'strong':
        out.push({ kind: 'strong', children: inlineFrom(node.children, context) })
        break
      case 'emphasis':
        out.push({ kind: 'emphasis', children: inlineFrom(node.children, context) })
        break
      case 'delete':
        out.push({ kind: 'strike', children: inlineFrom(node.children, context) })
        break
      case 'link':
        out.push({ kind: 'link', href: node.url, children: inlineFrom(node.children, context) })
        break
      case 'linkReference': {
        const definition = context.definitions.get(node.identifier)
        out.push(definition ? { kind: 'link', href: definition.url, children: inlineFrom(node.children, context) } : originalText(node, context))
        break
      }
      case 'break':
        out.push({ kind: 'break' })
        break
      case 'image':
        out.push({ kind: 'image', href: node.url, alt: node.alt ?? '' })
        break
      case 'imageReference': {
        const definition = context.definitions.get(node.identifier)
        out.push(definition ? { kind: 'image', href: definition.url, alt: node.alt ?? '' } : originalText(node, context))
        break
      }
      case 'footnoteReference': {
        if (!context.footnotes.has(node.identifier)) { out.push(originalText(node, context)); break }
        const reference = context.references.get(node.identifier) ?? { number: context.references.size + 1, count: 0 }
        reference.count++
        context.references.set(node.identifier, reference)
        out.push({ kind: 'footnote-reference', identifier: node.identifier, number: reference.number, occurrence: reference.count })
        break
      }
    }
  }
  return out
}

function inlineText(nodes: readonly InlineNode[]): string {
  return nodes.map(node => 'text' in node ? node.text : 'children' in node ? inlineText(node.children) : node.kind === 'image' ? node.alt : '').join('')
}

function headingAnchor(children: readonly InlineNode[], context: ParseContext): string {
  const base = inlineText(children).toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s+/gu, '-') || 'section'
  let anchor = base, suffix = 0
  while (context.anchors.has(anchor)) anchor = `${base}-${++suffix}`
  context.anchors.add(anchor)
  return anchor
}

function blocksFrom(nodes: readonly RootContent[], context: ParseContext): BlockNode[] {
  const out: BlockNode[] = []
  for (const node of nodes) {
    switch (node.type) {
      case 'heading': {
        const children = inlineFrom(node.children, context)
        const original = context.source.slice(node.position?.start.offset, node.position?.end.offset)
        const sourceMarker = /^(#{1,6})(?:[\t ]|$)/u.exec(original)?.[1]
        const heading: MarkdownHeading = { kind: 'heading', level: node.depth, anchor: headingAnchor(children, context),
          ...(sourceMarker ? { sourceMarker } : {}), children }
        out.push(heading)
        context.headings?.push(heading)
        break
      }
      case 'paragraph':
        out.push({ kind: 'paragraph', children: inlineFrom(node.children, context) })
        break
      case 'code':
        out.push({ kind: 'code', language: node.lang ?? null, text: node.value })
        break
      case 'math':
        out.push({ kind: 'math', text: node.value, source: context.source.slice(node.position?.start.offset, node.position?.end.offset) })
        break
      case 'list': {
        const checked = node.children.map(item => item.checked ?? null)
        out.push({ kind: 'list', ordered: node.ordered === true,
          ...(node.ordered && node.start !== null && node.start !== undefined ? { start: node.start } : {}),
          ...(checked.some(value => value !== null) ? { checked } : {}),
          items: node.children.map(item => blocksFrom(item.children, context)) })
        break
      }
      case 'blockquote':
        out.push({ kind: 'quote', children: blocksFrom(node.children, context) })
        break
      case 'thematicBreak':
        out.push({ kind: 'rule' })
        break
      case 'table': {
        const [header, ...rows] = node.children
        out.push({ kind: 'table', align: (node.align ?? []).map(value => value ?? null),
          header: (header?.children ?? []).map(cell => inlineFrom(cell.children, context)),
          rows: rows.map(row => row.children.map(cell => inlineFrom(cell.children, context))) })
        break
      }
      case 'html':
        out.push({ kind: 'paragraph', children: [{ kind: 'text', text: node.value }] })
        break
      case 'definition':
      case 'footnoteDefinition':
        break
    }
  }
  return out
}

/** Malformed source stays readable; parsing never repairs content or creates HTML. */
function parseMarkdown(source: string, collectHeadings: boolean): MarkdownDocument {
  const headings: MarkdownHeading[] = []
  try {
    const tree = processor.parse(source) as Root
    const context: ParseContext = { source, definitions: new Map(), footnotes: new Map(), references: new Map(), anchors: new Set(), headings: collectHeadings ? headings : null }
    collectDefinitions(tree, context)
    const blocks = blocksFrom(tree.children, context), notes: MarkdownFootnote[] = []
    // Map iteration includes references introduced by a footnote; each definition is projected once.
    for (const [identifier, reference] of context.references) {
      notes.push({ identifier, number: reference.number, references: 0, children: blocksFrom(context.footnotes.get(identifier)!.children, context) })
    }
    for (const note of notes) note.references = context.references.get(note.identifier)!.count
    if (notes.length) blocks.push({ kind: 'footnotes', items: notes })
    return { blocks, headings }
  } catch {
    return { blocks: source.trim() === '' ? [] : [{ kind: 'paragraph', children: [{ kind: 'text', text: source }] }], headings: [] }
  }
}

export function parseAgentMarkdown(source: string): BlockNode[] {
  return parseMarkdown(source, false).blocks
}

/** File outlines retain the original heading nodes during the same grammar projection. */
export function parseAgentMarkdownDocument(source: string): MarkdownDocument {
  return parseMarkdown(source, true)
}

/** Only an open outline needs a plain label; anchors remain owned by the original parse. */
export function markdownHeadingText(heading: MarkdownHeading): string {
  return inlineText(heading.children)
}

/** Conversation prose retains literal text unless it contains Markdown signals; files always parse. */
export function looksLikeMarkdown(source: string): boolean {
  return (
    source.includes('$') || /^(#{1,6}\s|\s*[-*+]\s|\s*\d+[.)]\s|```|~~~|>\s|\||---|\*\*\*|\s*\[[^\]]+\]:)/mu.test(source) ||
    /`|\*\*|__|~~|\[[^\]]*\]\(|\[[^\]]*\]\[[^\]]*\]|\[\^[^\]]+\]|(?:^|\s)[*_][^\s*_][^\n]*?[*_](?=\s|[.,!?;:]|$)|\n\s*=+\s*(?:\n|$)| {2,}\n/u.test(source)
  )
}
