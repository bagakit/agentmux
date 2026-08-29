// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppConfig, ScratchTopicSnapshot, WorkspaceBranchesSnapshot } from '../src/shared/contracts.js'

vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
vi.mock('../src/renderer/src/lib/api.js', () => ({
  api: { workspaces: { listBranches: vi.fn() }, scratch: { listTopics: vi.fn() } }
}))
vi.mock('../src/renderer/src/components/BoardDiscussionCanvas.js', () => ({ BoardDiscussionCanvas: () => null }))
vi.mock('../src/renderer/src/components/FanOutStrip.js', () => ({ FanOutStrip: () => null }))
import { api } from '../src/renderer/src/lib/api.js'
import { useAppStore } from '../src/renderer/src/store.js'
import { BoardRowsProvider, useBoardRows } from '../src/renderer/src/hooks/useBoardRows.js'
import { useScratchTopics } from '../src/renderer/src/hooks/useScratchTopics.js'
import { WorkspaceBoard } from '../src/renderer/src/components/WorkspaceBoard.js'
import { BoardToolList } from '../src/renderer/src/components/SurfaceToolDock.js'

let root: Root
let container: HTMLDivElement
const initial = useAppStore.getState()
function branches(name: string): WorkspaceBranchesSnapshot {
  return { kind: 'git-repository', hostId: 'local', repoPath: '/repo', branches: [
    { name, workspaceId: 'repo', worktreePath: '/repo', isCurrent: true }
  ] }
}
function topic(title: string): ScratchTopicSnapshot {
  return { id: 'view:one', title, summary: '', directoryPath: 'topic--view--one', topicPath: 'topic--view--one/topic.md', collaborators: [] }
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  useAppStore.setState({
    config: { workspaces: [{ id: 'repo', hostId: 'local', name: 'Repo', path: '/repo', kind: 'folder' }] } as AppConfig,
    activeWorkspaceId: 'repo', sessions: []
  })
  vi.mocked(api.workspaces.listBranches).mockReset().mockResolvedValue(branches('before-refresh'))
  vi.mocked(api.scratch.listTopics).mockReset()
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  useAppStore.setState(initial, true)
})
async function renderBoard(enabled = true) {
  await act(async () => root.render(createElement(BoardRowsProvider, {
    enabled, children: [createElement(WorkspaceBoard, { key: 'board' }), createElement(BoardToolList, { key: 'dock', hostId: 'local' })]
  })))
}
describe('Board request ownership', () => {
  it('one read supplies the real Board and dock; Refresh updates both', async () => {
    await renderBoard()
    expect(api.workspaces.listBranches).toHaveBeenCalledTimes(1)
    expect(container.querySelector('.board--matrix')!.textContent).toContain('before-refresh')
    expect(container.querySelector('.board-tool-list')!.textContent).toContain('No requests or ideas yet')
    vi.mocked(api.workspaces.listBranches).mockResolvedValue(branches('after-refresh'))
    const refresh = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Refresh')!
    expect(refresh).toBeDefined()
    await act(async () => refresh.click())
    expect(api.workspaces.listBranches).toHaveBeenCalledTimes(2)
    expect(container.querySelector('.board--matrix')!.textContent).toContain('after-refresh')
    expect(container.querySelector('.board-tool-list')!.textContent).toContain('No requests or ideas yet')
    expect(container.textContent).not.toContain('before-refresh')
  })
  it('shows read failure in both surfaces instead of an empty Board or endless loading', async () => {
    vi.mocked(api.workspaces.listBranches).mockRejectedValue(new Error('Git read failed'))
    await renderBoard()
    expect(container.querySelector('[data-loading-phase="failed"]')!.textContent).toContain('Git read failed')
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('Git read failed')
    expect(container.textContent).not.toContain('No branches yet')
  })
  it('does not read repositories when the Board is inactive', async () => {
    function Observer() { return createElement('span', null, useBoardRows().rows.length) }
    await act(async () => root.render(createElement(BoardRowsProvider, { enabled: false, children: createElement(Observer) })))
    expect(api.workspaces.listBranches).not.toHaveBeenCalled()
    expect(api.scratch.listTopics).not.toHaveBeenCalled()
  })
})

describe('Topic request lifetime', () => {
  const observed: Array<{ workspaceId: string; titles: string[] | null; error: string | null }> = []
  function Observer({ workspaceId }: { workspaceId: string }) {
    const { topics, error } = useScratchTopics(workspaceId)
    observed.push({ workspaceId, titles: topics?.map((t) => t.title) ?? null, error })
    return createElement('span', null, error ?? topics?.map((t) => t.title).join(','))
  }
  it('never renders old Topics under a new Workspace, even before effects run; ignores late replies', async () => {
    observed.length = 0
    let completeB!: (topics: ScratchTopicSnapshot[]) => void
    vi.mocked(api.scratch.listTopics).mockResolvedValueOnce([topic('A-only')])
      .mockImplementationOnce(() => new Promise((resolve) => { completeB = resolve }))
      .mockResolvedValueOnce([topic('C-only')])
    await act(async () => root.render(createElement(Observer, { workspaceId: 'A' })))
    expect(container.textContent).toBe('A-only')
    await act(async () => root.render(createElement(Observer, { workspaceId: 'B' })))
    expect(observed.filter((x) => x.workspaceId === 'B').every((x) => x.titles === null)).toBe(true)
    expect(observed.some((x) => x.workspaceId === 'B')).toBe(true)
    await act(async () => root.render(createElement(Observer, { workspaceId: 'C' })))
    await act(async () => completeB([topic('stale-B')]))
    expect(container.textContent).toBe('C-only')
  })
})
