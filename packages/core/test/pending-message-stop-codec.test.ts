import { expect, it, vi } from 'vitest'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { rpcControlRequest, parseRpcControlResult } from '../src/rpc-business-codec.js'
const params = { agentSessionId: 'original-session', pendingId: 'original-message' }
const message = { pendingId: params.pendingId, text: 'Original body', runId: 'original-run', enqueuedAt: 1,
  status: 'deferred', phase: null, editable: true, delivery: 'not-submitted', errorCode: null, error: null, archived: false,
  preparationWait: { reason: 'context-compaction', state: 'stopped', attempt: 1, maxAttempts: 3, nextAttemptAt: null } }
const result = { agentSessionId: params.agentSessionId, message, changed: true }
it('retains the exact typed stop request and stopped pending result through strict public codecs', () => {
  expect(rpcControlRequest('message.pending.stop', params)).toMatchObject({ operation: 'message.pending.stop', ...params })
  expect(parseRpcControlResult('message.pending.stop', result, params)).toEqual(result)
})
it.each([
  { ...params, runId: 'another-run' }, { ...params, caller: 'forged' }, { ...params, pendingId: '' }
])('rejects extra or ambiguous stop target facts: %j', input => {
  expect(() => rpcControlRequest('message.pending.stop', input)).toThrow()
})
it.each([
  { ...result, agentSessionId: 'other-session' }, { ...result, message: { ...message, pendingId: 'other-message' } },
  { ...result, message: { ...message, preparationWait: { ...message.preparationWait, state: 'waiting', nextAttemptAt: 2 } } },
  { ...result, message: { ...message, preparationWait: { ...message.preparationWait, state: 'stopped', nextAttemptAt: 2 } } },
  { ...result, message: { ...message, archived: true, editable: false } }, { ...result, extra: true }
])('rejects cross-target or non-stopped stop receipts: %j', input => {
  expect(() => parseRpcControlResult('message.pending.stop', input, params)).toThrow()
})

it('rejects an Agent or unapproved stop caller before the owner while preserving the trusted user path', async () => {
  const execute = vi.fn(async () => ({ operation: 'message.pending.stop' as const, ...result }))
  const service = new AgentMuxRpcService({ execute })
  for (const context of [{}, { caller: { agentSessionId: 'managed-agent', capability: 'unapproved' } }]) {
    await expect(service.call('message.pending.stop', params, context)).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
  }
  expect(execute).not.toHaveBeenCalled()
  expect(await service.call('message.pending.stop', params, { principal: { kind: 'user', id: 'approved-private-user' } })).toEqual(result)
  expect(execute).toHaveBeenCalledTimes(1)
})
