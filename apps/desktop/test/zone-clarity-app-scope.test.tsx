// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { GitWorktreesResult } from '../src/shared/git-contracts'
import type { WorkspaceRecord } from '../src/shared/contracts'
import { directoryIdentity, workspaceZoneId } from '../src/shared/space-addresses'
import { SurfaceToolDock } from '../src/renderer/src/components/SurfaceToolDock'
import { folderInventoryWorkspace } from '../src/renderer/src/lib/zone-worktree-observation'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

// Preserve the real App prop selection and original Store navigation. The sibling file tree is outside this scope assertion.
vi.mock('../src/renderer/src/components/WorkspaceFilesFrame', () => ({ WorkspaceFilesFrame: ({ children }: { children: ReactNode }) => <>{children}</> }))
const dom = composerDOM()
const folder: WorkspaceRecord = { ...composerConfig.workspaces[0]!, id: 'scope-root', name: 'Original Folder', path: new URL("private/folder", new URL('/', import.meta.url)).pathname, kind: 'folder' }
const missing: WorkspaceRecord = { ...folder, id: 'scope-missing', name: 'Saved missing', kind: 'worktree', repoPath: folder.path, path: new URL("private/removed", new URL('/', import.meta.url)).pathname }
const spaceId = directoryIdentity(folder.hostId, folder.path), missingZone = workspaceZoneId(spaceId, missing.id)
let inventoryRead: ReturnType<typeof vi.spyOn>, branchRead: ReturnType<typeof vi.spyOn>
function AppSelectedWorkspace() {
  const workspace = useAppStore(state => state.config?.workspaces.find(item => item.id === state.activeWorkspaceId))
  return <SurfaceToolDock workspace={workspace} />
}
async function flush() { await act(async () => { await Promise.allSettled(inventoryRead.mock.results.map(item => item.value)) }) }
function row(zoneId: string) { return [...dom.container.querySelectorAll<HTMLButtonElement>('[data-zone-id]')].find(item => item.dataset.zoneId === zoneId)! }
beforeEach(() => {
  useAppStore.setState({ config: { ...composerConfig, workspaces: [folder, missing] }, activeWorkspaceId: folder.id,
    layouts: { [folder.id]: createWorkspaceLayout('folder-group'), [missing.id]: createWorkspaceLayout('missing-group') }, tabs: {},
    workspaceTool: 'files-branches', workspaceGitView: 'changes', workbenchSpaceSelection: null, spaceZoneBindings: {}, spatialRequests: {},
    scratchTopicSnapshots: {}, topicCategories: [], projectGroups: [], loading: false })
  inventoryRead = vi.spyOn(api.git, 'worktrees').mockImplementation(async input => ({ kind: 'ready', ...input.expectedResource, repoPath: folder.path, checkedAt: 1, warnings: [],
    worktrees: [{ path: folder.path, branch: 'main', kind: 'main', detached: false, aliases: [] }, { path: new URL("private/unbound", new URL('/', import.meta.url)).pathname, branch: null, kind: 'linked', detached: true, aliases: [] }],
    directories: [{ path: folder.path, kind: 'directory', canonicalPath: folder.path }, { path: missing.path, kind: 'missing' }, { path: new URL("private/unbound", new URL('/', import.meta.url)).pathname, kind: 'directory', canonicalPath: new URL("private/unbound", new URL('/', import.meta.url)).pathname }]
  } satisfies GitWorktreesResult))
  branchRead = vi.spyOn(api.workspaces, 'listBranches').mockResolvedValue({ kind: 'git-repository', hostId: folder.hostId, repoPath: folder.path,
    branches: [{ name: 'main', isCurrent: true, worktreePath: folder.path, workspaceId: folder.id }] })
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
  vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
})

it('follows actual Store focus into a missing Workspace without retargeting the Folder inventory or selected Changes scope', async () => {
  const before = useAppStore.getState(), drafts = before.agentComposerDrafts
  await dom.render(<AppSelectedWorkspace />); await flush()
  await act(async () => row(missingZone).click()); await flush()
  expect(useAppStore.getState().activeWorkspaceId).toBe(missing.id)
  expect(useAppStore.getState().workbenchSpaceSelection?.zoneId).toBe(missingZone)
  expect(row(workspaceZoneId(spaceId, folder.id)).textContent).toContain('Main worktree')
  expect(row(missingZone).parentElement?.textContent).toContain('Directory not found')
  expect(inventoryRead.mock.calls.every(([p]) => p.workspaceId === folder.id && p.expectedResource.hostId === folder.hostId && p.expectedResource.workspacePath === folder.path)).toBe(true)
  const selected = useAppStore.getState().workbenchSpaceSelection
  await dom.click('[aria-label="Manage worktrees"]'); await flush()
  expect(dom.container.querySelectorAll('[data-worktree-path]')).toHaveLength(2)
  expect(dom.container.textContent).toContain('Detached HEAD')
  expect(dom.container.querySelector('[data-git-workspace="scope-root"]:not([hidden])')).not.toBeNull()
  expect(branchRead).toHaveBeenCalledWith(folder.id)
  await act(async () => useAppStore.getState().setWorkspaceGitView('changes')); await flush()
  const active = [...dom.container.querySelectorAll<HTMLElement>('[data-git-workspace]')].filter(node => !node.closest('[hidden]'))
  expect(active.map(node => node.dataset.gitWorkspace)).toEqual([missing.id])
  expect(useAppStore.getState().workbenchSpaceSelection).toBe(selected)
  expect(useAppStore.getState().agentComposerDrafts).toBe(drafts)
  expect(useAppStore.getState().config).toBe(before.config)
})

it('retains original branch reads and refresh while an exact Folder inventory target is absent', async () => {
  useAppStore.setState(state => ({ config: { ...state.config!, workspaces: [missing] }, activeWorkspaceId: missing.id, workspaceTool: 'git', workspaceGitView: 'branches' }))
  await dom.render(<AppSelectedWorkspace />); await flush()
  expect(inventoryRead).not.toHaveBeenCalled()
  expect(branchRead).toHaveBeenCalledWith(missing.id)
  expect(dom.container.textContent).toContain('Folder repository for this Space is unconfirmed')
  const refresh = dom.container.querySelector<HTMLButtonElement>('[title="Refresh branches"]')!
  expect(refresh.disabled).toBe(false)
  const count = branchRead.mock.calls.length
  await act(async () => refresh.click())
  expect(branchRead.mock.calls.length).toBe(count + 1)
  expect(dom.container.querySelector('[data-branch-group="branches"] .branch-row__open')).not.toBeNull()
})

it('resolves only a unique exact Folder Host and Space identity, retaining unknown for foreign, duplicate and closed records', () => {
  expect(folderInventoryWorkspace(spaceId, [folder, missing])).toBe(folder)
  expect(folderInventoryWorkspace(spaceId, [missing])).toBeNull()
  expect(folderInventoryWorkspace(spaceId, [{ ...folder, hostId: 'foreign' }])).toBeNull()
  expect(folderInventoryWorkspace(spaceId, [folder, { ...folder, id: 'duplicate' }])).toBeNull()
  expect(folderInventoryWorkspace(spaceId, [{ ...folder, closeout: { targetWorkspaceId: folder.id, operationId: 'original-closeout', cleanup: 'pending', retention: 'uncommitted-changes', reason: 'Retained original work' } }])).toBeNull()
})
