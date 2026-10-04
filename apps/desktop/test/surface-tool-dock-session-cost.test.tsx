const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { SurfaceToolDock } from '../src/renderer/src/components/SurfaceToolDock'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { createWorktreePresenceSelector } from '../src/renderer/src/lib/branch-agent-presence'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import type { SessionSnapshot } from '../src/shared/contracts'

const observed = vi.hoisted(() => ({ files: 0, menus: 0, presence: [] as string[] }))
// Count boundary renders while forwarding their real production descendants.
vi.mock('../src/renderer/src/components/FileExplorer', async () => {
  const actual = await vi.importActual<typeof import('../src/renderer/src/components/FileExplorer')>('../src/renderer/src/components/FileExplorer')
  return { ...actual, FileExplorer: (props: Parameters<typeof actual.FileExplorer>[0]) => {
    observed.files++; return <actual.FileExplorer {...props} />
  } }
})
vi.mock('../src/renderer/src/components/BranchContextMenu', async () => {
  const actual = await vi.importActual<typeof import('../src/renderer/src/components/BranchContextMenu')>('../src/renderer/src/components/BranchContextMenu')
  return { ...actual, BranchContextMenu: (props: Parameters<typeof actual.BranchContextMenu>[0]) => {
    observed.menus++; return <actual.BranchContextMenu {...props} />
  } }
})
vi.mock('../src/renderer/src/components/SelectorList', async () => {
  const actual = await vi.importActual<typeof import('../src/renderer/src/components/SelectorList')>('../src/renderer/src/components/SelectorList')
  return { ...actual, SelectorPresence: (props: Parameters<typeof actual.SelectorPresence>[0]) => {
    observed.presence.push(props.agents.map(a => `${a.executorId}:${a.state}:${a.count}`).join(','))
    return <actual.SelectorPresence {...props} />
  } }
})
const dom = composerDOM()
const workspace = composerConfig.workspaces[0]!
const path = (index: number) => `${workspace.path}/worktree-${index}`
const agent = (id: string, index: number): SessionSnapshot => ({ ...composerSession(), id,
  workspacePath: path(index), executorId: `executor-${id}`, updatedAt: 1 })
const first = agent('one', 1), second = agent('two', 2)
beforeEach(() => {
  // happy-dom has no layout engine. Give the actual virtual tree a visible viewport,
  // while keeping its real projection, renderer, nodes and updates intact.
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('file-tree') ? 240 : 0 })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('file-tree') ? 300 : 0 })
  useAppStore.setState({ config: composerConfig, activeWorkspaceId: workspace.id,
    workspaceTool: 'files-branches', projectRailOpen: true, explorerCollapsed: { [workspace.id]: false },
    sessions: [first, second], tabs: {}, layouts: {}, demands: {}, agentNames: {} })
  vi.spyOn(api.files, 'readDirectory').mockResolvedValue([{ path: 'README.md', name: 'README.md', isDirectory: false, isSymlink: false }])
  vi.spyOn(api.workspaces, 'listBranches').mockResolvedValue({ kind: 'git-repository', hostId: workspace.hostId,
    repoPath: workspace.path, branches: Array.from({ length: 500 }, (_, i) => ({
      name: `branch-${i}`, isCurrent: i === 0, workspaceId: `workspace-${i}`, worktreePath: path(i)
    })) })
})
const reset = () => { observed.files = 0; observed.menus = 0; observed.presence = [] }
it('isolates a real nonempty file tree and 500 branch menus while matching worktree presence stays live', async () => {
  await dom.render(<SurfaceToolDock workspace={workspace} />)
  await act(async () => { await vi.waitFor(() => expect(dom.container.querySelectorAll('[role="treeitem"]').length).toBeGreaterThan(0)) })
  expect(observed.files).toBeGreaterThan(0)
  expect(observed.menus).toBeGreaterThanOrEqual(500)
  expect(dom.container.querySelectorAll('.branch-row').length).toBe(500)
  expect(dom.container.querySelectorAll('[role="treeitem"]').length).toBeGreaterThan(0)
  const originalTree = dom.container.querySelector('[role="tree"]')
  const originalMenus = [...dom.container.querySelectorAll('.branch-row')]
  reset()
  const external = { ...agent('outside', 3), workspacePath: _hygiene_fixturePath("unrelated-repository"), hostId: 'different-host' }
  await act(async () => useAppStore.setState({ sessions: [first, second, external] }))
  expect(observed).toEqual({ files: 0, menus: 0, presence: [] })
  reset()
  const waiting = { ...second, status: { ...second.status, state: 'waiting' as const }, updatedAt: 2 }
  await act(async () => useAppStore.setState({ sessions: [first, waiting, external] }))
  expect(observed.files).toBe(0); expect(observed.menus).toBe(0)
  expect(observed.presence).toEqual(['executor-two:waiting:1'])
  expect(dom.container.querySelector('[role="tree"]')).toBe(originalTree)
  expect([...dom.container.querySelectorAll('.branch-row')]).toEqual(originalMenus)
  await dom.click('[aria-label="Agents"]')
  expect(dom.container.querySelector('.workspace-agents-tool')).not.toBeNull()
  await act(async () => useAppStore.setState({ sessions: [{ ...first, workspacePath: workspace.path }, waiting] }))
  expect(dom.container.textContent).toContain(first.label)
})
it('scans an immutable Session array once for 500 nonempty leaf selectors and retains display equivalence', () => {
  let scans = 0
  const real = [first, second]
  const sessions = new Proxy(real, { get(target, property, receiver) {
    if (property === Symbol.iterator) { scans++; return target[Symbol.iterator].bind(target) }
    return Reflect.get(target, property, receiver)
  } })
  const selectors = Array.from({ length: 500 }, (_, i) => createWorktreePresenceSelector(workspace.hostId, path(i)))
  const initial = selectors.map(select => select(sessions))
  expect(initial.filter(items => items.length > 0)).toHaveLength(2)
  expect(scans).toBe(1)
  const changed = [first, second, { ...agent('outside', 3), workspacePath: _hygiene_fixturePath("another-repo") }]
  expect(selectors.map(select => select(changed))).toEqual(initial)
  for (let i = 0; i < selectors.length; i++) expect(selectors[i]!(changed)).toBe(initial[i])
})
