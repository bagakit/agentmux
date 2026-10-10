// @vitest-environment node
import { expect, it } from 'vitest'
import { agentActivityRemainingMs, observeAgent, msUntilSemanticStatusStale } from '../src/agent-status-freshness.js'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'

it('Core remaining validity is a pure query over the original classified observation and its one freshness owner', () => {
  const observation = observeAgent({ process: 'running', status: { state: 'working', source: 'native-hook', observedAt: _historyFixtureEpoch(0, 1, 0) },
    currentActivity: { state: 'active', nativeSessionId: 'native-original', nativeTurnId: 'turn-original', sourceId: 'original-channel', sequence: 1, source: 'native-hook', run: { runId: 'original-run' }, hookReceiptId: 'original-receipt', observedAt: _historyFixtureEpoch(0, 1, 0) },
    timelineCapability: 'complete-events', awaitingRequest: false, terminalCapabilityUnverified: false }, 1000)
  const remaining = agentActivityRemainingMs(observation, 1000)
  expect(remaining).toBe(msUntilSemanticStatusStale({ state: 'working', observedAt: observation.observedAt }, 1000)); expect(remaining).toBeGreaterThan(0)
  expect(agentActivityRemainingMs(observation, 1000 + remaining)).toBe(0)
  for (const semantic of ['idle', 'unknown', 'awaiting-input', 'unsupported'] as const) expect(agentActivityRemainingMs({ ...observation, semantic }, 1000)).toBe(0)
})
