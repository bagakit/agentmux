import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentCatalogEntry } from '@agentmux/core'
import type { SessionSnapshot } from '../src/shared/contracts.js'

const fixture = vi.hoisted(() => ({
  session: undefined as SessionSnapshot | undefined,
  state: {
    sessions: [] as SessionSnapshot[],
    providerCatalog: [] as AgentCatalogEntry[],
    config: {
      workspaces: [{ id: 'workspace', name: 'Project', hostId: 'local', path: '/repo', kind: 'folder' as const }]
    },
    lastActiveFileByWorkspace: { workspace: 'src/index.ts' } as Record<string, string>,
    agentComposerDrafts: {} as Record<string, string>,
    setAgentComposerDraft: vi.fn(),
    clearAgentComposerDraftIfUnchanged: vi.fn(),
    send: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    setPosture: vi.fn(async () => {})
  }
}))

vi.mock('../src/renderer/src/store.js', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof fixture.state) => unknown) => selector(fixture.state),
    { getState: () => fixture.state }
  )
}))

// The composer reaches for native capabilities (file picker, pasted-image persistence) that only the
// desktop shell provides; the module itself resolves a build-time constant, so it is stubbed here.
vi.mock('../src/renderer/src/lib/api.js', () => ({
  api: {
    ui: {
      chooseFiles: vi.fn(async () => null),
      savePastedImage: vi.fn(async () => '/tmp/pasted.png')
    }
  }
}))

import {
  AgentSessionComposer,
  agentComposerAvailability
} from '../src/renderer/src/components/AgentSessionComposer.js'

function agentSession(overrides: Partial<Extract<SessionSnapshot, { kind: 'agent' }>> = {}): Extract<SessionSnapshot, { kind: 'agent' }> {
  return {
    id: 'agent-1',
    kind: 'agent',
    providerId: 'codex',
    executorId: 'codex',
    capabilities: {
      terminal: true,
      hookEvents: true,
      timeline: 'complete-events',
      permission: 'observe',
      providerResume: true,
      acp: false,
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
    control: {
      kind: 'agent',
      hostId: 'local',
      agentSessionId: 'agent-1',
      run: { runId: 'run-1' }
    },
    ...overrides
  }
}

afterEach(() => {
  fixture.state.sessions = []
  fixture.state.providerCatalog = []
  fixture.state.agentComposerDrafts = {}
  fixture.state.send.mockClear()
  fixture.state.interrupt.mockClear()
  fixture.state.setPosture.mockClear()
  fixture.state.setAgentComposerDraft.mockClear()
  fixture.state.clearAgentComposerDraftIfUnchanged.mockClear()
})

// A minimal grok-shaped catalog entry carrying only the fields the composer reads plus the DESCRIBE-half
// posture control. The keystrokes stay in core; only these labels/tiers ever reach the renderer.
function postureCatalogEntry(): AgentCatalogEntry {
  return {
    id: 'grok',
    label: 'Grok',
    executable: 'grok',
    expectedProcess: 'grok',
    promptDelivery: 'positional-argv',
    readySignal: { kind: 'foreground-process', expectedProcess: 'grok' },
    hookStrategy: { kind: 'none' },
    resumeStrategy: { kind: 'none' },
    acpStrategy: { kind: 'none' },
    capabilities: {
      terminal: true,
      hookEvents: false,
      timeline: 'unavailable',
      permission: 'none',
      providerResume: false,
      acp: false,
      replyCorrelation: 'none'
    },
    launchOptions: [],
    postureControl: {
      id: 'approval',
      label: 'Approvals',
      modes: [
        { id: 'ask', label: 'Ask each time', tier: 'safe' },
        { id: 'always-approve', label: 'Auto-approve', tier: 'danger' }
      ]
    }
  }
}

describe('AgentSessionComposer adapter', () => {
  it('binds a running Agent and current file to the reusable Composer', () => {
    fixture.state.sessions = [agentSession()]

    const markup = renderToStaticMarkup(createElement(AgentSessionComposer, { sessionId: 'agent-1' }))

    expect(markup).toContain('data-agent-composer="true"')
    expect(markup).toContain('placeholder="Ask, steer, or paste a command…"')
    expect(markup).toContain('index.ts')
    expect(markup).not.toMatch(/<textarea[^>]*disabled=""/)
  })

  it('projects a Browser context handoff from the shared per-session draft', () => {
    fixture.state.sessions = [agentSession()]
    fixture.state.agentComposerDrafts = { 'agent-1': 'Browser element context\nSelector: main > button' }

    const markup = renderToStaticMarkup(createElement(AgentSessionComposer, { sessionId: 'agent-1' }))

    expect(markup).toContain('Browser element context')
    expect(markup).toContain('Selector: main &gt; button')
  })

  it('submits and compare-clears the exact shared draft snapshot', async () => {
    fixture.state.sessions = [agentSession()]
    fixture.state.agentComposerDrafts = { 'agent-1': 'Browser element context' }
    const composer = AgentSessionComposer({ sessionId: 'agent-1' }) as unknown as {
      props: { onSubmit(): void }
    }

    composer.props.onSubmit()

    await vi.waitFor(() => {
      expect(fixture.state.send).toHaveBeenCalledWith('agent-1', 'Browser element context')
      expect(fixture.state.clearAgentComposerDraftIfUnchanged)
        .toHaveBeenCalledWith('agent-1', 'Browser element context')
    })
  })

  it('keeps the shared draft when prompt submission fails', async () => {
    fixture.state.sessions = [agentSession()]
    fixture.state.agentComposerDrafts = { 'agent-1': 'Retry this context' }
    fixture.state.send.mockRejectedValueOnce(new Error('submit failed'))
    const composer = AgentSessionComposer({ sessionId: 'agent-1' }) as unknown as {
      props: { onSubmit(): void }
    }

    composer.props.onSubmit()

    await vi.waitFor(() => expect(fixture.state.send).toHaveBeenCalledOnce())
    expect(fixture.state.clearAgentComposerDraftIfUnchanged).not.toHaveBeenCalled()
  })

  it('does not guess that a disconnected running process can accept input', () => {
    const disconnected = agentSession({
      status: { state: 'disconnected', source: 'run-process', observedAt: 2 }
    })
    fixture.state.sessions = [disconnected]

    const markup = renderToStaticMarkup(createElement(AgentSessionComposer, { sessionId: 'agent-1' }))

    expect(agentComposerAvailability(disconnected)).toEqual({
      disabled: true,
      placeholder: 'Agent is disconnected'
    })
    expect(markup).toContain('placeholder="Agent is disconnected"')
    expect(markup).toMatch(/<textarea[^>]*disabled=""/)
  })

  it('stays visible and disabled before the Agent snapshot exists', () => {
    const markup = renderToStaticMarkup(createElement(AgentSessionComposer, { sessionId: 'agent-1' }))

    expect(markup).toContain('data-agent-composer="true"')
    expect(markup).toContain('placeholder="Agent is connecting…"')
    expect(markup).toMatch(/<textarea[^>]*disabled=""/)
  })

  it('stays visible and disabled after the Agent Run exits', () => {
    const exited = agentSession({
      processState: 'exited',
      status: { state: 'exited', source: 'run-process', observedAt: 3 }
    })
    fixture.state.sessions = [exited]

    const markup = renderToStaticMarkup(createElement(AgentSessionComposer, { sessionId: 'agent-1' }))

    expect(agentComposerAvailability(exited)).toEqual({
      disabled: true,
      placeholder: 'Agent is not running'
    })
    expect(markup).toContain('placeholder="Agent is not running"')
    expect(markup).toMatch(/<textarea[^>]*disabled=""/)
  })

  it('renders a Provider-declared posture control on the composer, drawn from its catalog declaration', () => {
    fixture.state.sessions = [agentSession({ providerId: 'grok', status: { state: 'running', source: 'run-process', observedAt: 2 } })]
    fixture.state.providerCatalog = [postureCatalogEntry()]

    const markup = renderToStaticMarkup(createElement(AgentSessionComposer, { sessionId: 'agent-1' }))

    // The control's label (the DESCRIBE half) reaches the composer; the keystroke never does.
    expect(markup).toContain('Approvals')
    expect(markup).not.toContain('always-approve')
  })

  it('renders no posture control for a Provider that declares none (absence hides)', () => {
    // codex declares no addressable posture control — its catalog entry carries no postureControl, so the
    // composer draws nothing rather than a disabled affordance.
    fixture.state.sessions = [agentSession({ status: { state: 'running', source: 'run-process', observedAt: 2 } })]
    fixture.state.providerCatalog = [{ ...postureCatalogEntry(), id: 'codex', postureControl: undefined }]

    const markup = renderToStaticMarkup(createElement(AgentSessionComposer, { sessionId: 'agent-1' }))

    expect(markup).not.toContain('Approvals')
  })

  it('yields prompt entry to a pending typed Agent interaction', () => {
    const waiting = agentSession({
      status: { state: 'waiting', source: 'native-hook', observedAt: 2 },
      pendingInteraction: {
        kind: 'permission',
        id: 'permission-1',
        agentSessionId: 'agent-1',
        title: 'Allow command?',
        options: [{ id: 'allow', label: 'Allow', kind: 'allow-once' }],
        evidence: {
          source: 'native-hook',
          observedAt: 2,
          run: { runId: 'run-1' },
          hookReceiptId: 'permission-1'
        }
      }
    })
    fixture.state.sessions = [waiting]

    expect(agentComposerAvailability(waiting)).toEqual({
      disabled: true,
      placeholder: 'Answer the Agent request above…'
    })
  })
})
