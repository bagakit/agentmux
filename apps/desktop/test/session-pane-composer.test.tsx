import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionSnapshot } from '../src/shared/contracts.js'

const fixture = vi.hoisted(() => ({
  state: {
    sessions: [] as SessionSnapshot[],
    timelines: {} as Record<string, { items: never[] }>,
    config: { appearance: { terminalTheme: 'graphite' } },
    viewModes: {} as Record<string, 'terminal' | 'activity'>,
    refreshSession: vi.fn(async () => {}),
    recoverSession: vi.fn(async () => {})
  }
}))

vi.mock('../src/renderer/src/store.js', () => ({
  useAppStore: (selector: (state: typeof fixture.state) => unknown) => selector(fixture.state)
}))
vi.mock('../src/renderer/src/components/TerminalView.js', () => ({
  TerminalView: () => <div data-test-view="terminal" />
}))
vi.mock('../src/renderer/src/components/ActivityView.js', () => ({
  ActivityView: () => <div data-test-view="activity" />
}))
vi.mock('../src/renderer/src/components/AgentSessionComposer.js', () => ({
  AgentSessionComposer: ({ disabled }: { disabled?: boolean }) => (
    <div data-test-agent-composer={disabled ? 'disabled' : 'enabled'} />
  )
}))

import { SessionPane } from '../src/renderer/src/components/SessionPane.js'

function session(kind: 'agent' | 'terminal'): SessionSnapshot {
  const common = {
    id: `${kind}-1`,
    hostId: 'local',
    workspacePath: '/repo',
    label: kind === 'agent' ? 'Codex' : 'Terminal',
    createdAt: 1,
    updatedAt: 1,
    processState: 'running' as const,
    status: { state: 'running' as const, source: 'run-process' as const, observedAt: 1 },
    latestOutputBytes: 0
  }
  return kind === 'agent'
    ? {
        ...common,
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
        control: { kind: 'agent', hostId: 'local', agentSessionId: 'agent-1', run: { runId: 'run-1' } }
      }
    : {
        ...common,
        kind: 'terminal',
        providerId: null,
        control: { kind: 'terminal', hostId: 'local', runId: 'terminal-1', run: { runId: 'terminal-1' } }
      }
}

function render(sessionId: string, surfaceKind: 'agent' | 'terminal'): string {
  return renderToStaticMarkup(createElement(SessionPane, {
    sessionId,
    surfaceKind,
    interactiveResize: false
  }))
}

afterEach(() => {
  fixture.state.sessions = []
  fixture.state.viewModes = {}
})

describe('SessionPane Agent Composer ownership', () => {
  it('shows the Composer with an Agent Terminal projection', () => {
    fixture.state.sessions = [session('agent')]
    fixture.state.viewModes = { 'agent-1': 'terminal' }

    const markup = render('agent-1', 'agent')

    expect(markup).toContain('data-test-view="terminal"')
    expect(markup).toContain('data-test-agent-composer="enabled"')
  })

  it('shows the same Composer slot with an Agent Activity projection', () => {
    fixture.state.sessions = [session('agent')]
    fixture.state.viewModes = { 'agent-1': 'activity' }

    const markup = render('agent-1', 'agent')

    expect(markup).toContain('data-test-view="activity"')
    expect(markup).toContain('data-test-agent-composer="enabled"')
  })

  it('never adds an Agent Composer to Raw Terminal', () => {
    fixture.state.sessions = [session('terminal')]

    const markup = render('terminal-1', 'terminal')

    expect(markup).toContain('data-test-view="terminal"')
    expect(markup).not.toContain('data-test-agent-composer')
  })

  it('keeps a disabled Composer on a launching Agent Region', () => {
    const markup = render('agent-launching', 'agent')

    expect(markup).toContain('Connecting to this session')
    expect(markup).toContain('data-test-agent-composer="disabled"')
  })

})
