// @vitest-environment happy-dom
import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { afterEach, expect, it } from 'vitest'
import type { AgentMuxAgentSession, AgentTerminalFrontend } from '@agentmux/core'
import { composerSession, composerConfig } from './helpers/composer-dom-fixture'
import { useAppStore } from '../src/renderer/src/store'
import { sessionFrontendPresentation } from '../src/renderer/src/lib/session-recovery-banner'
import { originalFrontendRecovery, originalSessionRestart } from '../src/renderer/src/lib/session-original-recovery'
import { DEFAULT_AGENT_CONTINUITY_POLICY } from '@agentmux/core/agent-session-recovery'

const initial = useAppStore.getState()
afterEach(() => useAppStore.setState(initial, true))
const session = composerSession('frontend-original')
const frontend: AgentTerminalFrontend = { run: session.control.run, frontendId: 'original-frontend', state: 'detached',
  backendState: 'running', source: 'managed-process', observedAt: _tailFixtureEpoch(0, 0, 100), exitCode: 0 }

it('keeps the running backend fact separate from disconnected frontend presentation', () => {
  const view = { ...session, terminalFrontend: frontend }
  expect(sessionFrontendPresentation(view)).toEqual({ kind: 'detached', title: 'Terminal disconnected',
    detail: 'The backend is still running. Resume reconnects this terminal to the same conversation.' })
  expect(view.processState).toBe('running')
  expect(sessionFrontendPresentation({ ...view, terminalFrontend: { ...frontend, state: 'attached' } })).toBeNull()
  expect(sessionFrontendPresentation({ ...view, processState: 'exited' })).toBeNull()
})

it('does not apply an old frontend generation from another Run to the current terminal', () => {
  expect(sessionFrontendPresentation({ ...session, terminalFrontend: { ...frontend, run: { runId: 'previous-run' } } })).toBeNull()
  expect(sessionFrontendPresentation(session)).toBeNull()
})

it('expresses stopping and unknown without asserting a running task or a dead Session', () => {
  expect(sessionFrontendPresentation({ ...session, terminalFrontend: { ...frontend, backendState: 'stopping' } })?.detail).toContain('finishing its shutdown')
  expect(sessionFrontendPresentation({ ...session, terminalFrontend: { ...frontend, state: 'unknown', backendState: 'unknown' } })?.title).toBe('Terminal connection unconfirmed')
})

it('consumes actual Core Session events, clears recovered frontend state and preserves original drafts and Run', () => {
  useAppStore.setState({ ...initial, config: composerConfig, sessions: [session], loading: false,
    agentComposerDrafts: { [session.id]: 'Original unsent input' }, timelines: {}, tabs: {}, layouts: {} }, true)
  const event = (value: AgentTerminalFrontend | undefined, updatedAt: number) => {
    const core: AgentMuxAgentSession = { kind: 'agent', agentSessionId: session.id, providerId: session.providerId,
      executorId: session.executorId, hostId: 'local', workspacePath: session.workspacePath,
      run: session.control.run, retiredRuns: [], createdAt: session.createdAt, updatedAt,
      ...(value ? { terminalFrontend: value } : {}) }
    useAppStore.getState().applyEvent({ type: 'core', hostId: 'local', event: { type: 'agent-session', session: core } })
  }
  event(frontend, session.agentSessionUpdatedAt + 1)
  const detached = useAppStore.getState().sessions[0]!
  expect(detached.kind).toBe('agent')
  if (detached.kind !== 'agent') throw new Error('Expected the original Agent projection')
  expect(detached.terminalFrontend).toEqual(frontend)
  expect(sessionFrontendPresentation(detached)?.title).toBe('Terminal disconnected')
  event({ ...frontend, frontendId: 'new-frontend', state: 'attached', observedAt: _tailFixtureEpoch(0, 0, 200) }, session.agentSessionUpdatedAt + 2)
  expect(sessionFrontendPresentation(useAppStore.getState().sessions[0])).toBeNull()
  event(undefined, session.agentSessionUpdatedAt + 3)
  const restored = useAppStore.getState().sessions[0]!
  if (restored.kind !== 'agent') throw new Error('Expected the original Agent projection')
  expect(restored.terminalFrontend).toBeUndefined()
  expect(restored.control).toEqual(session.control)
  expect(restored.processState).toBe('running')
  expect(useAppStore.getState().agentComposerDrafts[session.id]).toBe('Original unsent input')
})

it('recovers the original frontend operation from retained Core facts after the current pointer changes', () => {
  const original = { operationId: 'original-reconnect', agentSessionId: session.id, trigger: 'manual' as const,
    policy: { ...DEFAULT_AGENT_CONTINUITY_POLICY }, previousRun: session.control.run,
    admittedAt: _tailFixtureEpoch(0, 0, 1), observedAt: _tailFixtureEpoch(0, 0, 2), rechecks: 0, kind: 'pending' as const, reason: 'operation-unconfirmed',
    evidence: { kind: 'run-running' as const, observedAt: _tailFixtureEpoch(0, 0, 2) },
    frontendReconnect: { previousFrontendId: frontend.frontendId, outputAfterByte: 100 } }
  const view = { ...session, terminalFrontend: frontend, continuityOperations: { [original.operationId]: original },
    continuity: { ...original, operationId: 'later-observation', frontendReconnect: undefined } }
  expect(originalFrontendRecovery(structuredClone(view))?.operationId).toBe('original-reconnect')
  expect(originalFrontendRecovery({ ...view, terminalFrontend: { ...frontend, frontendId: 'next-frontend' } })).toBeUndefined()
  expect(originalFrontendRecovery({ ...view, control: { ...session.control, run: { runId: 'later-run' } } })).toBeUndefined()
})

it('retains unknown restart operations while allowing a new explicit intent after typed startup failure', () => {
  const original = { operationId: 'failed-restart', agentSessionId: session.id, trigger: 'manual' as const,
    action: 'restart' as const, policy: { ...DEFAULT_AGENT_CONTINUITY_POLICY }, previousRun: { runId: 'previous-run' },
    newRun: session.control.run, admittedAt: _tailFixtureEpoch(0, 0, 1), observedAt: _tailFixtureEpoch(0, 0, 2), rechecks: 0, kind: 'unavailable' as const,
    reason: 'restart-startup-failed', errorCode: 'AGENT_TERMINAL_HANDSHAKE_FAILED',
    evidence: { kind: 'agent-session-store' as const } }
  expect(originalSessionRestart({ ...session, continuityOperations: { [original.operationId]: original } })).toBeUndefined()
  const unknown = { ...original, errorCode: undefined }
  expect(originalSessionRestart({ ...session, continuityOperations: { [unknown.operationId]: unknown } })?.operationId).toBe(original.operationId)
})


it('uses the retained original restart when an older current pointer has the same ID', () => {
  const original = { operationId: 'original-restart', agentSessionId: session.id, trigger: 'manual' as const,
    action: 'restart' as const, policy: { ...DEFAULT_AGENT_CONTINUITY_POLICY }, previousRun: session.control.run,
    admittedAt: _tailFixtureEpoch(0, 0, 1), observedAt: _tailFixtureEpoch(0, 0, 2), rechecks: 0, kind: 'starting' as const,
    reason: 'restart-stopping', evidence: { kind: 'run-unknown' as const, observedAt: _tailFixtureEpoch(0, 0, 2) } }
  const stale = { ...original, action: undefined, kind: 'reattachable' as const, reason: 'reattachable' }
  const view = { ...session, continuityOperations: { [original.operationId]: original }, continuity: stale }
  expect(originalSessionRestart(view)).toEqual(original)
  expect(originalSessionRestart({ ...view, continuity: { ...stale, operationId: 'other-observation' } })).toEqual(original)
})
