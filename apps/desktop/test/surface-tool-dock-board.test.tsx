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
 * Board 工具的次级面板是**工作清单**，不是说明页。
 *
 * 用户打开它是来找一条具体的工作线。所以这里断言的是"清单确实列出了 Board 的行和行内的
 * Agent，点一个 Agent 会定位到它"，以及一条同样重要的反面："行不是面板自己查来的"——
 * 面板与 Board 各查一遍，就等于给"这个 Board 有哪些行"开两份答案。
 */

const fixture = vi.hoisted(() => ({
  rows: [] as BoardRow[],
  kind: 'branch' as BoardRow['kind'],
  loading: false,
  selectSession: vi.fn()
}))

vi.mock('../src/renderer/src/hooks/useBoardRows.js', () => ({
  useBoardRows: () => ({ rows: fixture.rows, kind: fixture.kind, loading: fixture.loading })
}))

vi.mock('../src/renderer/src/store.js', () => ({
  useAppStore: (selector: (state: { selectSession: typeof fixture.selectSession }) => unknown) =>
    selector({ selectSession: fixture.selectSession })
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
  it('行与 Board 主视图同源——面板不自己查一遍 topics/branches', () => {
    // 这是本 task 最容易悄悄退化的一条：面板自己 useScratchTopics/useWorkspaceBranches，
    // 两处就会在筛选、排序、加载时序上各自漂移，而漂移时谁都不会响。
    expect(dockSource).toContain('const { rows, kind, loading, error } = useBoardRows()')
    expect(dockSource).not.toContain('useScratchTopics(')
    expect(dockSource).not.toContain('useWorkspaceBranches(')
    expect(dockSource).not.toContain('buildTopicBoardRows(')
    expect(dockSource).not.toContain('buildProjectBranchLanes(')
  })

  it('点 Agent 走既有的 selectSession，不新增第二条导航路径', () => {
    expect(dockSource).toContain('onClick={() => selectSession(session.id)}')
  })

  it('状态点复用共享 StatusDot，不发明第二套颜色或形状', () => {
    const list = dockSource.slice(
      dockSource.indexOf('function BoardToolList'),
      dockSource.indexOf('function SortableTopicItem')
    )
    expect(list).toContain('<StatusDot status={session.status} />')
    // 自己按状态挑颜色就是第二套语汇。
    expect(list).not.toContain('status--')
  })

  it('静态说明只在零行时作为空态出现，不再是默认视图', () => {
    const list = dockSource.slice(
      dockSource.indexOf('function BoardToolList'),
      dockSource.indexOf('function SortableTopicItem')
    )
    // 图例在 rows.length === 0 的分支里，且那个分支先于清单返回。
    const emptyBranch = list.indexOf('if (rows.length === 0)')
    const legend = list.indexOf('board-tool-legend')
    const listMarkup = list.indexOf('className="board-tool-list"')
    expect(emptyBranch).toBeGreaterThan(-1)
    expect(legend).toBeGreaterThan(emptyBranch)
    expect(listMarkup).toBeGreaterThan(legend)
  })

  it('Scratch 也有这个面板——Topic 行同样是工作线', () => {
    // 旧摘要挂在 `isBoard && project` 上，Scratch 没有 project，于是永远看不到它。
    expect(dockSource).toContain('{isBoard ? <BoardToolList')
    expect(dockSource).not.toContain('{isBoard && project ?')
  })
})

describe('BoardToolList 渲染', () => {
  it('列出行名与行内 Agent 数，展开前不渲染 Agent', async () => {
    fixture.rows = [row('alpha', [agentSession('s1'), agentSession('s2')])]
    fixture.kind = 'branch'
    const { BoardToolList } = await import('../src/renderer/src/components/SurfaceToolDock.js')
    const markup = renderToStaticMarkup(createElement(BoardToolList, { hostId: 'local' }))
    expect(markup).toContain('row-alpha')
    expect(markup).toContain('board-tool-row')
    // 计数在行上；Agent 名字要展开才出现，折叠态一行只占一行。
    expect(markup).toContain('>2</em>')
    expect(markup).not.toContain('Agent s1')
    expect(markup).toContain('aria-expanded="false"')
  })

  it('零行时显示空态说明，而不是一张空清单', async () => {
    fixture.rows = []
    fixture.loading = false
    const { BoardToolList } = await import('../src/renderer/src/components/SurfaceToolDock.js')
    const markup = renderToStaticMarkup(createElement(BoardToolList, { hostId: 'local' }))
    expect(markup).toContain('board-tool-legend')
    expect(markup).not.toContain('board-tool-list')
  })
})
