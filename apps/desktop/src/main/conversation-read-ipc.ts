import type { IpcMainInvokeEvent } from 'electron'
import type { AgentMuxRpcClient } from '@agentmux/core'
import type { ConversationTimelineReadInput, ConversationChangesInput, ConversationWatchInput, ConversationViewReleaseInput, ConversationWatchOpening } from '@agentmux/core/conversation'
import { CONVERSATION_READ_EVENT } from '../shared/conversation-read'
import { sessionInputOperationResult } from '../shared/session-input-result'
import { SessionHistoryReadOwners } from './session-history-read'

type Ports = {
  handle<T extends unknown[], R>(channel: string, listener: (event: IpcMainInvokeEvent, ...values: T) => R | Promise<R>): void
  trust(channel: 'conversation:inspect' | 'conversation:changes' | 'conversation:release' | 'conversation:watch' | 'conversation:cancel', event: IpcMainInvokeEvent): void
  connect(): Promise<AgentMuxRpcClient>
}

/** Sender trust and resource lifetime only; every read uses the original public service. */
export function registerConversationReadIpc(ports: Ports) {
  const reads = new SessionHistoryReadOwners()
  const invoke = async <M extends 'agent.conversation.inspect' | 'agent.conversation.changes' | 'agent.conversation.release'>(
    method: M, input: import('@agentmux/core').AgentMuxRpcParams<M>, signal?: AbortSignal) => {
    const client = await ports.connect()
    try { return await client.call(method, input, signal ? { signal } : {}) }
    finally { await client.dispose() }
  }
  ports.handle('conversation:inspect', (event, token: string, input: ConversationTimelineReadInput) => {
    ports.trust('conversation:inspect', event)
    return sessionInputOperationResult(() => reads.read(event.sender, token, signal => invoke('agent.conversation.inspect', input, signal)))
  })
  ports.handle('conversation:changes', (event, token: string, input: ConversationChangesInput) => {
    ports.trust('conversation:changes', event)
    return sessionInputOperationResult(() => reads.read(event.sender, token, signal => invoke('agent.conversation.changes', input, signal)))
  })
  ports.handle('conversation:release', (event, input: ConversationViewReleaseInput) => {
    ports.trust('conversation:release', event)
    return sessionInputOperationResult(() => invoke('agent.conversation.release', input))
  })
  ports.handle('conversation:cancel', (event, token: string) => {
    ports.trust('conversation:cancel', event); reads.cancel(event.sender.id, token)
  })
  ports.handle('conversation:watch', (event, token: string, input: ConversationWatchInput) => {
    ports.trust('conversation:watch', event)
    return sessionInputOperationResult(() => new Promise<ConversationWatchOpening>((resolve, reject) => {
      let opened = false
      void reads.read(event.sender, token, async signal => {
        const client = await ports.connect()
        try {
          await new Promise<void>((ended, failed) => {
            const abort = () => failed(signal.reason)
            signal.addEventListener('abort', abort, { once: true })
            void client.subscribe('agent.conversation.watch', input, { signal,
              onInitial: value => { opened = true; resolve(value) },
              onEvent: value => {
                if (!event.sender.isDestroyed() && value.type === 'snapshot') event.sender.send(CONVERSATION_READ_EVENT, { token, observation: value.data })
              },
              onEnd: error => {
                signal.removeEventListener('abort', abort)
                if (!opened) reject(error ?? new Error('The original conversation observation ended before opening.'))
                if (!event.sender.isDestroyed()) event.sender.send(CONVERSATION_READ_EVENT, { token, ended: true, ...(error ? { message: error.message } : {}) })
                ended()
              }
            }).catch(error => { signal.removeEventListener('abort', abort); failed(error) })
          })
        } finally { await client.dispose() }
      }).catch(reject)
    }))
  })
  return { dispose: () => reads.dispose() }
}
