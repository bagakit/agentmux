import { mintObjectId } from '@agentmux/core/object-id'
import type { ConversationReadPreloadApi, ConversationReadEvent } from '../shared/conversation-read'
import { CONVERSATION_READ_EVENT } from '../shared/conversation-read'

type Ipc = {
  invoke(channel: string, ...args: unknown[]): Promise<any>
  on(channel: string, listener: (event: unknown, value: ConversationReadEvent) => void): unknown
  removeListener(channel: string, listener: (event: unknown, value: ConversationReadEvent) => void): unknown
}

/** Cancellation and sender-owned subscriptions only; Core owns every read window. */
export function createPreloadConversationRead(ipc: Ipc): ConversationReadPreloadApi {
  const read = async (channel: string, input: unknown, options?: { onAbort?: (cancel: () => void) => () => void }) => {
    const token = mintObjectId()
    const pending = ipc.invoke(channel, token, input)
    const cleanup = options?.onAbort?.(() => { void ipc.invoke('conversation:cancel', token).catch(() => {}) })
    try { return await pending } finally { cleanup?.() }
  }
  return {
    readAgentConversation: (input, options) => read('conversation:inspect', input, options),
    readConversationChanges: (input, options) => read('conversation:changes', input, options),
    releaseConversationView: input => ipc.invoke('conversation:release', input),
    observeConversation: async (input, listener, options) => {
      const token = mintObjectId()
      let disposed = false
      let cleanup: (() => void) | undefined
      const dispose = () => {
        if (disposed) return
        disposed = true; cleanup?.()
        ipc.removeListener(CONVERSATION_READ_EVENT, receive)
        void ipc.invoke('conversation:cancel', token).catch(() => {})
      }
      const receive = (_event: unknown, value: ConversationReadEvent) => {
        if (value.token !== token || disposed) return
        if ('ended' in value) { options?.onEnd?.(value.message); dispose() }
        else listener(value.observation)
      }
      ipc.on(CONVERSATION_READ_EVENT, receive)
      const pending = ipc.invoke('conversation:watch', token, input)
      cleanup = options?.onAbort?.(dispose)
      if (disposed) cleanup?.()
      try {
        const result = await pending
        if (!result.ok || disposed) dispose()
        return result.ok ? { ok: true, value: { ...result.value, dispose } } : result
      } catch (error) { dispose(); throw error }
    }
  }
}
