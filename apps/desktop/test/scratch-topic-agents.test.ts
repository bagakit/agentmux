import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import type { AgentLaunchResult, AppConfig, SessionSnapshot, WorkspaceRecord } from '../src/shared/contracts.js'
import { api } from '../src/renderer/src/lib/api.js'
import { createWorkspaceLayout } from '@agentmux/layout'
import {
  createWorkbenchTab,
  initialWorkbenchRegionId,
  type WorkbenchTab
} from '../src/renderer/src/lib/workbench-tabs.js'
import { topicsWithAgents } from '../src/renderer/src/lib/surface-tool-dock.js'
import { useAppStore } from '../src/renderer/src/store.js'
import {
  SCRATCH_WORKSPACE_ID,
  scratchTopicDirectoryName,
  type ScratchTopicSnapshot
} from '../src/shared/scratch-topics.js'

const initialState = useAppStore.getState()

const scratchWorkspace: WorkspaceRecord = {
  id: SCRATCH_WORKSPACE_ID,
  name: 'Scratch',
  hostId: 'local',
  path: '/scratch',
  kind: 'folder'
}

const config: AppConfig = {
  version: 9,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {
    codex: { label: 'Codex', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true }
  },
  workspaces: [scratchWorkspace],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
}

function topicWorkspacePath(topicId: string): string {
  return `${scratchWorkspace.path}/${scratchTopicDirectoryName(topicId)}`
}

function agent(
  id: string,
  overrides: Partial<Extract<SessionSnapshot, { kind: 'agent' }>> = {}
): Extract<SessionSnapshot, { kind: 'agent' }> {
  return {
    id,
    kind: 'agent',
    providerId: 'codex',
    executorId: 'codex',
    capabilities: {
      terminal: true, timeline: 'streaming', permission: 'observe',
      providerResume: true, replyCorrelation: 'none'
    },
    hostId: 'local',
    workspacePath: scratchWorkspace.path,
    label: id,
    createdAt: 1,
    updatedAt: 1,
    processState: 'running',
    status: { state: 'running', source: 'run-process', observedAt: 1 },
    latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}` } },
    ...overrides
  }
}

function launch(session: Extract<SessionSnapshot, { kind: 'agent' }>): AgentLaunchResult {
  return { session, timeline: { agentSessionId: session.id, revision: 0, items: [] } }
}

function scratchTopicTab(tabId: string, topicId?: string): WorkbenchTab {
  const tab = createWorkbenchTab(tabId, {
    regionId: initialWorkbenchRegionId(tabId),
    kind: 'launcher',
    workspaceId: scratchWorkspace.id
  })
  return topicId ? { ...tab, topicId } : tab
}

function mountScratch(
  tabs: WorkbenchTab[],
  workspaceFileRevisions: Record<string, number> = {}
): void {
  useAppStore.setState({
    config,
    sessions: [],
    timelines: {},
    activeWorkspaceId: scratchWorkspace.id,
    mainSurface: 'workbench',
    tabs: Object.fromEntries(tabs.map((tab) => [tab.id, tab])),
    layouts: { [scratchWorkspace.id]: createWorkspaceLayout('group', tabs.map((tab) => tab.id)) },
    closingWorkbenchViews: {},
    workspaceFileRevisions,
    pendingAgentLaunches: {},
    error: null
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  useAppStore.setState(initialState, true)
})

// ---------------------------------------------------------------------------
// T-001 — the target Topic is carried explicitly by the View binding; a Tab id
// is never promoted into a Topic. Because a Tab id like `launcher:<uuid>` or
// `view:<uuid>` structurally satisfies the Scratch Topic-id grammar, the earlier
// `topicId ?? tabId` bug silently minted a fresh Topic per launch. These tests
// go red the moment that derivation returns.
// ---------------------------------------------------------------------------
describe('T-001 explicit Topic on Agent launch', () => {
  it('carries the View-bound Topic so multiple Agents land in one Topic', async () => {
    const bound = scratchTopicTab('launcher:one', 'view:shared')
    const alsoBound = scratchTopicTab('launcher:two', 'view:shared')
    mountScratch([bound, alsoBound])
    const launchAgent = vi.spyOn(api.sessions, 'launchAgent')
      .mockImplementation(async (input) => launch(agent(input.agentSessionId!, {
        workspacePath: topicWorkspacePath('view:shared')
      })))

    await useAppStore.getState().launchAgent('codex', 'first', 'group', {
      tabId: bound.id, regionId: bound.layout.activeRegionId
    })
    await useAppStore.getState().launchAgent('codex', 'second', 'group', {
      tabId: alsoBound.id, regionId: alsoBound.layout.activeRegionId
    })

    expect(launchAgent).toHaveBeenCalledTimes(2)
    expect(launchAgent.mock.calls.every(([input]) => input.scratchTopicId === 'view:shared')).toBe(true)
  })

  it('launches an unbound View with no Topic instead of inventing one from the Tab id', async () => {
    // `launcher:unbound` is a valid Topic-id shape, so `?? tabId` would mint it.
    const unbound = scratchTopicTab('launcher:unbound')
    mountScratch([unbound])
    const launchAgent = vi.spyOn(api.sessions, 'launchAgent')
      .mockImplementation(async (input) => launch(agent(input.agentSessionId!)))

    await useAppStore.getState().launchAgent('codex', 'solo', 'group', {
      tabId: unbound.id, regionId: unbound.layout.activeRegionId
    })

    expect(launchAgent).toHaveBeenCalledTimes(1)
    const [input] = launchAgent.mock.calls[0]!
    expect(input.scratchTopicId).toBeUndefined()
    expect(useAppStore.getState().tabs[unbound.id]?.topicId).toBeUndefined()
  })

  it('opens a new-agent Control into a fresh Tab with no Topic, minting none from the Tab', async () => {
    mountScratch([scratchTopicTab('launcher:anchor')])
    const launchAgent = vi.spyOn(api.sessions, 'launchAgent')
      .mockImplementation(async (input) => launch(agent(input.agentSessionId!)))

    await useAppStore.getState().executeControl({
      schemaVersion: 1,
      requestId: 'request-open-agent',
      operation: 'open.agent',
      content: { kind: 'new-agent', executorId: 'codex', prompt: 'write' },
      destination: { kind: 'new-tab', after: { kind: 'tab', tabId: 'launcher:anchor' } }
    })

    expect(launchAgent).toHaveBeenCalledTimes(1)
    const [input] = launchAgent.mock.calls[0]!
    expect(input.scratchTopicId).toBeUndefined()
    const created = Object.values(useAppStore.getState().tabs).find((tab) => tab.id !== 'launcher:anchor')
    expect(created?.topicId).toBeUndefined()
  })

  it('fails closed on an invalid bound Topic instead of degrading to no Topic', async () => {
    const corrupt = { ...scratchTopicTab('launcher:corrupt'), topicId: 'not a topic id' }
    mountScratch([corrupt])
    const launchAgent = vi.spyOn(api.sessions, 'launchAgent')
      .mockImplementation(async (input) => launch(agent(input.agentSessionId!)))

    await expect(useAppStore.getState().launchAgent('codex', 'x', 'group', {
      tabId: corrupt.id, regionId: corrupt.layout.activeRegionId
    })).rejects.toThrow(/invalid Topic/i)
    expect(launchAgent).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 在 Topic 里起 Agent 会在盘上建协作者文件，所以文件树的失效计数必须前进。
//
// 为什么单独一族：`workspace-file-revision.test.ts` 那边只执行了三个写入面（建 Topic / 改标题 /
// 建笔记），这个第四面从来没被跑到过——实测把它的实参换成 `{}`（清掉别人的计数）、换成错的
// workspace id、或者把整段条件改成永假，那 8 条断言全绿。「同一个纯函数被单测过」不等于
// 「这个调用点被执行过、且喂的是对的东西」。
//
// 判据落在这里而不是新开文件：起 Agent 的整条流程（launch → canonicalize → attach）在上面已经
// 跑通，另起一份 mock 只会得到第二套会漂移的前提。
//
// 症状：在 Topic 里起了 agent，它的协作者文件已经落盘，而文件树不显示——直到别的写入面碰巧
// bump 一次。
// ---------------------------------------------------------------------------
describe('在 Topic 里起 Agent 让文件树失效', () => {
  const BYSTANDER_REVISION = 41
  const TARGET_REVISION = 7

  /** 摆好一个绑定 Topic 的 View，并把两格计数都摆上非零初值。 */
  function mountBoundTopic(): WorkbenchTab {
    const bound = scratchTopicTab('launcher:one', 'view:shared')
    mountScratch([bound], {
      [SCRATCH_WORKSPACE_ID]: TARGET_REVISION,
      bystander: BYSTANDER_REVISION
    })
    vi.spyOn(api.sessions, 'launchAgent').mockImplementation(async (input) =>
      launch(agent(input.agentSessionId!, { workspacePath: topicWorkspacePath('view:shared') }))
    )
    return bound
  }

  function revisions(): Record<string, number> {
    return useAppStore.getState().workspaceFileRevisions
  }

  it('前提自检：这次启动真的走到了 attach——不是被前面某道守卫拦掉', async () => {
    // 启动被拦掉时「计数没动」与「漏 bump」完全同形，所以先钉住 Session 真的挂上了。
    const bound = mountBoundTopic()

    await useAppStore.getState().launchAgent('codex', 'first', 'group', {
      tabId: bound.id, regionId: bound.layout.activeRegionId
    })

    expect(useAppStore.getState().sessions).toHaveLength(1)
    expect(revisions().bystander, 'fixture 没把旁观者那格摆上，判据会从零开始').toBe(BYSTANDER_REVISION)
  })

  it('目标 Workspace +1，旁观者分毫不动', async () => {
    const bound = mountBoundTopic()

    await useAppStore.getState().launchAgent('codex', 'first', 'group', {
      tabId: bound.id, regionId: bound.layout.activeRegionId
    })

    expect(
      revisions()[SCRATCH_WORKSPACE_ID],
      '起 Agent 没有让文件树失效——新建的协作者文件在树里看不见'
    ).toBe(TARGET_REVISION + 1)
    expect(revisions().bystander, '别的 Workspace 的计数被动了').toBe(BYSTANDER_REVISION)
  })

  it('连起两个就前进两格——不是「设成某个常量」', async () => {
    // 单看一次调用，`+ 1` 与「写成 8」无法区分。
    // 用两个 View：启动成功后 Region 从 launcher 变成 agent，同一个 Region 起不了第二个。
    const bound = scratchTopicTab('launcher:one', 'view:shared')
    const alsoBound = scratchTopicTab('launcher:two', 'view:shared')
    mountScratch([bound, alsoBound], {
      [SCRATCH_WORKSPACE_ID]: TARGET_REVISION,
      bystander: BYSTANDER_REVISION
    })
    vi.spyOn(api.sessions, 'launchAgent').mockImplementation(async (input) =>
      launch(agent(input.agentSessionId!, { workspacePath: topicWorkspacePath('view:shared') }))
    )

    await useAppStore.getState().launchAgent('codex', 'first', 'group', {
      tabId: bound.id, regionId: bound.layout.activeRegionId
    })
    await useAppStore.getState().launchAgent('codex', 'second', 'group', {
      tabId: alsoBound.id, regionId: alsoBound.layout.activeRegionId
    })

    expect(useAppStore.getState().sessions).toHaveLength(2)
    expect(revisions()[SCRATCH_WORKSPACE_ID]).toBe(TARGET_REVISION + 2)
  })

  it('起一个不在 Topic 里的 Agent 不 bump——这条 bump 是 Topic 专属的', async () => {
    // 反向边界。判据故意落在**同一个 Workspace**：若实现改成「只要在 scratch 里就 bump」，
    // 上面那条正向断言照旧绿，只有这条会红。没有 Topic 就没有新建协作者文件，也就没有
    // 需要让文件树重扫的理由。
    const unbound = scratchTopicTab('launcher:unbound')
    mountScratch([unbound], {
      [SCRATCH_WORKSPACE_ID]: TARGET_REVISION,
      bystander: BYSTANDER_REVISION
    })
    vi.spyOn(api.sessions, 'launchAgent')
      .mockImplementation(async (input) => launch(agent(input.agentSessionId!)))

    await useAppStore.getState().launchAgent('codex', 'solo', 'group', {
      tabId: unbound.id, regionId: unbound.layout.activeRegionId
    })

    expect(useAppStore.getState().sessions).toHaveLength(1)
    expect(revisions()[SCRATCH_WORKSPACE_ID]).toBe(TARGET_REVISION)
  })
})

// ---------------------------------------------------------------------------
// T-002 — the Topic panel projects each filesystem Topic's Agents as the union
// of on-disk collaborators and live Session projections. The Topic list is the
// filesystem snapshot; Sessions are matched onto it, never used to invent a
// Topic. Zero-Agent Topics stay listed and empty.
// ---------------------------------------------------------------------------
function topic(id: string, collaborators: ScratchTopicSnapshot['collaborators'] = []): ScratchTopicSnapshot {
  const directoryPath = scratchTopicDirectoryName(id)
  return {
    id,
    directoryPath,
    topicPath: `${directoryPath}/topic.md`,
    title: id,
    summary: '',
    collaborators
  }
}

describe('T-002 Topic panel projects each Topic’s Agents from the filesystem', () => {
  it('unions on-disk collaborators with live Sessions and keeps empty Topics visible', () => {
    const topics: ScratchTopicSnapshot[] = [
      topic('view:shared', [
        { fileName: 'codex.persisted.identity.md', providerId: 'codex', sessionId: 'persisted' }
      ]),
      topic('view:empty')
    ]
    const sessions: SessionSnapshot[] = [
      // Same session id as the collaborator: must dedupe into one live entry.
      agent('persisted', { workspacePath: topicWorkspacePath('view:shared') }),
      // A live Agent in the same Topic with no identity file yet: additive.
      agent('fresh', { workspacePath: topicWorkspacePath('view:shared') })
    ]

    const projected = topicsWithAgents(topics, sessions, scratchWorkspace)

    const shared = projected.find((entry) => entry.id === 'view:shared')!
    expect(shared.agents.map((agentEntry) => agentEntry.sessionId).sort()).toEqual(['fresh', 'persisted'])
    expect(shared.agents.find((agentEntry) => agentEntry.sessionId === 'persisted')?.live?.id).toBe('persisted')
    expect(shared.agents.find((agentEntry) => agentEntry.sessionId === 'fresh')?.live?.id).toBe('fresh')

    const empty = projected.find((entry) => entry.id === 'view:empty')!
    expect(empty.agents).toEqual([])
  })

  it('does not reverse-derive Topics from Sessions', () => {
    const topics = [topic('view:listed')]
    const sessions: SessionSnapshot[] = [
      // A live Agent whose cwd is a Topic directory that the filesystem snapshot does not list.
      agent('ghost', { workspacePath: topicWorkspacePath('view:unlisted') }),
      // A live Agent that is not inside any Topic directory at all.
      agent('root', { workspacePath: scratchWorkspace.path })
    ]

    const projected = topicsWithAgents(topics, sessions, scratchWorkspace)

    expect(projected.map((entry) => entry.id)).toEqual(['view:listed'])
    expect(projected[0]!.agents).toEqual([])
  })

  it('reuses the existing openScratchTopic navigation action rather than a second path', () => {
    // 这条扫的是**规则现在住的那个文件**：459f5ccc 把 Topic 面板从 SurfaceToolDock 抽成了
    // WorkspaceTopicsPanel，而判据还钉着旧文件名。`toContain` 在「文件还在、内容搬走了」时
    // 只会变红（这次就是），但同一族的 `not.toContain` 会静默恒真——所以搬家之后判据必须
    // 跟着搬，而不是放宽。SurfaceToolDock 里如今 openScratchTopic/nextTopicId 是 0 处。
    const source = readFileSync(
      new URL('../src/renderer/src/components/WorkspaceTopicsPanel.tsx', import.meta.url),
      'utf8'
    )
    expect(source).toContain('await openScratchTopic(nextTopicId)')
    expect(source).toContain('topicsWithAgents(topics, sessions, workspace)')
  })
})

// ---------------------------------------------------------------------------
// openScratchTopic reuses one navigation path: it focuses the bound View when
// one is open, and only otherwise recreates a Launcher bound to the Topic.
// ---------------------------------------------------------------------------
describe('T-002 switching reuses the bound View', () => {
  it('focuses the View already bound to a Topic instead of opening a second one', async () => {
    const bound = scratchTopicTab('launcher:bound', 'view:shared')
    const other = scratchTopicTab('launcher:other', 'view:other')
    mountScratch([other, bound])
    vi.spyOn(api.scratch, 'readTopic').mockResolvedValue(topic('view:shared'))

    await useAppStore.getState().openScratchTopic('view:shared')

    const state = useAppStore.getState()
    const layout = state.layouts[scratchWorkspace.id]!
    expect(layout.groups[0]!.activeTabId).toBe('launcher:bound')
    // No third Tab created: the bound View was focused, not duplicated.
    expect(Object.keys(state.tabs).sort()).toEqual(['launcher:bound', 'launcher:other'])
  })

  it('reveals the Topic workbench when user navigation starts from another main surface', async () => {
    mountScratch([scratchTopicTab('launcher:bound', 'view:shared')])
    useAppStore.setState({ mainSurface: 'board' })
    vi.spyOn(api.scratch, 'readTopic').mockResolvedValue(topic('view:shared'))

    await useAppStore.getState().openScratchTopic('view:shared', SCRATCH_WORKSPACE_ID)

    const state = useAppStore.getState()
    expect(state.mainSurface).toBe('workbench')
    expect(state.activeWorkspaceId).toBe(SCRATCH_WORKSPACE_ID)
    expect(state.layouts[SCRATCH_WORKSPACE_ID]?.groups[0]?.activeTabId).toBe('launcher:bound')
  })

  it('can prepare a background Topic without stealing the current surface', async () => {
    mountScratch([scratchTopicTab('launcher:leader', 'launcher:leader')])
    useAppStore.setState({ activeWorkspaceId: 'project-a', mainSurface: 'board' })
    vi.spyOn(api.scratch, 'readTopic').mockResolvedValue(topic('launcher:leader'))

    await useAppStore.getState().openScratchTopic(
      'launcher:leader',
      SCRATCH_WORKSPACE_ID,
      { reveal: false }
    )

    const state = useAppStore.getState()
    expect(state.mainSurface).toBe('board')
    expect(state.activeWorkspaceId).toBe('project-a')
  })
})
