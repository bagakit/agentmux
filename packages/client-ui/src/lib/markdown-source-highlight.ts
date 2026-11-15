import type { Root, RootContent } from 'mdast'
import { parseMarkdownSource } from './markdown-source.js'

type MarkdownNode = Root | RootContent
type HighlightKind = 'heading' | 'list-marker' | 'quote-marker' | 'emphasis' | 'link' | 'code' | 'math'

export type MarkdownSourceHighlight = { start: number; end: number; kind: HighlightKind }

const highlights: Partial<Record<MarkdownNode['type'], HighlightKind>> = {
  heading: 'heading',
  listItem: 'list-marker',
  blockquote: 'quote-marker',
  emphasis: 'emphasis',
  strong: 'emphasis',
  delete: 'emphasis',
  link: 'link',
  linkReference: 'link',
  image: 'link',
  imageReference: 'link',
  code: 'code',
  inlineCode: 'code',
  math: 'math',
  inlineMath: 'math'
}

const MAX_SOURCE_LENGTH = 4096
const MAX_BLOCK_MARKS_PER_LINE = 128

/** Large input and very deep containers can stall the synchronous grammar. Budget coloring alone. */
function canHighlightSynchronously(source: string): boolean {
  if (source.length > MAX_SOURCE_LENGTH) return false
  let marks = 0
  for (const character of source) {
    if (character === '\n' || character === '\r') marks = 0
    if ('>-+*.)'.includes(character) && ++marks > MAX_BLOCK_MARKS_PER_LINE) return false
  }
  return true
}

function listMarkerEnd(source: string, start: number): number {
  let offset = start
  // The ListItem position starts at a recognized marker. Read its spelled length, including leading zeroes.
  while (source.charCodeAt(offset) >= 48 && source.charCodeAt(offset) <= 57) offset++
  return offset + 1
}

/** Non-overlapping spans in the caller's UTF-16 coordinates. Slice the original string to display them. */
export function getMarkdownSourceHighlights(source: string): MarkdownSourceHighlight[] {
  if (!canHighlightSynchronously(source)) return []
  const ranges: MarkdownSourceHighlight[] = []
  const offset = source.startsWith('\uFEFF') ? 1 : 0 // remark strips the leading BOM before assigning positions.
  let cursor = 0

  function appendThrough(end: number, kind: HighlightKind | undefined): void {
    if (end <= cursor) return
    if (kind) {
      const previous = ranges.at(-1)
      if (previous?.end === cursor && previous.kind === kind) previous.end = end
      else ranges.push({ start: cursor, end, kind })
    }
    cursor = end
  }

  function visit(node: MarkdownNode, enclosing?: HighlightKind): void {
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    const kind = start !== undefined && end !== undefined ? highlights[node.type] : undefined
    const marker = kind === 'list-marker' || kind === 'quote-marker'
    if (kind && start !== undefined) {
      const markerStart = start + offset
      appendThrough(markerStart, enclosing)
      if (marker) appendThrough(kind === 'list-marker' ? listMarkerEnd(source, markerStart) : markerStart + 1, kind)
    }
    if ('children' in node) {
      for (const child of node.children) visit(child, marker ? enclosing : kind ?? enclosing)
    }
    if (kind && !marker && end !== undefined) appendThrough(end + offset, kind)
  }

  try {
    visit(parseMarkdownSource(source))
    return ranges
  } catch {
    // Coloring is optional even if the parser rejects the input. The native draft still has the full source.
    return []
  }
}
