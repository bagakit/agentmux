import { parseMoteChatResult, type MoteChatOperation } from '@agentmux/core/mote-chat'
import { api } from './api'
import type { MoteChatIntent } from './mote-chat-intent'
import { clearMoteChatIntent, retainMoteChatIntent, useAppStore } from '../store'

/** Explicit pre-write owner refusals do not strand a draft as an unknown effect. */
const refusedBeforeWrite = new Set(['MOTE_CHAT_TARGET_CHANGED', 'MOTE_CHAT_CONNECTION_CHANGED', 'MOTE_CHAT_CONNECTION_UNAVAILABLE',
  'MOTE_CHAT_CREATOR_UNCONFIRMED', 'MOTE_CHAT_REVISION_CONFLICT', 'MOTE_CHAT_APPLICATION_IN_USE', 'MOTE_CHAT_CREATOR_UNLIMITED',
  'MOTE_CHAT_EXECUTOR_REQUIRED', 'MOTE_CHAT_EXECUTOR_UNCONFIRMED', 'MOTE_CHAT_EXECUTOR_UNAVAILABLE', 'MOTE_CHAT_HOST_UNAVAILABLE', 'MOTE_CHAT_TARGET_UNCONFIRMED'])

export async function submitMoteChatIntent(input: MoteChatIntent): Promise<MoteChatOperation> {
  const intent = structuredClone(input), previous = useAppStore.getState().moteChatIntents[intent.input.operationId]
  if (previous && !previous.hostingTarget) throw Error('The original bot hosting owner is unconfirmed. This request is kept without sending it to the current Host.')
  intent.hostingTarget ??= previous?.hostingTarget ?? await api.connections.hostingTarget()
  let dispatched = useAppStore.getState().moteChatIntents[intent.input.operationId]?.phase === 'may-have-dispatched'
  try {
    if (!dispatched) {
      const retained = await retainMoteChatIntent({ ...intent, phase: 'not-dispatched' })
      if (!retained.localStorageWritten) throw Error('The original chat settings request could not be retained. No request was sent.')
    }
    const retained = await retainMoteChatIntent({ ...intent, phase: 'may-have-dispatched' })
    if (!retained.localStorageWritten) throw Error('The original chat dispatch input could not be retained.')
    dispatched = true
    const operation = intent.method === 'space.mote.chat.configure'
      ? await api.moteChat.call(intent.method, intent.input, intent.hostingTarget) : await api.moteChat.call(intent.method, intent.input, intent.hostingTarget)
    await clearMoteChatIntent(intent.input.operationId)
    return operation
  } catch (error) {
    if (!dispatched || typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' && refusedBeforeWrite.has(error.code)) await clearMoteChatIntent(intent.input.operationId)
    throw error
  }
}

/** A current configuration read is never an acknowledgement of this original input. */
export async function inspectMoteChatIntent(intent: MoteChatIntent): Promise<MoteChatOperation | null> {
  if (!intent.hostingTarget) throw Error('The original bot hosting owner is unconfirmed. This request is kept without querying another Host.')
  const result = await api.moteChat.call('space.mote.chat.inspect', { operationId: intent.input.operationId }, intent.hostingTarget)
  if (!result.operation) return null
  const operation = intent.method === 'space.mote.chat.configure'
    ? parseMoteChatResult(intent.method, result.operation, intent.input) : parseMoteChatResult(intent.method, result.operation, intent.input)
  await clearMoteChatIntent(intent.input.operationId)
  return operation
}
