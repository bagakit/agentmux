/** Ephemeral ranges over the current readable DOM. Never changes text or Selection. */
export function readingMatches(root: HTMLElement, query: string, bodySelector: string): Range[] {
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
        return element.tagName === 'BR' ? 1 : 3
      }
      return node.textContent && (node.parentElement?.closest(bodySelector) && root.contains(node.parentElement.closest(bodySelector))) ? 1 : 2
    }
  })
  const groups: { block: Element; nodes: { node: Text; offset: number }[]; text: string }[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === 1) { groups.push({ block: node as Element, nodes: [], text: '' }); continue }
    const text = node as Text
    const body = text.parentElement!.closest(bodySelector)!
    const block = text.parentElement!.closest('p, li, td, th, pre, h1, h2, h3, h4, h5, h6, blockquote') ?? body
    let group = groups.at(-1)
    if (!group || group.block !== block) { group = { block, nodes: [], text: '' }; groups.push(group) }
    group.nodes.push({ node: text, offset: group.text.length }); group.text += text.data
  }
  const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu')
  const ranges: Range[] = []
  for (const group of groups) for (const match of group.text.matchAll(expression)) {
    const start = match.index, end = start + match[0].length
    const first = group.nodes.find(entry => entry.offset + entry.node.length > start)
    const last = group.nodes.find(entry => entry.offset + entry.node.length >= end)
    if (!first || !last) continue
    const range = document.createRange()
    range.setStart(first.node, start - first.offset); range.setEnd(last.node, end - last.offset)
    ranges.push(range)
  }
  return ranges
}

export function sameReadingMatch(a: Range, b: Range): boolean {
  return a.startContainer === b.startContainer && a.startOffset === b.startOffset && a.endContainer === b.endContainer && a.endOffset === b.endOffset
}
