import { Component, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { WorkbenchPresentationContext, type BrowserControlConfirmation } from '../lib/workbench-presentation'
import { workbenchRegionProjectionSlotId } from '../lib/workbench-projection'
import { tabSwitchObservation } from '../lib/tab-switch-observation'

type ReadingRange = { start: Node; startOffset: number; end: Node; endOffset: number }
type ReadingScroll = { element: HTMLElement; top: number; left: number }
type ReadingSnapshot = { ranges: ReadingRange[]; scrolls: ReadingScroll[]; activeElement: Element | null; parent: Element | null; interrupted: boolean; dispose(): void }
function captureReadingRanges(host: HTMLElement): ReadingRange[] {
  const selection = document.getSelection()
  return selection ? Array.from({ length: selection.rangeCount }, (_, index) => {
    const range = selection.getRangeAt(index)
    return host.contains(range.startContainer) && host.contains(range.endContainer)
      ? { start: range.startContainer, startOffset: range.startOffset, end: range.endContainer, endOffset: range.endOffset }
      : null
  }).filter((range): range is ReadingRange => range !== null) : []
}
function captureReadingScrolls(host: HTMLElement, ranges: ReadingRange[], activeElement: Element | null): ReadingScroll[] {
  const scrolls = new Map<HTMLElement, ReadingScroll>()
  // Original reading containers can be scrolled without a text selection or
  // focused input. Read only those actual containers in this one retained host.
  const readers = host.querySelectorAll<HTMLElement>('[data-workbench-reading-scroll]')
  for (const node of [...readers, ...ranges.flatMap(range => [range.start, range.end]), activeElement]) {
    let element = node instanceof HTMLElement ? node : node?.parentElement
    while (element && host.contains(element)) {
      if (element.scrollTop || element.scrollLeft) scrolls.set(element, { element, top: element.scrollTop, left: element.scrollLeft })
      element = element.parentElement
    }
  }
  return [...scrolls.values()]
}
function restoreReadingRanges(host: HTMLElement, ranges: ReadingRange[], activeElement: Element | null, active: boolean, reparentedWithoutInput = false): void {
  const selection = document.getSelection()
  if (!selection || ranges.length === 0 || !host.isConnected) return
  if (!ranges.every(endpoints => host.contains(endpoints.start) && host.contains(endpoints.end))) return
  const currentInput = document.activeElement
  if (currentInput !== activeElement && currentInput instanceof HTMLElement &&
    currentInput !== document.body) return
  // A later selection is the user's current intent. Only repair a DOM-induced
  // collapse, or preserve the exact same already-restored endpoints.
  let unchanged = selection.rangeCount === ranges.length
  for (let index = 0; index < selection.rangeCount; index++) {
    const current = selection.getRangeAt(index)
    const original = ranges[index]
    if (!original) return
    const same = current.startContainer === original.start && current.startOffset === original.startOffset &&
      current.endContainer === original.end && current.endOffset === original.endOffset
    if (!same) unchanged = false
    if (!same && (!current.collapsed || current.startContainer.nodeType === Node.TEXT_NODE && !reparentedWithoutInput)) return
  }
  // Reparenting can blur a live editor to body. Restore only that exact input
  // in an active presentation; a later focused control remains the user's intent.
  if (active && currentInput === document.body && activeElement instanceof HTMLElement && host.contains(activeElement) &&
    (activeElement.isContentEditable || activeElement.matches('input, textarea, [contenteditable="true"]')) &&
    !activeElement.closest('[hidden], [inert], [aria-hidden="true"]')) activeElement.focus({ preventScroll: true })
  if (unchanged) return
  selection.removeAllRanges()
  for (const endpoints of ranges) {
    const range = document.createRange()
    range.setStart(endpoints.start, endpoints.startOffset)
    range.setEnd(endpoints.end, endpoints.endOffset)
    selection.addRange(range)
  }
}
// Capture before React removes an old destination slot. A layout effect is too
// late: Chromium has already collapsed the live Range when that slot detaches.
class WorkbenchReadingSnapshot extends Component<{ host: HTMLElement; active: boolean; visible: boolean; children: ReactNode }> {
  private pending = new Set<ReadingSnapshot>()
  getSnapshotBeforeUpdate(): ReadingSnapshot {
    const ranges = captureReadingRanges(this.props.host), activeElement = document.activeElement
    const snapshot: ReadingSnapshot = { ranges, scrolls: captureReadingScrolls(this.props.host, ranges, activeElement), activeElement,
      parent: this.props.host.parentElement, interrupted: false, dispose() {} }
    if (snapshot.ranges.length || snapshot.scrolls.length) {
      const interrupt = () => { snapshot.interrupted = true }
      const events = ['pointerdown', 'keydown', 'beforeinput', 'wheel', 'touchmove'] as const
      for (const event of events) document.addEventListener(event, interrupt, true)
      snapshot.dispose = () => { for (const event of events) document.removeEventListener(event, interrupt, true) }
      this.pending.add(snapshot)
    }
    return snapshot
  }
  componentDidUpdate(_previous: Readonly<{ host: HTMLElement; active: boolean; visible: boolean; children: ReactNode }>, _state: unknown, snapshot: ReadingSnapshot): void {
    if (snapshot.ranges.length === 0 && snapshot.scrolls.length === 0) return
    const host = this.props.host
    // The parent layout effect reattaches this same host during this commit.
    queueMicrotask(() => {
      try {
        const reparentedWithoutInput = host.parentElement !== snapshot.parent && document.activeElement === snapshot.activeElement
        if (this.props.visible && !snapshot.interrupted) {
          if (host.parentElement !== snapshot.parent &&
            (document.activeElement === snapshot.activeElement || document.activeElement === document.body)) {
            for (const scroll of snapshot.scrolls) if (host.contains(scroll.element) && scroll.element.isConnected) {
              // Repair only a DOM-induced reset. A valid position already
              // committed by this reader, or a browser clamp, remains current.
              if (scroll.element.scrollTop === 0) scroll.element.scrollTop = scroll.top
              if (scroll.element.scrollLeft === 0) scroll.element.scrollLeft = scroll.left
            }
          }
          restoreReadingRanges(host, snapshot.ranges, snapshot.activeElement, this.props.active, reparentedWithoutInput)
        }
      } finally { snapshot.dispose(); this.pending.delete(snapshot) }
    })
  }
  componentWillUnmount(): void { for (const snapshot of this.pending) snapshot.dispose(); this.pending.clear() }
  render(): ReactNode { return this.props.children }
}

/** One React/terminal tree; only its existing DOM host changes spatial parent. */
export function StableWorkbenchView({ homeId, targetId, primaryTabId, nativeRegionId, active, visible = true, retainedRegionId, homeNotice, surface, survey, controlsOpen, onBrowserControlConfirmation, onSelectRegion, projection, reference, kind = 'tab', children }: {
  homeId: string
  /** Only the unique primary View carries an input-retention identity. */
  primaryTabId?: string | undefined
  /** The original Region leaf supplies its actual identity, not the selected sibling. */
  nativeRegionId?: string | undefined
  kind?: 'tab' | 'region'
  targetId: string | null
  active: boolean
  visible?: boolean
  retainedRegionId: string | null
  surface?: import('../lib/workbench-presentation').WorkbenchViewTarget['surface']
  survey?: boolean | undefined
  controlsOpen?: boolean | undefined
  onBrowserControlConfirmation?: BrowserControlConfirmation | undefined
  onSelectRegion?: ((regionId: string) => void) | undefined
  projection?: import('../lib/workbench-projection').WorkbenchProjection | undefined
  reference?: import('../lib/workbench-projection').WorkbenchProjectionSelection | undefined
  /** The existing projection owner describes a borrowed View at its original slot. */
  homeNotice?: ReactNode
  children: ReactNode
}) {
  const [host] = useState(() => {
    const element = document.createElement('div')
    element.className = kind === 'region' ? 'retained-workbench-region' : 'retained-workbench-view'
    return element
  })
  const [placedHostId, setPlacedHostId] = useState(homeId)
  const presentation = useMemo(() => ({ active, retainedRegionId, tabHostId: placedHostId, surface, survey, controlsOpen, onBrowserControlConfirmation, onSelectRegion, projection, reference }),
    [active, retainedRegionId, placedHostId, surface, survey, controlsOpen, onBrowserControlConfirmation, onSelectRegion, projection, reference])
  const parking = useRef<HTMLDivElement>(null)
  const showHomeNotice = Boolean(homeNotice)
  const [noticeHome, setNoticeHome] = useState<HTMLElement | null>(null)
  const switchTarget = useMemo(() => reference ? { ...reference, presentationId: projection?.presentationId ?? surface ?? 'space' } : null,
    [reference?.displayWorkspaceId, reference?.groupId, reference?.tabId, reference?.regionId, projection?.presentationId, surface])
  useLayoutEffect(() => {
    if (!switchTarget || (kind === 'region') !== (projection?.entity.kind === 'region')) return
    return tabSwitchObservation.registerPlacement(switchTarget, () => visible && host.isConnected &&
      host.parentElement?.id === (targetId ?? homeId) && !host.closest('[hidden], [inert]'))
  }, [switchTarget, kind, projection?.entity.kind, visible, host, targetId, homeId])
  useLayoutEffect(() => {
    const destinationId = targetId ?? homeId
    const attach = () => {
      // A Region's exact home is its sibling slot, including while its parent
      // View is being reparented. It need not wait in inert parking for body lookup.
      const siblingHome = kind === 'region' && targetId === null
        ? Array.from(parking.current?.parentElement?.children ?? []).find(element => element.id === destinationId) : undefined
      const destination = siblingHome ?? document.getElementById(destinationId)
      if (!destination) return false
      if (host.parentElement !== destination) {
        // Reparenting an existing DOM host collapses Chromium's live Range.
        // Snapshot node endpoints, not cloned live Ranges, for this one move.
        const ranges = captureReadingRanges(host), activeElement = document.activeElement
        // Connected moves preserve the existing editor focus and browser state.
        // A detached slot still needs insertion before its parent can attach.
        if (host.isConnected && destination.isConnected) destination.moveBefore(host, null)
        else destination.append(host)
        if (visible) restoreReadingRanges(host, ranges, activeElement, active)
      }
      if (kind === 'tab' && reference) {
        host.dataset.workbenchViewReference = workbenchRegionProjectionSlotId('view', reference)
      } else {
        delete host.dataset.workbenchViewReference
      }
      if (primaryTabId && reference?.tabId === primaryTabId) {
        host.dataset.workbenchPrimaryTabId = primaryTabId
        host.dataset.workbenchPrimaryReference = workbenchRegionProjectionSlotId('primary', reference)
      } else {
        delete host.dataset.workbenchPrimaryTabId
        delete host.dataset.workbenchPrimaryReference
      }
      if (kind === 'region' && reference && nativeRegionId) {
        host.dataset.workbenchRegionReference = workbenchRegionProjectionSlotId('primary', { ...reference, regionId: nativeRegionId })
      } else {
        delete host.dataset.workbenchRegionReference
      }
      setPlacedHostId(destinationId)
      // Confirm the actual placement before describing it. Pending targets retain
      // the original View; a destination hint alone does not prove it moved.
      setNoticeHome(showHomeNotice && targetId !== null ? document.getElementById(homeId) : null)
      if (switchTarget) tabSwitchObservation.observe(switchTarget)
      return true
    }
    // Keep the already-mounted view in its last host while a Focus slot arrives.
    // Initial restoration has a private parking host, never a second view tree.
    if (!host.isConnected && parking.current) parking.current.append(host)
    if (attach()) return
    const observer = new MutationObserver(() => { if (attach()) observer.disconnect() })
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }) // The original layout can replace a slot without changing its exact address.
  useLayoutEffect(() => () => host.remove(), [host])
  return <WorkbenchReadingSnapshot host={host} active={active} visible={visible}><WorkbenchPresentationContext.Provider value={presentation}>
    <div ref={parking} className="retained-workbench-parking" aria-hidden="true" inert />{createPortal(children, host)}
    {targetId !== null && noticeHome && homeNotice ? createPortal(homeNotice, noticeHome) : null}
  </WorkbenchPresentationContext.Provider></WorkbenchReadingSnapshot>
}
