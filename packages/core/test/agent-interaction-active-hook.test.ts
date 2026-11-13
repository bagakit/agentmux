import { expect, it } from 'vitest'
import { agentInteractionActiveRequest, agentInteractionResponseUnavailableReason } from '../src/agent-interaction-state.js'
import type { AgentMuxPendingInteraction, AgentMuxPermissionRequest } from '../src/types.js'

function request(id = 'original'): AgentMuxPermissionRequest {
  return { kind: 'permission', id, agentSessionId: 'session', title: 'Native permission',
    options: [{ id: 'allow-once', label: 'Allow once', kind: 'allow-once' }],
    permissionHook: { receiptId: id }, evidence: { source: 'native-hook', observedAt: 1, run: { runId: 'run' }, hookReceiptId: id } }
}
function response(delivery: 'saved' | 'unknown' | 'connection-written') {
  return { value: { kind: 'permission' as const, requestId: 'original', decision: { outcome: 'selected' as const, optionId: 'allow-once' } },
    operationId: 'original-response', responseDigest: 'original-digest', delivery }
}

it('a returned original callback leaves the active answer projection without deleting its undecided Native facts', () => {
  const original = request(), pending: AgentMuxPendingInteraction = { request: { ...original,
    permissionHook: { ...original.permissionHook!, closed: 'decision-returned', response: response('connection-written') } } }
  const before = structuredClone(pending)
  expect(agentInteractionActiveRequest(pending)).toBeUndefined()
  expect(agentInteractionResponseUnavailableReason(pending)).toBeUndefined()
  expect(pending).toEqual(before)
  expect(pending).not.toHaveProperty('nativeCompleted')
  expect(pending.request).not.toHaveProperty('nativeToolCallId')
})

it.each(['saved', 'unknown'] as const)('a %s response remains an unresolved original request even if a close observation arrives', delivery => {
  const original = request(), pending: AgentMuxPendingInteraction = { request: { ...original,
    permissionHook: { ...original.permissionHook!, closed: 'decision-returned', response: response(delivery) } } }
  expect(agentInteractionActiveRequest(pending)).toBe(pending.request)
  expect(agentInteractionResponseUnavailableReason(pending)).toContain('saved or its delivery is unknown')
})

it.each([undefined, 'abstained'] as const)('an original %s callback is retained for Native answer when delivery was not decided', closed => {
  const original = request(), pending: AgentMuxPendingInteraction = { request: { ...original,
    permissionHook: { ...original.permissionHook!, ...(closed ? { closed } : {}) } } }
  expect(agentInteractionActiveRequest(pending)).toBe(pending.request)
  if (closed) expect(agentInteractionResponseUnavailableReason(pending)).toContain('Use the original terminal')
})

it('a write observation without the original callback close cannot settle the wait', () => {
  const original = request(), pending: AgentMuxPendingInteraction = { request: { ...original,
    permissionHook: { ...original.permissionHook!, response: response('connection-written') } } }
  expect(agentInteractionActiveRequest(pending)).toBe(pending.request)
})

it('a returned callback cannot hide another original permission or a Native-only request', () => {
  const original = request(), second = request('second'), native = { ...request('native') }
  delete native.permissionHook
  const pending: AgentMuxPendingInteraction = { request: { ...original,
    permissionHook: { ...original.permissionHook!, closed: 'decision-returned', response: response('connection-written') } }, additionalRequests: [second, native] }
  expect(agentInteractionActiveRequest(pending)).toBe(second)
  const next = { ...pending, additionalRequests: [native] }
  expect(agentInteractionActiveRequest(next)).toBe(native)
})
