import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { expect, it, vi } from 'vitest'
import { AGENTMUX_AGENT_MESSAGING_ENTRY, observeAgent, AgentMuxError, type ContinuousProgressLoop } from '@agentmux/core'
import { deliverContinuousProgress } from '@agentmux/host/continuous-progress-delivery'
const signal = new AbortController().signal
const loop: ContinuousProgressLoop = { loopId: 'l', hostId: 'local', agentSessionId: 'a', providerId: 'codex', workspacePath: _hygiene_fixturePath("w"), intervalMs: 10, prompt: 'next',
  nextCheckAt: _tailFixtureEpoch(0, 0, 0), status: 'active', pendingCompletion: { prompt: 'next', agentMuxNote: AGENTMUX_AGENT_MESSAGING_ENTRY,
    inputByte: 0, id: '["r",1]', operationId: 'same-operation', condition: { expectedRun: { runId: 'r' }, afterSubmissionId: null } } }
function fixture(state: 'done' | 'working' = 'done', runId = 'r', observedAt = _tailFixtureEpoch(0, 0, 1)) {
  return { observeContinuousProgress: vi.fn(async () => ({ session: {
    kind: 'agent' as const, executorId: 'codex', retiredRuns: [],  createdAt: _tailFixtureEpoch(0, 0, 1), updatedAt: _tailFixtureEpoch(0, 0, 1),
    agentSessionId: 'a', hostId: 'local', providerId: 'codex', workspacePath: _hygiene_fixturePath("w"), run: { runId },
    semanticStatus: { state, source: 'native-hook' as const, observedAt }
  }, inputByte: 0, inputOccupied: false, observation: observeAgent({ process: 'running', status: { state, source: 'native-hook', observedAt }, timelineCapability: 'complete-events', awaitingRequest: false, terminalCapabilityUnverified: false }, _tailFixtureEpoch(0, 0, 1)), tickId: 't', now: _tailFixtureEpoch(0, 0, 1) })), submitPrompt: vi.fn(async () => {}) }
}
it.each(['working', 'new-run', 'new-completion', 'paused'] as const)('abandons an old claim after %s', async (changed) => {
  const runtime = fixture(changed === 'working' ? 'working' : 'done', changed === 'new-run' ? 'r2' : 'r', changed === 'new-completion' ? 2 : 1)
  expect(await deliverContinuousProgress(runtime, loop, 'same-operation', () => changed !== 'paused', signal)).toBe('skipped')
  expect(runtime.submitPrompt).not.toHaveBeenCalled()
})
it('passes the original operation and completion condition across the actual input boundary', async () => {
  const runtime = fixture(); const active = () => true
  expect(await deliverContinuousProgress(runtime, loop, 'same-operation', active, signal)).toBe('sent')
  expect(runtime.submitPrompt).toHaveBeenCalledWith({ kind: 'agent', agentSessionId: 'a', hostId: 'local', run: { runId: 'r' } },
    'next', 'same-operation', loop.pendingCompletion!.condition, { completionId: '["r",1]', inputByte: 0, isCurrent: active, signal },
    undefined, undefined, AGENTMUX_AGENT_MESSAGING_ENTRY)
  runtime.submitPrompt.mockRejectedValueOnce(new AgentMuxError('changed', 'AGENT_COMPLETION_CHANGED'))
  expect(await deliverContinuousProgress(runtime, loop, 'same-operation', active, signal)).toBe('skipped')
})

it('reconciles an unknown operation even when the Agent has already started working', async () => {
  const runtime = fixture('working')
  expect(await deliverContinuousProgress(runtime, { ...loop, lastOutcome: 'unknown' }, 'same-operation', () => true, signal)).toBe('sent')
  expect(runtime.submitPrompt).toHaveBeenCalledOnce()
})

it('does not replace missing original content facts with the current configuration', async () => {
  const runtime = fixture()
  const { prompt: _, agentMuxNote: __, ...pendingCompletion } = loop.pendingCompletion!
  await expect(deliverContinuousProgress(runtime, { ...loop, lastOutcome: 'unknown', pendingCompletion },
    'same-operation', () => true, signal)).rejects.toMatchObject({ code: 'AGENT_PROMPT_INPUT_UNCONFIRMED', detail: 'unknown' })
  expect(runtime.submitPrompt).not.toHaveBeenCalled()
})
