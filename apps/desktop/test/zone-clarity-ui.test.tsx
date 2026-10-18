// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { GitWorktreesResult, GitWorktreeEntry } from '../src/shared/git-contracts'
import type { WorkspaceBranchesSnapshot, WorkspaceRecord } from '../src/shared/contracts'
import { directoryIdentity, workspaceZoneId } from '../src/shared/space-addresses'
import { WorkspaceZonesPanel } from '../src/renderer/src/components/WorkspaceZonesPanel'
import { BranchesPanel } from '../src/renderer/src/components/BranchesPanel'
import { SurfaceToolDock } from '../src/renderer/src/components/SurfaceToolDock'
import { workspaceZoneContext } from '../src/renderer/src/lib/workspace-zone-context'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

// File reading/layout is a sibling to the real Dock -> ProjectFiles -> Zones -> Git route under test.
vi.mock('../src/renderer/src/components/WorkspaceFilesFrame', () => ({ WorkspaceFilesFrame: ({ children }: { children: ReactNode }) => <>{children}</> }))
const dom = composerDOM()
const workspace: WorkspaceRecord = { ...composerConfig.workspaces[0]!, id: 'root', path: new URL("private/working-alias", new URL('/', import.meta.url)).pathname, repoPath: new URL("private/working-alias", new URL('/', import.meta.url)).pathname, name: 'Repository' }
const lane: WorkspaceRecord = { ...workspace, id: 'lane', path: new URL("private/lane-alias", new URL('/', import.meta.url)).pathname, name: 'Saved review', kind: 'worktree', branch: 'obsolete-name' }
const spaceId = directoryIdentity('local', workspace.path), laneZone = workspaceZoneId(spaceId, lane.id)
const entry = (path: string, branch: string | null, kind: GitWorktreeEntry['kind'] = 'linked', aliases: string[] = []): GitWorktreeEntry => ({ path, branch, kind, detached: branch === null && kind !== 'bare', aliases })
let answer: GitWorktreesResult, branchAnswer: WorkspaceBranchesSnapshot
let read: ReturnType<typeof vi.spyOn>, open: ReturnType<typeof vi.spyOn>
function ready(): Extract<GitWorktreesResult, { kind: 'ready' }> { if (answer.kind !== 'ready') throw new Error('Test requires complete native inventory'); return answer }
const context = () => workspaceZoneContext(useAppStore.getState(), workspace)
const row = (id: string) => [...dom.container.querySelectorAll<HTMLButtonElement>('[data-zone-id]')].find(value => value.dataset.zoneId === id)!
const inventory = () => [...dom.container.querySelectorAll<HTMLElement>('[data-worktree-path]')]
async function flush() { await act(async () => { await Promise.allSettled(read.mock.results.map(value => value.value)) }) }
async function refresh() { await dom.click('[aria-label="Refresh Zone Git metadata"]'); await flush() }
async function search(value: string) { await act(async () => {
  const input = dom.container.querySelector<HTMLInputElement>('[aria-label="Find branch or worktree path"]')!
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}) }
beforeEach(() => {
  answer = { kind: 'ready', hostId: 'local', workspacePath: workspace.path, repoPath: new URL("private/physical-repo", new URL('/', import.meta.url)).pathname, checkedAt: 10, warnings: [],
    worktrees: [entry(new URL("private/physical-repo", new URL('/', import.meta.url)).pathname, 'main', 'main', [workspace.path]), entry(new URL("private/physical-lane", new URL('/', import.meta.url)).pathname, 'feature/review', 'linked', [lane.path]), entry(new URL("private/detached", new URL('/', import.meta.url)).pathname, null), entry(new URL("private/bare.git", new URL('/', import.meta.url)).pathname, null, 'bare')],
    directories: [workspace.path, lane.path, new URL("private/physical-repo", new URL('/', import.meta.url)).pathname, new URL("private/physical-lane", new URL('/', import.meta.url)).pathname, new URL("private/detached", new URL('/', import.meta.url)).pathname, new URL("private/bare.git", new URL('/', import.meta.url)).pathname].map(path => ({ kind: 'directory', path, canonicalPath: path === workspace.path ? new URL("private/physical-repo", new URL('/', import.meta.url)).pathname : path === lane.path ? new URL("private/physical-lane", new URL('/', import.meta.url)).pathname : path })) }
  branchAnswer = { kind: 'git-repository', hostId: 'local', repoPath: workspace.path, branches: [
    { name: 'main', isCurrent: false, worktreePath: new URL("private/physical-repo", new URL('/', import.meta.url)).pathname, workspaceId: workspace.id },
    { name: 'feature/review', isCurrent: false, worktreePath: new URL("private/physical-lane", new URL('/', import.meta.url)).pathname, workspaceId: lane.id },
    { name: 'without-worktree', isCurrent: false, worktreePath: null, workspaceId: null }
  ] }
  useAppStore.setState({ config: { ...composerConfig, workspaces: [workspace, lane] }, activeWorkspaceId: workspace.id,
    layouts: { root: createWorkspaceLayout('root-group'), lane: createWorkspaceLayout('lane-group') }, tabs: {},
    workspaceTool: 'files-branches', workspaceGitView: 'changes', workbenchSpaceSelection: null,
    spaceZoneBindings: {}, spatialRequests: {}, scratchTopicSnapshots: {}, topicCategories: [], projectGroups: [], loading: false })
  read = vi.spyOn(api.git, 'worktrees').mockImplementation(async () => answer)
  vi.spyOn(api.workspaces, 'listBranches').mockImplementation(async () => branchAnswer)
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
  open = vi.spyOn(api.workspaces, 'openBranch').mockResolvedValue({ config: useAppStore.getState().config!, workspace: lane })
  vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
})

it('separates saved workfaces from distinct native directories and suppresses an exact difference for ambiguous observations', async () => {
  useAppStore.setState({ spaceZoneBindings: { duplicate: { spaceId, workspaceId: lane.id } } })
  await dom.render(<WorkspaceZonesPanel workspace={workspace} onManageWorktrees={() => {}} />); await flush()
  expect(dom.container.querySelector('.selector-list__header')?.textContent).toContain('Working directories3')
  expect(dom.container.querySelector('.workspace-zones-scope')?.textContent).toContain('All worktrees 4')
  expect(dom.container.querySelector('.workspace-zones-scope')?.textContent).toContain('2 not in this Space')
  expect(row(workspaceZoneId(spaceId, workspace.id)).textContent).toContain('Main worktree')
  ready().warnings.push('A canonical relationship is ambiguous.')
  await refresh()
  expect(dom.container.querySelector('.workspace-zones-scope')?.textContent).not.toContain('not in this Space')
  expect(dom.container.querySelector('.workspace-zones-notice summary')?.textContent).toContain('unconfirmed')
})

it('keeps Home meaning when its exact path is also a currently observed Git worktree', async () => {
  useAppStore.setState({ spaceZoneBindings: { home: { spaceId, workspaceId: lane.id, directoryPath: lane.path,
    resource: { kind: 'home', hostId: 'local', directoryPath: lane.path, branch: null } } } })
  await dom.render(<WorkspaceZonesPanel workspace={workspace} onManageWorktrees={() => {}} />); await flush()
  expect(row('home').dataset.zoneKind).toBe('home')
  expect(row('home').querySelector('.workspace-zone-entry__kind')?.textContent).toBe('Home')
  expect(row('home').textContent).toContain('feature/review')
})

it('shows typed missing/file/unavailable/present-unlisted rows without erasing saved navigation or promoting foreign/unknown resources', async () => {
  const paths = [new URL("private/removed", new URL('/', import.meta.url)).pathname, new URL("private/file", new URL('/', import.meta.url)).pathname, new URL("private/denied", new URL('/', import.meta.url)).pathname, new URL("private/ordinary", new URL('/', import.meta.url)).pathname]
  const extras = paths.map((path, index) => ({ ...lane, id: `extra-${index}`, path, name: `Saved ${index}` }))
  useAppStore.setState(state => ({ config: { ...state.config!, workspaces: [workspace, lane, ...extras] },
    spaceZoneBindings: { nested: { spaceId, workspaceId: workspace.id, directoryPath: workspace.path + '/nested' },
      foreign: { spaceId, workspaceId: lane.id, resource: { kind: 'worktree', hostId: 'other', directoryPath: lane.path, branch: null } },
      unknown: { spaceId, workspaceId: lane.id, resource: { kind: 'unknown', hostId: 'local', directoryPath: lane.path, branch: null, issue: 'Original resource unconfirmed' } } } }))
  ready().directories.push({ kind: 'missing', path: paths[0]! }, { kind: 'not-directory', path: paths[1]! }, { kind: 'unavailable', path: paths[2]!, reason: 'EACCES original path' }, { kind: 'directory', path: paths[3]!, canonicalPath: paths[3]! })
  const before = useAppStore.getState()
  await dom.render(<WorkspaceZonesPanel workspace={workspace} onManageWorktrees={() => {}} />); await flush()
  const item = (id: string) => row(workspaceZoneId(spaceId, id)).parentElement!
  expect(item('extra-0').textContent).toContain('Directory not found')
  expect(item('extra-1').textContent).toContain('Not a directory')
  expect(item('extra-2').querySelector('details p')?.textContent).toContain('EACCES original path')
  expect(item('extra-3').textContent).toContain('Folder')
  expect(item('extra-3').textContent).toContain('Not listed as a worktree here')
  expect(row('foreign').textContent).not.toContain('feature/review')
  expect(row('unknown').dataset.zoneKind).toBe('unknown')
  expect(row('nested').parentElement?.textContent).toContain('Git relationship unconfirmed')
  expect(dom.container.textContent).not.toContain('Not a Git repository')
  expect([...dom.container.querySelectorAll<HTMLButtonElement>('[data-zone-id]')].every(button => !button.disabled)).toBe(true)
  expect(useAppStore.getState().config).toBe(before.config); expect(useAppStore.getState().tabs).toBe(before.tabs)
})

it('consumes fresh directory outcomes on Git failure while retaining historical branches, and marks FS history after transport failure', async () => {
  await dom.render(<WorkspaceZonesPanel workspace={workspace} onManageWorktrees={() => {}} />); await flush()
  answer = { kind: 'unavailable', hostId: 'local', workspacePath: workspace.path, checkedAt: 20, reason: 'Git offline', directories: [{ kind: 'missing', path: lane.path }] }
  await refresh()
  expect(row(laneZone).textContent).toContain('feature/review')
  expect(row(laneZone).textContent).toContain('Last observed')
  expect(row(laneZone).parentElement?.querySelector('summary')?.textContent).toBe('Directory not found')
  read.mockRejectedValueOnce(new Error('Transport offline'))
  await refresh()
  expect(row(laneZone).parentElement?.querySelector('summary')?.textContent).toBe('Directory not found · Last checked')
  expect(row(laneZone).textContent).toContain('feature/review')
})

it('renders the full native inventory including detached/bare, exact attached actions, all saved positions and native alias current status', async () => {
  useAppStore.setState({ spaceZoneBindings: { duplicate: { spaceId, workspaceId: lane.id } } })
  await dom.render(<BranchesPanel workspace={workspace} zoneContext={context()} />); await flush()
  expect(inventory()).toHaveLength(4)
  expect(inventory()[0]?.querySelector('[aria-label="Current branch"]')).not.toBeNull()
  expect(inventory()[1]?.querySelectorAll('.worktree-inventory-relations button')).toHaveLength(2)
  expect(inventory()[2]?.textContent).toContain('Detached HEAD')
  expect(inventory()[3]?.textContent).toContain('Bare repository')
  expect(inventory()[2]?.querySelector('.branch-row__pin')).toBeNull()
  await search(new URL("private/detached", new URL('/', import.meta.url)).pathname); expect(inventory()).toHaveLength(1)
  expect(inventory()[0]?.dataset.worktreePath).toBe(new URL("private/detached", new URL('/', import.meta.url)).pathname)
  await search('feature/review')
  await dom.click(["[data-worktree-path=\"","physical-lane\"] .branch-row__open"].join(new URL("private/", new URL('/', import.meta.url)).pathname))
  expect(open).toHaveBeenCalledExactlyOnceWith(workspace.id, 'feature/review')
})

it('keeps original branch-owner actions reachable when the new inventory read fails or branch/path disagrees', async () => {
  answer = { kind: 'unavailable', hostId: 'local', workspacePath: workspace.path, checkedAt: 10, directories: [], reason: 'Controlled inventory unavailable' }
  await dom.render(<BranchesPanel workspace={workspace} zoneContext={context()} />); await flush()
  const original = () => [...dom.container.querySelectorAll<HTMLButtonElement>('[data-branch-group="branches"] .branch-row__open')]
  expect(original()).toHaveLength(3)
  await act(async () => original().find(button => button.textContent?.includes('feature/review'))!.click())
  expect(open).toHaveBeenCalledWith(workspace.id, 'feature/review')
})

it('does not borrow an attached action from a branch/path mismatch', async () => {
  if (branchAnswer.kind === 'git-repository') branchAnswer.branches[1]!.worktreePath = new URL("private/other-checkout", new URL('/', import.meta.url)).pathname
  await dom.render(<BranchesPanel workspace={workspace} zoneContext={context()} />); await flush()
  const displayed = dom.container.querySelector(["[data-worktree-path=\"","physical-lane\"]"].join(new URL("private/", new URL('/', import.meta.url)).pathname))!
  expect(displayed.querySelector(["[aria-label=\"Copy worktree path: ","physical-lane\"]"].join(new URL("private/", new URL('/', import.meta.url)).pathname))).not.toBeNull()
  expect(displayed.querySelector('.branch-row__pin')).toBeNull()
  expect(dom.container.querySelector('[data-branch-group="branches"]')?.textContent).toContain('feature/review')
  expect(open).not.toHaveBeenCalled()
})

it('keeps the original branch refresh available while the independent native inventory is pending', async () => {
  let resolve!: (value: GitWorktreesResult) => void
  read.mockImplementationOnce(() => new Promise<GitWorktreesResult>(yes => { resolve = yes }))
  const branchRead = vi.mocked(api.workspaces.listBranches)
  await dom.render(<BranchesPanel workspace={workspace} zoneContext={context()} />)
  expect(branchRead).toHaveBeenCalledTimes(1)
  const refreshButton = dom.container.querySelector<HTMLButtonElement>('[title="Refresh branches"]')!
  expect(refreshButton.disabled).toBe(false)
  await act(async () => refreshButton.click())
  expect(branchRead).toHaveBeenCalledTimes(2)
  await act(async () => resolve(answer))
})

it.each(['nested', 'missing'])('opens All worktrees from %s through the real Dock at the original Folder scope without changing Zone', async chosen => {
  useAppStore.setState({ spaceZoneBindings: { [chosen]: { spaceId, workspaceId: chosen === 'missing' ? lane.id : workspace.id, ...(chosen === 'nested' ? { directoryPath: workspace.path + '/nested' } : {}) } },
    workbenchSpaceSelection: { spaceId, zoneId: chosen, workspaceId: workspace.id, groupId: null, tabId: null, regionId: null, topicId: null } })
  if (chosen === 'missing') ready().directories = ready().directories.map(value => value.path === lane.path ? { kind: 'missing', path: value.path } : value)
  const before = useAppStore.getState()
  await dom.render(<SurfaceToolDock workspace={workspace} />); await flush()
  await dom.click('[aria-label="Manage worktrees"]'); await flush()
  expect(useAppStore.getState().workspaceTool).toBe('git')
  expect(useAppStore.getState().workspaceGitView).toBe('branches')
  expect(read.mock.calls.every(([input]) => input.workspaceId === workspace.id && input.expectedResource.workspacePath === workspace.path)).toBe(true)
  expect(inventory()).toHaveLength(4)
  expect(useAppStore.getState().workbenchSpaceSelection).toBe(before.workbenchSpaceSelection)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
})
