// Markdown for untrusted agent output.
//
// Agent output is text we did not write and cannot vet, and it lands in a sandboxed renderer that must
// never turn it into live markup. So this parser produces a bounded NODE TREE and never an HTML string:
// the renderer maps nodes to React elements, `dangerouslySetInnerHTML` is never involved, and there is
// consequently nothing to sanitise. The risk surface is zero by construction rather than "filtered".
//
// That is also why no markdown library is used. The repo ships none (checked: no marked, markdown-it,
// react-markdown, remark, dompurify), and adopting one would import both its HTML output and the
// obligation to correctly neutralise that output forever. A small subset covering what agents actually
// emit is the cheaper honest trade.
//
// Anything unsupported degrades to text rather than disappearing. Silently eating characters from an
// agent's answer would be worse than showing a stray asterisk.

export type InlineNode =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; children: InlineNode[] }
  | { kind: 'emphasis'; children: InlineNode[] }
  // href is carried verbatim. Whether it may be opened is the renderer's call through the existing
  // external-URL seam — a parser deciding that would be a second place where escape rules live.
  | { kind: 'link'; href: string; children: InlineNode[] }

export type BlockNode =
  // `level` is kept for semantics (h1..h6) even though every level renders at ONE font size: the design
  // contract puts a floor on type and forbids buying hierarchy with size, so weight and spacing carry it.
  | { kind: 'heading'; level: number; children: InlineNode[] }
  | { kind: 'paragraph'; children: InlineNode[] }
  | { kind: 'code'; language: string | null; text: string }
  | { kind: 'list'; ordered: boolean; items: InlineNode[][] }

const FENCE = /^\s*(?:```|~~~)\s*([A-Za-z0-9_+-]*)\s*$/
const HEADING = /^(#{1,6})\s+(.*)$/
const UNORDERED = /^\s*[-*+]\s+(.*)$/
const ORDERED = /^\s*\d+[.)]\s+(.*)$/

/**
 * Parse agent output into blocks.
 *
 * Deliberately line-oriented: agent output arrives as lines, and a line-based reader cannot be walked
 * into pathological backtracking by hostile input the way a nested grammar can.
 */
export function parseAgentMarkdown(source: string): BlockNode[] {
  const lines = source.replace(/\r\n?/gu, '\n').split('\n')
  const blocks: BlockNode[] = []
  let paragraph: string[] = []

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    blocks.push({ kind: 'paragraph', children: parseInline(paragraph.join('\n')) })
    paragraph = []
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!

    const fence = FENCE.exec(line)
    if (fence) {
      flushParagraph()
      const language = fence[1]!.trim()
      const body: string[] = []
      index += 1
      // An unterminated fence takes the rest of the output rather than discarding it. Half an answer is
      // worse than an unclosed block.
      while (index < lines.length && !FENCE.test(lines[index]!)) {
        body.push(lines[index]!)
        index += 1
      }
      blocks.push({
        kind: 'code',
        language: language === '' ? null : language,
        text: body.join('\n')
      })
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      flushParagraph()
      blocks.push({
        kind: 'heading',
        level: heading[1]!.length,
        children: parseInline(heading[2]!.trim())
      })
      continue
    }

    const unordered = UNORDERED.exec(line)
    const ordered = unordered ? null : ORDERED.exec(line)
    if (unordered || ordered) {
      flushParagraph()
      const isOrdered = ordered !== null
      const items: InlineNode[][] = []
      while (index < lines.length) {
        const current = lines[index]!
        const match = isOrdered ? ORDERED.exec(current) : UNORDERED.exec(current)
        if (!match) break
        items.push(parseInline(match[1]!))
        index += 1
      }
      index -= 1
      blocks.push({ kind: 'list', ordered: isOrdered, items })
      continue
    }

    if (line.trim() === '') {
      flushParagraph()
      continue
    }
    paragraph.push(line)
  }

  flushParagraph()
  return blocks
}

// Inline scanning walks left to right and never rewinds. Every construct that fails to close is emitted
// as the literal text it was written as, so a stray backtick or asterisk shows up rather than swallowing
// the remainder of a sentence.
export function parseInline(source: string): InlineNode[] {
  const nodes: InlineNode[] = []
  let text = ''

  const flushText = (): void => {
    if (text === '') return
    nodes.push({ kind: 'text', text })
    text = ''
  }

  let index = 0
  while (index < source.length) {
    const rest = source.slice(index)

    // Inline code first, and its content is never parsed further: `**not bold**` inside backticks has to
    // survive verbatim, which is exactly what an agent quoting markdown depends on.
    if (rest.startsWith('`')) {
      const close = rest.indexOf('`', 1)
      if (close > 0) {
        flushText()
        nodes.push({ kind: 'code', text: rest.slice(1, close) })
        index += close + 1
        continue
      }
    }

    // [text](href) — href is taken as written; no scheme judgement happens here.
    if (rest.startsWith('[')) {
      const labelEnd = rest.indexOf('](')
      if (labelEnd > 0) {
        const hrefEnd = rest.indexOf(')', labelEnd + 2)
        if (hrefEnd > labelEnd) {
          flushText()
          nodes.push({
            kind: 'link',
            href: rest.slice(labelEnd + 2, hrefEnd).trim(),
            children: parseInline(rest.slice(1, labelEnd))
          })
          index += hrefEnd + 1
          continue
        }
      }
    }

    // Strong before emphasis, so `**` is never read as two `*`. The first marker that actually closes
    // wins; one that does not close falls through and becomes literal text.
    const marker = (['**', '__', '*', '_'] as const).find((candidate) => {
      if (!rest.startsWith(candidate)) return false
      return rest.indexOf(candidate, candidate.length) > candidate.length
    })
    if (marker) {
      const close = rest.indexOf(marker, marker.length)
      flushText()
      nodes.push({
        kind: marker === '**' || marker === '__' ? 'strong' : 'emphasis',
        children: parseInline(rest.slice(marker.length, close))
      })
      index += close + marker.length
      continue
    }

    text += source[index]!
    index += 1
  }

  flushText()
  return nodes
}

/**
 * Whether output is worth parsing at all.
 *
 * A plain sentence should not pay for a tree walk, and — more importantly — should not risk a parser
 * reshaping text that was never markdown.
 */
export function looksLikeMarkdown(source: string): boolean {
  return /^(#{1,6}\s|\s*[-*+]\s|\s*\d+[.)]\s|```|~~~)/mu.test(source) || /`|\*\*|__|\[[^\]]*\]\(/u.test(source)
}
