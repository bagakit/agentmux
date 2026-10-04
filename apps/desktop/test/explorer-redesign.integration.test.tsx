// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalExecutionHost } from '@agentmux/core'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
import { GitService } from '../src/main/git-service.js'
import { GIT_NONINTERACTIVE_ENV } from '@agentmux/git'
import { SurfaceToolDock } from '../src/renderer/src/components/SurfaceToolDock'
import { WorkspaceSidebar } from '../src/renderer/src/components/WorkspaceSidebar'
import { TopBreadcrumb } from '../src/renderer/src/components/TopRowChrome'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
import type { GitHistoryInput } from '../src/shared/git-contracts'

const dom = composerDOM()
let directory: string, config: typeof composerConfig, workspace: typeof composerConfig.workspaces[number]
let originalTabs: ReturnType<typeof useAppStore.getState>['tabs'], originalLayouts: ReturnType<typeof useAppStore.getState>['layouts']
let history: ReturnType<typeof vi.fn>, move: ReturnType<typeof vi.fn>, expectedOids: string[]
const originalBridge = Object.getOwnPropertyDescriptor(window, 'agentmux')
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'amx-explorer-joined-')))
  const host = new LocalExecutionHost()
  const git = async (...args: string[]) => {
    const result = await host.run('git', ['-C', directory, ...args], { env: GIT_NONINTERACTIVE_ENV, timeoutMs: 20000, maxOutputBytes: 2 * 1024 * 1024 })
    if (result.exitCode !== 0) throw new Error(result.stderr)
    return result.stdout.trim()
  }
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Explorer review'); await git('config', 'user.email', 'review@example.invalid')
  await git('config', 'commit.gpgsign', 'false'); await git('config', 'core.hooksPath', '/dev/null')
  await writeFile(join(directory, 'notes.md'), '# Keep reading\n')
  await git('add', 'notes.md'); await git('commit', '-m', 'Project seed')
  const seed = await git('rev-parse', 'HEAD'), tree = await git('rev-parse', 'HEAD^{tree}')
  const main = await git('commit-tree', tree, '-p', seed, '-m', 'Main work')
  const topic = await git('commit-tree', tree, '-p', seed, '-m', 'Topic work')
  const merge = await git('commit-tree', tree, '-p', main, '-p', topic, '-m', 'Merge both work lines')
  const remote = await git('commit-tree', tree, '-m', 'Remote-only root')
  await git('update-ref', 'refs/heads/main', merge); await git('update-ref', 'refs/heads/topic', topic)
  await git('update-ref', 'refs/remotes/origin/experiment', remote)
  expectedOids = [seed, main, topic, merge, remote]
  workspace = { id: 'joined', hostId: 'local', name: 'Joined project', path: directory, kind: 'folder', branch: 'main' }
  config = { ...composerConfig, workspaces: [workspace], copyPathsAsAbsolute: false }
  const service = new GitService(() => host)
  history = vi.fn((id: string, input: GitHistoryInput) => service.history(id, { ...input, limit: 2 }, config))
  Object.defineProperty(window, 'agentmux', { configurable: true, value: { git: {
    history, status: (id: string) => service.status(id, config), aheadBehind: vi.fn().mockResolvedValue(null),
    remoteActions: vi.fn(), compareBranches: vi.fn(), branchDiff: vi.fn()
  } } })
  vi.spyOn(api.files, 'readDirectory').mockImplementation(async (id, relative) => {
    expect(id).toBe(workspace.id)
    const entries = await readdir(join(directory, relative), { withFileTypes: true })
    return entries.map(entry => ({ path: relative ? `${relative}/${entry.name}` : entry.name, name: entry.name,
      isDirectory: entry.isDirectory(), isSymlink: entry.isSymbolicLink(), ignored: entry.name === '.git' }))
  })
  vi.spyOn(api.workspaces, 'listBranches').mockImplementation(async id => ({ kind: 'git-repository', hostId: 'local', repoPath: directory,
    branches: [{ name: 'main', isCurrent: true, worktreePath: directory, workspaceId: id }] }))
  move = vi.fn(async (source: string, target: string, id: string) => {
    expect(id).toBe(workspace.id); await rename(join(directory, source), join(directory, target))
  })
  const originalTab = createWorkbenchTab('original-tab', { regionId: 'original-region', workspaceId: workspace.id, kind: 'launcher' })
  originalTabs = { [originalTab.id]: originalTab }
  originalLayouts = { [workspace.id]: createWorkspaceLayout('original-group', [originalTab.id]) }
  useAppStore.setState({ config, localHome: homedir(), activeWorkspaceId: workspace.id, mainSurface: 'workbench', workspaceTool: 'files-branches',
    projectRailOpen: true, sessions: [], tabs: originalTabs, layouts: originalLayouts, pinnedItems: {}, spaceObjectIcons: {}, explorerCollapsed: {},
    fileExplorerStates: {}, workspaceFileRevisions: {}, dirtyDocuments: {}, lastActiveFileByWorkspace: {},
    renamePath: move, detectExecutors: vi.fn(), agentComposerDrafts: { preserved: 'Keep this unsent draft' } })
})
afterEach(async () => {
  if (originalBridge) Object.defineProperty(window, 'agentmux', originalBridge)
  else Reflect.deleteProperty(window, 'agentmux')
  await rm(directory, { recursive: true, force: true })
})
function element(selector: string) {
  const node = dom.container.querySelector<HTMLElement>(selector)
  expect(node, `Joined production consumer ${selector}`).not.toBeNull()
  return node!
}
async function settle(test: () => boolean) {
  for (let i = 0; i < 100; i++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
    if (test()) return
  }
  expect(test(), 'Joined request did not settle').toBe(true)
}
async function click(selector: string) { await act(async () => element(selector).click()) }
const rows = () => [...dom.container.querySelectorAll<HTMLElement>('[data-history-oid]')].map(node => node.dataset.historyOid!)
async function tab(label: string) {
  const button = [...dom.container.querySelectorAll<HTMLElement>('[role="tab"]')].find(node => node.textContent?.trim() === label)
  expect(button, `Joined source-control tab ${label}`).toBeDefined(); await act(async () => button!.click())
}
async function historyTab() { await tab('History'); await settle(() => rows().length > 0) }

it('joins actual file IO, fixed real Git history, source-control switching, collapse and display preference without losing original workface', async () => {
  await dom.render(<><WorkspaceSidebar /><TopBreadcrumb /><SurfaceToolDock workspace={workspace} /></>)
  await settle(() => !!dom.container.querySelector('[data-tree-path="notes.md"]') && !!dom.container.querySelector('.branch-row'))
  expect(element('.workspace-tool-context--explorer strong').textContent).toBe(workspace.name)
  expect(dom.container.querySelectorAll('.explorer-header')).toHaveLength(0)
  const label = element('[data-tree-path="notes.md"] .tree-row__label')
  await act(async () => label.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
  const input = element('.tree-inline-input') as HTMLInputElement
  expect([input.selectionStart, input.selectionEnd]).toEqual([0, 5])
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'renamed.md'); input.dispatchEvent(new Event('input', { bubbles: true })) })
  await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
  await settle(() => !!dom.container.querySelector('[data-tree-path="renamed.md"]'))
  expect(move).toHaveBeenCalledExactlyOnceWith('notes.md', 'renamed.md', workspace.id)
  expect(await readFile(join(directory, 'renamed.md'), 'utf8')).toBe('# Keep reading\n')
  await historyTab()
  expect(rows()).toHaveLength(2)
  for (let i = 0; i < 2; i++) { await click('.git-history-footer button'); await settle(() => rows().length === Math.min(4 + i * 2, 5)) }
  expect(new Set(rows())).toEqual(new Set(expectedOids))
  const merge = [...dom.container.querySelectorAll('.git-history-commit strong')].find(row => row.textContent === 'Merge both work lines')!
  expect(merge).toBeDefined()
  const mergeOid = merge.closest<HTMLElement>('[data-history-oid]')!.dataset.historyOid!
  const parentEdges = [...dom.container.querySelectorAll<SVGPathElement>(`[data-child-oid="${mergeOid}"]`)]
  expect(parentEdges.map(edge => edge.getAttribute('data-parent-oid'))).toEqual([expectedOids[1], expectedOids[2]])
  const mergeRow = rows().indexOf(mergeOid)
  expect(mergeRow).toBeGreaterThanOrEqual(0)
  const parentEnds = parentEdges.map(edge => {
    const point = /, ([-\d.]+) ([-\d.]+)$/.exec(edge.getAttribute('d')!)
    expect(point, 'Actual parent curve endpoint').not.toBeNull()
    expect(Number(point![2])).toBe((mergeRow + 1) * 24)
    return Number(point![1])
  })
  expect(new Set(parentEnds).size).toBe(2)
  expect([...dom.container.querySelectorAll<HTMLElement>('.git-history-commit')].map(row => row.style.height)).toEqual(['24px', '24px', '24px', '24px', '24px'])
  expect([...dom.container.querySelectorAll('.git-history-node')].map(node => Number(node.getAttribute('cy')))).toEqual([12, 36, 60, 84, 108])
  expect(history).toHaveBeenCalledTimes(3)
  await click('[aria-label="Hide file tree"]')
  expect(rows()).toHaveLength(5); expect(history).toHaveBeenCalledTimes(3)
  await click('[aria-label="Show file tree"]')
  expect(rows()).toHaveLength(5); expect(history).toHaveBeenCalledTimes(3)
  await tab('Changes')
  await settle(() => !!dom.container.querySelector('.change-row'))
  await historyTab()
  expect(rows()).toHaveLength(5); expect(history).toHaveBeenCalledTimes(3)
  await act(async () => useAppStore.setState({ config: { ...config, copyPathsAsAbsolute: true } }))
  expect(element('.workspace-tool-context--explorer > span').title).toBe(directory)
  expect(element('select[aria-label="History reference"]').title).toBe(directory)
  expect(element('.breadcrumbs strong').title).toBe(directory)
  expect(history).toHaveBeenCalledTimes(3)
  expect(useAppStore.getState().config!.workspaces[0]!.path).toBe(directory)
  expect(useAppStore.getState().activeWorkspaceId).toBe('joined')
  expect(useAppStore.getState().agentComposerDrafts).toEqual({ preserved: 'Keep this unsent draft' })
  expect(useAppStore.getState().tabs).toBe(originalTabs); expect(useAppStore.getState().layouts).toBe(originalLayouts)
})
