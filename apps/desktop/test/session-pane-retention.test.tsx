// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from 'react'
import { expect, it, vi } from 'vitest'
import { appendFileSync } from 'node:fs'
import type { AgentMuxAgentSession } from '@agentmux/core'
import { DEFAULT_AGENT_CONTINUITY_POLICY, type AgentMuxContinuityOperation } from '@agentmux/core/agent-session-recovery'
import type { SessionSnapshot } from '../src/shared/contracts'
import { useAppStore, type AgentSteerQueueEntry } from '../src/renderer/src/store'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { createClientUiRoot } from './helpers/client-ui-render'
import { SessionPane } from '../src/renderer/src/components/SessionPane'

// Same boundary as T018: the actual Pane/Composer and Store remain mounted.
vi.mock('@agentmux/client-ui/components/AgentComposer', () => ({
  AgentComposer: ({ value }: { value: string }) => createElement('output', { 'data-draft': true }, value)
}))
vi.mock('../src/renderer/src/components/SessionMailbox', () => ({
  SessionMailbox: ({ children }: ComponentProps<typeof import('../src/renderer/src/components/SessionMailbox').SessionMailbox>) => children?.(null, null, { current: null })
}))
vi.mock('../src/renderer/src/components/TerminalView', () => ({
  TerminalView: ({ session }: { session: SessionSnapshot }) => createElement('output', {
    'data-original-run': session.control.run.runId, 'data-status': session.status.state,
    'data-agent-clock': session.kind === 'agent' ? session.agentSessionUpdatedAt : undefined,
    'data-continuity': session.kind === 'agent' && Boolean(session.continuity)
  })
}))

type Observation = { collected: boolean }
const registry = new FinalizationRegistry<Observation>(observation => { observation.collected = true })
function seed() {
  const session = composerSession('pane-retention-original')
  const unrelated = composerSession('pane-retention-current')
  const queueEntry: AgentSteerQueueEntry = { operationId: 'preserved-queued-intent', runId: session.control.run.runId,
    text: 'Original explicitly deferred input', status: 'deferred', awaitingExplicitSend: true, enqueuedAt: 1 }
  const key = { kind: 'message' as const, agentSessionId: session.id, expectedRun: session.control.run, messageId: 'pane-retention-message' }
  const operation: AgentMuxContinuityOperation = {
    operationId: 'pane-retention-continuity', agentSessionId: session.id, trigger: 'startup',
    policy: { ...DEFAULT_AGENT_CONTINUITY_POLICY }, previousRun: session.control.run,
    admittedAt: 1, observedAt: 2, rechecks: 0, kind: 'pending', reason: 'operation-unconfirmed',
    evidence: { kind: 'run-running', observedAt: 2 },
    messageInput: { ref: { key, waitGeneration: 1 }, key,
      admissionIntent: { kind: 'session-conversation', expectedRun: session.control.run },
      prompt: 'Private Pane diagnostic input',
      message: { userContent: 'Private Pane obsolete frozen composed body'.repeat(30_000), authorHuman: true },
      lifecycleOperationId: 'pane-retention-lifecycle' }
  }
  const core: AgentMuxAgentSession = {
    kind: 'agent', agentSessionId: session.id, providerId: session.providerId,
    executorId: session.executorId, hostId: session.hostId, workspacePath: session.workspacePath,
    run: session.control.run, retiredRuns: [], createdAt: 1, updatedAt: 2, continuity: operation
  }
  useAppStore.setState({ config: composerConfig, loading: false, sessions: [session, unrelated], timelines: {},
    agentNames: {}, agentComposerDrafts: { [session.id]: 'Original private unsent draft 中' },
    agentSteerQueues: { [session.id]: [queueEntry] }, recoveryCandidates: [], viewModes: { [session.id]: 'terminal' },
    pendingAgentLaunches: {}, runtimeEndpointWarnings: [] })
  useAppStore.getState().applyEvent({ type: 'core', hostId: session.hostId, event: { type: 'agent-session', session: core } })
  const pendingKey = { kind: 'message' as const, agentSessionId: unrelated.id, expectedRun: unrelated.control.run, messageId: 'current-pending-message' }
  const pendingCore: AgentMuxAgentSession = { ...core, agentSessionId: unrelated.id, run: unrelated.control.run,
    continuity: { ...operation, operationId: 'current-pending-continuity', agentSessionId: unrelated.id, previousRun: unrelated.control.run,
      messageInput: { ref: { key: pendingKey, waitGeneration: 1 }, key: pendingKey,
        admissionIntent: { kind: 'session-conversation', expectedRun: unrelated.control.run }, prompt: 'Current pending prompt',
        message: { userContent: 'Current pending input stays usable', authorHuman: true }, lifecycleOperationId: 'current-pending-lifecycle' } } }
  useAppStore.getState().applyEvent({ type: 'core', hostId: unrelated.hostId, event: { type: 'agent-session', session: pendingCore } })
  const owned = useAppStore.getState().sessions[0] as Extract<SessionSnapshot, { kind: 'agent' }>
  const ownedUnrelated = useAppStore.getState().sessions[1] as Extract<SessionSnapshot, { kind: 'agent' }>
  const observation = { collected: false }
  registry.register(owned.continuity!.messageInput!.message, observation)
  const pendingObservation = { collected: false }
  registry.register(ownedUnrelated.continuity!.messageInput!.message, pendingObservation)
  const { continuity: _continuity, ...clear } = core
  return { session, observation, clear: { ...clear, updatedAt: 3 }, unrelatedId: unrelated.id, queueEntry, pendingObservation,
    unrelated: new WeakRef(ownedUnrelated), pendingMessage: new WeakRef(ownedUnrelated.continuity!.messageInput!.message) }
}

it('the mounted original Pane and Composer release retired input while preserving current work and original controls', async () => {
  expect(globalThis.gc, 'Only this isolated Node fork may collect').toBeTypeOf('function')
  const initial = useAppStore.getState(), stackTraceLimit = Error.stackTraceLimit
  Error.stackTraceLimit = 0
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }))
  const host = document.body.appendChild(document.createElement('div')), root = createClientUiRoot(host)
  try {
    const { session, observation, clear, unrelatedId, queueEntry, pendingObservation, unrelated, pendingMessage } = seed()
    const expectCurrentWork = () => {
      const state = useAppStore.getState(), current = state.sessions.find(item => item.id === unrelatedId)
      expect(current).toBe(unrelated.deref())
      expect(current?.kind === 'agent' && current.continuity?.messageInput?.message).toBe(pendingMessage.deref())
      expect(current?.kind === 'agent' && current.continuity?.messageInput?.message.userContent).toBe('Current pending input stays usable')
      expect(pendingObservation.collected).toBe(false)
      expect(state.agentSteerQueues[session.id]?.[0]).toBe(queueEntry)
      expect(queueEntry).toMatchObject({ text: 'Original explicitly deferred input', status: 'deferred', awaitingExplicitSend: true })
    }
    await act(async () => root.render(<SessionPane sessionId={session.id} surfaceKind="agent" interactiveResize={false}
      visible={false} linkOrigin={{ workspaceId: 'workspace' }} />))
    const draft = host.querySelector('[data-draft]'), terminal = host.querySelector('[data-original-run]')
    expect(draft?.textContent).toBe('Original private unsent draft 中')
    expectCurrentWork()
    expect(terminal?.getAttribute('data-original-run')).toBe(session.control.run.runId)
    for (let n = 0; n < 5; n++) await act(async () => useAppStore.getState().applyEvent({ type: 'core', hostId: session.hostId,
      event: { type: 'agent-session', session: { ...clear, updatedAt: 3 + n } } }))
    const current = useAppStore.getState().sessions[0] as Extract<SessionSnapshot, { kind: 'agent' }>
    expect(current.continuity).toBeUndefined(); expect(current.agentSessionUpdatedAt).toBe(7)
    expect(current.control).toEqual(session.control)
    expect(host.querySelector('[data-draft]')).toBe(draft)
    expect(host.querySelector('[data-original-run]')).toBe(terminal)
    expect(terminal?.getAttribute('data-agent-clock')).toBe('7')
    expect(terminal?.getAttribute('data-continuity')).toBe('false')
    expect(draft?.textContent).toBe('Original private unsent draft 中')
    for (let n = 0; n < 40 && !observation.collected; n++) { globalThis.gc?.(); await new Promise(done => setTimeout(done, 15)) }
    expectCurrentWork()
    if (process.env.SESSION_PANE_RETENTION_FACTS) appendFileSync(process.env.SESSION_PANE_RETENTION_FACTS, JSON.stringify({
      collectedWhileMounted: observation.collected, currentStoreCleared: true, coherentUpdates: 5,
      originalPaneAndComposerMounted: true, paneRenderedClearedSessionClock: 7, draftAndTerminalDOMPreserved: true, controlPreserved: true,
      unrelatedSessionIdentityPreserved: true, currentPendingInputHeldAndUsable: true, deferredQueueIntentPreserved: true,
      boundary: 'Synthetic input and private Node GC only; no user App access and no installed Renderer heap/RSS inference.'
    }) + '\n')
    expect(observation.collected, 'The original mounted Pane and Composer must release the retired Session input graph after consuming its authoritative clear').toBe(true)
  } finally {
    await act(async () => root.unmount()); host.remove()
    document.getElementById('agentmux-window-overlay-host')?.remove()
    useAppStore.setState(initial, true); Error.stackTraceLimit = stackTraceLimit
    vi.restoreAllMocks(); vi.unstubAllGlobals()
  }
})
