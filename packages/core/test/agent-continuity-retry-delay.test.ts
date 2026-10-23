import { expect, it } from 'vitest'
import { agentContinuityRetryBaseDelay } from '../src/agent-session-recovery/continuity.js'

it('doubles additional retry waits and caps each base without accumulating time', () => {
  const policy = { retryInitialDelayMs: 1000, retryMaxDelayMs: 5000 }
  expect([1, 2, 3, 4, 5].map(retry => agentContinuityRetryBaseDelay(policy, retry))).toEqual([1000, 2000, 4000, 5000, 5000])
})

it('keeps zero waits and very large valid retry counts finite', () => {
  expect(agentContinuityRetryBaseDelay({ retryInitialDelayMs: 0, retryMaxDelayMs: 5000 }, Number.MAX_SAFE_INTEGER)).toBe(0)
  expect(agentContinuityRetryBaseDelay({ retryInitialDelayMs: 1, retryMaxDelayMs: Number.MAX_SAFE_INTEGER }, Number.MAX_SAFE_INTEGER)).toBe(2 ** 52)
})
