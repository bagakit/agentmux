import { mintObjectId } from '@agentmux/core/object-id'
import { observeResolvedTheme } from '@agentmux/client-ui/theme'
import { updateIconSprite, removeIconSprite } from '@agentmux/client-ui/icons'
import { useNativeOverlayChrome } from '../hooks/useNativeOverlayChrome'
import { useEffect, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { AppWindowDescriptor, AppWindowTarget, AppWindowOperation } from '@agentmux/core/control'
import type { WorkbenchWindowRequest, WorkbenchWindowDocument } from '../../../shared/workbench-windows'
import { api } from './api'
import { useAppStore } from '../store'
import { awaitOriginalWorkbenchHost, originalWorkbenchHost, placeWorkbenchWindow, registerWorkbenchDocument, workbenchTargetKey, workbenchDocumentReturning, observeWorkbenchNativeVisibility } from './workbench-window-registry'
import { ServiceWindowNotice } from '../components/ServiceWindowNotice'

type OpenWindow = { window: Window; document: Document; identity: WorkbenchWindowDocument; target: AppWindowTarget; slot: HTMLElement; returned: boolean; dispose(): void }
const opened = new Map<string, OpenWindow>()
const listeners = new Set<() => void>()
let snapshot: { windows: AppWindowDescriptor[]; issue: string | null; operation: AppWindowOperation | null } = { windows: [], issue: null, operation: null }
const notify = () => { snapshot = { ...snapshot }; for (const listener of listeners) listener() }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) }
const publishIssue = (error: unknown) => { snapshot = { ...snapshot, issue: String(error) }; notify() }

export async function openWorkbenchWindow(target: AppWindowTarget): Promise<void> {
  try {
    const page = await api.ui.workbenchWindows.call('app.window.open', { operationId: mintObjectId(), target })
    snapshot = { ...snapshot, windows: page.windows, operation: page.recordedOperation }; notify()
    if (page.recordedOperation?.state !== 'confirmed') publishIssue(page.recordedOperation?.message ?? 'Original window presentation is unconfirmed. Original work remains.')
  } catch (error) { publishIssue(error) }
}
export async function focusWorkbenchWindow(identity: WorkbenchWindowDocument): Promise<boolean> {
  try {
    const page = await api.ui.workbenchWindows.call('app.window.focus', { operationId: mintObjectId(), ...identity })
    snapshot = { ...snapshot, windows: page.windows, operation: page.recordedOperation }; notify()
    if (page.recordedOperation?.state !== 'confirmed') publishIssue(page.recordedOperation?.message ?? 'Original window focus is unconfirmed.')
    return page.recordedOperation?.state === 'confirmed'
  } catch (error) { publishIssue(error); return false }
}
export async function returnWorkbenchWindow(identity: WorkbenchWindowDocument): Promise<void> {
  try {
    const page = await api.ui.workbenchWindows.call('app.window.return', { operationId: mintObjectId(), ...identity })
    snapshot = { ...snapshot, windows: page.windows, operation: page.recordedOperation }; notify()
    if (page.recordedOperation?.state !== 'confirmed') publishIssue(page.recordedOperation?.message ?? 'Returning the original workface is unconfirmed. Original work remains.')
  } catch (error) { publishIssue(error) }
}
/** Native page destruction has already retired these Regions; close only their borrowed shells. */
export async function returnClosedWorkbenchWindows(regions: readonly { tabId: string; regionId: string }[]): Promise<void> {
  for (const record of opened.values()) {
    const target = record.target
    if (record.returned || !regions.some(region => region.tabId === target.tabId &&
      (target.kind === 'region' ? region.regionId === target.regionId : !useAppStore.getState().tabs[target.tabId]))) continue
    await returnWorkbenchWindow(record.identity)
  }
}
function validateTarget(target: AppWindowTarget): void {
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
async function apply(request: WorkbenchWindowRequest, signal: AbortSignal): Promise<void> {
  if (request.action === 'return' && !originalWorkbenchHost(request.target)) {
    const record = opened.get(request.windowId)
    if (!record || record.identity.documentGeneration !== request.documentGeneration) throw new Error('The exact original window document is not current.')
    const tab = useAppStore.getState().tabs[request.target.tabId]
    if (!tab || request.target.kind === 'region' && !Object.hasOwn(tab.regions, request.target.regionId)) { record.returned = true; notify(); return }
  }
  validateTarget(request.target)
  if (!originalWorkbenchHost(request.target)) useAppStore.getState().activateTab(request.target.displayWorkspaceId, request.target.groupId, request.target.tabId, 'navigation')
  const host = await awaitOriginalWorkbenchHost(request.target, signal)
  if (request.action === 'prepare') return
  const identity = { windowId: request.windowId, documentGeneration: request.documentGeneration }
  if (request.action === 'open') {
    const existing = opened.get(request.windowId)
    if (existing) {
      if (existing.identity.documentGeneration !== request.documentGeneration || workbenchTargetKey(existing.target) !== workbenchTargetKey(request.target)) throw new Error('Original window document identity has changed.')
      return
    }
    await awaitComposition(host.host, signal)
    const child = window.open(request.url, request.frameName)
    if (!child) throw new Error('The exact native workface window was refused. Original content remains.')
    const slot = await shellLoaded(child, signal)
    slot.id = 'workbench-window-' + request.windowId
    slot.dataset.workbenchDocumentRoot = ''
    child.document.body.classList.add('workbench-detached-window')
    const disposeStyle = mirrorStyles(child.document), disposeDocument = registerWorkbenchDocument(child.document, identity), disposeEvents = documentEvents(child.document)
    const record: OpenWindow = { window: child, document: child.document, identity, target: request.target, slot, returned: false, dispose: () => { disposeStyle(); disposeDocument(); disposeEvents() } }
    opened.set(request.windowId, record); child.addEventListener('unload', () => { if (opened.get(request.windowId) === record) { record.dispose(); notify() } }, { once: true }); notify()
    try { await placeWorkbenchWindow(request.target, { destination: slot, window: identity }) }
    catch (error) { publishIssue(error); throw error }
    return
  }
  const record = opened.get(request.windowId)
  if (!record && request.action === 'return' && host.host.ownerDocument === document) return
  if (!record || record.identity.documentGeneration !== request.documentGeneration || workbenchTargetKey(record.target) !== workbenchTargetKey(request.target)) throw new Error('The exact original window document is not current.')
  if (request.action === 'focus') {
    if (record.returned || host.host.ownerDocument !== record.document) throw new Error('The original content has returned from this native shell. Focus its current workface.')
    return
  }
  if (!record.returned) { await awaitComposition(host.host, signal); useAppStore.getState().activateTab(request.target.displayWorkspaceId, request.target.groupId, request.target.tabId, 'navigation'); await placeWorkbenchWindow(request.target, null); workbenchDocumentReturning(record.document, document); record.returned = true; notify() }
}

/** One original Renderer owns every shell; no child starts an App or Store. */
export function useWorkbenchWindows(ready: boolean): void {
  useEffect(() => {
    if (!ready) return
    const abort = new AbortController()
    const rootEvents = documentEvents(document)
    let rootDocument: (() => void) | null = null
    const stopRequests = api.ui.workbenchWindows.onRequest(request => {
      void apply(request, abort.signal).then(() => api.ui.workbenchWindows.respond({ ...request, outcome: 'applied', message: null }),
        error => { publishIssue(error); api.ui.workbenchWindows.respond({ requestId: request.requestId, windowId: request.windowId, documentGeneration: request.documentGeneration, outcome: 'rejected', message: String(error) }) })
    })
    const stopChanges = api.ui.workbenchWindows.onChanged(value => {
      snapshot = { ...snapshot, ...value }; observeWorkbenchNativeVisibility(value.windows)
      for (const [id, record] of opened) if (record.returned && (!value.windows.some(window => window.windowId === id) || record.window.closed)) { record.dispose(); opened.delete(id) }
      notify()
    })
    void api.ui.workbenchWindows.ready().then(identity => { if (identity && !abort.signal.aborted) rootDocument = registerWorkbenchDocument(document, identity) }).catch(publishIssue)
    return () => { abort.abort(); stopRequests(); stopChanges(); rootEvents(); rootDocument?.(); for (const record of opened.values()) record.dispose(); opened.clear(); notify() }
  }, [ready])
}
function WorkbenchWindowToolbar({ record }: { record: OpenWindow }) {
  const warning = useNativeOverlayChrome(record.document, record.identity)
  return <><header className="workbench-window-toolbar"><strong>AgentMux</strong><button className="small-button" onClick={() => void returnWorkbenchWindow(record.identity)}>Return to workspace</button></header>{warning ? <ServiceWindowNotice notice={{ kind: 'indeterminate', notice: { step: 'Window overlay presentation', mode: warning, restore: 'Keep using the original Browser; close and reopen the floating control.' } }} /> : null}</>
}
export function WorkbenchWindowNotices() {
  const state = useSyncExternalStore(subscribe, () => snapshot)
  // React portals keep the original event/context owner in each empty native shell.
  const windows = [...opened.values()].filter(record => !record.returned)
  const inspect = async () => {
    if (!state.operation) return
    try { const page = await api.ui.workbenchWindows.call('app.window.ls', { operationId: state.operation.input.operationId }); snapshot = { ...snapshot, windows: page.windows, operation: page.recordedOperation }; notify() } catch (error) { publishIssue(error) }
  }
  return <>{state.issue ? <ServiceWindowNotice notice={{ kind: 'indeterminate', notice: { step: 'Workbench window presentation needs attention', mode: state.issue, restore: 'Keep using the original workface. Inspect its window or return it before a new move.' } }} actions={state.operation ? <details><summary>Window action details</summary><pre>{JSON.stringify(state.operation, null, 2)}</pre><button className="small-button" onClick={() => void inspect()}>Inspect original action</button></details> : undefined} /> : null}
    {windows.map(record => createPortal(<WorkbenchWindowToolbar record={record} />, record.document.body, record.identity.windowId))}</>
}
