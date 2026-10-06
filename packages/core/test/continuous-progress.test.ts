import { fixtureEpoch as _liveTailFixtureEpoch } from "./helpers/fixture-values.js"
import { createHash } from 'node:crypto'
import { fixturePath } from './helpers/fixture-values.js'
import { describe, expect, it } from 'vitest'
import { observeAgent } from '../src/agent-status-freshness.js'
import { agentInteractionActiveRequest } from '../src/agent-interaction-state.js'
import type { AgentMuxPendingInteraction } from '../src/types.js'
import { decideContinuousProgress } from '../src/continuous-progress.js'

const pending: AgentMuxPendingInteraction = { request: { kind: 'permission', id: 'permission', agentSessionId: 's', title: 'Private request',
  options: [{ id: 'allow-once', kind: 'allow-once', label: 'Allow' }], evidence: { source: 'native-hook', run: { runId: 'r' }, hookReceiptId: 'permission', observedAt: _liveTailFixtureEpoch(0, 0, 999) } } }

const base = {
  agentSessionId: 's', hostId: 'local', providerId: 'codex' as const, workspacePath: fixturePath("w"),
  run: { runId: 'r' }, semanticStatus: { state: 'done' as const, source: 'native-hook' as const, observedAt: 1000 },
  terminalPromptReadiness: { id: 'ready-1', source: 'native-stop' as const, run: { runId: 'r' }, outputCursorBytes: 1, readyThroughByte: 1 }
}

function observation(session: { semanticStatus: Parameters<typeof observeAgent>[0]['status']; pendingInteraction?: AgentMuxPendingInteraction }, now: number) {
  return observeAgent({ process: 'running', status: session.semanticStatus,
    timelineCapability: 'complete-events', awaitingRequest: agentInteractionActiveRequest(session.pendingInteraction) !== undefined,
    terminalCapabilityUnverified: false }, now)
}

describe('decideContinuousProgress', () => {
  it('sends once for an unconsumed ready stop', () => {
    expect(decideContinuousProgress({ inputByte: 0, inputOccupied: false, observation: observation(base, 2000), session: base, tickId: 't1', now: 2000 })).toEqual({ kind: 'send', tickId: 't1', completionId: '["r",1000]' })
  })
  it('preserves an unknown input fence without treating it as byte zero or consuming the ready stop', () => {
    const input = { inputOccupied: false, observation: observation(base, 2000), session: base, tickId: 't1', now: 2000 }
    expect(decideContinuousProgress({ ...input, inputByte: null })).toEqual({ kind: 'skip', reason: 'unknown-status' })
    expect(decideContinuousProgress({ ...input, inputByte: 0 })).toEqual({ kind: 'send', tickId: 't1', completionId: '["r",1000]' })
  })
  it('does not send while working or awaiting interaction, but missing readiness is not a gate', () => {
    expect(decideContinuousProgress({ inputByte: 0, inputOccupied: false, observation: observation({ ...base, semanticStatus: { state: 'working', source: 'native-hook', observedAt: 1000 } }, 2000), session: { ...base, semanticStatus: { state: 'working', source: 'native-hook', observedAt: 1000 } }, tickId: 't1', now: 2000 })).toEqual({ kind: 'skip', reason: 'working' })
    expect(decideContinuousProgress({ inputByte: 0, inputOccupied: false, observation: observation({ ...base, pendingInteraction: pending }, _liveTailFixtureEpoch(0, 2)), session: { ...base, pendingInteraction: pending }, tickId: 't1', now: _liveTailFixtureEpoch(0, 2) })).toEqual({ kind: 'skip', reason: 'interaction-pending' })
    const { readyThroughByte: _readyThroughByte, ...notReady } = base.terminalPromptReadiness
    const withoutScreenReadiness = { ...base, terminalPromptReadiness: notReady }
    expect(withoutScreenReadiness.terminalPromptReadiness).not.toHaveProperty('readyThroughByte')
    expect(decideContinuousProgress({ inputByte: 0, inputOccupied: false, observation: observation(withoutScreenReadiness, 2000), session: withoutScreenReadiness, tickId: 't1', now: 2000 })).toEqual({ kind: 'send', tickId: 't1', completionId: '["r",1000]' })
  })
  it('deduplicates tick/readiness and protects changed user input', () => {
    expect(decideContinuousProgress({ inputByte: 0, inputOccupied: false, observation: observation(base, 2000), session: base, tickId: 't1', lastTickId: 't1', now: 2000 })).toEqual({ kind: 'skip', reason: 'duplicate-tick' })
    expect(decideContinuousProgress({ inputByte: 0, inputOccupied: false, observation: observation(base, 2000), session: base, tickId: 't2', lastCompletionId: '["r",1000]', now: 2000 })).toEqual({ kind: 'skip', reason: 'completion-consumed' })
    expect(decideContinuousProgress({ inputByte: 0, observation: observation(base, 2000), session: base, tickId: 't2', inputOccupied: true, now: 2000 })).toEqual({ kind: 'skip', reason: 'user-input-changed' })
  })
})

it('does not reuse done while a manual admission is waiting for its native start event', () => {
  const session = { agentSessionId: 'a', hostId: 'local', providerId: 'codex', workspacePath: fixturePath("w"), run: { runId: 'r' },
    semanticStatus: { state: 'done' as const, source: 'native-hook' as const, observedAt: 1 },
    promptCompletionAdmission: { completionId: '["r",1]', operationId: 'manual-input', startByte: 0, endByte: 5 } }
  expect(decideContinuousProgress({ inputByte: 0, inputOccupied: false, observation: observation(session, 1), session, tickId: 't', now: 1 })).toEqual({ kind: 'skip', reason: 'completion-consumed' })
})

it('does not let a retained exact Hook receipt block continuous progress after the original native turn ended', () => {
  const request = pending.request
  if (request.kind !== 'permission') throw new Error('Fixture permission request is missing.')
  const ended = { ...request, permissionHook: { receiptId: request.id, nativeSessionId: 'native', nativeTurnId: 'turn',
    closed: 'decision-returned' as const, nativeTurnEnded: { recordId: 'original-turn-completion', observedAt: _liveTailFixtureEpoch(0, 1) } } }
  const session = { ...base, pendingInteraction: { request: ended } }
  expect(agentInteractionActiveRequest(session.pendingInteraction)).toBeUndefined()
  expect(decideContinuousProgress({ inputByte: 0, inputOccupied: false, observation: observation(session, _liveTailFixtureEpoch(0, 2)), session, tickId: 't1', now: _liveTailFixtureEpoch(0, 2) }))
    .toEqual({ kind: 'send', tickId: 't1', completionId: '["r",1000]' })
  const { nativeTurnEnded: _, ...httpOnly } = ended.permissionHook
  const unresolved = { ...base, pendingInteraction: { request: { ...ended, permissionHook: httpOnly } } }
  expect(decideContinuousProgress({ inputByte: 0, inputOccupied: false, observation: observation(unresolved, _liveTailFixtureEpoch(0, 2)), session: unresolved, tickId: 't2', now: _liveTailFixtureEpoch(0, 2) }))
    .toEqual({ kind: 'skip', reason: 'interaction-pending' })
})


it('does not resurrect an ended additional Hook when the original terminal tuple retains its unknown receipt', () => {
  const request = pending.request
  if (request.kind !== 'permission') throw new Error('Fixture permission request is missing.')
  const root = { ...request, nativeToolCallId: 'original-terminal-call' }
  const ended = { ...request, id: 'new-hook', permissionHook: { receiptId: 'new-hook', nativeSessionId: 'native', nativeTurnId: 'turn',
    nativeTurnEnded: { recordId: 'exact-turn-end', observedAt: _liveTailFixtureEpoch(0, 1) } } }
  const value = { kind: 'permission' as const, requestId: root.id, decision: { outcome: 'selected' as const, optionId: 'allow-once' } }
  const retained: AgentMuxPendingInteraction = { request: root, additionalRequests: [ended],
    response: { value, responseDigest: createHash('sha256').update(JSON.stringify(value)).digest('base64url'), operationId: 'original-tty-unknown',
      inputByteRange: { startByte: 0, endByte: 1 }, acknowledged: false },
    nativeCompleted: { source: 'native-hook', run: { runId: 'r' }, hookReceiptId: 'original-terminal-call-end', observedAt: _liveTailFixtureEpoch(0, 1) } }
  const session = { ...base, pendingInteraction: retained }
  expect(agentInteractionActiveRequest(retained)).toBeUndefined()
  expect(decideContinuousProgress({ inputByte: 0, inputOccupied: false, session, observation: observation(session, _liveTailFixtureEpoch(0, 2)), tickId: 'new', now: _liveTailFixtureEpoch(0, 2) }))
    .toEqual({ kind: 'send', tickId: 'new', completionId: '["r",1000]' })
  expect(session.pendingInteraction).toBe(retained)
})
