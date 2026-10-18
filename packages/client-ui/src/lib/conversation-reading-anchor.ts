type ReadingAnchor = { kind: 'record' | 'group' | 'segment'; id: string; offset: number }
export function conversationReadingAnchor(viewport: HTMLElement, observedScope?: HTMLElement | null, nativeOnly = false, visibleShells?: Iterable<Element>): ReadingAnchor | null {
  const bounds = viewport.getBoundingClientRect()
  if (bounds.height <= 0) return null
  const selector = nativeOnly ? '[data-native-record-id], [data-native-record-ids]' : '[data-segment-key], [data-native-record-id], [data-native-record-ids]'
  if (visibleShells) {
    // The host already observes these shells for its visible reading band. Reuse
    // those candidates rather than measuring every earlier record on scroll.
    const rows = [...new Set([...visibleShells].map(node => node.closest<HTMLElement>(selector)))]
      .filter((node): node is HTMLElement => Boolean(node && node.isConnected && viewport.contains(node)))
      .sort((a, b) => a === b ? 0 : a.compareDocumentPosition(b) & 4 ? -1 : 1)
    const anchor = anchorFromRows(rows, bounds)
    if (anchor) return anchor
  }
  // Read the actual mixed DOM order. Source priority would choose a later native
  // row over an earlier captured message. A cold observation still has a complete
  // reading path; once visibility is known the scroll path stays local.
  return anchorFromRows((observedScope ?? viewport).querySelectorAll<HTMLElement>(selector), bounds)
}

function anchorFromRows(rows: Iterable<HTMLElement>, bounds: DOMRect): ReadingAnchor | null {
  for (const row of rows) {
    const rect = row.getBoundingClientRect()
    if (rect.height <= 0 || rect.bottom <= bounds.top || rect.top >= bounds.bottom) continue
    if (row.dataset.segmentKey) return { kind: 'segment', id: row.dataset.segmentKey, offset: rect.top - bounds.top }
    if (row.dataset.nativeRecordId) return { kind: 'record', id: row.dataset.nativeRecordId, offset: rect.top - bounds.top }
    const head = row.querySelector<HTMLElement>('.wf-card--observation > .wf-head[aria-expanded="false"]')
    const headRect = head?.getBoundingClientRect(), id = head?.parentElement?.dataset.observationId
    if (id && headRect && headRect.height > 0 && headRect.bottom > bounds.top && headRect.top < bounds.bottom)
      return { kind: 'group', id, offset: headRect.top - bounds.top }
  }
  return null
}

export function restoreConversationAnchor(viewport: HTMLElement, anchor: ReadingAnchor, tailSpace?: HTMLElement | null): void {
  const row = anchor.kind === 'segment'
    ? [...viewport.querySelectorAll<HTMLElement>('[data-segment-key]')].find(node => node.dataset.segmentKey === anchor.id)
    : anchor.kind === 'record'
    ? [...viewport.querySelectorAll<HTMLElement>('[data-native-record-id]')].find(node => node.dataset.nativeRecordId === anchor.id)
    : [...viewport.querySelectorAll<HTMLElement>('[data-observation-id]')].find(node => node.dataset.observationId === anchor.id)
      ?.querySelector<HTMLElement>(':scope > .wf-head[aria-expanded="false"]')
  if (!row) return
  const bounds = viewport.getBoundingClientRect(), rect = row.getBoundingClientRect()
  if (bounds.height <= 0 || rect.height <= 0) return
  const target = viewport.scrollTop + rect.top - bounds.top - anchor.offset
  viewport.scrollTop = target
  if (tailSpace && (viewport.scrollTop < target || tailSpace.style.height)) {
    // A folded, underfilled page otherwise clamps the accepted Earlier anchor at zero.
    // Keep only the blank extent needed for this position, outside both reading tails.
    const end = viewport.scrollTop + tailSpace.getBoundingClientRect().top - bounds.top
      + (Number.parseFloat(getComputedStyle(viewport).paddingBottom) || 0)
    const height = Math.min(viewport.clientHeight, Math.max(0, target + viewport.clientHeight - end))
    const value = height ? `${height}px` : ''
    if (tailSpace.style.height !== value) tailSpace.style.height = value
    viewport.scrollTop = target
  }
}
