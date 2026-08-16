import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionSnapshot } from '../src/shared/contracts.js'
import type { OpenHttpLinkOrigin } from '../src/renderer/src/lib/open-destination.js'
import type { WorkbenchTab } from '../src/renderer/src/lib/workbench-tabs.js'

vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })

// 这条测的是那个「难题」：composer 自己不知道它在哪个 Region，Region 的名字又取决于兄弟格。
// SessionPane 是唯一持有 Region 起点（linkOrigin 的 tabId + regionId）的宿主，所以名字在它这里
// 按 store 里那张 Tab 的全体 regions（视觉顺序）现算，再喂给 composer。这里把 AgentSessionComposer
// 换成一个只回吐 regionName 的桩，驱动 SessionPane，断言它算出并交出了正确的名字。
const captured = vi.hoisted(() => ({ regionName: undefined as string | undefined }))

const fixture = vi.hoisted(() => ({
  state: {
    sessions: [] as SessionSnapshot[],
    timelines: {} as Record<string, { items: never[] }>,
    tabs: {} as Record<string, unknown>,
    config: { appearance: { terminalTheme: 'graphite' }, workspaces: [] },
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
// 桩把 SessionPane 交下来的 regionName 俘获出来——这正是被测的那次派生的产物。
vi.mock('../src/renderer/src/components/AgentSessionComposer.js', () => ({
  AgentSessionComposer: ({ regionName }: { regionName?: string }) => {
    captured.regionName = regionName
    return <div data-test-agent-composer data-region-name={regionName ?? 'absent'} />
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

// 一张有两格的 Tab：两格都是终端表面（regionSurfaceLabel 给它们同一个裸名 "Terminal"），于是去重
// 编号必须把它们分成 "Terminal 1" / "Terminal 2"。layout 用一个横向 split（左 r1、右 r2）给出视觉顺序。
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
  captured.regionName = undefined
})

describe('SessionPane 把 Region 名喂给 composer 水印', () => {
  it('名字随 Region 上下文出现——同名两格里这一格拿到带编号的名', () => {
    // 两格同名 "Terminal"，右格（r2）在视觉顺序里是第二个，所以它的名字是 "Terminal 2"。
    // 这钉住了两件事：名字确实到达了 composer；同名去重的编号确实生效。
    fixture.state.sessions = [agentSession('term-b', 'Codex')]
    fixture.state.tabs = { 'tab-1': twoTerminalTab() }
    fixture.state.viewModes = { 'term-b': 'terminal' }

    render('term-b', ORIGIN_R2)

    expect(captured.regionName, 'Region 名没到达 composer').toBe('Terminal 2')
  })

  it('第一格拿到 "Terminal 1"——编号跟着视觉顺序走', () => {
    fixture.state.sessions = [agentSession('term-a', 'Codex')]
    fixture.state.tabs = { 'tab-1': twoTerminalTab() }
    fixture.state.viewModes = { 'term-a': 'terminal' }

    render('term-a', { ...ORIGIN_R2, regionId: 'r1' })

    expect(captured.regionName).toBe('Terminal 1')
  })

  it('无 Region 上下文（origin 缺 tabId/regionId）时名字缺席', () => {
    // 无 Region 的宿主用的正是这种半截 origin（同 canSplit 读的那对真相）。名字必须是 undefined，
    // 让 composer 那层整段不渲染水印，而不是渲染一个占位符。
    fixture.state.sessions = [agentSession('term-b', 'Codex')]
    fixture.state.tabs = { 'tab-1': twoTerminalTab() }
    fixture.state.viewModes = { 'term-b': 'terminal' }

    render('term-b', { workspaceId: 'workspace-1', tabGroupId: 'group-1' })

    expect(captured.regionName, '没有 Region 上下文却算出了名字').toBeUndefined()
  })
})
