// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { appendFileSync } from 'node:fs'
import type { AgentMuxAgentSession } from '@agentmux/core'
import { DEFAULT_AGENT_CONTINUITY_POLICY, type AgentMuxContinuityOperation } from '@agentmux/core/agent-session-recovery'
import type { SessionSnapshot } from '../src/shared/contracts'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'

// Keep both real product consumers; isolate unrelated workface mounting and filesystem IO.
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))
vi.mock('../src/renderer/src/lib/use-focus-hierarchy', () => ({ useFocusHierarchy: () => ({ facts: { topics: {}, worktrees: [] }, errors: [] }) }))
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { WorkspaceAgentsTool } from '../src/renderer/src/components/SurfaceToolDock'

type AgentSession = Extract<SessionSnapshot, { kind: 'agent' }>
type CollectionObservation = { collected: boolean }
const pause = () => new Promise(done => setTimeout(done, 15))
const registry = new FinalizationRegistry<CollectionObservation>(observation => { observation.collected = true })
async function collect(observation: CollectionObservation) {
  for (let n = 0; n < 40 && !observation.collected; n++) { globalThis.gc?.(); await pause() }
}

// Return no original operation or body. Only the authoritative Store and its consumers may retain them.
function seed() {
  const session = composerSession('mounted-retention')
  const key = { kind: 'message' as const, agentSessionId: session.id, expectedRun: session.control.run, messageId: 'original-message' }
  const operation: AgentMuxContinuityOperation = {
    operationId: 'original-continuity', agentSessionId: session.id, trigger: 'startup',
    policy: { ...DEFAULT_AGENT_CONTINUITY_POLICY }, previousRun: session.control.run,
    admittedAt: 1, observedAt: 2, rechecks: 0, kind: 'pending', reason: 'operation-unconfirmed',
    evidence: { kind: 'run-running', observedAt: 2 },
    messageInput: {
      ref: { key, waitGeneration: 1 }, key,
      admissionIntent: { kind: 'session-conversation', expectedRun: session.control.run },
      prompt: 'Original frozen input',
      message: { userContent: 'Original frozen composed body'.repeat(40_000), authorHuman: true },
      lifecycleOperationId: 'original-lifecycle'
    }
  }
  const core: AgentMuxAgentSession = {
    kind: 'agent', agentSessionId: session.id, providerId: session.providerId,
    executorId: session.executorId, hostId: session.hostId, workspacePath: session.workspacePath,
    run: session.control.run, retiredRuns: [], createdAt: 1, updatedAt: 2, continuity: operation
  }
  useAppStore.setState({
    config: composerConfig, loading: false, sessions: [session, composerSession('mounted-unrelated')],
    timelines: {}, mainSurface: 'agents', focusView: 'list', tabs: {}, layouts: {}, recoveryCandidates: [],
    agentNames: { [session.id]: 'Original mounted card' }, scratchTopicSnapshots: {},
    agentComposerDrafts: { [session.id]: 'Keep original draft' },
    agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } },
    runtimeEndpointWarnings: [], pendingAgentLaunches: {}
  })
  useAppStore.getState().applyEvent({ type: 'core', hostId: session.hostId, event: { type: 'agent-session', session: core } })
  const owned = useAppStore.getState().sessions.find(item => item.id === session.id) as AgentSession
  const observation = { collected: false }
  registry.register(owned.continuity!.messageInput!.message, observation)
  const { continuity: _continuity, ...clear } = core
  return { session, observation, clear: { ...clear, updatedAt: 3 } }
}

it.each(['Focus', 'Workspace'])('the mounted %s consumer releases obsolete frozen input after unchanged presentation cache hits', async consumer => {
  expect(globalThis.gc, 'GC belongs only to this private test fork').toBeTypeOf('function')
  const before = useAppStore.getState(), stackTraceLimit = Error.stackTraceLimit
  // Development React retains creation stacks; shipped production does not.
  Error.stackTraceLimit = 0
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.body.appendChild(document.createElement('div')), root = createRoot(container)
  try {
    const { session, observation, clear } = seed()
    await act(async () => root.render(consumer === 'Focus' ? <GlobalFocusSurface />
      : <WorkspaceAgentsTool workspace={composerConfig.workspaces[0]!} onOpen={() => {}} />))
    const row = container.querySelector(`[data-session-id="${session.id}"]`)
    expect(row).not.toBeNull()
    let selected: HTMLInputElement | null = null
    if (consumer === 'Workspace') {
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Select Agents"]')!.click())
      selected = container.querySelector<HTMLInputElement>('[aria-label="Select Agent Original mounted card"]')
      expect(selected).not.toBeNull()
      await act(async () => selected!.click()); expect(selected!.checked).toBe(true)
    }
    for (let n = 0; n < 5; n++) await act(async () => useAppStore.getState().applyEvent({
      type: 'core', hostId: session.hostId,
      event: { type: 'agent-session', session: { ...clear, updatedAt: 3 + n } }
    }))
    const current = useAppStore.getState().sessions.find(item => item.id === session.id) as AgentSession
    expect(current.continuity).toBeUndefined(); expect(current.agentSessionUpdatedAt).toBe(7)
    expect(container.querySelector(`[data-session-id="${session.id}"]`)).toBe(row)
    expect(useAppStore.getState().agentComposerDrafts[session.id]).toBe('Keep original draft')
    expect(current.control).toEqual(session.control)
    if (selected) {
      expect(container.querySelector('[aria-label="Select Agent Original mounted card"]')).toBe(selected)
      expect(selected.checked).toBe(true)
      await act(async () => selected!.click()); expect(selected.checked).toBe(false)
      await act(async () => selected!.click()); expect(selected.checked).toBe(true)
    }
    await collect(observation)
    expect(observation.collected, 'The mounted original consumer must release an obsolete Session input graph after consuming the cleared authoritative record').toBe(true)
    if (process.env.FOCUS_SESSION_CACHE_FACTS) appendFileSync(process.env.FOCUS_SESSION_CACHE_FACTS, JSON.stringify({
      consumer, collectedWhileMounted: observation.collected, updates: 5, cardDOMPreserved: true,
      draftAndControlPreserved: true, workspaceSelectionPreserved: consumer === 'Workspace',
      boundary: 'Actual AppStore.applyEvent and original mounted consumers; private fork GC only. No user Renderer heap/RSS conclusion.'
    }) + '\n')
  } finally {
    await act(async () => root.unmount()); container.remove()
    document.getElementById('agentmux-window-overlay-host')?.remove()
    useAppStore.setState(before, true); Error.stackTraceLimit = stackTraceLimit
    vi.restoreAllMocks(); vi.unstubAllGlobals()
  }
})
