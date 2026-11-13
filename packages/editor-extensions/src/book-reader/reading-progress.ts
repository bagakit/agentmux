/** Progress follows the actual scroll axis, including Chromium's negative RTL scrollLeft. */
function axis(doc: Document) {
  const element = doc.scrollingElement ?? doc.documentElement
  const style = doc.defaultView?.getComputedStyle(doc.body ?? doc.documentElement)
  const x = Math.max(0, element.scrollWidth - element.clientWidth), y = Math.max(0, element.scrollHeight - element.clientHeight)
  const horizontal = x > 0 && (style?.writingMode.startsWith('vertical') || style?.writingMode.startsWith('sideways') || y === 0)
  return {element, horizontal, length: horizontal ? x : y, sign: style?.writingMode.endsWith('-rl') || style?.direction === 'rtl' ? -1 : 1}
}
export function readBookProgress(doc: Document): number {
  const {element,horizontal,length} = axis(doc)
  return Math.max(0, Math.min(1, (horizontal ? Math.abs(element.scrollLeft) : element.scrollTop) / Math.max(1,length)))
}
export function restoreBookProgress(doc: Document, progress: number): void {
  const {element,horizontal,length,sign} = axis(doc)
  if (horizontal) element.scrollLeft = sign * progress * length
  else element.scrollTop = progress * length
}
