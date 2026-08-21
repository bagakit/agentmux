import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionSnapshot } from '../src/shared/contracts.js'
import type { OpenHttpLinkOrigin } from '../src/renderer/src/lib/open-destination.js'
import type { WorkbenchTab } from '../src/renderer/src/lib/workbench-tabs.js'

vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })

// SessionPane supplies authored Tab context; AgentSessionComposer owns Session identity.
const captured = vi.hoisted(() => ({ tabName: undefined as string | undefined }))

const fixture = vi.hoisted(() => ({
  state: {
    sessions: [] as SessionSnapshot[],
    pendingAgentLaunches: {},
    recoveryCandidates: [],
    timelines: {} as Record<string, { items: never[] }>,
    tabs: {} as Record<string, unknown>,
    config: { appearance: { terminalTheme: 'graphite' }, workspaces: [], executors: {} },
    activeWorkspaceId: undefined as string | undefined,
    viewModes: {} as Record<string, 'terminal' | 'activity'>,
    refreshSession: vi.fn(async () => {}),
    recoverSession: vi.fn(async () => {}),
    respondInteraction: vi.fn(async () => {}),
    openFile: vi.fn(async () => {}),
    openHttpLink: vi.fn(async () => {}),
    reportError: vi.fn()
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
vi.mock('../src/renderer/src/components/OpenDestinationBar.js', () => ({
  OpenDestinationPopover: () => null
}))
vi.mock('../src/renderer/src/components/AgentInteractionCard.js', () => ({
  AgentInteractionCard: () => <div data-test-interaction-card />
}))
// 桩把 SessionPane 交下来的 tabName 俘获出来——这正是被测的那次派生的产物。
vi.mock('../src/renderer/src/components/AgentSessionComposer.js', () => ({
  AgentSessionComposer: ({ tabName }: { tabName?: string }) => {
    captured.tabName = tabName
    return <div data-test-agent-composer data-region-name={tabName ?? 'absent'} />
  }
}))

import { SessionPane } from '../src/renderer/src/components/SessionPane.js'

function agentSession(id: string, label: string): SessionSnapshot {
  return {
    id,
    kind: 'agent',
    hostId: 'local',
    workspacePath: '/repo',
    label,
    createdAt: 1,
    updatedAt: 1,
    processState: 'running',
    status: { state: 'running', source: 'run-process', observedAt: 1 },
    latestOutputBytes: 0,
    providerId: 'codex',
    executorId: 'codex',
    capabilities: {
      terminal: true,
      timeline: 'complete-events',
      permission: 'observe',
      providerResume: true,
      replyCorrelation: 'none'
    },
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}` } }
  } as SessionSnapshot
}

// Both regions share the same authored Tab context.
function twoTerminalTab(): WorkbenchTab {
  return {
    id: 'tab-1',
    workspaceId: 'workspace-1',
    titleRegionId: 'r1',
    layout: {
      root: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', regionId: 'r1' },
        second: { type: 'leaf', regionId: 'r2' },
        ratio: 0.5
      },
      activeRegionId: 'r1'
    },
    regions: {
      r1: { regionId: 'r1', kind: 'terminal', phase: 'attached', workspaceId: 'workspace-1', sessionId: 'term-a' },
      r2: { regionId: 'r2', kind: 'terminal', phase: 'attached', workspaceId: 'workspace-1', sessionId: 'term-b' }
    }
  } as WorkbenchTab
}

function render(sessionId: string, linkOrigin: OpenHttpLinkOrigin): string {
  return renderToStaticMarkup(createElement(SessionPane, {
    sessionId,
    surfaceKind: 'agent',
    interactiveResize: false,
    visible: true,
    parked: false,
    linkOrigin
  }))
}

const ORIGIN_R2: OpenHttpLinkOrigin = {
  workspaceId: 'workspace-1',
  tabGroupId: 'group-1',
  tabId: 'tab-1',
  regionId: 'r2'
}

afterEach(() => {
  fixture.state.sessions = []
  fixture.state.tabs = {}
  fixture.state.viewModes = {}
  captured.tabName = undefined
})

describe('SessionPane supplies current Tab context', () => {
  it('passes the authored Tab name to the Composer', () => {
    fixture.state.sessions = [agentSession('term-b', 'Codex')]
    fixture.state.tabs = { 'tab-1': { ...twoTerminalTab(), name: 'Release review' } }
    fixture.state.viewModes = { 'term-b': 'terminal' }

    render('term-b', ORIGIN_R2)

    expect(captured.tabName).toBe('Release review')
  })

  it('Tab 重命名后传入当前名', () => {
    fixture.state.sessions = [agentSession('term-a', 'Codex')]
    fixture.state.tabs = { 'tab-1': { ...twoTerminalTab(), name: 'Release review' } }
    fixture.state.viewModes = { 'term-a': 'terminal' }

    render('term-a', { ...ORIGIN_R2, regionId: 'r1' })

    expect(captured.tabName).toBe('Release review')
    fixture.state.tabs['tab-1'] = { ...twoTerminalTab(), name: 'Updated review' }
    render('term-a', { ...ORIGIN_R2, regionId: 'r1' })
    expect(captured.tabName).toBe('Updated review')
  })

  it('无 Region 上下文（origin 缺 tabId/regionId）时名字缺席', () => {
    fixture.state.sessions = [agentSession('term-b', 'Codex')]
    fixture.state.tabs = { 'tab-1': { ...twoTerminalTab(), name: 'Release review' } }
    fixture.state.viewModes = { 'term-b': 'terminal' }

    render('term-b', { workspaceId: 'workspace-1', tabGroupId: 'group-1' })

    expect(captured.tabName, '没有 Region 上下文却算出了名字').toBeUndefined()
  })
})
