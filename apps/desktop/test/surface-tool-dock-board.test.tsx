import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import type { SessionSnapshot } from '../src/shared/contracts.js'
import type { BoardRow } from '../src/renderer/src/lib/project-board.js'
import { boardListSegments, BOARD_LIST_VISIBLE_ROWS } from '../src/renderer/src/lib/surface-tool-dock.js'
import { browserOpenError } from '../src/renderer/src/lib/browser-open-feedback.js'

/**
 * Board 工具的次级面板是**Demand 工作清单**，不是 Branch 说明页。
 *
 * 用户打开它是来找一条具体的工作线。所以这里断言的是"清单确实列出了 Board 的行和行内的
 * Agent，点一个 Agent 会定位到它"，以及一条同样重要的反面："行不是面板自己查来的"——
 * 面板与 Board 各查一遍，就等于给"这个 Board 有哪些行"开两份答案。
 */

const fixture = vi.hoisted(() => ({
  rows: [] as BoardRow[],
  kind: 'branch' as BoardRow['kind'],
  loading: false,
  selectSession: vi.fn(),
  setSelectedDemand: vi.fn()
}))

vi.mock('../src/renderer/src/hooks/useBoardRows.js', () => ({
  useBoardRows: () => ({ rows: fixture.rows, kind: fixture.kind, loading: fixture.loading })
}))

vi.mock('../src/renderer/src/store.js', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ selectSession: fixture.selectSession, setSelectedDemand: fixture.setSelectedDemand, config: null, sessions: [], demands: {}, selectedDemandId: null })
}))

const dockSource = readFileSync(
  new URL('../src/renderer/src/components/SurfaceToolDock.tsx', import.meta.url),
  'utf8'
)

function agentSession(id: string, state: SessionSnapshot['status']['state'] = 'working'): SessionSnapshot {
  return {
    id,
    kind: 'agent',
    providerId: 'codex',
    executorId: 'codex',
    capabilities: {
      terminal: true, timeline: 'streaming', permission: 'respond',
      providerResume: true, replyCorrelation: 'none'
    },
    hostId: 'local',
    workspacePath: '/repo',
    label: `Agent ${id}`,
    createdAt: 1,
    updatedAt: 1,
    processState: 'running',
    status: { state, source: 'native-hook', observedAt: 1 },
    latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}` } }
  } as SessionSnapshot
}

function row(id: string, sessions: SessionSnapshot[] = []): BoardRow {
  return {
    id,
    name: `row-${id}`,
    path: `/repo/${id}`,
    workspace: null,
    kind: 'branch',
    branch: { name: id, worktreePath: null, workspaceId: null } as BoardRow extends { branch: infer B } ? B : never,
    runsByColumn: { inbox: [], working: sessions, 'needs-you': [], done: [] },
    sessions,
    searchText: id
  } as BoardRow
}

describe('boardListSegments', () => {
  it('行不多时全列，不折叠', () => {
    const rows = [row('a'), row('b')]
    expect(boardListSegments(rows, false)).toEqual({ shown: rows, hidden: 0 })
  })

  it('超出上限时其余折叠成一个数，而不是被截断丢掉', () => {
    const rows = Array.from({ length: BOARD_LIST_VISIBLE_ROWS + 3 }, (_, index) => row(`r${index}`))
    const { shown, hidden } = boardListSegments(rows, false)
    expect(shown).toHaveLength(BOARD_LIST_VISIBLE_ROWS)
    expect(hidden).toBe(3)
    // 折叠的那部分必须能被找回——数字对得上才说明它只是没显示，不是丢了。
    expect(shown.length + hidden).toBe(rows.length)
  })

  it('展开后全列，hidden 归零', () => {
    const rows = Array.from({ length: BOARD_LIST_VISIBLE_ROWS + 3 }, (_, index) => row(`r${index}`))
    expect(boardListSegments(rows, true)).toEqual({ shown: rows, hidden: 0 })
  })
})

describe('Browser Tools launch feedback', () => {
  it('turns an unfocused pane into deterministic visible error text', () => {
    expect(browserOpenError(undefined)).toBe('Select a workspace and focus a pane before opening a browser.')
    expect(browserOpenError('focused-pane')).toBeNull()
  })
})

describe('Board 工具面板是工作清单', () => {
  it('Demand 面板不自己查 Branch/Topic，也不把 Branch 作为空态行', () => {
    // Board 的主实体是持久化 Demand。Branch 读取即使存在，也不能填充 Demand 面板。
    expect(dockSource).not.toContain('useBoardRows()')
    expect(dockSource).not.toContain('useScratchTopics(')
    expect(dockSource).not.toContain('useWorkspaceBranches(')
    expect(dockSource).not.toContain('buildTopicBoardRows(')
    expect(dockSource).not.toContain('buildProjectBranchLanes(')
  })

  it('状态点复用共享 StatusDot，不发明第二套颜色或形状', () => {
    const start = dockSource.indexOf('function BoardToolList')
    const end = dockSource.indexOf('function SurfaceToolDock')
    // 两个锚点都要真的找到，否则 slice 会静默扩张/坍缩成扫错范围（RegionMosaic/SortableTopicItem
    // 搬走后旧的 `function SortableTopicItem` 止锚不复存在，会让 slice 一路扫到文件末尾）。
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const list = dockSource.slice(start, end)
    expect(list).toContain('<StatusDot status={demand.sessions[0]?.status')
    // 自己按状态挑颜色就是第二套语汇。
    expect(list).not.toContain('status--')
  })

  it('零 Demand 时显示明确空态，不显示 Branch 名', () => {
    const start = dockSource.indexOf('function BoardToolList')
    const end = dockSource.indexOf('function SurfaceToolDock')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const list = dockSource.slice(start, end)
    expect(list).toContain('No demands yet. Use PMO Teams Topic to create one.')
    expect(list).not.toContain('boardRows.rows.slice')
    expect(list).not.toContain('row.name')
  })

  it('全局 Board 直接挂载 Demand 面板', () => {
    expect(dockSource).toContain('{isBoard ? <BoardToolList')
  })
})

describe('BoardToolList 渲染', () => {
  it('零 Demand 时不渲染 Branch 行', async () => {
    fixture.rows = [row('main')]
    const { BoardToolList } = await import('../src/renderer/src/components/SurfaceToolDock.js')
    const markup = renderToStaticMarkup(createElement(BoardToolList, { hostId: 'local' }))
    expect(markup).toContain('board-tool-row')
    expect(markup).toContain('No demands yet')
    expect(markup).not.toContain('main')
  })

  it('零行时显示空态说明，而不是一张空清单', async () => {
    fixture.rows = []
    fixture.loading = false
    const { BoardToolList } = await import('../src/renderer/src/components/SurfaceToolDock.js')
    const markup = renderToStaticMarkup(createElement(BoardToolList, { hostId: 'local' }))
    expect(markup).toContain('board-tool-list')
    expect(markup).toContain('No demands yet')
  })
})
