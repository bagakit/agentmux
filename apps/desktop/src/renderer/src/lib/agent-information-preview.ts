import type { AgentSessionControl, SessionSnapshot } from '../../../shared/contracts'
import { nativeBindingKey } from '../../../shared/agent-native-source'
import { agentBookmarks, type AgentBookmark, type AgentBookmarkBounds } from './agent-bookmarks'
import type { FocusContext } from './focus-context'
import type { FocusContextIdentity } from './focus-context-identity'
import type { FocusGoalLinks } from './focus-goal-links'
import { agentRegionLocationBindings, useAppStore } from '../store'
import { desktopAgentExecutionFromSpatial } from './desktop-agent-presentation'

/** Disposable reading intent; durable bookmark data never contains these callbacks or control facts. */
export type AgentInformationPreview = {
  token: object; id: string; context: FocusContext
  identity?: FocusContextIdentity | undefined; goalLinks?: FocusGoalLinks | undefined
  anchor: HTMLButtonElement; keepOpen(): void; restoreFocus(): void; openWorkface(): void
  readingBranch?: { attach(element: HTMLElement): () => void; retainedEscape(event: KeyboardEvent): boolean } | undefined
  session: SessionSnapshot | undefined; control: AgentSessionControl | undefined; sourceKey: string | undefined
  sourceRuntimeId?: string | undefined
  enterReading: boolean; pinned: boolean; contentChanged: boolean
  focusReading?: object | undefined
  bookmark?: AgentBookmark | undefined
}
type Opening = Omit<AgentInformationPreview, 'session' | 'control' | 'sourceKey' | 'sourceRuntimeId' | 'pinned' | 'contentChanged' | 'bookmark'>
let current: readonly AgentInformationPreview[] = []
const listeners = new Set<() => void>()
const transientSuspensions = new WeakMap<Document, number>()
let pending: { token: object; cancel(): void } | null = null
function cancelIntent(token?: object) {
  if (pending && (!token || pending.token === token)) { const intent = pending; pending = null; intent.cancel() }
}
function publish(next: readonly AgentInformationPreview[]) { current = next; for (const listener of listeners) listener() }
function original(request: Opening) {
  if (request.context.access) return undefined
  return useAppStore.getState().sessions.find(session => session.id === request.context.id && session.hostId === request.context.hostId && session.control.run.runId === request.context.runId)
}
function originalRuntime(session: SessionSnapshot | undefined): string | undefined {
  if (session?.kind !== 'agent') return
  const runtimes = new Set(agentRegionLocationBindings()?.flatMap(region => {
    const execution = desktopAgentExecutionFromSpatial(region, session)
    return execution ? [execution.runtimeId] : []
  }))
  return runtimes.size === 1 ? [...runtimes][0] ?? undefined : undefined
}
function sourceBookmarkMatches(bookmark: AgentBookmark | undefined, context: FocusContext) {
  return Boolean(bookmark && context.access && bookmark.sourceRuntimeId !== undefined && bookmark.sourceRuntimeId === context.access.identity.runtimeId &&
    bookmark.agentSessionId === context.access.identity.agentSessionId && bookmark.presentationId === context.id)
}
function restoredContext(bookmark: AgentBookmark): FocusContext {
  return { id: bookmark.presentationId, hostId: bookmark.hostId, name: bookmark.label, workspaceName: bookmark.workspaceName, workspaceId: '', workspacePath: '', workspace: undefined,
    kind: 'agent', providerId: null, topicId: null, state: 'disconnected', stateLabel: 'Reading snapshot', processState: 'interrupted', bucket: 'idle', runId: '',
    liveAgent: false, actionable: false, lastActivityAt: null, workingEnteredAt: null, detail: 'Saved bookmark · Original Agent observation pending', detailIsRecap: false, detailKind: 'service',
    recap: bookmark.excerpt ? { text: bookmark.excerpt, reading: { text: bookmark.excerpt, truncated: true }, source: 'Saved conversation excerpt', origin: 'timeline' } : null }
}

/** Idempotent promotion shared by explicit Pin and the first deliberate drag. */
function pinReading(request: AgentInformationPreview, bounds?: AgentBookmarkBounds): AgentBookmark | undefined {
  if (request.pinned) return request.bookmark
  const access = request.context.access
  const session = request.session
  if (access) {
    const key = agentBookmarks.pin({ hostId: request.context.hostId, sourceRuntimeId: access.identity.runtimeId, agentSessionId: access.identity.agentSessionId, presentationId: request.context.id, label: request.context.name, workspaceName: request.context.workspaceName, excerpt: request.context.recap?.reading?.text ?? request.context.recap?.text, bounds: bounds ?? { x: 32, y: 72, width: 460, height: 600 } })
    const bookmark = agentBookmarks.get().bookmarks.find(item => item.key === key)
    publish(current.map(item => item === request ? { ...item, pinned: true, bookmark } : item))
    return bookmark
  }
  if (session?.kind !== 'agent') { publish(current.map(item => item === request ? { ...item, pinned: true } : item)); return }
  const key = agentBookmarks.pin({ hostId: session.control.hostId, agentSessionId: session.control.agentSessionId, presentationId: session.id, label: request.context.name,
    workspaceName: request.context.workspaceName, excerpt: request.context.recap?.reading?.text ?? request.context.recap?.text,
    bounds: bounds ?? { x: 32, y: 72, width: 460, height: 600 } })
  const bookmark = agentBookmarks.get().bookmarks.find(item => item.key === key)
  publish(current.map(item => item === request ? { ...item, pinned: true, bookmark } : item))
  return bookmark
}

export const agentInformationPreview = {
  get: () => current.at(-1) ?? null,
  getAll: () => current,
  cancelIntent,
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
  suspendTransient(document: Document): () => void {
    transientSuspensions.set(document, (transientSuspensions.get(document) ?? 0) + 1)
    cancelIntent()
    const visible = current.filter(item => item.pinned || item.anchor.ownerDocument !== document)
    if (visible.length !== current.length) publish(visible)
    return () => {
      const remaining = (transientSuspensions.get(document) ?? 1) - 1
      if (remaining) transientSuspensions.set(document, remaining)
      else transientSuspensions.delete(document)
    }
  },
  schedule(token: object, cancel: () => void): boolean { cancelIntent(); pending = { token, cancel }; return true },
  show(request: Opening): boolean {
    cancelIntent()
    if (transientSuspensions.has(request.anchor.ownerDocument)) return false
    const session = original(request)
    const existing = request.context.access ? current.find(item => sourceBookmarkMatches(item.bookmark, request.context)) : session?.kind === 'agent' ? current.find(item => item.bookmark?.hostId === session.control.hostId && item.bookmark.agentSessionId === session.control.agentSessionId) : undefined
    if (existing) {
      agentBookmarks.bringToFront(existing.bookmark!.key)
      if (request.enterReading) publish(current.map(item => item.token === existing.token ? { ...item, focusReading: {} } : item))
      return true
    }
    if (current.some(item => item.token === request.token)) return true
    const control = session?.kind === 'agent' && session.control.hostId === request.context.hostId ? session.control : undefined
    publish([...current.filter(item => item.pinned), { ...request, session, control, sourceRuntimeId: request.context.access?.identity.runtimeId ?? originalRuntime(session), sourceKey: session?.kind === 'agent' ? nativeBindingKey(session) : undefined, pinned: false, contentChanged: false }])
    return true
  },
  noteContent(token: object, context: FocusContext) {
    if (context.access) {
      const access = context.access
      const matches = (item: AgentInformationPreview) => sourceBookmarkMatches(item.bookmark, context)
      for (const item of current) if (matches(item)) agentBookmarks.updateSnapshot(item.bookmark!.key, { label: context.name, workspaceName: context.workspaceName, excerpt: context.recap?.reading?.text ?? context.recap?.text })
      if (current.some(matches)) publish(current.map(item => matches(item) ? { ...item, context, openWorkface: () => access.select(),
        contentChanged: item.contentChanged || (item.context.recap?.reading?.text ?? item.context.recap?.text) !== (context.recap?.reading?.text ?? context.recap?.text) } : item))
    }
    // Transient text is held from intent. Bookmarks derive live facts independently of origin rows.
    const request = current.find(item => item.token === token)
    if (!request?.pinned || request.bookmark || request.contentChanged) return
    if (request.context.recap?.reading?.text !== context.recap?.reading?.text) publish(current.map(item => item === request ? { ...item, contentChanged: true } : item))
  },
  noteSourceSubagents(token: object, context: FocusContext) {
    const request = current.find(item => item.token === token || sourceBookmarkMatches(item.bookmark, context))
    const original = request?.context
    if (!request || !original?.access || !context.access || original.id !== context.id || original.hostId !== context.hostId ||
        original.runId !== context.runId || original.nativeSessionId !== context.nativeSessionId || original.nativeSubagents === context.nativeSubagents) return
    const refreshed = { ...original }
    if (context.nativeSubagents) refreshed.nativeSubagents = context.nativeSubagents
    else delete refreshed.nativeSubagents
    publish(current.map(item => item === request ? { ...item, context: refreshed } : item))
  },
  dismiss(token: object, explicit = false) {
    cancelIntent(token)
    const request = current.find(item => item.token === token)
    if (!request || request.pinned && !explicit) return
    publish(current.filter(item => item !== request))
    if (request.bookmark) agentBookmarks.remove(request.bookmark.key)
  },
  pin(token: object, bounds?: AgentBookmarkBounds) {
    const request = current.find(item => item.token === token)
    if (!request) return
    if (request.pinned) {
      publish(current.map(item => item === request ? { ...item, pinned: false, bookmark: undefined } : item).filter(item => item === request || item.pinned || item.token === token))
      if (request.bookmark) agentBookmarks.remove(request.bookmark.key)
      return
    }
    pinReading(request, bounds)
  },
  ensurePinned(token: object, bounds: AgentBookmarkBounds) {
    const request = current.find(item => item.token === token)
    if (!request) return
    const session = request.session
    if (!request.context.access && session?.kind !== 'agent') return
    const existed = agentBookmarks.get().bookmarks.some(item => request.context.access
      ? sourceBookmarkMatches(item, request.context)
      : session?.kind === 'agent' && item.sourceRuntimeId === undefined && item.hostId === session.control.hostId && item.agentSessionId === session.control.agentSessionId)
    const bookmark = pinReading(request, bounds)
    if (!bookmark) return
    return { key: bookmark.key, created: !existed, cancel: () => {
      if (existed || !current.some(item => item.token === token && item.bookmark?.key === bookmark.key)) return
      publish(current.map(item => item.token === token ? { ...item, pinned: false, bookmark: undefined } : item))
      agentBookmarks.remove(bookmark.key)
    } }
  },
  /** Reconcile presentation records only. Empty Runtime snapshots never delete a durable bookmark. */
  restore(bookmarks: readonly AgentBookmark[], document: Document) {
    let changed = false
    const pinned = bookmarks.map(bookmark => {
      const held = current.find(item => item.bookmark?.key === bookmark.key || item.pinned && item.session?.kind === 'agent' && item.session.control.hostId === bookmark.hostId && item.session.control.agentSessionId === bookmark.agentSessionId)
      if (held) { if (held.bookmark === bookmark) return held; changed = true; return { ...held, bookmark } }
      changed = true
      return { token: {}, id: 'agent-bookmark-' + encodeURIComponent(bookmark.key), anchor: document.createElement('button'), context: restoredContext(bookmark),
        session: undefined, control: undefined, sourceKey: undefined, enterReading: false, pinned: true, contentChanged: false, bookmark,
        keepOpen() {}, restoreFocus() {}, openWorkface() {} } satisfies AgentInformationPreview
    })
    const next = [...pinned, ...current.filter(item => !item.pinned || !item.bookmark && item.session?.kind !== 'agent')]
    if (changed || next.length !== current.length || next.some((item, index) => item !== current[index])) publish(next)
  },
  detach() { cancelIntent(); publish([]) }
}
