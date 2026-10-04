const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
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

it('reuses the original Git region while changing selection and preserves other documents', () => {
  const file = createWorkbenchTab('original-file', { regionId: 'file-region', kind: 'file', workspaceId: 'repo', path: 'dirty.ts' })
  const documents = { 'repo\0dirty.ts': { path: 'dirty.ts', content: 'unsaved', revision: 'r1' } }
  useAppStore.setState({ tabs: { [file.id]: file }, layouts: { repo: createWorkspaceLayout('original-group', [file.id]) }, documents, dirtyDocuments: { 'repo\0dirty.ts': true } })
  useAppStore.getState().focusRegion('repo', file.id, 'file-region', 'navigation', 'original-group')
  expect(workbenchObjectLayout(useAppStore.getState(), 'repo').choice?.regionId).toBe('file-region')
  const first = useAppStore.getState().openGitWorkbench('repo', snapshot)
  expect(workbenchObjectLayout(useAppStore.getState(), 'repo').choice?.regionId).toBe(first.regionId)
  const next = { ...snapshot, commitOid: 'c'.repeat(40) }
  const second = useAppStore.getState().openGitWorkbench('repo', next)
  expect(workbenchObjectLayout(useAppStore.getState(), 'repo').choice?.regionId).toBe(first.regionId)
  expect(second).toEqual(first)
  expect(Object.keys(useAppStore.getState().tabs)).toHaveLength(2)
  expect(useAppStore.getState().tabs[first.tabId]!.regions[first.regionId]).toMatchObject({ kind: 'git', selection: { commitOid: next.commitOid, parentOid: next.parentOid } })
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
