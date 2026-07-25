import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import type { Root, RootContent, PhrasingContent } from 'mdast'

// Markdown for untrusted agent output.
//
// Agent answers are written in markdown, so a conversation that shows the source is a conversation you
// have to decode. This turns that source into a bounded node tree the renderer maps to React elements.
//
// The parser is remark (`remark-parse` + `remark-gfm`) rather than something hand-rolled: the repo had no
// markdown capability at all, and a hand-written subset was already failing on real agent output —
// tables came out as a wall of pipes and dashes, nested lists collapsed flat, blockquotes and rules read
// as literal text. remark is the maintained implementation of the same grammar, and GFM tables are the
// construct agents reach for most.
//
// It is specifically remark and NOT marked/markdown-it because remark stops at an mdast SYNTAX TREE and
// never emits HTML. That is the whole security position: untrusted text becomes React elements,
// `dangerouslySetInnerHTML` never appears, and there is consequently nothing to sanitise. Adopting an
// HTML-emitting library would import both its output and the permanent duty to neutralise that output
// correctly — a duty we would eventually discharge wrongly.

export type InlineNode =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; children: InlineNode[] }
  | { kind: 'emphasis'; children: InlineNode[] }
  | { kind: 'strike'; children: InlineNode[] }
  // href is carried verbatim. Whether it may be opened is the renderer's call through the existing
  // external-URL seam — a parser deciding that would be a second place where escape rules live.
  | { kind: 'link'; href: string; children: InlineNode[] }

export type TableAlign = 'left' | 'center' | 'right' | null

export type BlockNode =
  // `level` is semantics only (h1..h6). Every level renders at ONE font size: the surface contract puts a
  // floor on type and forbids buying hierarchy with scale, so weight and spacing carry it instead.
  | { kind: 'heading'; level: number; children: InlineNode[] }
  | { kind: 'paragraph'; children: InlineNode[] }
  | { kind: 'code'; language: string | null; text: string }
  | { kind: 'list'; ordered: boolean; items: BlockNode[][] }
  | { kind: 'quote'; children: BlockNode[] }
  | { kind: 'rule' }
  | { kind: 'table'; align: TableAlign[]; header: InlineNode[][]; rows: InlineNode[][][] }

const processor = unified().use(remarkParse).use(remarkGfm)

function inlineFrom(nodes: readonly PhrasingContent[]): InlineNode[] {
  const out: InlineNode[] = []
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        out.push({ kind: 'text', text: node.value })
        break
      case 'inlineCode':
        out.push({ kind: 'code', text: node.value })
        break
      case 'strong':
        out.push({ kind: 'strong', children: inlineFrom(node.children) })
        break
      case 'emphasis':
        out.push({ kind: 'emphasis', children: inlineFrom(node.children) })
        break
      case 'delete':
        out.push({ kind: 'strike', children: inlineFrom(node.children) })
        break
      case 'link':
        out.push({ kind: 'link', href: node.url, children: inlineFrom(node.children) })
        break
      case 'break':
        out.push({ kind: 'text', text: '\n' })
        break
      // An mdast `html` node is a run of raw markup in the source. It becomes LITERAL TEXT: an agent
      // quoting `<script>` from a file must see those characters, and nothing here may create an element.
      case 'html':
        out.push({ kind: 'text', text: node.value })
        break
      case 'image':
        // Remote images in untrusted output would be an outbound request we never authorised, so the
        // alt text and URL are shown as words instead of fetched.
        out.push({ kind: 'text', text: node.alt ? `${node.alt} (${node.url})` : node.url })
        break
      default:
        // Anything else (footnote refs, custom nodes) degrades to its text content rather than
        // disappearing. Silently eating part of an answer is worse than showing it plainly.
        if ('children' in node && Array.isArray(node.children)) {
          out.push(...inlineFrom(node.children as PhrasingContent[]))
        } else if ('value' in node && typeof node.value === 'string') {
          out.push({ kind: 'text', text: node.value })
        }
    }
  }
  return out
}

function blocksFrom(nodes: readonly RootContent[]): BlockNode[] {
  const out: BlockNode[] = []
  for (const node of nodes) {
    switch (node.type) {
      case 'heading':
        out.push({ kind: 'heading', level: node.depth, children: inlineFrom(node.children) })
        break
      case 'paragraph':
        out.push({ kind: 'paragraph', children: inlineFrom(node.children) })
        break
      case 'code':
        out.push({ kind: 'code', language: node.lang ?? null, text: node.value })
        break
      case 'list':
        out.push({
          kind: 'list',
          ordered: node.ordered === true,
          // Items keep BLOCK children so a nested list stays nested. The previous hand-rolled parser
          // flattened them, which lost the structure the author used to express grouping.
          items: node.children.map((item) => blocksFrom(item.children))
        })
        break
      case 'blockquote':
        out.push({ kind: 'quote', children: blocksFrom(node.children) })
        break
      case 'thematicBreak':
        out.push({ kind: 'rule' })
        break
      case 'table': {
        const [header, ...rows] = node.children
        out.push({
          kind: 'table',
          align: (node.align ?? []).map((value) => value ?? null),
          header: (header?.children ?? []).map((cell) => inlineFrom(cell.children)),
          rows: rows.map((row) => row.children.map((cell) => inlineFrom(cell.children)))
        })
        break
      }
      // Raw markup at block level, same rule as inline: literal text, never an element.
      case 'html':
        out.push({ kind: 'paragraph', children: [{ kind: 'text', text: node.value }] })
        break
      default:
        if ('children' in node && Array.isArray(node.children)) {
          out.push(...blocksFrom(node.children as RootContent[]))
        }
    }
  }
  return out
}

/**
 * Parse agent output into blocks.
 *
 * Never throws: malformed markdown is a normal occurrence in generated text, and a parse failure must
 * degrade to showing the words rather than losing the answer.
 */
export function parseAgentMarkdown(source: string): BlockNode[] {
  try {
    return blocksFrom((processor.parse(source) as Root).children)
  } catch {
    return source.trim() === '' ? [] : [{ kind: 'paragraph', children: [{ kind: 'text', text: source }] }]
  }
}

/**
 * Whether output is worth parsing at all.
 *
 * A plain sentence should not be round-tripped through a parser that could reshape it — text that was
 * never markdown must reach the reader exactly as written.
 */
export function looksLikeMarkdown(source: string): boolean {
  return (
    /^(#{1,6}\s|\s*[-*+]\s|\s*\d+[.)]\s|```|~~~|>\s|\||---|\*\*\*)/mu.test(source) ||
    /`|\*\*|__|~~|\[[^\]]*\]\(/u.test(source)
  )
}
