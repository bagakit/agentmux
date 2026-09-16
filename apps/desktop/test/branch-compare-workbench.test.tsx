// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AppConfig, SessionSnapshot, WorkspaceRecord } from '../src/shared/contracts'
import type { GitBranchCompareInput, GitBranchComparisonResult, GitBranchDiffDescriptor, GitFileDiff } from '../src/shared/git-contracts'

vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
// The unrelated Launcher terminal preview needs a browser canvas; it is outside this Git fixture.
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
vi.mock('../src/renderer/src/monaco', () => ({}))
vi.mock('@monaco-editor/react', () => ({
  default: () => <div data-monaco-edit="true" />,
  DiffEditor: ({ original, modified, options }: { original: string; modified: string; options: { readOnly: boolean } }) => (
    <div data-monaco-diff="true" data-read-only={String(options.readOnly)}><pre data-side="old">{original}</pre><pre data-side="new">{modified}</pre></div>
  )
}))

import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { BranchesPanel } from '../src/renderer/src/components/BranchesPanel'
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'
import { gitDiffIdentity, initialWorkbenchRegionId, fileTabId, createWorkbenchTab, addWorkbenchRegion, type GitDiffWorkbenchSurface } from '../src/renderer/src/lib/workbench-tabs'
import { restorePersistedWorkbench } from '../src/renderer/src/lib/workbench-persistence'
import { regionDiffRequestIds } from '../src/renderer/src/lib/file-document-bookkeeping'
import { inspectWorkbenchControlTab, messageTargetCandidates } from '../src/renderer/src/lib/control'
import { collectSurfaceMemoryCandidates } from '../src/renderer/src/lib/surface-memory-budget-candidates'

const workspace: WorkspaceRecord = { id: 'compare-workspace', name: 'Private comparison', hostId: 'local', path: '/private/compare', kind: 'folder' }
const config: AppConfig = {
  version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private host' }], executors: {}, workspaces: [workspace],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
}
const branches = [
  { name: 'base/lane', worktreePath: null, workspaceId: null, isCurrent: false },
  { name: 'feature/lane', worktreePath: null, workspaceId: null, isCurrent: false },
  { name: 'third-current', worktreePath: workspace.path, workspaceId: workspace.id, isCurrent: true }
]
function ready(targetOid = 'b'.repeat(40)): Extract<GitBranchComparisonResult, { kind: 'ready' }> {
  return { kind: 'ready', snapshot: {
    hostId: 'local', repoPath: '/private/compare', mode: 'merge-base', baseBranch: 'base/lane', targetBranch: 'feature/lane',
    baseOid: 'a'.repeat(40), targetOid, comparisonBaseOid: 'c'.repeat(40)
  }, entries: [
    { path: 'deleted.txt', origPath: null, change: 'deleted' },
    { path: 'new/name.ts', origPath: 'old/name.ts', change: 'renamed' }
  ], warnings: [] }
}
function descriptor(result = ready(), index = 0): GitBranchDiffDescriptor {
  const file = result.entries[index]!
  return { snapshot: result.snapshot, file: { path: file.path, origPath: file.origPath } }
}
function diff(text = 'fixed base body'): GitFileDiff {
  return { path: 'deleted.txt', old: { present: true, binary: false, text }, new: { present: false }, binary: false, change: 'deleted' }
}
const compareBranches = vi.fn<(workspaceId: string, input: GitBranchCompareInput) => Promise<GitBranchComparisonResult>>()
const branchDiff = vi.fn<(workspaceId: string, descriptor: GitBranchDiffDescriptor) => Promise<GitFileDiff>>()
const fileDiff = vi.fn<(workspaceId: string, path: string) => Promise<GitFileDiff>>()
let mounted: { root: Root; element: HTMLDivElement } | undefined
let dispose: (() => void) | undefined

async function settle() { await act(async () => { await new Promise<void>(done => setTimeout(done, 0)) }) }
async function mount(withWorkbench = true) {
  const element = document.createElement('div'); document.body.append(element)
  const root = createRoot(element); mounted = { root, element }
  await act(async () => { root.render(<><BranchesPanel workspace={workspace} />{withWorkbench ? <WorkspaceWorkbench workspaceId={workspace.id} /> : null}</>) })
  await vi.waitFor(() => expect(element.querySelector('[aria-label="Compare two local branches"]')).not.toBeNull())
  return element
}
async function click(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.getAttribute('aria-label') === label || item.textContent?.trim() === label)
  expect(button, `Actual button ${label}`).toBeDefined()
  await act(async () => button!.click()); await settle()
}
async function select(label: string, value: string) {
  const element = document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)
  expect(element).not.toBeNull()
  await act(async () => { element!.value = value; element!.dispatchEvent(new Event('change', { bubbles: true })) })
}
async function begin() {
  await click('Compare two local branches')
  await select('Base branch A', 'base/lane')
  await select('Target branch B', 'feature/lane')
  await click('Compare branches')
}
function owner(comparison: GitBranchDiffDescriptor) {
  const matches = Object.values(useAppStore.getState().tabs).flatMap(tab => Object.values(tab.regions).flatMap(surface => (
    surface.kind === 'git-diff' && gitDiffIdentity(surface.workspaceId, surface.comparison) === gitDiffIdentity(workspace.id, comparison)
      ? [{ tab, surface }] : []
  )))
  expect(matches).toHaveLength(1)
  return { id: matches[0]!.tab.id, regionId: matches[0]!.surface.regionId }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

beforeEach(async () => {
  localStorage.clear()
  compareBranches.mockReset().mockResolvedValue(ready())
  branchDiff.mockReset().mockResolvedValue(diff())
  fileDiff.mockReset().mockResolvedValue(diff())
  Object.assign(window, { agentmux: { git: { compareBranches, branchDiff, diff: fileDiff, aheadBehind: vi.fn(async () => null) } } })
  vi.spyOn(api.config, 'get').mockResolvedValue(config)
  vi.spyOn(api.providers, 'list').mockResolvedValue([])
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [], timelines: {}, recoveryCandidates: [] })
  vi.spyOn(api.sessions, 'onEvent').mockReturnValue(() => {})
  vi.spyOn(api.workspaces, 'listBranches').mockResolvedValue({ kind: 'git-repository', hostId: 'local', repoPath: '/private/compare', branches })
  vi.spyOn(api.files, 'read').mockRejectedValue(new Error('A commit diff must not read the worktree'))
  vi.spyOn(api.files, 'observe').mockRejectedValue(new Error('A commit diff must not watch a document'))
  vi.spyOn(api.files, 'write').mockRejectedValue(new Error('A commit diff must not save a document'))
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
  useAppStore.setState({ tabs: {}, layouts: {}, restoredWorkbench: null, documents: {}, dirtyDocuments: {}, editorRegionDiffs: {}, editorRegionModes: {}, activeWorkspaceId: workspace.id })
  dispose = await useAppStore.getState().initialize()
  expect(useAppStore.getState().loading).toBe(false)
  useAppStore.setState({ tabs: {}, layouts: { [workspace.id]: createWorkspaceLayout('group', []) } })
})
afterEach(async () => {
  if (mounted) { await act(async () => mounted!.root.unmount()); mounted.element.remove(); mounted = undefined }
  dispose?.(); dispose = undefined
  vi.restoreAllMocks()
})

it('clicks actual branch selectors and opens a deleted commit file through Store, bridge and the readonly shared canvas', async () => {
  const element = await mount()
  await begin()
  expect(compareBranches).toHaveBeenCalledExactlyOnceWith(workspace.id, { baseBranch: 'base/lane', targetBranch: 'feature/lane', mode: 'merge-base' })
  expect([...element.querySelectorAll('.branch-comparison__file')].map(item => item.textContent)).toEqual(['deleted.txtdeleted', 'old/name.ts → new/name.tsrenamed'])
  await click('deleted.txtdeleted')
  await vi.waitFor(() => expect(element.querySelector('[data-monaco-diff]')).not.toBeNull())
  expect(branchDiff).toHaveBeenCalledExactlyOnceWith(workspace.id, descriptor())
  expect(element.querySelector('[data-monaco-diff]')?.getAttribute('data-read-only')).toBe('true')
  expect(element.querySelector('[data-side="old"]')?.textContent).toBe('fixed base body')
  expect(element.querySelector('[data-side="new"]')?.textContent).toBe('')
  expect(element.querySelector('[data-monaco-edit]')).toBeNull()
  expect(element.querySelector('[aria-label="Fixed comparison commits"]')?.textContent).toContain('cccccccc')
  expect(element.querySelector('[aria-label="Fixed comparison commits"]')?.textContent).toContain('bbbbbbbb')
  expect(api.files.read).not.toHaveBeenCalled(); expect(api.files.observe).not.toHaveBeenCalled(); expect(api.files.write).not.toHaveBeenCalled()
  expect(regionDiffRequestIds.size).toBe(0)
  await click('Reload')
  expect(branchDiff.mock.calls).toEqual([[workspace.id, descriptor()], [workspace.id, descriptor()]])
})

it('uses the explicit two-point mode and opens different fixed snapshots independently of an ordinary dirty file', async () => {
  const path = 'deleted.txt', fileId = fileTabId(workspace.id, path), regionId = initialWorkbenchRegionId(fileId)
  const document = { path, content: 'unsaved current buffer', revision: 'dirty-revision' }
  useAppStore.setState({ documents: { [`${workspace.id}\0${path}`]: document }, dirtyDocuments: { [`${workspace.id}\0${path}`]: true },
    tabs: { [fileId]: createWorkbenchTab(fileId, { kind: 'file', regionId, workspaceId: workspace.id, path }) },
    layouts: { [workspace.id]: createWorkspaceLayout('group', [fileId]) } })
  await mount(false)
  await click('Compare two local branches'); await select('Base branch A', 'base/lane'); await select('Target branch B', 'feature/lane'); await select('Comparison mode', 'two-point')
  const first = ready(); first.snapshot.mode = 'two-point'; first.snapshot.comparisonBaseOid = first.snapshot.baseOid
  compareBranches.mockResolvedValueOnce(first)
  await click('Compare branches'); await click('deleted.txtdeleted')
  expect(compareBranches).toHaveBeenLastCalledWith(workspace.id, { baseBranch: 'base/lane', targetBranch: 'feature/lane', mode: 'two-point' })
  const second = ready('d'.repeat(40)); second.snapshot.mode = 'two-point'; second.snapshot.comparisonBaseOid = second.snapshot.baseOid
  compareBranches.mockResolvedValueOnce(second)
  await click('Refresh comparison'); await click('deleted.txtdeleted')
  const state = useAppStore.getState()
  expect(Object.keys(state.tabs)).toEqual([fileId, owner(descriptor(first)).id, owner(descriptor(second)).id])
  expect(state.documents[`${workspace.id}\0${path}`]).toBe(document)
  expect(state.dirtyDocuments).toEqual({ [`${workspace.id}\0${path}`]: true })
  expect(api.files.read).not.toHaveBeenCalled(); expect(api.files.observe).not.toHaveBeenCalled(); expect(api.files.write).not.toHaveBeenCalled()
})

it('does not let a late comparison replace the newer selection and fixed result', async () => {
  await mount(false); await click('Compare two local branches'); await select('Base branch A', 'base/lane'); await select('Target branch B', 'feature/lane')
  const old = deferred<ReturnType<typeof ready>>(); compareBranches.mockReturnValueOnce(old.promise)
  await click('Compare branches')
  await select('Comparison mode', 'two-point')
  const latest = ready('d'.repeat(40)); latest.snapshot.mode = 'two-point'; latest.snapshot.comparisonBaseOid = latest.snapshot.baseOid
  compareBranches.mockResolvedValueOnce(latest); await click('Compare branches')
  await act(async () => old.resolve(ready()))
  expect(document.querySelector('.branch-comparison__summary')?.textContent).toContain('dddddddd')
  await click('deleted.txtdeleted')
  expect(Object.keys(useAppStore.getState().tabs)).toEqual([owner(descriptor(latest)).id])
})

it('keeps the last successful result beside a real error and never presents a failed comparison as zero changes', async () => {
  await mount(false); await begin()
  compareBranches.mockRejectedValueOnce(new Error('Private read limit exceeded'))
  await click('Refresh comparison')
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('Private read limit exceeded')
  expect([...document.querySelectorAll('.branch-comparison__file')].map(item => item.textContent)).toEqual(['deleted.txtdeleted', 'old/name.ts → new/name.tsrenamed'])
  expect(document.body.textContent).not.toContain('No changed files')
  Object.assign(window, { agentmux: undefined })
  await click('Refresh comparison')
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('Git is unavailable in this build.')
})

it('shows genuine ready empty, not-repository and real Git warning outcomes explicitly', async () => {
  await mount(false)
  const zero = ready(); zero.entries = []; zero.warnings = ['Private rename detection warning']
  compareBranches.mockResolvedValueOnce(zero); await begin()
  expect(document.body.textContent).toContain('No changed files between these commits.')
  expect(document.querySelector('[role="status"]')?.textContent).toBe('Private rename detection warning')
  expect(Object.keys(useAppStore.getState().tabs)).toEqual([])
  compareBranches.mockResolvedValueOnce({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: workspace.path })
  await click('Refresh comparison')
  expect(document.querySelector('.branch-comparison')?.textContent).toContain('Not a Git repository.')
  expect(document.querySelector('.branch-comparison__summary')).toBeNull()
})

it('serializes only the durable descriptor and restores the same fixed commits and focus without disk documents', async () => {
  const comparison = descriptor()
  useAppStore.getState().openBranchDiff(workspace.id, comparison)
  const { id, regionId } = owner(comparison)
  await useAppStore.getState().loadBranchDiff(regionId)
  const state = useAppStore.getState(), partialize = useAppStore.persist.getOptions().partialize!
  const persisted = JSON.parse(JSON.stringify(partialize(state)))
  expect(Object.keys(persisted.restoredWorkbench.tabs)).toEqual([id])
  expect(persisted.restoredWorkbench.tabs[id].regions[regionId]).toEqual({ kind: 'git-diff', regionId, workspaceId: workspace.id, comparison })
  expect(JSON.stringify(persisted)).not.toContain('fixed base body')
  expect(persisted.editorRegionDiffs).toBeUndefined()
  const restored = restorePersistedWorkbench({ config, sessions: [], persisted: persisted.restoredWorkbench, createTabGroupId: () => "restored-group" })
  expect(restored.tabs[id]?.regions[regionId]).toEqual({ kind: 'git-diff', regionId, workspaceId: workspace.id, comparison })
  expect(restored.layouts).toEqual(state.layouts)
  useAppStore.setState({ tabs: restored.tabs, layouts: restored.layouts, documents: {}, editorRegionDiffs: {} })
  const element = await mount()
  await vi.waitFor(() => expect(element.querySelector('[data-monaco-diff]')).not.toBeNull())
  expect(branchDiff.mock.calls).toEqual([[workspace.id, comparison], [workspace.id, comparison]])
  expect(api.files.read).not.toHaveBeenCalled(); expect(api.files.observe).not.toHaveBeenCalled()
})

it('discards a late blob after its actual Region closes instead of recreating orphan transient state', async () => {
  const comparison = descriptor()
  useAppStore.getState().openBranchDiff(workspace.id, comparison)
  const { id, regionId } = owner(comparison)
  const pending = deferred<GitFileDiff>(); branchDiff.mockReturnValueOnce(pending.promise)
  const read = useAppStore.getState().loadBranchDiff(regionId)
  expect(useAppStore.getState().editorRegionDiffs[regionId]?.loading).toBe(true)
  await useAppStore.getState().closeTab(workspace.id, 'group', id)
  expect(Object.keys(useAppStore.getState().tabs)).toEqual([])
  pending.resolve(diff('obsolete blob')); await read
  expect(useAppStore.getState().editorRegionDiffs[regionId]).toBeUndefined()
})

it('rejects an older blob reload and retains the last good readonly content beside reload failure', async () => {
  const comparison = descriptor()
  useAppStore.getState().openBranchDiff(workspace.id, comparison)
  const { id, regionId } = owner(comparison)
  await useAppStore.getState().loadBranchDiff(regionId)
  const old = deferred<GitFileDiff>(); branchDiff.mockReturnValueOnce(old.promise)
  const firstRead = useAppStore.getState().loadBranchDiff(regionId)
  branchDiff.mockResolvedValueOnce(diff('newer blob'))
  await useAppStore.getState().loadBranchDiff(regionId)
  old.resolve(diff('older blob')); await firstRead
  expect(useAppStore.getState().editorRegionDiffs[regionId]?.diff?.old).toEqual({ present: true, binary: false, text: 'newer blob' })
  branchDiff.mockRejectedValueOnce(new Error('Private object read failed'))
  await useAppStore.getState().loadBranchDiff(regionId)
  const element = await mount()
  await vi.waitFor(() => expect(element.querySelector('[data-monaco-diff]')).not.toBeNull())
  expect(element.querySelector('[role="alert"]')?.textContent).toBe('Private object read failed')
  expect(element.querySelector('[data-side="old"]')?.textContent).toBe('newer blob')
})

it('shows a binary-or-too-large reason without pretending there is an empty textual diff', async () => {
  branchDiff.mockResolvedValueOnce({ path: 'deleted.txt', old: { present: true, binary: true }, new: { present: false }, binary: true, change: 'deleted' })
  const element = await mount(); await begin(); await click('deleted.txtdeleted')
  await vi.waitFor(() => expect(element.textContent).toContain('Binary file or too large for textual diff.'))
  expect(element.querySelector('[data-monaco-diff]')).toBeNull()
  expect(element.querySelector('[data-monaco-edit]')).toBeNull()
})

it('admits a readonly diff to the existing Monaco budget without a file-document owner', () => {
  const comparison = descriptor()
  useAppStore.getState().openBranchDiff(workspace.id, comparison)
  const { id, regionId } = owner(comparison)
  const state = useAppStore.getState()
  const candidates = collectSurfaceMemoryCandidates({ ...state, workbenchVisible: true })
  expect(candidates).toEqual([expect.objectContaining({ id: regionId, kind: 'monaco', ownerPresent: true, canRebuild: true, protected: false })])
  const surface = Object.values(state.tabs[id]!.regions)[0] as GitDiffWorkbenchSurface
  expect(surface.comparison).toBe(comparison)
})


it('uses bounded opaque Control addresses for long legal paths while repeated fixed-snapshot opens reuse one Tab', () => {
  const comparison = descriptor()
  comparison.snapshot.repoPath = '/' + ['a'.repeat(200), 'b'.repeat(200), 'c'.repeat(200)].join('/')
  comparison.file.path = ['d'.repeat(200), 'e'.repeat(200), 'file.txt'].join('/')
  useAppStore.getState().openBranchDiff(workspace.id, comparison)
  const first = owner(comparison)
  useAppStore.getState().openBranchDiff(workspace.id, JSON.parse(JSON.stringify(comparison)))
  const state = useAppStore.getState()
  expect(Object.keys(state.tabs)).toEqual([first.id])
  expect(Object.keys(state.tabs[first.id]!.regions)).toEqual([first.regionId])
  expect(new TextEncoder().encode(first.id).length).toBeLessThanOrEqual(512)
  expect(new TextEncoder().encode(first.regionId).length).toBeLessThanOrEqual(512)
  expect(inspectWorkbenchControlTab(state, state.tabs[first.id]!)).toMatchObject({
    tabId: first.id, regions: [{ kind: 'view', tabId: first.id, regionId: first.regionId, workspaceId: workspace.id }]
  })
})

it('keeps a newer pending read token when an older request reaches finally, then accepts the newer blob', async () => {
  const comparison = descriptor()
  useAppStore.getState().openBranchDiff(workspace.id, comparison)
  const { regionId } = owner(comparison)
  const old = deferred<GitFileDiff>(), latest = deferred<GitFileDiff>()
  branchDiff.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise)
  const olderRead = useAppStore.getState().loadBranchDiff(regionId)
  const newerRead = useAppStore.getState().loadBranchDiff(regionId)
  old.resolve(diff('older read')); await olderRead
  expect(regionDiffRequestIds.has(regionId)).toBe(true)
  expect(useAppStore.getState().editorRegionDiffs[regionId]?.loading).toBe(true)
  latest.resolve(diff('newest read')); await newerRead
  expect(useAppStore.getState().editorRegionDiffs[regionId]?.diff?.old).toEqual({ present: true, binary: false, text: 'newest read' })
  expect(regionDiffRequestIds.has(regionId)).toBe(false)
})

it('does not accept an old file diff after close and the same deterministic file Region reopens', async () => {
  const path = 'same-file.txt', id = fileTabId(workspace.id, path), regionId = initialWorkbenchRegionId(id)
  vi.mocked(api.files.observe).mockResolvedValue(undefined)
  vi.mocked(api.files.read).mockResolvedValue({ status: 'read', document: { path, content: 'worktree fixture', revision: 'r1' } })
  await useAppStore.getState().openFile(path, undefined, undefined, workspace.id)
  expect(Object.keys(useAppStore.getState().tabs)).toEqual([id])
  const old = deferred<GitFileDiff>(), latest = deferred<GitFileDiff>()
  fileDiff.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise)
  const oldRead = useAppStore.getState().setEditorRegionMode(regionId, workspace.id, path, 'diff')
  await useAppStore.getState().closeTab(workspace.id, 'group', id)
  expect(regionDiffRequestIds.has(regionId)).toBe(false)
  await useAppStore.getState().openFile(path, undefined, undefined, workspace.id)
  expect(Object.keys(useAppStore.getState().tabs)).toEqual([id])
  const newRead = useAppStore.getState().setEditorRegionMode(regionId, workspace.id, path, 'diff')
  old.resolve(diff('old lifecycle')); await oldRead
  expect(regionDiffRequestIds.has(regionId)).toBe(true)
  expect(useAppStore.getState().editorRegionDiffs[regionId]?.loading).toBe(true)
  latest.resolve(diff('new lifecycle')); await newRead
  expect(useAppStore.getState().editorRegionDiffs[regionId]?.diff?.old).toEqual({ present: true, binary: false, text: 'new lifecycle' })
  expect(fileDiff.mock.calls).toEqual([[workspace.id, path], [workspace.id, path]])
  expect(regionDiffRequestIds.has(regionId)).toBe(false)
})

it('projects a mixed comparison and healthy Agent Tab while keeping the real Agent as its sole message candidate', () => {
  const comparison = descriptor()
  useAppStore.getState().openBranchDiff(workspace.id, comparison)
  const { id, regionId } = owner(comparison)
  const session: SessionSnapshot = {
    id: 'known-agent', kind: 'agent', providerId: 'codex', executorId: 'private', hostId: 'local', workspacePath: workspace.path,
    label: 'Known healthy Agent', createdAt: 1, updatedAt: 1, processState: 'running', latestOutputBytes: 0,
    status: { state: 'working', source: 'native-hook', observedAt: 1 },
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'respond', providerResume: true, replyCorrelation: 'none' },
    control: { kind: 'agent', hostId: 'local', agentSessionId: 'known-agent', run: { runId: 'known-run' } }
  }
  const tab = addWorkbenchRegion(useAppStore.getState().tabs[id]!, regionId, 'right', {
    kind: 'agent', phase: 'attached', regionId: 'known-agent-region', workspaceId: workspace.id, sessionId: session.id
  })
  useAppStore.setState({ tabs: { [id]: tab }, sessions: [session] })
  const state = useAppStore.getState(), inspected = inspectWorkbenchControlTab(state, tab)
  expect(inspected.regions.map(region => [region.kind, region.regionId])).toEqual([['view', regionId], ['agent', 'known-agent-region']])
  expect(messageTargetCandidates(state, id)).toEqual([{ agentSessionId: session.id, regionIds: ['known-agent-region'] }])
  expect(state.sessions).toEqual([session])
})
