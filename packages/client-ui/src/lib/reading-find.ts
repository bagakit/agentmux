/** Ephemeral ranges over the current readable DOM. Never changes text or Selection. */
export type ReadingMatch = { range: Range; text: string; offset: number; occurrence: number; body: HTMLElement | null; opaque: boolean }

export function readingMatches(root: HTMLElement, query: string, bodySelector: string): Range[] {
  return readingMatchDetails(root, query, bodySelector).map(match => match.range)
}

export function readingMatchDetails(root: HTMLElement, query: string, bodySelector: string): ReadingMatch[] {
  if (!query) return []
  const document = root.ownerDocument
  const view = document.defaultView
  const excluded = 'button:not(.md-link), input, textarea, select, summary, nav, script, style, svg, .md-code-toolbar, .md-footnote-backlinks, [contenteditable]:not([contenteditable="false"]), [role="button"]:not(.md-link), [role="textbox"], [data-reading-find-exclude]'
  const walker = document.createTreeWalker(root, 5, {
    acceptNode(node) {
      if (node.nodeType === 1) {
        const element = node as HTMLElement
        if (element.matches(excluded) || element.hidden || element.inert || element.getAttribute('aria-hidden') === 'true' || (element.tagName === 'DETAILS' && !element.hasAttribute('open'))) return 2
        const style = view?.getComputedStyle(element)
        if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse') return 2
        return element.tagName === 'BR' || element.matches('[data-reading-find-boundary], .md-math') ? 1 : 3
      }
      return node.textContent && (node.parentElement?.closest(bodySelector) && root.contains(node.parentElement.closest(bodySelector))) ? 1 : 2
    }
  })
  const groups: { block: Element; boundary: Element | null; nodes: { node: Text; offset: number }[]; text: string }[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === 1) { groups.push({ block: node as Element, boundary: null, nodes: [], text: '' }); continue }
    const text = node as Text
    const body = text.parentElement!.closest(bodySelector)!
    const block = text.parentElement!.closest('p, li, td, th, pre, h1, h2, h3, h4, h5, h6, blockquote, [data-reading-find-block]') ?? body
    const boundary = text.parentElement!.closest('[data-reading-find-boundary], .md-math')
    let group = groups.at(-1)
    if (!group || group.block !== block || group.boundary !== boundary) { group = { block, boundary, nodes: [], text: '' }; groups.push(group) }
    group.nodes.push({ node: text, offset: group.text.length }); group.text += text.data
  }
  const ranges: ReadingMatch[] = []
  const expression = readingQuery(query)
  const occurrences = new Map<HTMLElement | null, Map<string, number>>()
  for (const group of groups) {
    if (!group.text) continue
    const body = group.block.closest<HTMLElement>('.conversation-progressive-body')
    const seen = occurrences.get(body) ?? new Map<string, number>()
    occurrences.set(body, seen)
    const occurrence = seen.get(group.text) ?? 0
    if (!group.boundary) seen.set(group.text, occurrence + 1)
    for (const match of literalReadingMatches(group.text, expression)) {
      const start = match.offset, end = start + match.length
      const first = group.nodes.find(entry => entry.offset + entry.node.length > start)
      const last = group.nodes.find(entry => entry.offset + entry.node.length >= end)
      if (!first || !last) continue
      const range = document.createRange()
      range.setStart(first.node, start - first.offset); range.setEnd(last.node, end - last.offset)
      ranges.push({ range, text: group.text, offset: start, occurrence, body, opaque: Boolean(group.boundary) })
    }
  }
  return ranges
}

export function readingQuery(query: string): RegExp {
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu')
}

export function literalReadingMatches(text: string, expression: RegExp): { offset: number; length: number }[] {
  return Array.from(text.matchAll(expression),
    match => ({ offset: match.index, length: match[0].length }))
}

/** Same visibility contract as the DOM walker, also used before reading deferred text. */
export function readableReadingBody(node: HTMLElement, root: HTMLElement): boolean {
  if (!root.contains(node) || node.closest('[data-reading-find-exclude]')) return false
  for (let element: HTMLElement | null = node; element; element = element.parentElement) {
    if (element.hidden || element.inert || element.getAttribute('aria-hidden') === 'true' || element.matches('details:not([open])')) return false
    const style = element.ownerDocument.defaultView?.getComputedStyle(element)
    if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse') return false
    if (element === root) return true
  }
  return false
}

export function sameReadingMatch(a: Range, b: Range): boolean {
  return a.startContainer === b.startContainer && a.startOffset === b.startOffset && a.endContainer === b.endContainer && a.endOffset === b.endOffset
}
