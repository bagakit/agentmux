import { describe, expect, it } from 'vitest'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { decideAgentSessionContinuity } from '../src/agent-session-continuity.js'
import type { AgentMuxAgentSession, AgentMuxRun } from '../src/types.js'

const providers = new AgentProviderRegistry()

function session(providerId = 'codex'): AgentMuxAgentSession {
  return {
    kind: 'agent',
    agentSessionId: 'agent-1',
    providerId,
    executorId: providerId,
    hostId: 'local',
    workspacePath: '/repo',
    run: { runId: 'run-1' },
    retiredRuns: [],
    outputCursorBytes: 0,
    createdAt: 1,
    updatedAt: 1,
    nativeHandle: { kind: 'provider', providerId, sessionId: 'native-1' }
  }
}

function run(state: AgentMuxRun['state'] = 'running'): AgentMuxRun {
  return {
    runId: 'run-1',
    kind: 'agent',
    providerId: 'codex',
    executorId: 'codex',
    agentSessionId: 'agent-1',
    workspacePath: '/repo',
    pid: state === 'running' ? 42 : null,
    state,
    cols: 80,
    rows: 24,
    observedAt: 10,
    latestOutputBytes: 12,
    acceptedInputBytes: 0,
    ...(state === 'exited' ? { exitCode: 0 } : {}),
    ...(state === 'interrupted' ? { interruptionReason: 'daemon_restart' } : {})
  }
}

function facts(overrides: Partial<Parameters<typeof decideAgentSessionContinuity>[0]> = {}) {
  const current = session()
  const catalog = providers.get('codex').catalog
  return {
    agentSessionId: current.agentSessionId,
    hostId: current.hostId,
    expectedRun: current.run,
    observedAt: 10,
    session: current,
    retirement: null,
    run: run(),
    catalog,
    capability: {
      providerId: current.providerId,
      executable: 'codex',
      installed: true,
      capabilities: { ...catalog.capabilities }
    },
    ...overrides
  }
}

describe('Agent Session continuity decision', () => {
  it('keeps a matching live Run attach-only even when Provider resume is available', () => {
    expect(decideAgentSessionContinuity(facts())).toMatchObject({
      kind: 'reattachable',
      previousRun: { runId: 'run-1' },
      run: { runId: 'run-1', state: 'running' },
      evidence: { kind: 'run-running', observedAt: 10 }
    })
  })

  it.each(['exited', 'interrupted', null] as const)(
    'selects Provider-native resume for a trusted handle when the Run is %s',
    (state) => {
      const currentRun = state === null ? null : run(state)
      expect(decideAgentSessionContinuity(facts({ run: currentRun }))).toMatchObject({
        kind: 'resume',
        previousRun: { runId: 'run-1' },
        nativeHandle: { providerId: 'codex', sessionId: 'native-1' },
        evidence: state === null
          ? { kind: 'run-missing' }
          : { kind: 'run-ended', state }
      })
    }
  )

  it('returns explicit unavailability without a verified Provider handle', () => {
    const current = session()
    delete current.nativeHandle
    expect(decideAgentSessionContinuity(facts({ session: current, run: null }))).toMatchObject({
      kind: 'unavailable',
      reason: 'native-handle-unavailable',
      evidence: { kind: 'run-missing' }
    })
  })

  it('returns retired only from persisted retired Run truth', () => {
    expect(decideAgentSessionContinuity(facts({
      session: null,
      retirement: {
        agentSessionId: 'agent-1',
        hostId: 'local',
        run: { runId: 'run-1' },
        source: 'user',
        observedAt: 20
      },
      run: null,
      catalog: null,
      capability: null
    }))).toEqual({
      kind: 'retired',
      agentSessionId: 'agent-1',
      previousRun: { runId: 'run-1' },
      evidence: { kind: 'user-retired', observedAt: 20 }
    })
    expect(decideAgentSessionContinuity(facts({
      session: null,
      retirement: null,
      run: null,
      catalog: null,
      capability: null
    }))).toMatchObject({ kind: 'unavailable', reason: 'unknown-session' })
    for (const retirement of [
      {
        agentSessionId: 'another-agent',
        hostId: 'local',
        run: { runId: 'run-1' },
        source: 'user' as const,
        observedAt: 20
      },
      {
        agentSessionId: 'agent-1',
        hostId: 'another-host',
        run: { runId: 'run-1' },
        source: 'user' as const,
        observedAt: 20
      },
      {
        agentSessionId: 'agent-1',
        hostId: 'local',
        run: { runId: 'another-run' },
        source: 'user' as const,
        observedAt: 20
      }
    ]) {
      expect(decideAgentSessionContinuity(facts({
        session: null,
        retirement,
        run: null,
        catalog: null,
        capability: null
      }))).toMatchObject({ kind: 'unavailable', reason: 'unknown-session' })
    }
  })

  it('fails a stale exact Run fence as a typed conflict', () => {
    expect(decideAgentSessionContinuity(facts({ expectedRun: { runId: 'stale-run' } }))).toEqual({
      kind: 'conflict',
      agentSessionId: 'agent-1',
      previousRun: { runId: 'stale-run' },
      currentRun: { runId: 'run-1' },
      reason: 'session-run-changed',
      evidence: { kind: 'agent-session-store' }
    })
  })

  it('requires the Provider locator and a positive host capability', () => {
    const pi = session('pi')
    expect(decideAgentSessionContinuity(facts({
      session: pi,
      run: null,
      catalog: providers.get('pi').catalog,
      capability: null
    }))).toMatchObject({ kind: 'unavailable', reason: 'native-handle-unavailable' })
    expect(decideAgentSessionContinuity(facts({
      run: null,
      capability: {
        providerId: 'codex',
        executable: 'codex',
        installed: false,
        capabilities: { ...providers.get('codex').catalog.capabilities }
      }
    }))).toMatchObject({ kind: 'unavailable', reason: 'provider-unavailable' })
  })

  it('rejects Run and Provider facts that belong to another owner', () => {
    expect(decideAgentSessionContinuity(facts({
      run: { ...run(), runId: 'run-2' }
    }))).toMatchObject({ kind: 'conflict', reason: 'session-run-changed' })
    expect(decideAgentSessionContinuity(facts({
      run: { ...run(), agentSessionId: 'agent-2' }
    }))).toMatchObject({ kind: 'conflict', reason: 'session-run-changed' })
    expect(decideAgentSessionContinuity(facts({
      run: null,
      catalog: providers.get('pi').catalog
    }))).toMatchObject({ kind: 'unavailable', reason: 'provider-resume-unsupported' })
    expect(decideAgentSessionContinuity(facts({
      run: null,
      capability: {
        providerId: 'pi',
        executable: 'pi',
        installed: true,
        capabilities: { ...providers.get('pi').catalog.capabilities }
      }
    }))).toMatchObject({ kind: 'unavailable', reason: 'provider-unavailable' })
  })
})
