import { returnWorkbenchWindow, focusWorkbenchWindow, openWorkbenchWindow } from '../lib/workbench-windows'
import { DesktopClientUiProvider } from './DesktopClientUiProvider'
import { Component, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { MotePresentationContext } from '../lib/mote-presentation-context'
import { WorkbenchPresentationContext, WorkbenchBrowserTargetsContext, type BrowserControlConfirmation } from '../lib/workbench-presentation'
import { workbenchReturnContext } from '../lib/workbench-return-context'
import { workbenchReturnLabel, type WorkbenchReturnSelection } from '../../../shared/workbench-windows'
import { workbenchRegionProjectionSlotId } from '../lib/workbench-projection'
import { tabSwitchObservation } from '../lib/tab-switch-observation'
import { WorkbenchDocumentContext, useWorkbenchDocument } from '../lib/workbench-document'
import { registerWorkbenchHost, workbenchDocumentIdentity, useWorkbenchDocumentVisibility, useWorkbenchSurfaceDocument, type WorkbenchSurface, type WorkbenchWindowPlacement } from '../lib/workbench-window-registry'
import type { AppWindowTarget } from '@agentmux/core/control'
import { markProgrammaticReadingScroll } from '@agentmux/client-ui/reading-scroll'

function isHtmlElement(node: Node | null | undefined): node is HTMLElement {
  return node?.nodeType === 1 && (node as Element).namespaceURI === 'http://www.w3.org/1999/xhtml'
}
type ReadingRange = { start: Node; startOffset: number; end: Node; endOffset: number }
type ReadingScroll = { element: HTMLElement; top: number; left: number }
type ReadingSnapshot = { ranges: ReadingRange[]; scrolls: ReadingScroll[]; activeElement: Element | null; parent: Element | null; interrupted: boolean; dispose(): void }
function captureReadingRanges(host: HTMLElement): ReadingRange[] {
  const selection = host.ownerDocument.getSelection()
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
    let element = isHtmlElement(node) ? node : node?.parentElement
    while (element && host.contains(element)) {
      if (element.scrollTop || element.scrollLeft) scrolls.set(element, { element, top: element.scrollTop, left: element.scrollLeft })
      element = element.parentElement
    }
  }
  return [...scrolls.values()]
}
function restoreReadingRanges(host: HTMLElement, ranges: ReadingRange[], activeElement: Element | null, active: boolean, reparentedWithoutInput = false): void {
  if (!host.isConnected) return
  if (!ranges.every(endpoints => host.contains(endpoints.start) && host.contains(endpoints.end))) return
  const document = host.ownerDocument
  const currentInput = document.activeElement
  const restoreInput = active && currentInput === document.body && isHtmlElement(activeElement) && host.contains(activeElement) &&
    (activeElement.isContentEditable || activeElement.matches('input, textarea, [contenteditable="true"]')) &&
    !activeElement.closest('[hidden], [inert], [aria-hidden="true"]')
  // A scroll-only snapshot has no selection to repair. Keep the original input
  // repair path below, including its protection for a later selection elsewhere.
  if (ranges.length === 0 && !restoreInput) return
  const selection = document.getSelection()
  if (!selection) return
  if (ranges.length === 0 && !selection.isCollapsed && selection.anchorNode && !host.contains(selection.anchorNode)) return
  if (currentInput !== activeElement && isHtmlElement(currentInput) &&
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
    if (!same && (!current.collapsed || current.startContainer.nodeType === 3 && !reparentedWithoutInput)) return
  }
  // Reparenting can blur a live editor to body. Restore only that exact input
  // in an active presentation; a later focused control remains the user's intent.
  if (restoreInput) activeElement.focus({ preventScroll: true })
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
  getSnapshotBeforeUpdate(previous: Readonly<{ host: HTMLElement; active: boolean; visible: boolean; children: ReactNode }>): ReadingSnapshot | null {
    // Snapshot the outgoing presentation, before React moves or hides it.
    // A previously hidden host has no live reading to capture on this commit.
    if (!previous.visible) return null
    const document = this.props.host.ownerDocument
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
  componentDidUpdate(_previous: Readonly<{ host: HTMLElement; active: boolean; visible: boolean; children: ReactNode }>, _state: unknown, snapshot: ReadingSnapshot | null): void {
    if (!snapshot || snapshot.ranges.length === 0 && snapshot.scrolls.length === 0) return
    const host = this.props.host
    const document = host.ownerDocument
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
              if (scroll.element.scrollTop === 0) {
                scroll.element.scrollTop = scroll.top
                markProgrammaticReadingScroll(scroll.element)
              }
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
export function StableWorkbenchView({ homeId, targetId, primaryTabId, nativeRegionId, active, visible = true, retainHiddenPlacement = true, retainedRegionId, homeNotice, surface, moteInputIntent, moteContextKey, survey, controlsOpen, onBrowserControlConfirmation, onSelectRegion, projection, reference, returnSelection, windowTarget, kind = 'tab', children }: {
  homeId: string
  /** Only the unique primary View carries an input-retention identity. */
  primaryTabId?: string | undefined
  /** The original Region leaf supplies its actual identity, not the selected sibling. */
  nativeRegionId?: string | undefined
  kind?: 'tab' | 'region'
  targetId: string | null
  active: boolean
  visible?: boolean
  /** A content-role handoff can require its exact slot even while hidden. Ordinary reading keeps its placement. */
  retainHiddenPlacement?: boolean
  retainedRegionId: string | null
  surface?: import('../lib/workbench-presentation').WorkbenchViewTarget['surface']
  moteInputIntent?: 'main' | 'member' | undefined
  moteContextKey?: string | undefined
  survey?: boolean | undefined
  controlsOpen?: boolean | undefined
  onBrowserControlConfirmation?: BrowserControlConfirmation | undefined
  onSelectRegion?: ((regionId: string) => void) | undefined
  projection?: import('../lib/workbench-projection').WorkbenchProjection | undefined
  reference?: import('../lib/workbench-projection').WorkbenchProjectionSelection | undefined
  /** The window owner requests this exact occurrence without changing the presentation selection. */
  returnSelection?: WorkbenchReturnSelection | undefined
  windowTarget?: AppWindowTarget | undefined
  /** The existing projection owner describes a borrowed View at its original slot. */
  homeNotice?: ReactNode
  children: ReactNode
}) {
  const parentDocument = useWorkbenchDocument()
  const surfaceDocument = useWorkbenchSurfaceDocument(surface)
  const [host] = useState(() => {
    const element = document.createElement('div')
    element.className = kind === 'region' ? 'retained-workbench-region' : 'retained-workbench-view'
    return element
  })
  const [placedHostId, setPlacedHostId] = useState(homeId)
  const wasVisible = useRef(false)
  const [placementRequest, setWindowPlacement] = useState<{ placement: WorkbenchWindowPlacement | null; revision: number }>({ placement: null, revision: 0 })
  const windowPlacement = placementRequest.placement
  const placementRevision = useRef(0)
  const [hostDocument, setHostDocument] = useState(host.ownerDocument)
  const placementWaiters = useRef<Array<{ placement: WorkbenchWindowPlacement | null; resolve(): void; reject(error: Error): void }>>([])
  const frozenTarget = useRef<AppWindowTarget | null>(null)
  const originalTarget = useMemo<AppWindowTarget | null>(() => frozenTarget.current ?? windowTarget ?? (reference && (kind === 'region' ? nativeRegionId : primaryTabId)
    ? kind === 'region' ? { kind: 'region', displayWorkspaceId: reference.displayWorkspaceId, groupId: reference.groupId, tabId: reference.tabId, regionId: nativeRegionId! }
      : { kind: 'tab', displayWorkspaceId: reference.displayWorkspaceId, groupId: reference.groupId, tabId: reference.tabId }
    : null), [kind, nativeRegionId, primaryTabId, reference?.displayWorkspaceId, reference?.groupId, reference?.tabId, windowTarget])
  const returnTargets = useContext(WorkbenchBrowserTargetsContext)
  const returnHint = useRef({ surface, survey, projection, reference, returnSelection, returnTargets, windowPlacement })
  useLayoutEffect(() => { returnHint.current = { surface, survey, projection, reference, returnSelection, returnTargets, windowPlacement } })
  useLayoutEffect(() => {
    if (!originalTarget) return
    return registerWorkbenchHost({ target: originalTarget, host, getReturnContext: () => {
      if (originalTarget.kind === 'surface') return null
      const hint = returnHint.current
      if (hint.windowPlacement) return workbenchReturnContext({ ...hint, returnContext: hint.windowPlacement.returnContext ?? null },
        hint.reference && originalTarget.kind === 'region' ? { ...hint.reference, regionId: originalTarget.regionId } : hint.reference)
      // Repeatable Browser content can keep its canonical tree parked in Space.
      // Its unique visible occurrence, rather than that parking owner, is origin.
      const sources = hint.returnTargets.filter(source => source.visible === true && source.reference &&
        source.reference.displayWorkspaceId === originalTarget.displayWorkspaceId && source.reference.groupId === originalTarget.groupId &&
        source.reference.tabId === originalTarget.tabId && (originalTarget.kind === 'tab' || source.projection?.entity.kind !== 'region' ||
          source.projection.entity.regionId === originalTarget.regionId))
      if (sources.length === 1) {
        const source = sources[0]!, reference = source.reference!
        return workbenchReturnContext(source, originalTarget.kind === 'region' ? { ...reference, regionId: originalTarget.regionId } : reference)
      }
      if (hint.returnTargets.length) return null
      return workbenchReturnContext(hint, hint.reference && originalTarget.kind === 'region'
        ? { ...hint.reference, regionId: originalTarget.regionId } : hint.reference)
    }, place: placement => new Promise<void>((resolve, reject) => {
      frozenTarget.current = placement ? originalTarget : null
      placementWaiters.current.push({ placement, resolve, reject })
      // An equal desired value still requires its own physical placement commit.
      setWindowPlacement({ placement, revision: ++placementRevision.current })
    }) })
  }, [originalTarget, host])
  useLayoutEffect(() => () => { for (const waiter of placementWaiters.current.splice(0)) waiter.reject(new Error('Original workface host departed before placement confirmation.')) }, [])
  const documentVisible = useWorkbenchDocumentVisibility(hostDocument)
  const windowActive = windowPlacement !== null
  const presentedActive = (windowActive || active) && documentVisible
  const presentedVisible = (windowActive || visible) && documentVisible
  const documentContext = useMemo(() => ({ document: hostDocument, window: windowPlacement?.window ?? workbenchDocumentIdentity(hostDocument) }), [hostDocument, windowPlacement])
  const displayReference = useMemo(() => windowPlacement && frozenTarget.current && frozenTarget.current.kind !== 'surface' && reference
    ? { ...reference, displayWorkspaceId: frozenTarget.current.displayWorkspaceId, groupId: frozenTarget.current.groupId, tabId: frozenTarget.current.tabId,
      ...(frozenTarget.current.kind === 'region' ? { regionId: frozenTarget.current.regionId } : {}) } : reference, [windowPlacement, reference])
  const presentation = useMemo(() => ({ active: presentedActive, retainedRegionId, tabHostId: placedHostId, surface, returnSelection, ...(windowPlacement ? { returnContext: windowPlacement.returnContext ?? null } : {}), moteInputIntent, moteContextKey, survey, controlsOpen, onBrowserControlConfirmation, onSelectRegion, projection, reference: displayReference }),
    [presentedActive, retainedRegionId, placedHostId, surface, returnSelection, windowPlacement, moteInputIntent, moteContextKey, survey, controlsOpen, onBrowserControlConfirmation, onSelectRegion, projection, displayReference])
  const parking = useRef<HTMLDivElement>(null)
  const showHomeNotice = Boolean(homeNotice)
  const [noticeHome, setNoticeHome] = useState<HTMLElement | null>(null)
  const switchTarget = useMemo(() => reference ? { ...reference, presentationId: projection?.presentationId ?? surface ?? 'space' } : null,
    [reference?.displayWorkspaceId, reference?.groupId, reference?.tabId, reference?.regionId, projection?.presentationId, surface])
  // Reveal and spatial moves update this owner; cleanup means its exact identity departed.
  const placementFacts = useRef({ visible, destinationId: targetId ?? homeId })
  useLayoutEffect(() => { placementFacts.current = { visible, destinationId: targetId ?? homeId } }, [visible, targetId, homeId])
  useLayoutEffect(() => {
    if (!switchTarget || (kind === 'region') !== (projection?.entity.kind === 'region')) return
    return tabSwitchObservation.registerPlacement(switchTarget, () => placementFacts.current.visible && host.isConnected &&
      host.parentElement?.id === placementFacts.current.destinationId && !host.closest('[hidden], [inert]'))
  }, [switchTarget, kind, projection?.entity.kind, host])
  useLayoutEffect(() => {
    const destinationId = windowPlacement?.destination.id ?? targetId ?? homeId
    const attach = () => {
      if (placementRequest.revision !== placementRevision.current) return false
      // A Region's exact home is its sibling slot, including while its parent
      // View is being reparented. It need not wait in inert parking for body lookup.
      const siblingHome = kind === 'region' && targetId === null
        ? Array.from(parking.current?.parentElement?.children ?? []).find(element => element.id === destinationId) : undefined
      const destination = windowPlacement?.destination ?? siblingHome ?? host.ownerDocument.getElementById(destinationId) ?? parentDocument.getElementById(destinationId) ?? surfaceDocument.getElementById(destinationId) ?? document.getElementById(destinationId)
      if (!destination) return false
      if (host.parentElement !== destination) {
        // The pre-mutation owner protects same-document reading. This late
        // snapshot is consumed only when adoption crosses native documents;
        // reading selection or scroll here otherwise flushes unused layout.
        const oldDocument = host.ownerDocument
        const crossDocument = oldDocument !== destination.ownerDocument
        const parent = host.parentElement
        // A live hidden View need not be moved back into an inert home. That
        // browser move destroys its scroll/selection even with moveBefore.
        // Keep the actual placement until reveal; explicit/window and detached
        // placements still run below and keep their original confirmations.
        if (retainHiddenPlacement && !presentedVisible && wasVisible.current && !crossDocument && host.isConnected && parent?.isConnected && parent.id === placedHostId &&
          oldDocument.getElementById(placedHostId) === parent &&
          !windowPlacement && placementWaiters.current.length === 0) return true
        const hadDocumentFocus = crossDocument && oldDocument.hasFocus()
        const ranges = crossDocument ? captureReadingRanges(host) : []
        const activeElement = crossDocument ? oldDocument.activeElement : null
        const scrolls = crossDocument ? captureReadingScrolls(host, ranges, activeElement) : []
        // Connected moves preserve the existing editor focus and browser state.
        // A detached slot still needs insertion before its parent can attach.
        if (crossDocument) { destination.ownerDocument.adoptNode(host); destination.append(host) }
        else if (host.isConnected && destination.isConnected) destination.moveBefore(host, null)
        else destination.append(host)
        if (crossDocument) for (const scroll of scrolls) { scroll.element.scrollTop = scroll.top; scroll.element.scrollLeft = scroll.left; markProgrammaticReadingScroll(scroll.element) }
        setHostDocument(host.ownerDocument)
        if (crossDocument && presentedVisible) restoreReadingRanges(host, ranges, activeElement, presentedActive && hadDocumentFocus, true)
      }
      if (kind === 'tab' && displayReference) {
        host.dataset.workbenchViewReference = workbenchRegionProjectionSlotId('view', displayReference)
      } else {
        delete host.dataset.workbenchViewReference
      }
      if (primaryTabId && displayReference?.tabId === primaryTabId) {
        host.dataset.workbenchPrimaryTabId = primaryTabId
        host.dataset.workbenchPrimaryReference = workbenchRegionProjectionSlotId('primary', displayReference)
      } else {
        delete host.dataset.workbenchPrimaryTabId
        delete host.dataset.workbenchPrimaryReference
      }
      if (kind === 'region' && displayReference && nativeRegionId) {
        host.dataset.workbenchRegionReference = workbenchRegionProjectionSlotId('primary', { ...displayReference, regionId: nativeRegionId })
      } else {
        delete host.dataset.workbenchRegionReference
      }
      setHostDocument(host.ownerDocument)
      setPlacedHostId(destinationId)
      if (presentedVisible && host.isConnected && host.parentElement === destination) wasVisible.current = true
      if (placementWaiters.current.length && hostDocument === host.ownerDocument && placedHostId === destinationId) {
        // A committed DOM placement is applied even when its document cannot paint.
        queueMicrotask(() => {
          if (placementRequest.revision !== placementRevision.current || host.parentElement !== destination || host.ownerDocument !== hostDocument) return
          for (const waiter of placementWaiters.current.splice(0)) {
            if (waiter.placement?.destination === windowPlacement?.destination &&
              waiter.placement?.window.windowId === windowPlacement?.window.windowId &&
              waiter.placement?.window.documentGeneration === windowPlacement?.window.documentGeneration) waiter.resolve()
            else waiter.reject(new Error('A later placement replaced this original workface placement before confirmation.'))
          }
        })
      }
      // Confirm the actual placement before describing it. Pending targets retain
      // the original View; a destination hint alone does not prove it moved.
      setNoticeHome(windowPlacement || showHomeNotice && targetId !== null ? document.getElementById(homeId) : null)
      if (switchTarget) tabSwitchObservation.observe(switchTarget)
      return true
    }
    // Keep the already-mounted view in its last host while a Focus slot arrives.
    // Initial restoration has a private parking host, never a second view tree.
    if (!host.isConnected && parking.current) parking.current.append(host)
    if (attach()) return
    const observer = new MutationObserver(() => { if (attach()) observer.disconnect() })
    for (const doc of new Set([document, parentDocument, surfaceDocument, host.ownerDocument])) {
      observer.observe(doc.body, { childList: true, subtree: true })
    }
    return () => observer.disconnect()
  }) // The original layout can replace a slot without changing its exact address.
  useLayoutEffect(() => () => host.remove(), [host])
  const content = <WorkbenchDocumentContext.Provider value={documentContext}><WorkbenchPresentationContext.Provider value={presentation}>
    <div ref={parking} className="retained-workbench-parking" aria-hidden="true" inert />{createPortal(<DesktopClientUiProvider document={hostDocument}><MotePresentationContext contextKey={moteContextKey} isolated={surface === 'mote'}>{children}</MotePresentationContext></DesktopClientUiProvider>, host)}
    {windowPlacement && noticeHome ? createPortal(<div className="workbench-restore-notice" role="status">{originalTarget?.kind === 'surface' ? (originalTarget.surface === 'survey' ? 'Survey is open in its own window.' : 'Recall is open in its own window.') : `Original ${kind === 'tab' ? 'Tab' : 'Region'} is in its independent window.`}
      <button className="small-button" onClick={() => void focusWorkbenchWindow(windowPlacement.window)}>Show window</button>
      <button className="small-button" onClick={() => void returnWorkbenchWindow(windowPlacement.window)}>{originalTarget?.kind === 'surface' ? 'Return to main window' : workbenchReturnLabel(windowPlacement.returnContext)}</button>
      {originalTarget && workbenchDocumentIdentity(windowPlacement.destination.ownerDocument) === null ? <button className="small-button" onClick={() => void openWorkbenchWindow(originalTarget)}>Recover original window</button> : null}
    </div>, noticeHome) : targetId !== null && noticeHome && homeNotice ? createPortal(homeNotice, noticeHome) : null}
  </WorkbenchPresentationContext.Provider></WorkbenchDocumentContext.Provider>
  // A whole surface stays in its own permanent slot until native transfer. Its
  // cross-document move captures reading once, at attach, for the actual move.
  if (originalTarget?.kind === 'surface') return content
  return <WorkbenchReadingSnapshot host={host} active={presentedActive} visible={presentedVisible}>{content}</WorkbenchReadingSnapshot>
}

/** A knowledge surface keeps its mounted directory, editor and navigation owners across native windows. */
export function WorkbenchSurfaceHost({ surface, homeId, visible, children }: {
  surface: WorkbenchSurface; homeId: string; visible: boolean; children: ReactNode
}) {
  const target = useMemo(() => ({ kind: 'surface' as const, surface }), [surface])
  return <StableWorkbenchView homeId={homeId} targetId={null} active={visible} visible={visible} retainedRegionId={null}
    surface={surface} windowTarget={target}>{children}</StableWorkbenchView>
}
