/** Move the mounted reader without losing a focused control or a selected passage. */
export function moveReadingHost(host: HTMLElement, destination: HTMLElement, before: Element | null = null) {
  const document = host.ownerDocument
  const selection = document.getSelection(), range = selection?.rangeCount ? selection.getRangeAt(0) : null
  const saved = range && host.contains(range.startContainer) && host.contains(range.endContainer)
    ? { range, start: range.startContainer, startOffset: range.startOffset, end: range.endContainer, endOffset: range.endOffset } : null
  const active = document.activeElement, focus = active && host.contains(active) ? active as HTMLElement : null
  if (host.isConnected && host.ownerDocument === destination.ownerDocument && typeof destination.moveBefore === 'function') destination.moveBefore(host, before)
  else destination.insertBefore(host, before)
  focus?.focus({ preventScroll: true })
  if (saved && document === destination.ownerDocument) {
    saved.range.setStart(saved.start, saved.startOffset); saved.range.setEnd(saved.end, saved.endOffset)
    selection?.removeAllRanges(); selection?.addRange(saved.range)
  }
}
