import type { Blockquote, Definition, FootnoteDefinition, Link, Root, RootContent, PhrasingContent } from 'mdast'
import { htmlBlocks, htmlInlines, type HtmlProjection } from './markdown-html.js'
import remarkMath from 'remark-math'
import { markdownSourceGrammar } from './markdown-source.js'

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
  /** HTML images may declare a validated size and App-appearance variants (`<picture>`). */
  | { kind: 'image'; href: string; alt: string; width?: string; height?: string; variants?: { dark?: string; light?: string } }
  | { kind: 'html-mark'; tag: HtmlMarkTag; title?: string; children: InlineNode[] }
  | { kind: 'footnote-reference'; identifier: string; number: number; occurrence: number }

export type TableAlign = 'left' | 'center' | 'right' | null
export type HtmlAlign = 'left' | 'center' | 'right' | 'justify'
export type HtmlVerticalAlign = 'top' | 'middle' | 'bottom'
/** Inline HTML meanings with their own reading presentation; `samp` also covers `tt`. */
export type HtmlMarkTag = 'kbd' | 'sub' | 'sup' | 'ins' | 'mark' | 'small' | 'abbr' | 'q' | 'samp' | 'var' | 'cite' | 'dfn'
export type MarkdownAlertType = 'note' | 'tip' | 'important' | 'warning' | 'caution'
export type HtmlTableCell = { header: boolean; width?: string; align?: HtmlAlign; valign?: HtmlVerticalAlign; colspan?: number; rowspan?: number; children: BlockNode[] }
export type HtmlTableRow = { head: boolean; cells: HtmlTableCell[] }
export type MarkdownFootnote = { identifier: string; number: number; references: number; children: BlockNode[] }

export type BlockNode =
  | { kind: 'heading'; level: number; anchor: string; sourceMarker?: string; align?: HtmlAlign; children: InlineNode[] }
  | { kind: 'paragraph'; align?: HtmlAlign; children: InlineNode[] }
  | { kind: 'code'; language: string | null; text: string }
  | { kind: 'math'; text: string; source: string }
  | { kind: 'list'; ordered: boolean; start?: number; checked?: (boolean | null)[]; items: BlockNode[][] }
  | { kind: 'quote'; children: BlockNode[] }
  | { kind: 'rule' }
  | { kind: 'table'; align: TableAlign[]; header: InlineNode[][]; rows: InlineNode[][][] }
  | { kind: 'footnotes'; items: MarkdownFootnote[] }
  /** `<div align>` and definition bodies: grouping with an alignment or indent, no other meaning. */
  | { kind: 'container'; align?: HtmlAlign; indent?: boolean; children: BlockNode[] }
  /** A layout table has only `td` cells (README cards); a data table has a header. */
  | { kind: 'html-table'; layout: boolean; caption?: InlineNode[]; rows: HtmlTableRow[] }
  | { kind: 'details'; open: boolean; summary: InlineNode[]; children: BlockNode[] }
  | { kind: 'alert'; alert: MarkdownAlertType; children: BlockNode[] }

export type MarkdownHeading = Extract<BlockNode, { kind: 'heading' }>
export type MarkdownDocument = { blocks: BlockNode[]; headings: MarkdownHeading[] }

const readingGrammar = markdownSourceGrammar().use(remarkMath)

type ParseContext = {
  source: string
  definitions: Map<string, Definition>
  footnotes: Map<string, FootnoteDefinition>
  references: Map<string, { number: number; count: number }>
  anchors: Set<string>
  nextAnchorSuffix: Map<string, number>
  headings: MarkdownHeading[] | null
  /** GitHub only recognizes alerts in quotes at the document level, never nested. */
  alertsAllowed: boolean
  /** False while content is flattened into a line, so its headings take no outline entry or anchor. */
  outline: boolean
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

const BARE_LINK_PROSE_PUNCTUATION = /[、。…，；：！？（）「」『』《》〈〉【】〔〕“”‘’]/u

function inlineLink(node: Link, context: ParseContext): InlineNode[] {
  const child = node.children[0]
  if (node.children.length === 1 && child?.type === 'text') {
    const label = child.value
    const boundary = label.search(BARE_LINK_PROSE_PUNCTUATION)
    const bareUrl = /^https?:\/\//iu.test(label) && node.url === label
    const bareWww = /^www\./iu.test(label) && node.url === `http://${label}`
    // Remark uses the same Link node for GFM literals and authored destinations.
    // Only the exact unadorned source spelling qualifies for the prose boundary.
    if (boundary > 0 && (bareUrl || bareWww) && originalText(node, context).text === label) {
      const address = label.slice(0, boundary)
      return [
        { kind: 'link', href: bareWww ? `http://${address}` : address, children: [{ kind: 'text', text: address }] },
        { kind: 'text', text: label.slice(boundary) }
      ]
    }
  }
  return [{ kind: 'link', href: node.url, children: inlineFrom(node.children, context) }]
}

function inlineFrom(nodes: readonly PhrasingContent[], context: ParseContext): InlineNode[] {
  // Inline HTML is paired across siblings (`<sub>` … `</sub>`), so the whole run is projected together.
  if (nodes.some(node => node.type === 'html')) return htmlInlines(nodes, htmlProjection(context))
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
        out.push(...inlineLink(node, context))
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
  // Anchors only accumulate within this parse. Resume after the last suffix,
  // while retaining the Set for collisions with literal headings like "a-1".
  let suffix = context.nextAnchorSuffix.get(base) ?? 0
  let anchor = suffix === 0 ? base : `${base}-${suffix}`
  while (context.anchors.has(anchor)) anchor = `${base}-${++suffix}`
  context.anchors.add(anchor)
  context.nextAnchorSuffix.set(base, suffix + 1)
  return anchor
}

/** The same anchors, outline and footnote numbering serve Markdown and HTML headings. */
function headingNode(level: number, children: InlineNode[], context: ParseContext, extra: { sourceMarker?: string; align?: HtmlAlign } = {}): MarkdownHeading {
  if (!context.outline) return { kind: 'heading', level, anchor: '', ...extra, children }
  const heading: MarkdownHeading = { kind: 'heading', level, anchor: headingAnchor(children, context), ...extra, children }
  context.headings?.push(heading)
  return heading
}

function htmlProjection(context: ParseContext): HtmlProjection {
  return {
    blocks: (nodes, atRoot, outline = true) => blocksFrom(nodes, { ...context, ...(atRoot ? {} : { alertsAllowed: false }), outline: context.outline && outline }, true),
    inlines: nodes => inlineFrom(nodes, context),
    heading: (level, children, align, outline) => headingNode(level, children, outline ? context : { ...context, outline: false }, align ? { align } : {}),
    sourceOf: node => context.source.slice(node.position?.start.offset ?? 0, node.position?.end.offset ?? 0)
  }
}

const ALERT_MARKER = /^\[!(note|tip|important|warning|caution)\][\t ]*(?:\r?\n|$)/iu
/** GitHub alerts: the marker alone on the first line of a top-level quote that has a body. */
function alertFrom(node: Blockquote, context: ParseContext): BlockNode | null {
  const first = node.children[0]
  if (!context.alertsAllowed || first?.type !== 'paragraph' || first.children[0]?.type !== 'text') return null
  const marker = ALERT_MARKER.exec(first.children[0].value)
  if (!marker) return null
  const rest = first.children[0].value.slice(marker[0].length)
  const paragraph = { ...first, children: [...(rest ? [{ ...first.children[0], value: rest }] : []), ...first.children.slice(1)] }
  const body = [...(paragraph.children.length ? [paragraph] : []), ...node.children.slice(1)]
  if (!body.length) return null
  return { kind: 'alert', alert: marker[1]!.toLowerCase() as MarkdownAlertType, children: blocksFrom(body, { ...context, alertsAllowed: false }) }
}

function blocksFrom(nodes: readonly RootContent[], context: ParseContext, projectingHtml = false): BlockNode[] {
  // Block HTML pairs across siblings (`<div>` … Markdown … `</div>`); the projection keeps the Markdown between.
  if (!projectingHtml && nodes.some(node => node.type === 'html')) return htmlBlocks(nodes, htmlProjection(context))
  const out: BlockNode[] = []
  for (const node of nodes) {
    switch (node.type) {
      case 'heading': {
        const children = inlineFrom(node.children, context)
        const original = context.source.slice(node.position?.start.offset, node.position?.end.offset)
        const sourceMarker = /^(#{1,6})(?:[\t ]|$)/u.exec(original)?.[1]
        out.push(headingNode(node.depth, children, context, sourceMarker ? { sourceMarker } : {}))
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
          items: node.children.map(item => blocksFrom(item.children, { ...context, alertsAllowed: false })) })
        break
      }
      case 'blockquote':
        out.push(alertFrom(node, context) ?? { kind: 'quote', children: blocksFrom(node.children, { ...context, alertsAllowed: false }) })
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
        out.push(...htmlBlocks([node], htmlProjection(context)))
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
    const tree = readingGrammar.parse(source)
    const context: ParseContext = {
      source, definitions: new Map(), footnotes: new Map(), references: new Map(),
      anchors: new Set(), nextAnchorSuffix: new Map(), headings: collectHeadings ? headings : null, alertsAllowed: true, outline: true
    }
    collectDefinitions(tree, context)
    const blocks = blocksFrom(tree.children, context), notes: MarkdownFootnote[] = []
    // Map iteration includes references introduced by a footnote; each definition is projected once.
    for (const [identifier, reference] of context.references) {
      notes.push({ identifier, number: reference.number, references: 0, children: blocksFrom(context.footnotes.get(identifier)!.children, { ...context, alertsAllowed: false }) })
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
    /(?:^|\n)[\t ]*(?:https?:\/\/[^\s<>]+|<https?:\/\/[^\s<>]+>)[\t ]*(?=\r?\n|$)/iu.test(source) ||
    source.includes('$') || /^(#{1,6}\s|\s*[-*+]\s|\s*\d+[.)]\s|```|~~~|>\s|\||---|\*\*\*|\s*\[[^\]]+\]:)/mu.test(source) ||
    /`|\*\*|__|~~|\[[^\]]*\]\(|\[[^\]]*\]\[[^\]]*\]|\[\^[^\]]+\]|(?:^|\s)[*_][^\s*_][^\n]*?[*_](?=\s|[.,!?;:]|$)|\n\s*=+\s*(?:\n|$)| {2,}\n/u.test(source)
  )
}
