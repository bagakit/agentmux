import { describe, expect, it, vi } from 'vitest'
import type { SessionSnapshot } from '../src/shared/contracts.js'

// composerSubmitMode is pure, but the agreement assertions below call the real agentComposerAvailability,
// which lives in a module that also pulls the Store and the native api. Those resolve build-time constants
// in a browser bundle, so they are stubbed exactly as the sibling composer test stubs them; nothing here
// reads store state — the mocks only satisfy the import graph.
vi.mock('../src/renderer/src/store.js', () => ({
  useAppStore: Object.assign((selector: (state: unknown) => unknown) => selector({}), {
    getState: () => ({})
  })
}))
vi.mock('../src/renderer/src/lib/api.js', () => ({ api: { ui: {} } }))

import { composerSubmitMode } from '../src/renderer/src/lib/composer-submit-mode.js'
import { agentComposerAvailability } from '../src/renderer/src/components/AgentSessionComposer.js'

function agentSession(
  overrides: Partial<Extract<SessionSnapshot, { kind: 'agent' }>> = {}
): Extract<SessionSnapshot, { kind: 'agent' }> {
  return {
    id: 'agent-1',
    kind: 'agent',
    providerId: 'codex',
    executorId: 'codex',
    capabilities: {
      terminal: true,
      timeline: 'complete-events',
      permission: 'observe',
      providerResume: true,
      replyCorrelation: 'none'
    },
    hostId: 'local',
    workspacePath: '/repo',
    label: 'Codex',
    createdAt: 1,
    updatedAt: 1,
    processState: 'running',
    status: { state: 'working', source: 'native-hook', observedAt: 1 },
    latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: 'agent-1', run: { runId: 'run-1' } },
    ...overrides
  }
}

const pendingInteraction: Extract<SessionSnapshot, { kind: 'agent' }>['pendingInteraction'] = {
  kind: 'permission',
  id: 'permission-1',
  agentSessionId: 'agent-1',
  title: 'Allow command?',
  options: [{ id: 'allow', label: 'Allow', kind: 'allow-once' }],
  evidence: { source: 'native-hook', observedAt: 2, run: { runId: 'run-1' }, hookReceiptId: 'permission-1' }
}

describe('composerSubmitMode', () => {
  it('lets a working Agent be BOTH steered and stopped — canSubmit true while primaryAction stays stop', () => {
    // The bug this whole module exists to fix: one !isWorking flag decided both questions, so a running
    // Agent could only be interrupted, never steered. These are different questions and must not agree.
    const mode = composerSubmitMode(agentSession({ status: { state: 'working', source: 'native-hook', observedAt: 1 } }))

    expect(mode.canType).toBe(true)
    expect(mode.canSubmit).toBe(true)
    expect(mode.primaryAction).toBe('stop')
    expect(mode.placeholder).toBe('Ask, steer, or paste a command…')
  })

  it('offers Send, not Stop, for an idle running Agent', () => {
    const mode = composerSubmitMode(agentSession({ status: { state: 'running', source: 'run-process', observedAt: 1 } }))

    expect(mode.canType).toBe(true)
    expect(mode.canSubmit).toBe(true)
    expect(mode.primaryAction).toBe('send')
  })

  it('blocks submit while an interaction is pending, so steer cannot bypass the card', () => {
    const mode = composerSubmitMode(
      agentSession({ status: { state: 'waiting', source: 'native-hook', observedAt: 2 }, pendingInteraction })
    )

    // The card is the only input surface here; the textarea shuts and no submit is offered.
    expect(mode.canType).toBe(true)
    expect(mode.canSubmit).toBe(false)
    expect(mode.placeholder).toContain('Draft a steer')
  })

  it('keeps Stop reachable even while a pending card blocks submit on a working Agent', () => {
    // canSubmit is false (card owns input) but a turn is still in flight, so the primary action stays Stop:
    // the two axes are independent, and folding them would strand an un-interruptible running turn.
    const mode = composerSubmitMode(
      agentSession({ status: { state: 'working', source: 'native-hook', observedAt: 2 }, pendingInteraction })
    )

    expect(mode.canSubmit).toBe(false)
    expect(mode.primaryAction).toBe('stop')
  })

  it('cannot type when the Agent snapshot is missing', () => {
    const mode = composerSubmitMode(undefined)

    expect(mode.canType).toBe(false)
    expect(mode.canSubmit).toBe(false)
    expect(mode.placeholder).toBe('Agent is connecting…')
  })

  it('cannot type when forceDisabled, regardless of a live working Agent', () => {
    const mode = composerSubmitMode(agentSession(), true)

    expect(mode.canType).toBe(false)
    expect(mode.canSubmit).toBe(false)
  })

  // canType must never disagree with the sealed availability contract for the cases that gate typing at
  // all. This calls the REAL agentComposerAvailability so a drift in either function fails the suite.
  it('agrees item-for-item with agentComposerAvailability on every gate that disables the surface', () => {
    const cases: Array<{ session: SessionSnapshot | undefined; forceDisabled: boolean }> = [
      { session: undefined, forceDisabled: false },
      { session: agentSession(), forceDisabled: true },
      { session: agentSession({ status: { state: 'disconnected', source: 'run-process', observedAt: 2 } }), forceDisabled: false },
      { session: agentSession({ processState: 'exited', status: { state: 'exited', source: 'run-process', observedAt: 3 } }), forceDisabled: false },
      { session: agentSession({ status: { state: 'waiting', source: 'native-hook', observedAt: 2 }, pendingInteraction }), forceDisabled: false },
      { session: agentSession({ status: { state: 'running', source: 'run-process', observedAt: 1 } }), forceDisabled: false },
      { session: agentSession({ status: { state: 'working', source: 'native-hook', observedAt: 1 } }), forceDisabled: false }
    ]

    for (const { session, forceDisabled } of cases) {
      const availability = agentComposerAvailability(session, forceDisabled)
      const mode = composerSubmitMode(session, forceDisabled)
      // canType is the inverse of availability.disabled, and the placeholder text is identical.
      expect(mode.canType).toBe(session?.pendingInteraction ? true : !availability.disabled)
      expect(mode.placeholder).toBe(session?.pendingInteraction ? 'Answer the Agent request above… Draft a steer…' : availability.placeholder)
    }
  })
})
