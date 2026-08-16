import { expect, it, vi } from 'vitest'
import { AgentMuxError, type ContinuousProgressLoop } from '@agentmux/core'
import { deliverContinuousProgress } from '../src/main/continuous-progress-delivery'
const signal = new AbortController().signal
const loop: ContinuousProgressLoop = { loopId: 'l', agentSessionId: 'a', intervalMs: 10, prompt: 'next',
  nextCheckAt: 0, status: 'active', pendingCompletion: { id: '["r",1]', operationId: 'same-operation' } }
function fixture(state: 'done' | 'working' = 'done', runId = 'r', observedAt = 1) {
  return { observeContinuousProgress: vi.fn(async () => ({ session: {
    agentSessionId: 'a', hostId: 'local', providerId: 'codex', workspacePath: '/w', run: { runId },
    semanticStatus: { state, source: 'native-hook' as const, observedAt }
  }, tickId: 't', now: 1 })), submitPrompt: vi.fn(async () => {}) }
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
    'next', 'same-operation', { completionId: '["r",1]', isCurrent: active, signal })
  runtime.submitPrompt.mockRejectedValueOnce(new AgentMuxError('changed', 'AGENT_COMPLETION_CHANGED'))
  expect(await deliverContinuousProgress(runtime, loop, 'same-operation', active, signal)).toBe('skipped')
})

it('reconciles an unknown operation even when the Agent has already started working', async () => {
  const runtime = fixture('working')
  expect(await deliverContinuousProgress(runtime, { ...loop, lastOutcome: 'unknown' }, 'same-operation', () => true, signal)).toBe('sent')
  expect(runtime.submitPrompt).toHaveBeenCalledOnce()
})
