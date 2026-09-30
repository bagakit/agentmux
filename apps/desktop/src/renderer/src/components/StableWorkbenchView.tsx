import { Component, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { WorkbenchPresentationContext, type BrowserControlConfirmation } from '../lib/workbench-presentation'

type ReadingRange = { start: Node; startOffset: number; end: Node; endOffset: number }
type ReadingSnapshot = { ranges: ReadingRange[]; activeElement: Element | null }
function captureReadingRanges(host: HTMLElement): ReadingRange[] {
  const selection = document.getSelection()
  return selection ? Array.from({ length: selection.rangeCount }, (_, index) => {
    const range = selection.getRangeAt(index)
    return host.contains(range.startContainer) && host.contains(range.endContainer)
      ? { start: range.startContainer, startOffset: range.startOffset, end: range.endContainer, endOffset: range.endOffset }
      : null
  }).filter((range): range is ReadingRange => range !== null) : []
}
function restoreReadingRanges(host: HTMLElement, ranges: ReadingRange[], activeElement: Element | null): void {
  const selection = document.getSelection()
  if (!selection || ranges.length === 0 || !host.isConnected) return
  if (!ranges.every(endpoints => host.contains(endpoints.start) && host.contains(endpoints.end))) return
  const currentInput = document.activeElement
  if (currentInput !== activeElement && currentInput instanceof HTMLElement &&
    (currentInput.matches('input, textarea') || currentInput.isContentEditable)) return
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
    if (!same && (!current.collapsed || current.startContainer.nodeType === Node.TEXT_NODE)) return
  }
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
class WorkbenchReadingSnapshot extends Component<{ host: HTMLElement; children: ReactNode }> {
  getSnapshotBeforeUpdate(): ReadingSnapshot { return { ranges: captureReadingRanges(this.props.host), activeElement: document.activeElement } }
  componentDidUpdate(_previous: Readonly<{ host: HTMLElement; children: ReactNode }>, _state: unknown, snapshot: ReadingSnapshot): void {
    if (snapshot.ranges.length === 0) return
    const host = this.props.host
    // The parent layout effect reattaches this same host during this commit.
    queueMicrotask(() => restoreReadingRanges(host, snapshot.ranges, snapshot.activeElement))
  }
  render(): ReactNode { return this.props.children }
}

/** One React/terminal tree; only its existing DOM host changes spatial parent. */
export function StableWorkbenchView({ homeId, targetId, active, retainedRegionId, homeNotice, survey, controlsOpen, onBrowserControlConfirmation, onSelectRegion, projection, reference, kind = 'tab', children }: {
  homeId: string
  kind?: 'tab' | 'region'
  targetId: string | null
  active: boolean
  retainedRegionId: string | null
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
  const presentation = useMemo(() => ({ active, retainedRegionId, tabHostId: targetId ?? homeId, survey, controlsOpen, onBrowserControlConfirmation, onSelectRegion, projection, reference }),
    [active, retainedRegionId, targetId, homeId, survey, controlsOpen, onBrowserControlConfirmation, onSelectRegion, projection, reference])
  const parking = useRef<HTMLDivElement>(null)
  const showHomeNotice = Boolean(homeNotice)
  const [noticeHome, setNoticeHome] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    const destinationId = targetId ?? homeId
    const attach = () => {
      const destination = document.getElementById(destinationId)
      if (!destination) return false
      if (host.parentElement !== destination) {
        // Reparenting an existing DOM host collapses Chromium's live Range.
        // Snapshot node endpoints, not cloned live Ranges, for this one move.
        const ranges = captureReadingRanges(host), activeElement = document.activeElement
        destination.append(host)
        restoreReadingRanges(host, ranges, activeElement)
      }
      // Confirm the actual placement before describing it. Pending targets retain
      // the original View; a destination hint alone does not prove it moved.
      setNoticeHome(showHomeNotice && targetId !== null ? document.getElementById(homeId) : null)
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
  return <WorkbenchReadingSnapshot host={host}><WorkbenchPresentationContext.Provider value={presentation}>
    <div ref={parking} className="retained-workbench-parking" aria-hidden="true" inert />{createPortal(children, host)}
    {targetId !== null && noticeHome && homeNotice ? createPortal(homeNotice, noticeHome) : null}
  </WorkbenchPresentationContext.Provider></WorkbenchReadingSnapshot>
}
