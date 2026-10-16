import type { AgentSessionControl, SessionSnapshot } from '../../../shared/contracts'
import { nativeBindingKey } from '../../../shared/agent-native-source'
import { agentBookmarks, type AgentBookmark, type AgentBookmarkBounds } from './agent-bookmarks'
import type { FocusContext } from './focus-context'
import type { FocusContextIdentity } from './focus-context-identity'
import type { FocusGoalLinks } from './focus-goal-links'
import { useAppStore } from '../store'

/** Disposable reading intent; durable bookmark data never contains these callbacks or control facts. */
export type AgentInformationPreview = {
  token: object; id: string; context: FocusContext
  identity?: FocusContextIdentity | undefined; goalLinks?: FocusGoalLinks | undefined
  anchor: HTMLButtonElement; keepOpen(): void; restoreFocus(): void; openWorkface(): void
  session: SessionSnapshot | undefined; control: AgentSessionControl | undefined; sourceKey: string | undefined
  enterReading: boolean; pinned: boolean; contentChanged: boolean
  focusReading?: object | undefined
  bookmark?: AgentBookmark | undefined
}
type Opening = Omit<AgentInformationPreview, 'session' | 'control' | 'sourceKey' | 'pinned' | 'contentChanged' | 'bookmark'>
let current: readonly AgentInformationPreview[] = []
const listeners = new Set<() => void>()
let pending: { token: object; cancel(): void } | null = null
function cancelIntent(token?: object) {
  if (pending && (!token || pending.token === token)) { const intent = pending; pending = null; intent.cancel() }
}
function publish(next: readonly AgentInformationPreview[]) { current = next; for (const listener of listeners) listener() }
function original(request: Opening) {
  return useAppStore.getState().sessions.find(session => session.id === request.context.id && session.hostId === request.context.hostId && session.control.run.runId === request.context.runId)
}
function restoredContext(bookmark: AgentBookmark): FocusContext {
  return { id: bookmark.presentationId, hostId: bookmark.hostId, name: bookmark.label, workspaceName: bookmark.workspaceName, workspaceId: '', workspacePath: '', workspace: undefined,
    kind: 'agent', providerId: null, topicId: null, state: 'disconnected', stateLabel: 'Reading snapshot', processState: 'interrupted', bucket: 'idle', runId: '',
    liveAgent: false, actionable: false, lastActivityAt: null, workingEnteredAt: null, detail: 'Saved bookmark · Original Agent observation pending', detailIsRecap: false, detailKind: 'service',
    recap: bookmark.excerpt ? { text: bookmark.excerpt, reading: { text: bookmark.excerpt, truncated: true }, source: 'Last assistant message', origin: 'timeline' } : null }
}

/** Idempotent promotion shared by explicit Pin and the first deliberate drag. */
function pinReading(request: AgentInformationPreview, bounds?: AgentBookmarkBounds): AgentBookmark | undefined {
  if (request.pinned) return request.bookmark
  const session = request.session
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
  schedule(token: object, cancel: () => void): boolean { cancelIntent(); pending = { token, cancel }; return true },
  show(request: Opening): boolean {
    cancelIntent()
    const session = original(request)
    const existing = session?.kind === 'agent' ? current.find(item => item.bookmark?.hostId === session.control.hostId && item.bookmark.agentSessionId === session.control.agentSessionId) : undefined
    if (existing) {
      agentBookmarks.bringToFront(existing.bookmark!.key)
      if (request.enterReading) publish(current.map(item => item.token === existing.token ? { ...item, focusReading: {} } : item))
      return true
    }
    if (current.some(item => item.token === request.token)) return true
    const control = session?.kind === 'agent' && session.control.hostId === request.context.hostId ? session.control : undefined
    publish([...current.filter(item => item.pinned), { ...request, session, control, sourceKey: session?.kind === 'agent' ? nativeBindingKey(session) : undefined, pinned: false, contentChanged: false }])
    return true
  },
  noteContent(token: object, context: FocusContext) {
    // Transient text is held from intent. Bookmarks derive live facts independently of origin rows.
    const request = current.find(item => item.token === token)
    if (!request?.pinned || request.bookmark || request.contentChanged) return
    if (request.context.recap?.reading?.text !== context.recap?.reading?.text) publish(current.map(item => item === request ? { ...item, contentChanged: true } : item))
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
    if (!request || request.session?.kind !== 'agent') return
    const session = request.session
    const existed = agentBookmarks.get().bookmarks.some(item => item.hostId === session.control.hostId && item.agentSessionId === session.control.agentSessionId)
    const bookmark = pinReading(request, bounds)
    if (!bookmark) return
    return { key: bookmark.key, cancel: () => {
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
