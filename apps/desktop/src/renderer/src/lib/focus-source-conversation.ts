import { consumeConversationWindowPage, projectConversationWindow, type ConversationObservation,
  type ConversationWindowAssembly } from '@agentmux/core/conversation'
import type { SpaceMountReadingSurface } from '../../../shared/space-mount'
import type { ConversationReadApi } from '../../../shared/conversation-read'

/** The common Reader's port, fixed to one original member; no observer-local fallback. */
export function sourceConversationPort(surface: SpaceMountReadingSurface, agentSessionId: string,
  observations: Map<string, (event: ConversationObservation) => void>, lifetime: AbortSignal): ConversationReadApi {
  const original = (input: { hostId: string; agentSessionId: string }) => {
    if (input.hostId !== 'local' || input.agentSessionId !== agentSessionId) throw Error('This reading belongs to another original Agent. The original task and reading are retained.')
  }
  return {
    readAgentConversation: (input, options) => {
      original(input)
      const { hostId: _host, agentSessionId: _sid, ...selection } = input
      return surface.call('conversationRead', { input: selection }, options?.signal)
    },
    readConversationChanges: (input, options) => {
      original(input)
      const { hostId: _host, agentSessionId: _sid, ...selection } = input
      return surface.call('conversationChanges', { input: selection }, options?.signal)
    },
    releaseConversationView: input => {
      original(input)
      return surface.call('conversationRelease', { view: input.view })
    },
    observeConversation: async (input, listener, options) => {
      original(input)
      options?.signal?.throwIfAborted()
      const closed = new AbortController()
      let readerId: string | undefined
      const dispose = () => {
        if (closed.signal.aborted) return
        if (readerId) {
          observations.delete(readerId)
          // Releasing the containing surface already releases its Main-owned readers.
          if (!lifetime.aborted) void surface.call('conversationUnwatch', { readerId }).catch(cause => console.warn('[focus-source] Conversation reader release unconfirmed', cause))
        }
        options?.signal?.removeEventListener('abort', dispose); lifetime.removeEventListener('abort', dispose); closed.abort()
      }
      try {
        const opening = await surface.call('conversationWatch', { ...(input.view ? { view: input.view } : {}) }, options?.signal)
        readerId = opening.readerId; observations.set(readerId, listener)
        if (options?.signal?.aborted || lifetime.aborted) dispose()
        else { options?.signal?.addEventListener('abort', dispose, { once: true }); lifetime.addEventListener('abort', dispose, { once: true }) }
        return { ...opening, closed: closed.signal, dispose }
      } catch (cause) { dispose(); throw cause }
    }
  }
}

/** Reuse Core's original framed-window assembly and presentation adapter. */
export async function readSourceConversationRecap(port: ConversationReadApi, agentSessionId: string, signal: AbortSignal) {
  let cursor: string | undefined, pending: ConversationWindowAssembly | undefined, view: string | null = null
  try {
    for (;;) {
      signal.throwIfAborted()
      const page = await port.readAgentConversation({ hostId: 'local', agentSessionId, limit: 3, maxBytes: 64 * 1024, processDetails: 'deferred',
        ...(cursor ? { cursor } : {}) }, { signal })
      view = page.window.view ?? view
      const consumed = consumeConversationWindowPage(page, pending)
      if (consumed.kind === 'complete') return projectConversationWindow(consumed.snapshot)
      pending = consumed.pending; cursor = page.nextCursor ?? undefined
    }
  } finally {
    if (view) await port.releaseConversationView({ hostId: 'local', agentSessionId, view }).catch(() => {})
  }
}
