import { useCallback, useMemo } from 'react'
import { ConversationReactionActions, type ConversationReactionSend } from '@agentmux/client-ui/components/ConversationReactionActions'
import { conversationReplySourceKey, promptReactionDefinitions, promptReactionMessage, samePromptReaction, type ConversationReplySource, type PromptReactionDefinition } from '@agentmux/core/prompt-reaction'
import { resolveComposerShortcuts } from '../../../shared/composer-shortcut-library'
import { api } from './api'
import { useAppStore, type AgentSteerQueueEntry } from '../store'
import { pendingSteerInput } from './steer-queue-delivery'
const NO_PENDING: readonly AgentSteerQueueEntry[] = Object.freeze([])

/** Explicit click reads the current ConfigOwner snapshot; background rendering does no I/O. */
export async function sendConversationReaction(sessionId: string, expected: PromptReactionDefinition,
  source: ConversationReplySource, onRejected: (error: unknown) => void): Promise<boolean> {
  const original = useAppStore.getState().sessions.find(session => session.id === sessionId)
  if (original?.kind !== 'agent' || original.processState !== 'running') {
    throw new Error('This Agent is not ready to receive a reply. Your draft is kept.')
  }
  if (source.agentSessionId !== original.control.agentSessionId) throw new Error('This reply belongs to another conversation.')
  const saved = await api.config.get()
  const selected = promptReactionDefinitions(resolveComposerShortcuts(saved), original.providerId).find(item => item.id === expected.id)
  if (!selected || !samePromptReaction(selected, expected)) {
    throw new Error('This quick reply changed in Settings. Review its new meaning before sending.')
  }
  const state = useAppStore.getState()
  const current = state.sessions.find(session => session.id === sessionId)
  if (current?.kind !== 'agent' || current.control.agentSessionId !== original.control.agentSessionId ||
    current.control.hostId !== original.control.hostId || current.control.run.runId !== original.control.run.runId ||
    current.processState !== 'running') {
    throw new Error('The Agent changed while preparing this reply. Nothing was queued.')
  }
  if (state.agentSteerQueues[sessionId]?.some(entry => pendingSteerInput(entry) && entry.reaction?.code === selected.keyword &&
    conversationReplySourceKey(entry.reaction.replySource) === conversationReplySourceKey(source))) {
    throw new Error('This reply is already in the Outbox. Check its status there before retrying.')
  }
  const input = promptReactionMessage(selected, source)
  const operationId = crypto.randomUUID()
  const accepted = state.enqueueAgentSteer(sessionId, input.prompt, onRejected, operationId, 'manual', input.agentMuxNote,
    { reaction: { code: selected.keyword, replySource: source }, sourceChannel: 'reaction' })
  if (!accepted) return false
  // A reaction cannot answer a pending permission or question; it waits in the ordinary queue.
  void state.flushAgentSteerQueue(sessionId, current.pendingInteraction ? undefined : operationId)
  return true
}

/** One location subscription supplies all visible message actions, not one reader per card. */
export function useConversationReactions(sessionId: string, enabled: boolean) {
  const prompts = useAppStore(state => resolveComposerShortcuts(state.config))
  const providerId = useAppStore(state => {
    const session = state.sessions.find(item => item.id === sessionId)
    return session?.kind === 'agent' ? session.providerId : undefined
  })
  const queue = useAppStore(state => state.agentSteerQueues[sessionId] ?? NO_PENDING)
  const definitions = useMemo(() => promptReactionDefinitions(prompts, providerId), [prompts, providerId])
  const onSend = useCallback<ConversationReactionSend>((definition, source, rejected) =>
    sendConversationReaction(sessionId, definition, source, rejected), [sessionId])
  return useCallback((source: ConversationReplySource) => enabled && definitions.length
    ? <ConversationReactionActions definitions={definitions} source={source} onSend={onSend}
      pending={queue.flatMap(entry => pendingSteerInput(entry) && entry.reaction && conversationReplySourceKey(entry.reaction.replySource) === conversationReplySourceKey(source)
        ? [{code: entry.reaction.code, status: entry.status, ...(entry.error === undefined ? {} : {error: entry.error})}] : [])} /> : null,
    [enabled, definitions, onSend, queue])
}
