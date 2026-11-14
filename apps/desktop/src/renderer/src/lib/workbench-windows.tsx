import { mintObjectId } from '@agentmux/core/object-id'
import { observeResolvedTheme } from '@agentmux/client-ui/theme'
import { updateIconSprite, removeIconSprite } from '@agentmux/client-ui/icons'
import { useNativeOverlayChrome } from '../hooks/useNativeOverlayChrome'
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { AppWindowDescriptor, AppWindowTarget, AppWindowOperation, AppWindowPage } from '@agentmux/core/control'
import { readWorkbenchReturnContext, type WorkbenchReturnContext, type WorkbenchWindowRequest, type WorkbenchWindowDocument, type WorkbenchWindowStage } from '../../../shared/workbench-windows'
import { api } from './api'
import { useAppStore } from '../store'
import { awaitOriginalWorkbenchHost, originalWorkbenchHost, placeWorkbenchWindow, registerWorkbenchDocument, workbenchTargetKey, workbenchDocumentReturning, observeWorkbenchNativeVisibility, registerWorkbenchNavigationStamp, workbenchNavigationStamp, type WorkbenchSurface } from './workbench-window-registry'
import { ServiceWindowNotice } from '../components/ServiceWindowNotice'
import { WorkbenchWindowNotice } from '../components/WorkbenchWindowNotice'

type OpenWindow = { window: Window; document: Document; identity: WorkbenchWindowDocument; target: AppWindowTarget; returnContext: WorkbenchReturnContext | null; slot: HTMLElement; returned: boolean; dispose(): void }
const opened = new Map<string, OpenWindow>()
// Only unfinished original open calls retain their provenance until Main captures it.
const openingContexts = new Map<string, { target: AppWindowTarget; context: WorkbenchReturnContext | null }>()
function settleOpeningContext(operation: AppWindowOperation | null): void {
  if (operation?.method === 'app.window.open' && (operation.state === 'confirmed' || operation.state === 'rejected')) openingContexts.delete(operation.input.operationId)
}
const listeners = new Set<() => void>()
let snapshot: { windows: AppWindowDescriptor[]; issue: string | null; operations: AppWindowOperation[] } = { windows: [], issue: null, operations: [] }
/** Unresolved receipts retain their original identity; unrelated success cannot settle them. */
function observeOperation(operation: AppWindowOperation | null | undefined): void {
  if (!operation) return
  settleOpeningContext(operation)
  const operations = snapshot.operations.filter(original => original.input.operationId !== operation.input.operationId)
  if (operation.state === 'unknown' || operation.state === 'pending') operations.push(operation)
  if (operation.state === 'rejected') useAppStore.getState().reportError(operation.message ?? 'The original window action was refused.', {
    kind: 'indeterminate', summary: 'Window action refused', event: { source: 'workbench-window', key: operation.input.operationId }
  })
  snapshot = { ...snapshot, operations }
}
// Request-local observations prevent an older invoke/read response from undoing
// a newer push receipt. They are released with the request, not kept as history.
const reads = new Set<{ operationId: string; receipt?: AppWindowOperation }>()
async function readWindowPage(operationId: string, call: () => Promise<AppWindowPage>): Promise<AppWindowPage> {
  const request = { operationId } as { operationId: string; receipt?: AppWindowOperation }, windows = snapshot.windows
  reads.add(request)
  try {
    const page = await call()
    if (!request.receipt) observeOperation(page.recordedOperation)
    if (snapshot.windows === windows) snapshot = { ...snapshot, windows: page.windows }
    notify()
    return { ...page, windows: snapshot.windows, recordedOperation: request.receipt ?? page.recordedOperation }
  } finally { reads.delete(request) }
}
type WindowTarget = Pick<AppWindowDescriptor, 'windowId' | 'target'>
let windowTargets: readonly WindowTarget[] = []
const notify = () => {
  const targets = snapshot.windows.filter(window => window.target).map(({ windowId, target }) => ({ windowId, target }))
  // Native geometry/focus observations do not remount unrelated workfaces.
  if (JSON.stringify(targets) !== JSON.stringify(windowTargets)) windowTargets = targets
  snapshot = { ...snapshot }; for (const listener of listeners) listener()
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) }
const publishIssue = (error: unknown) => { snapshot = { ...snapshot, issue: String(error) }; notify() }
let contextNavigator: ((context: WorkbenchReturnContext) => void) | null = null
/** Reuse the original App navigation owner, without another selection or focus Store. */
export function revealWorkbenchContext(context: WorkbenchReturnContext): void {
  if (contextNavigator) contextNavigator(context)
  else publishIssue('The original scene navigation owner is unavailable. The original page and current selection remain.')
}

export async function openWorkbenchWindow(target: AppWindowTarget, options: { focus?: boolean; returnContext?: WorkbenchReturnContext | null } = {}): Promise<void> {
  const operationId = mintObjectId(), context = readWorkbenchReturnContext(options.returnContext, target)
  if (Object.hasOwn(options, 'returnContext')) openingContexts.set(operationId, { target: structuredClone(target), context })
  try {
    await readWindowPage(operationId, () => api.ui.workbenchWindows.call('app.window.open', { operationId, target, ...(options.focus === undefined ? {} : { focus: options.focus }) }))
  } catch (error) { publishIssue(error) }
}
export function workbenchFocusUnavailable(surface: WorkbenchSurface): false {
  publishIssue(`The original ${surface === 'survey' ? 'Survey' : 'Recall'} window could not confirm focus. Its selection is kept. Show the window again to bring it forward.`)
  return false
}
export async function focusWorkbenchWindow(identity: WorkbenchWindowDocument): Promise<boolean> {
  try {
    const operationId = mintObjectId()
    const page = await readWindowPage(operationId, () => api.ui.workbenchWindows.call('app.window.focus', { operationId, ...identity }))
    return page.recordedOperation?.state === 'confirmed'
  } catch (error) { publishIssue(error); return false }
}
export async function returnWorkbenchWindow(identity: WorkbenchWindowDocument): Promise<void> {
  try {
    const operationId = mintObjectId()
    await readWindowPage(operationId, () => api.ui.workbenchWindows.call('app.window.return', { operationId, ...identity }))
  } catch (error) { publishIssue(error) }
}
/** Native page destruction has already retired these Regions; close only their borrowed shells. */
export async function returnClosedWorkbenchWindows(regions: readonly { tabId: string; regionId: string }[]): Promise<void> {
  for (const record of opened.values()) {
    const target = record.target
    if (record.returned || target.kind === 'surface' || !regions.some(region => region.tabId === target.tabId &&
      (target.kind === 'region' ? region.regionId === target.regionId : !useAppStore.getState().tabs[target.tabId]))) continue
    await returnWorkbenchWindow(record.identity)
  }
}
function validateTarget(target: AppWindowTarget): void {
  if (target.kind === 'surface') return
  const state = useAppStore.getState(), group = state.layouts[target.displayWorkspaceId]?.groups.find(group => group.id === target.groupId)
  const tab = state.tabs[target.tabId]
  if (!group?.tabOrder.includes(target.tabId) || !tab || target.kind === 'region' && !Object.hasOwn(tab.regions, target.regionId)) {
    throw new Error('That original display occurrence is not present in the recovered spatial state. Original workfaces and Sessions remain.')
  }
}
function awaitComposition(host: HTMLElement, signal: AbortSignal): Promise<void> {
  const doc = host.ownerDocument
  // The document event owner records real composition events, not input text.
  if (!composing.has(doc)) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const finish = () => { cleanup(); resolve() }
    const aborted = () => { cleanup(); reject(new Error('Original composition remains in its workface; window observation ended.')) }
    const cleanup = () => { doc.removeEventListener('compositionend', finish); signal.removeEventListener('abort', aborted) }
    doc.addEventListener('compositionend', finish, { once: true }); signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
  })
}
const composing = new WeakSet<Document>()
function documentEvents(doc: Document): () => void {
  const start = () => composing.add(doc), end = () => composing.delete(doc)
  doc.addEventListener('compositionstart', start, true); doc.addEventListener('compositionend', end, true)
  return () => { doc.removeEventListener('compositionstart', start, true); doc.removeEventListener('compositionend', end, true); composing.delete(doc) }
}
function mirrorStyles(child: Document): () => void {
  const nodes = new Map<Element, Element>()
  const sync = () => {
    const originals = new Set(document.head.querySelectorAll('style,link[rel="stylesheet"]'))
    for (const [original, copy] of nodes) if (!originals.has(original)) { copy.remove(); nodes.delete(original) }
    for (const original of originals) {
      let copy = nodes.get(original)
      if (!copy) { copy = original.cloneNode(true) as Element; nodes.set(original, copy); child.head.append(copy) }
      else if (copy.outerHTML !== original.outerHTML) { const next = original.cloneNode(true) as Element; copy.replaceWith(next); nodes.set(original, next) }
    }
    for (const name of child.documentElement.getAttributeNames()) if (!document.documentElement.hasAttribute(name)) child.documentElement.removeAttribute(name)
    for (const attribute of document.documentElement.attributes) child.documentElement.setAttribute(attribute.name, attribute.value)
  }
  sync()
  const disposeTheme = observeResolvedTheme(theme => updateIconSprite(child, theme.value, theme.variant.colors.text))
  const observer = new MutationObserver(sync)
  observer.observe(document.head, { childList: true, subtree: true, characterData: true, attributes: true })
  observer.observe(document.documentElement, { attributes: true })
  return () => { observer.disconnect(); disposeTheme(); removeIconSprite(child) }
}
async function shellLoaded(child: Window, signal: AbortSignal): Promise<HTMLElement> {
  return new Promise((resolve, reject) => {
    const check = () => {
      if (child.closed) { cleanup(); reject(new Error('The original native shell ended before loading. Original content remains.')); return }
      try { const slot = child.document.getElementById('workbench-window-root'); if (child.document.readyState === 'complete' && slot) { cleanup(); resolve(slot) } }
      catch (error) { cleanup(); reject(error) }
    }
    const aborted = () => { cleanup(); reject(new Error('Original window document loading ended before confirmation.')) }
    const interval = setInterval(check, 25)
    const cleanup = () => { clearInterval(interval); signal.removeEventListener('abort', aborted) }
    signal.addEventListener('abort', aborted, { once: true }); if (signal.aborted) aborted(); else check()
  })
}
function returnNavigationStamp(): string {
  const state = useAppStore.getState()
  return JSON.stringify([state.mainSurface, state.activeWorkspaceId, state.workbenchSpaceSelection, state.surveyZoneSelection, state.focusView])
}
async function apply(request: WorkbenchWindowRequest, signal: AbortSignal, onReturn?: (context: WorkbenchReturnContext) => void, onReturnSurface?: (surface: WorkbenchSurface) => void): Promise<WorkbenchReturnContext | null | void> {
  const progress = (stage: WorkbenchWindowStage) => api.ui.workbenchWindows.respond({ requestId: request.requestId,
    windowId: request.windowId, documentGeneration: request.documentGeneration, outcome: 'pending', stage, message: null })
  const navigationAtStart = returnNavigationStamp(), localNavigationAtStart = workbenchNavigationStamp()
  if (request.action === 'return' && request.target.kind !== 'surface' && !originalWorkbenchHost(request.target)) {
    const record = opened.get(request.windowId)
    if (!record || record.identity.documentGeneration !== request.documentGeneration) throw new Error('The exact original window document is not current.')
    const tab = useAppStore.getState().tabs[request.target.tabId]
    if (!tab || request.target.kind === 'region' && !Object.hasOwn(tab.regions, request.target.regionId)) { record.returned = true; notify(); return }
  }
  validateTarget(request.target)
  progress('host')
  const host = await awaitOriginalWorkbenchHost(request.target, signal)
  if (request.action === 'prepare') {
    try {
      const retained = request.operationId ? openingContexts.get(request.operationId) : undefined
      const context = readWorkbenchReturnContext(retained && workbenchTargetKey(retained.target) === workbenchTargetKey(request.target)
        ? retained.context : host.getReturnContext?.(), request.target)
      return context
    } catch (error) { publishIssue('Original return-context observation failed. The original window remains available. ' + String(error)); return null }
  }
  const identity = { windowId: request.windowId, documentGeneration: request.documentGeneration }
  if (request.action === 'open') {
    const existing = opened.get(request.windowId)
    if (existing) {
      if (existing.identity.documentGeneration !== request.documentGeneration || workbenchTargetKey(existing.target) !== workbenchTargetKey(request.target)) throw new Error('Original window document identity has changed.')
      return
    }
    progress('composition')
    await awaitComposition(host.host, signal)
    const child = window.open(request.url, request.frameName)
    if (!child) throw new Error('The exact native workface window was refused. Original content remains.')
    progress('shell')
    const slot = await shellLoaded(child, signal)
    slot.id = 'workbench-window-' + request.windowId
    slot.dataset.workbenchDocumentRoot = ''
    child.document.body.classList.add('workbench-detached-window')
    const disposeStyle = mirrorStyles(child.document), disposeDocument = registerWorkbenchDocument(child.document, identity), disposeEvents = documentEvents(child.document)
    const record: OpenWindow = { window: child, document: child.document, identity, target: request.target, returnContext: readWorkbenchReturnContext(request.returnContext, request.target), slot, returned: false, dispose: () => { disposeStyle(); disposeDocument(); disposeEvents() } }
    opened.set(request.windowId, record); child.addEventListener('unload', () => { if (opened.get(request.windowId) === record) { record.dispose(); notify() } }, { once: true }); notify()
    progress('placement')
    await placeWorkbenchWindow(request.target, { destination: slot, window: identity, returnContext: record.returnContext })
    return
  }
  const record = opened.get(request.windowId)
  if (!record && request.action === 'return' && host.host.ownerDocument === document) return
  if (!record || record.identity.documentGeneration !== request.documentGeneration || workbenchTargetKey(record.target) !== workbenchTargetKey(request.target)) throw new Error('The exact original window document is not current.')
  if (request.action === 'focus') {
    if (record.returned || host.host.ownerDocument !== record.document) throw new Error('The original content has returned from this native shell. Focus its current workface.')
    return
  }
  if (!record.returned) {
    progress('composition')
    await awaitComposition(host.host, signal)
    // Explicit Return owns its original scene; a delayed/automatic return never supersedes later navigation.
    const context = readWorkbenchReturnContext(request.returnContext, request.target)
    if (request.navigate === true && returnNavigationStamp() === navigationAtStart && workbenchNavigationStamp() === localNavigationAtStart) {
      if (request.target.kind === 'surface') onReturnSurface?.(request.target.surface)
      else if (context && onReturn) onReturn(context)
      else if (context) publishIssue('The original workface is returning. Its navigation owner is unavailable; current navigation is kept.')
    }
    progress('placement')
    await placeWorkbenchWindow(request.target, null)
    workbenchDocumentReturning(record.document, document); record.returned = true; notify()
  }
}

/** One original Renderer owns every shell; no child starts an App or Store. */
export function useWorkbenchWindows(ready: boolean, onReturn?: (context: WorkbenchReturnContext) => void, localNavigationStamp?: object, onReturnSurface?: (surface: WorkbenchSurface) => void): readonly WindowTarget[] {
  const navigator = useRef(onReturn), surfaceNavigator = useRef(onReturnSurface), localNavigation = useRef(localNavigationStamp)
  useLayoutEffect(() => { navigator.current = onReturn; surfaceNavigator.current = onReturnSurface; localNavigation.current = localNavigationStamp })
  useLayoutEffect(() => ready ? registerWorkbenchNavigationStamp(() => localNavigation.current) : undefined, [ready])
  const windows = useSyncExternalStore(subscribe, () => windowTargets)
  useEffect(() => {
    if (!ready) return
    const abort = new AbortController()
    const navigate = (context: WorkbenchReturnContext) => {
      if (navigator.current) navigator.current(context)
      else publishIssue('The original scene navigation owner is unavailable. The original page and current selection remain.')
    }
    contextNavigator = navigate
    const rootEvents = documentEvents(document)
    let rootDocument: (() => void) | null = null
    const stopRequests = api.ui.workbenchWindows.onRequest(request => {
      void apply(request, abort.signal, navigate, surface => surfaceNavigator.current?.(surface)).then(returnContext => api.ui.workbenchWindows.respond({ requestId: request.requestId, windowId: request.windowId, documentGeneration: request.documentGeneration, outcome: 'applied', message: null,
        ...(request.action === 'prepare' ? { returnContext: returnContext ?? null } : {}) }),
        error => { api.ui.workbenchWindows.respond({ requestId: request.requestId, windowId: request.windowId, documentGeneration: request.documentGeneration, outcome: 'rejected', message: String(error) }) })
    })
    const stopChanges = api.ui.workbenchWindows.onChanged(value => {
      if (value.recordedOperation) for (const request of reads) if (request.operationId === value.recordedOperation.input.operationId) request.receipt = value.recordedOperation
      observeOperation(value.recordedOperation)
      snapshot = { ...snapshot, windows: value.windows, issue: value.issue }; observeWorkbenchNativeVisibility(value.windows)
      for (const [id, record] of opened) if (record.returned && (!value.windows.some(window => window.windowId === id) || record.window.closed)) { record.dispose(); opened.delete(id) }
      notify()
    })
    void api.ui.workbenchWindows.ready().then(identity => { if (identity && !abort.signal.aborted) rootDocument = registerWorkbenchDocument(document, identity) }).catch(publishIssue)
    return () => { if (contextNavigator === navigate) contextNavigator = null; abort.abort(); stopRequests(); stopChanges(); rootEvents(); rootDocument?.(); for (const record of opened.values()) record.dispose(); opened.clear(); notify() }
  }, [ready])
  return windows
}
function WorkbenchWindowOverlayNotice({ record }: { record: OpenWindow }) {
  const warning = useNativeOverlayChrome(record.document, record.identity)
  return warning ? <ServiceWindowNotice notice={{ kind: 'indeterminate', notice: { step: 'Window overlay presentation', mode: warning, restore: 'Keep using the original Browser; close and reopen the floating control.' } }} /> : null
}
export function WorkbenchWindowNotices() {
  const state = useSyncExternalStore(subscribe, () => snapshot)
  // React portals keep the original event/context owner in each empty native shell.
  const windows = [...opened.values()].filter(record => !record.returned)
  const inspect = async (operationId: string) => {
    if (!operationId) return
    try { await readWindowPage(operationId, () => api.ui.workbenchWindows.call('app.window.ls', { operationId })) } catch (error) { publishIssue(error) }
  }
  return <><WorkbenchWindowNotice issue={state.issue} operations={state.operations}>
    {state.operations.map(operation => <details key={operation.input.operationId} className="workbench-window-notice__technical">
      <summary>Window action details · {operation.windowId ?? operation.input.operationId}</summary>
      <pre>{JSON.stringify(operation, null, 2)}</pre>
      <button className="small-button" onClick={() => void inspect(operation.input.operationId)}>Inspect original action</button>
    </details>)}
    {openingContexts.size ? <details className="workbench-window-notice__technical"><summary>Original opening context</summary>
      {[...openingContexts].map(([operationId, original]) => <div key={operationId}><pre>{JSON.stringify({ operationId, target: original.target, returnContext: original.context }, null, 2)}</pre>
        <button className="small-button" onClick={() => void inspect(operationId)}>Inspect original open</button></div>)}
    </details> : null}
    </WorkbenchWindowNotice>
    {windows.map(record => createPortal(<WorkbenchWindowOverlayNotice record={record} />, record.document.body, record.identity.windowId))}</>
}
