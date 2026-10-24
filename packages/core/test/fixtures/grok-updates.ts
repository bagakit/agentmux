// Official durable envelope: grok-build 2bdd1d6a, storage/mod.rs and
// acp_session_impl/updates.rs. These are synthetic protocol records, not user data.
export const grokUpdate = (sessionId: string, update: Record<string, unknown>, promptId = 'prompt-1', method = 'session/update') => ({
  timestamp: 2, method, params: { sessionId, update, _meta: { promptId, eventId: 'synthetic-event' } }
})
export const grokChunk = (sessionId: string, text: string, promptId = 'prompt-1') =>
  grokUpdate(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }, promptId)
export const grokUser = (sessionId: string, text: string, promptId = 'prompt-1') =>
  grokUpdate(sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } }, promptId)
export const grokDone = (sessionId: string, promptId = 'prompt-1', stopReason = 'end_turn') => {
  const row = grokUpdate(sessionId, { sessionUpdate: 'turn_completed', prompt_id: promptId, stop_reason: stopReason, agent_result: null }, promptId, '_x.ai/session/update')
  // Native XAI terminal correlates through update.prompt_id, not ACP meta.
  return { ...row, params: { ...row.params, _meta: { eventId: 'synthetic-terminal' } } }
}
