import { fixtureEpoch as _newTailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { AgentMuxError } from '../src/errors.js'
import { agentInteractionResponseUnavailableReason } from '../src/agent-interaction-state.js'
import type { AgentMuxInteractionRequest, AgentMuxInteractionResponse, AgentMuxPendingInteraction } from '../src/types.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'

const sid = 'recipient', runId = 'run-recipient', operationId = 'original-answer-operation'
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); vi.restoreAllMocks() })
function request(kind: 'permission' | 'question' = 'permission'): AgentMuxInteractionRequest {
  const common = { id: 'original-request', agentSessionId: sid, nativeToolCallId: 'original-call',
    evidence: { source: 'native-hook' as const, observedAt: _newTailFixtureEpoch(0, 0, 1), run: { runId }, hookReceiptId: 'original-request' } }
  return kind === 'permission' ? { ...common, kind, title: 'Original approval',
    options: [{ id: 'allow-once', label: 'Original option', kind: 'allow-once' }] }
    : { ...common, kind, questions: [{ id: 'original-question', prompt: 'Original prompt', options: [{ id: 'a', label: 'Original choice' }] }] }
}
function answer(kind: 'permission' | 'question' = 'permission'): AgentMuxInteractionResponse {
  return kind === 'permission' ? { kind, requestId: 'original-request', decision: { outcome: 'selected', optionId: 'allow-once' } }
    : { kind, requestId: 'original-request', outcome: 'answered', answers: [{ questionId: 'original-question', optionId: 'a' }] }
}
async function fixture(cursor: number | null = 11, frozen = false, kind: 'permission' | 'question' = 'permission') {
  const h = await rpcOwnerFixture([sid]); cleanups.push(h.close)
  const req = request(kind), response = answer(kind)
  const pending: AgentMuxPendingInteraction = { request: req, ...(frozen ? { response: {
    value: response, responseDigest: createHash('sha256').update(JSON.stringify(response)).digest('base64url'),
    operationId, inputByteRange: { startByte: 10, endByte: 11 }, acknowledged: false
  } } : {}) }
  const stored = (await h.store.readMetadata(sid))!
  await h.store.compareAndSwapMetadata(stored, { ...stored, pendingInteraction: pending,
    ...(frozen ? { interactionOperations: { [operationId]: { operationId, agentSessionId: sid, run: { runId },
      expectedRequest: req, response, delivery: 'unknown', nativeAdoption: 'unknown', inputByteRange: { startByte: 10, endByte: 11 } } } } : {}) })
  await h.inner.registry.load('local')
  h.inner.kernel.status = vi.fn(async (id: string) => ({ ...h.run(id), acceptedInputBytes: cursor }))
  const respond = () => h.client.respondAgentInteraction({ agentSessionId: sid, expectedRun: { runId }, operationId,
    expectedRequest: req, response })
  const recover = () => Reflect.get(h.client, 'recoverPendingInteractionResponses').call(h.client, [{ ...h.run(runId), acceptedInputBytes: cursor }]) as Promise<void>
  return { ...h, pending, respond, recover }
}

it.each(['permission', 'question'] as const)('terminal-only %s keeps the exact request and gives its original terminal route with no typed input', async kind => {
  const h = await fixture(0, false, kind)
  const connect = vi.spyOn(h.client, 'connect').mockRejectedValue(new Error('Runtime observation unavailable'))
  const route = agentInteractionResponseUnavailableReason(h.pending)
  expect(typeof route).toBe('string')
  expect(route).toMatch(/no addressable reply channel.*original terminal/)
  await expect(h.respond()).rejects.toMatchObject({ code: 'AGENT_INTERACTION_UNCONFIRMED', message: route })
  expect(connect).not.toHaveBeenCalled()
  expect(h.inner.kernel.input).not.toHaveBeenCalled()
  expect(h.client.agentSession(sid).pendingInteraction).toEqual(h.pending)
  connect.mockRestore()
  await h.client.writeAgent({ agentSessionId: sid, expectedRun: { runId }, source: 'user', data: 'human text' })
  expect(h.inner.kernel.input).toHaveBeenCalledOnce()
  expect(h.client.agentSession(sid).run).toEqual({ runId })
})

it.each([null, 0, 10])('cursor %s cannot replay the old unknown answer during explicit response or reconnect', async cursor => {
  const h = await fixture(cursor, true), before = structuredClone(h.client.agentSession(sid).pendingInteraction)
  await expect(h.respond()).rejects.toMatchObject({ code: 'AGENT_INTERACTION_UNCONFIRMED' })
  await h.recover()
  expect(h.inner.kernel.input).not.toHaveBeenCalled()
  expect(h.client.agentSession(sid).pendingInteraction).toEqual(before)
})

it('a partially crossed original byte range remains unknown without another Runtime call', async () => {
  const h = await fixture(11, true), stored = (await h.store.readMetadata(sid))!
  const original = h.client.providers.get('codex').planInteractionResponse
  vi.spyOn(h.client.providers.get('codex'), 'planInteractionResponse').mockImplementation((...args) => ({ ...original(...args), data: '12' }))
  await h.store.compareAndSwapMetadata(stored, { ...stored, pendingInteraction: { ...stored.pendingInteraction!,
    response: { ...stored.pendingInteraction!.response!, inputByteRange: { startByte: 10, endByte: 12 } } } })
  await h.inner.registry.load('local')
  await expect(h.respond()).rejects.toMatchObject({ code: 'AGENT_INTERACTION_UNCONFIRMED' })
  await h.recover()
  expect(h.inner.kernel.input).not.toHaveBeenCalled()
  expect(h.client.agentSession(sid).pendingInteraction?.response).toMatchObject({ acknowledged: false, inputByteRange: { startByte: 10, endByte: 12 } })
})

it('a later shared cursor cannot settle an unknown original operation without its Runtime receipt', async () => {
  const h = await fixture(14, true)
  h.inner.kernel.input = vi.fn(async () => { throw new AgentMuxError('Original operation unavailable.', 'CTXMUX_input_unknown', 'unknown') })
  await expect(h.respond()).rejects.toMatchObject({ detail: 'unknown' })
  await h.recover()
  expect(h.client.agentSession(sid).pendingInteraction).toEqual(h.pending)
  expect(await h.client.inspectAgentInteractionOperation({ agentSessionId: sid, operationId })).toMatchObject({ delivery: 'unknown', nativeAdoption: 'unknown' })
})

it('only the original operation and matching byte range confirm an already applied frozen answer', async () => {
  const h = await fixture(14, true)
  h.inner.kernel.input = vi.fn(async () => ({ run: { ...h.run(runId), acceptedInputBytes: 14 }, appliedByteRange: { startByte: 10, endByte: 11 } }))
  const receipt = await h.respond()
  expect(h.inner.kernel.input).toHaveBeenCalledExactlyOnceWith(runId, {
    ownerInstanceId: 'fixture-runtime', operationId, expectedByte: 10, data: '1'
  })
  expect(receipt).toMatchObject({ delivery: 'bytes-accepted', nativeAdoption: 'unknown', inputByteRange: { startByte: 10, endByte: 11 } })
  expect(h.client.agentSession(sid).pendingInteraction).toEqual({ ...h.pending,
    response: { ...h.pending.response!, acknowledged: true } })
  await h.recover()
  expect(h.inner.kernel.input).toHaveBeenCalledOnce()
})

it.each(['range', 'run'] as const)('an original Runtime ACK for the wrong %s cannot confirm the frozen answer', async changed => {
  const h = await fixture(14, true)
  h.inner.kernel.input = vi.fn(async () => ({ run: { ...h.run(changed === 'run' ? 'foreign-run' : runId), acceptedInputBytes: 14 },
    appliedByteRange: { startByte: changed === 'range' ? 11 : 10, endByte: 11 } }))
  await expect(h.respond()).rejects.toMatchObject({ code: 'AGENT_INTERACTION_RECEIPT_MISMATCH' })
  expect(h.client.agentSession(sid).pendingInteraction).toEqual(h.pending)
})
