type ReadingAnchor = { node: Text; offset: number; top: number }

/** Capture a visible character, not a scroll ratio which changes when lines reflow. */
export function captureReadingAnchor(container: HTMLElement): ReadingAnchor | null {
  const viewport = container.getBoundingClientRect(), range = document.createRange()
  if (typeof range.getBoundingClientRect !== 'function' || viewport.height <= 0) return null
  const text = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  for (let node = text.nextNode() as Text | null; node; node = text.nextNode() as Text | null) {
    if (!node.length || !node.data.trim()) continue
    range.selectNodeContents(node)
    const bounds = range.getBoundingClientRect()
    if (bounds.bottom <= viewport.top || bounds.top >= viewport.bottom || !bounds.height) continue
    let low = 0, high = node.length - 1
    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      range.setStart(node, middle); range.setEnd(node, middle + 1)
      if (range.getBoundingClientRect().bottom <= viewport.top + 1) low = middle + 1
      else high = middle
    }
    range.setStart(node, low); range.setEnd(node, low + 1)
    const character = range.getBoundingClientRect()
    if (character.height) return { node, offset: low, top: character.top - viewport.top }
  }
  return null
}

/** Synchronous layout restoration lets later scrolling, selection and navigation win. */
export function restoreReadingAnchor(container: HTMLElement, anchor: ReadingAnchor | null): void {
  if (!anchor || !container.contains(anchor.node) || anchor.offset >= anchor.node.length) return
  const range = document.createRange()
  if (typeof range.getBoundingClientRect !== 'function') return
  range.setStart(anchor.node, anchor.offset); range.setEnd(anchor.node, anchor.offset + 1)
  container.scrollTop += range.getBoundingClientRect().top - container.getBoundingClientRect().top - anchor.top
}
