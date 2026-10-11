import { fixtureEpoch as _lateFixtureEpoch } from "../../../../test/fixture-values.mjs"
import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentProviderRegistry } from '../../src/agent-provider.js'
import { cloneSession } from '../../src/agent-session-identity.js'
import { AgentMuxFileAgentSessionStore, loadAgentSessions, normalizeStoredAgentSession } from '../../src/agent-session-store.js'
import { parseRpcAgentSession, parseRpcNativeResult } from '../../src/rpc-native-codec.js'
import type { AgentMuxStoredAgentSession, AgentRecoveryActivity } from '../../src/types.js'
import { fixturePath } from '../helpers/fixture-values.js'

const providers = new AgentProviderRegistry()
const original = (): AgentMuxStoredAgentSession => ({
  kind: 'agent', agentSessionId: 'core-main', providerId: 'claude', executorId: 'claude', hostId: 'local',
  workspacePath: fixturePath('recovery/main'), run: { runId: 'original-run' }, retiredRuns: [],
  nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'native-main' },
  hookBindingId: 'original-hook', hookToken: 'original-token', createdAt: _lateFixtureEpoch(0, 0, 1), updatedAt: _lateFixtureEpoch(0, 0, 100)
})
const ended = (): AgentRecoveryActivity => ({
  state: 'idle', interruption: 'interrupted', run: { runId: 'original-run' }, nativeSessionId: 'native-main',
  nativeTurnId: 'original-turn', sourceId: 'native-source', sequence: 2,
  hookReceiptId: 'original-end', observedAt: _lateFixtureEpoch(0, 0, 90), promptSubmissionId: 'original-prompt'
})
function native(eventName: string, extra: Record<string, unknown> = {}) {
  return providers.get('claude').normalizeHook({ receiptId: 'native-record', agentSessionId: 'core-main',
    runId: 'original-run', providerId: 'claude', eventName,
    payload: { session_id: 'native-main', sourceId: 'native-source', turnId: 'original-turn', sequence: 2, ...extra }
  }, { nativeHandle: original().nativeHandle! })
}

describe('Provider native interruption evidence', () => {
  it('declares support explicitly and preserves it through Provider construction, probing and public native catalog decoding', async () => {
    expect(providers.catalog().filter(entry => entry.capabilities.nativeInterruption).map(entry => entry.id).sort())
      .toEqual(['claude', 'codex'])
    for (const providerId of ['claude', 'codex', 'pi']) {
      const provider = providers.get(providerId)
      const probe = await provider.probeCapabilities({ hasExecutable: async () => true })
      expect(probe.capabilities.nativeInterruption).toBe(provider.catalog.capabilities.nativeInterruption)
      const params = { hostId: 'local', executorId: providerId }
      const result = { ...params, providerId, capabilities: probe.capabilities, availability: 'available', sessions: [], issues: [] }
      expect(parseRpcNativeResult('agent.native.ls', result, params)).toEqual(result)
      expect(() => parseRpcNativeResult('agent.native.ls', { ...result,
        capabilities: { ...probe.capabilities, nativeInterruption: false } }, params)).toThrow()
    }
  })

  it('uses only exact completed native-turn reason and preserves task-completion uncertainty', () => {
    for (const reason of ['aborted', 'answer', 'refusal', 'error']) {
      const event = native('turn.complete', { reason, isAborted: reason === 'aborted' })
      expect(event.currentActivity).toMatchObject({ state: 'idle', nativeSessionId: 'native-main',
        nativeTurnId: 'original-turn', sourceId: 'native-source', sequence: 2,
        interruption: reason === 'aborted' ? 'interrupted' : 'not-interrupted' })
      expect(event.semanticState).toBe(reason === 'error' ? 'error' : 'unknown')
    }
    const oldEnd = native('turn.complete', { reason: 'aborted', isAborted: true }).currentActivity!
    const newTurn = native('turn.start', { turnId: 'later-turn', sequence: 3 }).currentActivity!
    expect(oldEnd.interruption).toBe('interrupted')
    expect(newTurn).toMatchObject({ state: 'active', nativeTurnId: 'later-turn', sequence: 3 })
    expect(newTurn).not.toHaveProperty('interruption')
    const gap = native('AgentMuxActivityUnavailable', { reason: 'delivery-gap', sequence: 4 }).currentActivity!
    expect(gap.state).toBe('unknown')
    expect(gap).not.toHaveProperty('interruption')
  })

  it('withholds main interruption for contradictory, unknown, display-only, foreign and child observations', () => {
    for (const extra of [
      { reason: 'aborted', isAborted: false }, { reason: 'answer', isAborted: true },
      { reason: 'future-reason', isAborted: false }, { reason: 'aborted' },
      { reason: 'aborted', isAborted: true, turnId: '' },
      { reason: 'aborted', isAborted: true, session_id: 'foreign-main' },
      { reason: 'aborted', isAborted: true, agent_id: 'child' },
      { reason: 'aborted', isAborted: true, agentId: 'child' }
    ]) expect(native('turn.complete', extra).currentActivity).toBeUndefined()
    for (const eventName of ['Stop', 'SessionEnd', 'Notification']) {
      expect(native(eventName, { reason: 'interrupted', isAborted: true,
        last_assistant_message: 'Interrupted', message: 'active' }).currentActivity).toBeUndefined()
    }
  })
})

describe('retained original-Run recovery activity', () => {
  it('persists through the real FileStore and replaces an old ending with a new turn and an observation gap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-native-interruption-'))
    const path = join(root, 'sessions.json')
    try {
      const writer = new AgentMuxFileAgentSessionStore(path)
      const previous = { ...original(), recoveryActivity: ended() }
      await writer.compareAndSwap(null, previous)
      const [restored] = await loadAgentSessions(new AgentMuxFileAgentSessionStore(path))
      expect(restored?.recoveryActivity).toEqual(ended())
      const { interruption: _ending, ...position } = ended()
      const active: AgentRecoveryActivity = { ...position, state: 'active', nativeTurnId: 'later-turn', sequence: 3 }
      const next = { ...previous, recoveryActivity: active }
      await writer.compareAndSwap(previous, next)
      expect((await loadAgentSessions(new AgentMuxFileAgentSessionStore(path)))[0]?.recoveryActivity).toEqual(active)
      const { nativeTurnId: _turn, ...unbound } = active
      const gap: AgentRecoveryActivity = { ...unbound, state: 'unknown', sequence: 4 }
      await writer.compareAndSwap(next, { ...next, recoveryActivity: gap })
      expect((await loadAgentSessions(new AgentMuxFileAgentSessionStore(path)))[0]?.recoveryActivity).toEqual(gap)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('round-trips exact recovery evidence without exposing it as live activity or a public Session field', () => {
    const activity = ended(), session = normalizeStoredAgentSession({ ...original(), recoveryActivity: activity })
    expect(session.recoveryActivity).toEqual(activity)
    expect(session).not.toHaveProperty('currentActivity')
    expect(cloneSession(session)).not.toHaveProperty('recoveryActivity')
    expect(cloneSession(session)).not.toHaveProperty('currentActivity')
    const { promptSubmissionId: _privatePrompt, ...publicActivity } = activity
    const currentActivity = { ...publicActivity, source: 'native-hook' }
    expect(parseRpcAgentSession({ ...cloneSession(session), currentActivity }).currentActivity).toEqual(currentActivity)
    expect(() => parseRpcAgentSession({ ...cloneSession(session), currentActivity: { ...currentActivity, state: 'active' } })).toThrow()
  })

  it('preserves unknown observations and absent historic prompt identity without inventing an ending', () => {
    const { interruption: _end, nativeTurnId: _turn, promptSubmissionId: _prompt, ...position } = ended()
    const unknown = { ...position, state: 'unknown' }
    expect(normalizeStoredAgentSession({ ...original(), recoveryActivity: unknown }).recoveryActivity).toEqual(unknown)
    const { interruption: _oldEnd, ...active } = ended()
    const next = { ...active, state: 'active', nativeTurnId: 'later-turn', sequence: 3 }
    expect(normalizeStoredAgentSession({ ...original(), recoveryActivity: next }).recoveryActivity).toEqual(next)
    expect(normalizeStoredAgentSession(original())).not.toHaveProperty('recoveryActivity')
  })

  it('rejects changed subjects, malformed ordered identities and contradictory outcome metadata', () => {
    for (const mutation of [
      { run: { runId: 'retired-run' } }, { nativeSessionId: 'foreign-main' },
      { nativeTurnId: '' }, { sourceId: '' }, { hookReceiptId: '' }, { promptSubmissionId: '' },
      { sequence: 0 }, { sequence: 1.5 }, { sequence: Number.MAX_SAFE_INTEGER + 1 },
      { observedAt: _lateFixtureEpoch(0, 0, -1) }, { observedAt: _lateFixtureEpoch(0, 0, 101) }, { state: 'active' }, { state: 'unknown' },
      { interruption: 'unknown' }, { displayedState: 'interrupted' }
    ]) expect(() => normalizeStoredAgentSession({ ...original(), recoveryActivity: { ...ended(), ...mutation } })).toThrow()
    expect(() => normalizeStoredAgentSession({ ...original(), nativeHandle: undefined, recoveryActivity: ended() })).toThrow()
    expect(() => normalizeStoredAgentSession({ ...original(), providerId: 'different-provider', recoveryActivity: ended() })).toThrow()
  })
})
