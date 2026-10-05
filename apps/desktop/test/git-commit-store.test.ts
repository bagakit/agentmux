const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
import { collectSurfaceMemoryCandidates } from '../src/renderer/src/lib/surface-memory-budget-candidates'
// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core/control'
import type { AppConfig } from '../src/shared/contracts'
import type { GitCommitSnapshot, GitCommitDiffDescriptor } from '../src/shared/git-contracts'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { workbenchObjectLayout } from '../src/renderer/src/lib/desktop-focus-navigation'
import { projectPersistedWorkbench, restorePersistedWorkbench } from '../src/renderer/src/lib/workbench-persistence'

vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Local' }], executors: {},
  workspaces: [{ id: 'repo', name: 'Repository', hostId: 'local', path: _hygiene_fixturePath("repo"), kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
const snapshot: GitCommitSnapshot = { hostId: 'local', repoPath: _hygiene_fixturePath("repo"), commitOid: 'a'.repeat(40), parentOid: 'b'.repeat(40) }
const descriptor: GitCommitDiffDescriptor = { kind: 'commit', snapshot, file: { path: 'new.ts', origPath: 'old.ts' } }
const initial = useAppStore.getState()
const commitDiff = vi.fn(async () => ({ path: 'new.ts', old: { present: true, binary: false, text: 'fixed old' }, new: { present: true, binary: false, text: 'fixed new' }, binary: false, change: 'modified' }))
beforeEach(() => {
  localStorage.clear()
  Object.assign(window, { agentmux: { git: { commitDiff, branchDiff: vi.fn() } } })
  useAppStore.setState({ config, tabs: {}, layouts: { repo: createWorkspaceLayout('original-group', []) }, activeWorkspaceId: 'repo', editorRegionDiffs: {} })
  vi.spyOn(api.files, 'read'); vi.spyOn(api.files, 'observe'); vi.spyOn(api.files, 'write')
})
afterEach(() => { useAppStore.setState(initial, true); vi.restoreAllMocks(); commitDiff.mockClear() })

it('retains independent fixed commit regions, reuses the exact target and preserves other documents', () => {
  const file = createWorkbenchTab('original-file', { regionId: 'file-region', kind: 'file', workspaceId: 'repo', path: 'dirty.ts' })
  const documents = { 'repo\0dirty.ts': { path: 'dirty.ts', content: 'unsaved', revision: 'r1' } }
  useAppStore.setState({ tabs: { [file.id]: file }, layouts: { repo: createWorkspaceLayout('original-group', [file.id]) }, documents, dirtyDocuments: { 'repo\0dirty.ts': true } })
  useAppStore.getState().focusRegion('repo', file.id, 'file-region', 'navigation', 'original-group')
  expect(workbenchObjectLayout(useAppStore.getState(), 'repo').choice?.regionId).toBe('file-region')
  const first = useAppStore.getState().openGitWorkbench('repo', snapshot)
  expect(workbenchObjectLayout(useAppStore.getState(), 'repo').choice?.regionId).toBe(first.regionId)
  const next = { ...snapshot, commitOid: 'c'.repeat(40) }
  const second = useAppStore.getState().openGitWorkbench('repo', next)
  expect(workbenchObjectLayout(useAppStore.getState(), 'repo').choice?.regionId).toBe(second.regionId)
  expect(second).not.toEqual(first)
  expect(useAppStore.getState().openGitWorkbench('repo', snapshot)).toEqual(first)
  expect(Object.keys(useAppStore.getState().tabs)).toHaveLength(3)
  expect(useAppStore.getState().tabs[first.tabId]!.regions[first.regionId]).toMatchObject({ kind: 'git', selection: { commitOid: snapshot.commitOid, parentOid: snapshot.parentOid } })
  expect(useAppStore.getState().documents).toBe(documents)
  expect(useAppStore.getState().dirtyDocuments['repo\0dirty.ts']).toBe(true)
  expect(api.files.read).not.toHaveBeenCalled(); expect(api.files.observe).not.toHaveBeenCalled(); expect(api.files.write).not.toHaveBeenCalled()
})

it('round-trips the exact Git scope, selected merge parent and immutable diff in original Tab/Region/focus', () => {
  const selected = { ...snapshot, parentOid: 'd'.repeat(40) }
  const opened = useAppStore.getState().openGitWorkbench('repo', selected)
  useAppStore.getState().openBranchDiff('repo', descriptor)
  const source = useAppStore.getState()
  const persisted = JSON.parse(JSON.stringify(projectPersistedWorkbench(source)))
  const restored = restorePersistedWorkbench({ config, persisted, sessions: [], createTabGroupId: () => 'unexpected-group' })
  expect(restored.tabs).toEqual(source.tabs)
  expect(restored.layouts).toEqual(source.layouts)
  expect(restored.tabs[opened.tabId]!.regions[opened.regionId]).toMatchObject({ scope: { hostId: 'local', repoPath: _hygiene_fixturePath("repo") }, selection: { commitOid: selected.commitOid, parentOid: selected.parentOid } })
})

it('loads a fixed commit diff through the commit bridge without attaching a worktree document', async () => {
  const original = useAppStore.getState().openGitWorkbench('repo', snapshot)
  useAppStore.getState().openBranchDiff('repo', descriptor)
  const surface = Object.values(useAppStore.getState().tabs).flatMap(tab => Object.values(tab.regions)).find(region => region.kind === 'git-diff')!
  expect(workbenchObjectLayout(useAppStore.getState(), 'repo').choice?.regionId).toBe(surface.regionId)
  useAppStore.getState().focusRegion('repo', original.tabId, original.regionId, 'navigation', 'original-group')
  useAppStore.getState().openBranchDiff('repo', descriptor)
  expect(workbenchObjectLayout(useAppStore.getState(), 'repo').choice?.regionId).toBe(surface.regionId)
  await useAppStore.getState().loadBranchDiff(surface.regionId)
  expect(commitDiff).toHaveBeenCalledExactlyOnceWith('repo', descriptor)
  expect(window.agentmux!.git.branchDiff).not.toHaveBeenCalled()
  expect(useAppStore.getState().editorRegionDiffs[surface.regionId]?.diff?.old).toEqual({ present: true, binary: false, text: 'fixed old' })
  expect(api.files.read).not.toHaveBeenCalled(); expect(api.files.observe).not.toHaveBeenCalled(); expect(api.files.write).not.toHaveBeenCalled()
})

it('keeps an existing scope when a mismatched snapshot arrives and refuses an unrelated Host', () => {
  const opened = useAppStore.getState().openGitWorkbench('repo', snapshot)
  useAppStore.getState().selectGitCommit(opened.regionId, { ...snapshot, repoPath: _hygiene_fixturePath("other") })
  expect(useAppStore.getState().tabs[opened.tabId]!.regions[opened.regionId]).toMatchObject({ selection: { commitOid: snapshot.commitOid } })
  expect(() => useAppStore.getState().openGitWorkbench('repo', { ...snapshot, hostId: 'other' })).toThrow('original Git workspace')
  expect(Object.keys(useAppStore.getState().tabs)).toEqual([opened.tabId])
})

const request = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'exact-git-open', operation: 'open.git' as const,
  workspaceId: 'repo', expectedResource: { hostId: 'local', workspacePath: _hygiene_fixturePath("repo") }, oid: snapshot.commitOid }
it('rejects a wrong public resource before reading or changing the workface', async () => {
  const read = vi.fn(); Object.assign(window.agentmux!.git, { commitDetails: read })
  await expect(useAppStore.getState().executeControl({ ...request, expectedResource: { ...request.expectedResource, workspacePath: _hygiene_fixturePath("unrelated") } })).rejects.toThrow('resource changed')
  expect(read).not.toHaveBeenCalled(); expect(useAppStore.getState().tabs).toEqual({})
})

it('rejects a workspace rebound during public commit read without opening a stale page', async () => {
  let resolve!: (value: unknown) => void
  Object.assign(window.agentmux!.git, { commitDetails: vi.fn(() => new Promise(done => { resolve = done })) })
  const opened = useAppStore.getState().executeControl(request)
  const rejected = expect(opened).rejects.toThrow('resource changed while reading')
  useAppStore.setState({ config: { ...config, workspaces: [{ ...config.workspaces[0]!, path: _hygiene_fixturePath("other") }] } })
  resolve({ kind: 'ready', snapshot })
  await rejected; expect(useAppStore.getState().tabs).toEqual({})
})

it('opens repository history separately and keeps its exact selected file through persistence', () => {
  const commit = useAppStore.getState().openGitWorkbench('repo', snapshot)
  const repository = useAppStore.getState().openGitHistory('repo', snapshot, 'refs/heads/topic', snapshot)
  expect(repository.regionId).not.toBe(commit.regionId)
  expect(useAppStore.getState().openGitHistory('repo', snapshot)).toEqual(repository)
  useAppStore.getState().selectGitFile(repository.regionId, descriptor.file)
  const source = useAppStore.getState(), persisted = JSON.parse(JSON.stringify(projectPersistedWorkbench(source)))
  const restored = restorePersistedWorkbench({ config, persisted, sessions: [], createTabGroupId: () => 'unexpected' })
  expect(restored.tabs[repository.tabId]!.regions[repository.regionId]).toMatchObject({ history: { reference: 'refs/heads/topic' }, file: descriptor.file, selection: { commitOid: snapshot.commitOid, parentOid: snapshot.parentOid } })
  expect(restored.layouts).toEqual(source.layouts)
  useAppStore.getState().showGitCommitDetails(repository.regionId)
  expect(useAppStore.getState().tabs[repository.tabId]!.regions[repository.regionId]).not.toHaveProperty('history')
})
it('invalidates an inline file response when another fixed file replaces it', async () => {
  const opened = useAppStore.getState().openGitWorkbench('repo', snapshot)
  let finish!: (value: any) => void
  commitDiff.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  useAppStore.getState().selectGitFile(opened.regionId, descriptor.file)
  const pending = useAppStore.getState().loadBranchDiff(opened.regionId)
  useAppStore.getState().selectGitFile(opened.regionId, { path: 'other.ts', origPath: null })
  finish({ path: 'new.ts', old: { present: false }, new: { present: true, binary: false, text: 'late wrong file' }, binary: false, change: 'added' })
  await pending
  expect(useAppStore.getState().editorRegionDiffs[opened.regionId]).toBeUndefined()
  await useAppStore.getState().loadBranchDiff(opened.regionId)
  expect(commitDiff).toHaveBeenLastCalledWith('repo', { kind: 'commit', snapshot, file: { path: 'other.ts', origPath: null } })
  useAppStore.getState().releaseBranchDiff(opened.regionId)
  expect(useAppStore.getState().editorRegionDiffs[opened.regionId]).toBeUndefined()
  expect(useAppStore.getState().tabs[opened.tabId]!.regions[opened.regionId]).toMatchObject({ file: { path: 'other.ts' } })
})
it('opens repository history through the original control owner without inventing a commit snapshot', async () => {
  const history = vi.fn(async () => ({ kind: 'ready', snapshot: { hostId: 'local', repoPath: _hygiene_fixturePath("repo"), selectedRef: null, roots: [], refs: [], checkedAt: 1 }, commits: [], nextCursor: null }))
  Object.assign(window.agentmux!.git, { history })
  const { oid: _oid, ...browse } = request
  const opened = await useAppStore.getState().executeControl(browse)
  expect(opened).toMatchObject({ operation: 'open.git', read: { kind: 'ready', snapshot: { hostId: 'local', repoPath: _hygiene_fixturePath("repo") } } })
  expect(opened).not.toHaveProperty('read.snapshot.commitOid')
  expect(history).toHaveBeenCalledExactlyOnceWith('repo', { limit: 1 })
  const surface = Object.values(useAppStore.getState().tabs).flatMap(tab => Object.values(tab.regions)).find(item => item.kind === 'git')!
  expect(surface).toMatchObject({ history: { reference: null }, selection: null })
})

it('preserves the same fixed file on reopen and invalidates it when locating another commit', async () => {
  const fixed = useAppStore.getState().openGitWorkbench('repo', snapshot)
  useAppStore.getState().selectGitFile(fixed.regionId, descriptor.file)
  expect(useAppStore.getState().openGitWorkbench('repo', snapshot)).toEqual(fixed)
  expect(useAppStore.getState().tabs[fixed.tabId]!.regions[fixed.regionId]).toMatchObject({ file: descriptor.file })
  const repository = useAppStore.getState().openGitHistory('repo', snapshot, null, snapshot)
  useAppStore.getState().selectGitFile(repository.regionId, descriptor.file)
  let finish!: (value: any) => void
  commitDiff.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const pending = useAppStore.getState().loadBranchDiff(repository.regionId)
  const target = { ...snapshot, commitOid: 'd'.repeat(40) }
  expect(useAppStore.getState().openGitHistory('repo', snapshot, undefined, target)).toEqual(repository)
  finish({ path: 'new.ts', old: { present: false }, new: { present: true, binary: false, text: 'old selection' }, binary: false, change: 'added' })
  await pending
  expect(useAppStore.getState().editorRegionDiffs[repository.regionId]).toBeUndefined()
  expect(useAppStore.getState().tabs[repository.tabId]!.regions[repository.regionId]).not.toHaveProperty('file')
})

it('counts only an open inline diff as a rebuildable Monaco budget resource', () => {
  const opened = useAppStore.getState().openGitWorkbench('repo', snapshot)
  const collect = () => collectSurfaceMemoryCandidates({ ...useAppStore.getState(), documents: {}, dirtyDocuments: {}, savingDocuments: {}, workbenchVisible: true })
  expect(collect()).toEqual([])
  useAppStore.getState().selectGitFile(opened.regionId, descriptor.file)
  expect(collect()).toEqual([expect.objectContaining({ id: opened.regionId, kind: 'monaco', canRebuild: true, visible: true })])
  useAppStore.getState().selectGitFile(opened.regionId, null)
  expect(collect()).toEqual([])
})
