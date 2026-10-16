import { parseConversationReadPageForWindow, parseConversationChangesPageForWindow, parseConversationViewReleaseResult, parseConversationWatchOpening, parseConversationObservation } from '@agentmux/core/conversation'
import type { ConversationObservation, ConversationWatchOpening } from '@agentmux/core/conversation'
import type { ConversationReadApi, ConversationReadPreloadApi } from '../../../shared/conversation-read'
import { unwrapSessionInputOperationResult } from '../../../shared/session-input-result'

export function createConversationReadApi(bridge: ConversationReadPreloadApi): ConversationReadApi {
  const cancellation = (signal?: AbortSignal) => signal ? { onAbort: (cancel: () => void) => {
    if (signal.aborted) { cancel(); return () => {} }
    signal.addEventListener('abort', cancel, { once: true })
    return () => signal.removeEventListener('abort', cancel)
  } } : undefined
  return {
    readAgentConversation: async (input, options = {}) => {
      options.signal?.throwIfAborted()
      const result = await bridge.readAgentConversation(input, cancellation(options.signal))
      options.signal?.throwIfAborted()
      return parseConversationReadPageForWindow(unwrapSessionInputOperationResult(result), input)
    },
    readConversationChanges: async (input, options = {}) => {
      options.signal?.throwIfAborted()
      const result = await bridge.readConversationChanges(input, cancellation(options.signal))
      options.signal?.throwIfAborted()
      return parseConversationChangesPageForWindow(unwrapSessionInputOperationResult(result), input)
    },
    releaseConversationView: async input => parseConversationViewReleaseResult(unwrapSessionInputOperationResult(await bridge.releaseConversationView(input)), input),
    observeConversation: async (input, listener, options = {}) => {
      options.signal?.throwIfAborted()
      const closed = new AbortController()
      let opening: ConversationWatchOpening | undefined
      // An invalidation may precede the opening response across IPC. Retain only
      // the latest notification for each original source, never conversation rows.
      const pending = new Map<string, ConversationObservation>()
      const receive = (value: ConversationObservation) => {
        if (closed.signal.aborted) return
        try {
          if (opening) listener(parseConversationObservation(value, opening))
          else {
            if (pending.size >= 4) throw new Error('Conversation observation exceeded its original source scope.')
            pending.set(JSON.stringify(value.source), value)
          }
        } catch (error) { closed.abort(error) }
      }
      const handle = unwrapSessionInputOperationResult(await bridge.observeConversation(input, receive, {
        ...cancellation(options.signal), onEnd: message => closed.abort(new Error(message ?? 'The original conversation observation ended.'))
      }))
      const { dispose: release, ...value } = handle
      const dispose = () => { options.signal?.removeEventListener('abort', dispose); closed.signal.removeEventListener('abort', dispose); release(); closed.abort() }
      closed.signal.addEventListener('abort', dispose, { once: true })
      try {
        opening = parseConversationWatchOpening(value, input)
        options.signal?.throwIfAborted()
        closed.signal.throwIfAborted()
        options.signal?.addEventListener('abort', dispose, { once: true })
        for (const observation of pending.values()) receive(observation)
        pending.clear()
        closed.signal.throwIfAborted()
        return { ...opening, closed: closed.signal, dispose }
      } catch (error) { dispose(); throw error }
    }
  }
}
