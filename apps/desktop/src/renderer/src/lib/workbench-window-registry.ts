import { useCallback, useSyncExternalStore } from 'react'
import type { AppWindowDescriptor, AppWindowTarget } from '@agentmux/core/control'
import type { WorkbenchReturnContext, WorkbenchWindowDocument } from '../../../shared/workbench-windows'

export type WorkbenchSurface = Extract<AppWindowTarget, { kind: 'surface' }>['surface']
export type WorkbenchWindowPlacement = { destination: HTMLElement; window: WorkbenchWindowDocument; returnContext?: WorkbenchReturnContext | null }
export type WorkbenchHost = {
  target: AppWindowTarget
  host: HTMLElement
  getReturnContext?(): WorkbenchReturnContext | null
  place(placement: WorkbenchWindowPlacement | null): Promise<void>
}
const hosts = new Map<string, WorkbenchHost>()
const placements = new Map<string, WorkbenchWindowPlacement>()
const placementRequests = new Map<string, object>()
const listeners = new Set<() => void>()
const documents = new Map<Document, WorkbenchWindowDocument>()
const nativeVisibility = new Map<Document, boolean>()
const visibilityListeners = new Map<Document, Set<() => void>>()
const visibilityChanged = (doc: Document) => { for (const listener of visibilityListeners.get(doc) ?? []) listener() }
// One read-only callback to the original App's local workface-view owner.
let navigationStampReader: (() => object | undefined) | null = null
export function registerWorkbenchNavigationStamp(read: () => object | undefined): () => void {
  navigationStampReader = read
  return () => { if (navigationStampReader === read) navigationStampReader = null }
}
export function workbenchNavigationStamp(): object | null { return navigationStampReader?.() ?? null }
let revision = 0
export const workbenchTargetKey = (target: AppWindowTarget): string => JSON.stringify(target)
const changed = () => { revision++; for (const listener of listeners) listener() }
export function subscribeWorkbenchWindows(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener) }
export function useWorkbenchWindowRevision(): number { return useSyncExternalStore(subscribeWorkbenchWindows, () => revision) }
export function registerWorkbenchHost(entry: WorkbenchHost): () => void {
  const key = workbenchTargetKey(entry.target)
  const previous = hosts.get(key)
  if (previous && previous.host !== entry.host) throw new Error('Original workface host is ambiguous; no duplicate window was created.')
  hosts.set(key, entry); changed()
  return () => { if (hosts.get(key) === entry) { hosts.delete(key); changed() } }
}
export function originalWorkbenchHost(target: AppWindowTarget): WorkbenchHost | null { return hosts.get(workbenchTargetKey(target)) ?? null }
export function workbenchWindowPlacement(target: AppWindowTarget | null): WorkbenchWindowPlacement | null {
  return target ? placements.get(workbenchTargetKey(target)) ?? null : null
}
const surfaceTargets = { survey: { kind: 'surface', surface: 'survey' }, recall: { kind: 'surface', surface: 'recall' } } as const
const ignoreChanges = () => () => {}
/** The committed owner document, including while an opening or return is pending. */
export function workbenchSurfaceDocument(surface?: string): Document {
  if (surface === 'survey' || surface === 'recall') return originalWorkbenchHost(surfaceTargets[surface])?.host.ownerDocument ?? document
  return document
}
export function isWorkbenchSurfaceDetached(surface: WorkbenchSurface): boolean { return typeof document !== 'undefined' && workbenchSurfaceDocument(surface) !== document }
export function useWorkbenchSurfaceDocument(surface?: string): Document {
  const relevant = surface === 'survey' || surface === 'recall'
  return useSyncExternalStore(relevant ? subscribeWorkbenchWindows : ignoreChanges, () => workbenchSurfaceDocument(surface))
}
export function useWorkbenchSurfaceDetached(surface: WorkbenchSurface): boolean { return useWorkbenchSurfaceDocument(surface) !== document }

/** Remaining exact placements keep their original window's presentation in place. */
export function workbenchDocumentHasPlacement(doc: Document): boolean {
  return [...placements.values()].some(placement => placement.destination.ownerDocument === doc)
}
export async function placeWorkbenchWindow(target: AppWindowTarget, placement: WorkbenchWindowPlacement | null): Promise<void> {
  const entry = originalWorkbenchHost(target)
  if (!entry) throw new Error('The original workface host is not yet available. Its original Session and saved layout remain.')
  const key = workbenchTargetKey(target), previous = placements.get(key), request = {}
  placementRequests.set(key, request)
  if (placement) placements.set(key, placement); else placements.delete(key)
  changed()
  try {
    await entry.place(placement)
    // Sibling React trees can own Regions inside the adopted surface. Refresh
    // their original document bindings only after the physical move commits.
    if (target.kind === 'surface') changed()
  }
  catch (error) {
    if (placementRequests.get(key) === request) {
      if (previous) placements.set(key, previous); else placements.delete(key)
      changed()
    }
    throw error
  } finally { if (placementRequests.get(key) === request) placementRequests.delete(key) }
}
export function registerWorkbenchDocument(doc: Document, identity: WorkbenchWindowDocument): () => void {
  documents.set(doc, identity)
  const onVisibilityChanged = () => visibilityChanged(doc)
  doc.addEventListener('visibilitychange', onVisibilityChanged)
  changed()
  return () => { if (documents.get(doc) === identity) { doc.removeEventListener('visibilitychange', onVisibilityChanged); documents.delete(doc); nativeVisibility.delete(doc); visibilityChanged(doc); changed() } }
}
/** Native visibility only scopes presentation work; it never changes Run ownership. */
export function observeWorkbenchNativeVisibility(windows: readonly AppWindowDescriptor[]): void {
  const observedById = new Map(windows.map(window => [window.windowId, window]))
  for (const [doc, identity] of documents) {
    const observed = observedById.get(identity.windowId)
    if (!observed || observed.documentGeneration !== identity.documentGeneration || observed.presentation !== 'visible' && observed.presentation !== 'hidden') continue
    const visible = observed.presentation === 'visible'
    if (nativeVisibility.get(doc) !== visible) { nativeVisibility.set(doc, visible); visibilityChanged(doc) }
  }
}
export function workbenchDocumentVisible(doc: Document): boolean {
  return !doc.defaultView?.closed && doc.visibilityState !== 'hidden' && nativeVisibility.get(doc) !== false
}
/** A visibility update wakes only consumers of that actual document. */
export function useWorkbenchDocumentVisibility(doc: Document): boolean {
  const subscribe = useCallback((listener: () => void) => {
    let consumers = visibilityListeners.get(doc)
    if (!consumers) { consumers = new Set(); visibilityListeners.set(doc, consumers) }
    consumers.add(listener)
    return () => { consumers.delete(listener); if (!consumers.size && visibilityListeners.get(doc) === consumers) visibilityListeners.delete(doc) }
  }, [doc])
  return useSyncExternalStore(subscribe, () => workbenchDocumentVisible(doc))
}
export function workbenchDocumentIdentity(doc: Document): WorkbenchWindowDocument | null { return documents.get(doc) ?? null }
export function workbenchDocuments(): readonly Document[] { return [...documents.keys()].filter(doc => !doc.defaultView?.closed) }
export function focusedWorkbenchDocument(): Document {
  return workbenchDocuments().find(doc => doc.hasFocus()) ?? document
}
export async function awaitOriginalWorkbenchHost(target: AppWindowTarget, signal?: AbortSignal): Promise<WorkbenchHost> {
  const current = originalWorkbenchHost(target)
  if (current) return current
  return new Promise((resolve, reject) => {
    const cleanup = () => { unsubscribe(); signal?.removeEventListener('abort', aborted) }
    const check = () => { const host = originalWorkbenchHost(target); if (host) { cleanup(); resolve(host) } }
    const aborted = () => { cleanup(); reject(new Error('Original workface observation ended; saved layout and Sessions remain.')) }
    const unsubscribe = subscribeWorkbenchWindows(check)
    signal?.addEventListener('abort', aborted, { once: true })
    if (signal?.aborted) aborted(); else check()
  })
}

const documentReturnListeners = new Set<(source: Document, destination: Document) => void>()
export function observeWorkbenchDocumentReturn(listener: (source: Document, destination: Document) => void): () => void {
  documentReturnListeners.add(listener); return () => documentReturnListeners.delete(listener)
}
/** A confirmed original host return, before its native shell can close. */
export function workbenchDocumentReturning(source: Document, destination: Document): void {
  for (const listener of documentReturnListeners) listener(source, destination)
}
