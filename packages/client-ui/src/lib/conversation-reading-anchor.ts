type ReadingAnchor = { kind: 'record' | 'group' | 'segment'; id: string; offset: number }
/** Prefer a visible selected original; endpoint checks never scan the reading window. */
export function selectedConversationReadingNode(root: HTMLElement, selector: string,
  visible: (node: HTMLElement) => boolean, candidates: () => Iterable<Element>): HTMLElement | null {
  const selection = root.ownerDocument.defaultView?.getSelection()
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null
  // Element/offset endpoints can name a process container; it is not an original leaf.
  const isLeaf = (node: HTMLElement) => !node.hasAttribute('data-conversation-process-key')
  const range = selection.getRangeAt(0), node = range.startContainer
  const element = node.nodeType === 1 ? node as Element : node.parentElement
  const selected = element?.closest<HTMLElement>(selector)
  if (selected && isLeaf(selected) && root.contains(selected) && visible(selected)) return selected
  const end = range.endContainer.nodeType === 1 ? range.endContainer as Element : range.endContainer.parentElement
  const last = end?.closest<HTMLElement>(selector)
  if (last && isLeaf(last) && root.contains(last) && visible(last)) return last
  let first: HTMLElement | null = null
  for (const candidate of candidates()) {
    const row = candidate.closest<HTMLElement>(selector)
    // A group header can intersect a crossing Range without being its readable leaf.
    if (!row || !isLeaf(row) || !root.contains(row)) continue
    if (first && !(row.compareDocumentPosition(first) & 4)) continue
    try { if (!range.intersectsNode(row)) continue } catch { continue }
    if (visible(row)) first = row
  }
  return first
}
export function conversationReadingAnchor(viewport: HTMLElement, observedScope?: HTMLElement | null, nativeOnly = false, visibleShells?: Iterable<Element>): ReadingAnchor | null {
  const bounds = viewport.getBoundingClientRect()
  if (bounds.height <= 0) return null
  const selector = nativeOnly ? '[data-native-record-id], [data-conversation-process-key]' : '[data-segment-key], [data-native-record-id], [data-conversation-process-key]'
  const selected = selectedConversationReadingNode(viewport, selector, row => anchorFromRows([row], bounds) !== null,
    () => visibleShells ?? (observedScope ?? viewport).querySelectorAll<HTMLElement>(selector))
  const selectedAnchor = selected && anchorFromRows([selected], bounds)
  if (selectedAnchor) return selectedAnchor
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
