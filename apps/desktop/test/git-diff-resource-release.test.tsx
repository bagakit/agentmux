const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import type { AppConfig } from '../src/shared/contracts'
import type { GitCommitDiffDescriptor, GitDiffDescriptor, GitFileDiff } from '../src/shared/git-contracts'

vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
// The unrelated dirty editor is retained as Store data; this task mounts the real fixed-Diff owner.
vi.mock('../src/renderer/src/components/EditorPane', () => ({ EditorPane: () => null }))
vi.mock('../src/renderer/src/monaco', () => ({}))
vi.mock('monaco-editor', () => ({
  Uri: { parse: (value: string) => value },
  editor: {
    createModel: (text: string, language: string) => ({ getValue: () => text, setValue: (value: string) => { text = value }, getLanguageId: () => language, dispose() {} }),
    setModelLanguage() {}, setTheme() {},
    createDiffEditor: (host: HTMLElement) => ({
      createViewModel: (pair: any) => ({ ...pair, dispose() {} }),
      setModel: (pair: any) => { host.textContent = pair ? pair.original.getValue() + '|' + pair.modified.getValue() : '' },
      updateOptions() {}, dispose() {}
    })
  }
}))

import { useAppStore } from '../src/renderer/src/store'
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { collectSurfaceMemoryCandidates } from '../src/renderer/src/lib/surface-memory-budget-candidates'
import { selectSurfaceMemoryReleases } from '../src/renderer/src/lib/surface-memory-budget'
import { SurfaceMemoryBudgetProvider } from '../src/renderer/src/lib/surface-memory-budget-coordinator'

const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Local' }], executors: {},
  workspaces: [{ id: 'repo', name: 'Repository', hostId: 'local', path: _hygiene_fixturePath("repo"), kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
const descriptor: GitCommitDiffDescriptor = { kind: 'commit', snapshot: { hostId: 'local', repoPath: _hygiene_fixturePath("repo"), commitOid: 'a'.repeat(40), parentOid: 'b'.repeat(40) }, file: { path: 'fixed.ts', origPath: null } }
const fixed: GitFileDiff = { path: 'fixed.ts', old: { present: true, binary: false, text: 'fixed old' }, new: { present: true, binary: false, text: 'fixed new' }, binary: false, change: 'modified' }
const commitDiff = vi.fn<(...args: unknown[]) => Promise<GitFileDiff>>()
const branchDiff = vi.fn<(...args: unknown[]) => Promise<GitFileDiff>>()
const initial = useAppStore.getState()
let root: ReturnType<typeof createRoot> | undefined, element: HTMLDivElement
let target: { tabId: string; regionId: string }, other: { tabId: string; regionId: string }

function newestDiff(path: string) {
  const tab = Object.values(useAppStore.getState().tabs).find(tab => Object.values(tab.regions).some(surface => surface.kind === 'git-diff' && surface.comparison.file.path === path))!
  return { tabId: tab.id, regionId: tab.layout.activeRegionId }
}
async function render(released = new Set<string>()) {
  if (!root) { element = document.createElement('div'); document.body.append(element); root = createRoot(element) }
  await act(async () => root!.render(<SurfaceMemoryBudgetProvider state={{ monacoRegionIds: released, browserRegionIds: new Set() }}><WorkspaceWorkbench workspaceId="repo" /></SurfaceMemoryBudgetProvider>))
}
async function hideAndRelease() {
  await act(async () => useAppStore.getState().focusRegion('repo', other.tabId, other.regionId, 'navigation', 'group'))
  const state = useAppStore.getState()
  const candidates = collectSurfaceMemoryCandidates({ ...state, workbenchVisible: true }).map(candidate => ({ ...candidate, hiddenSinceMs: candidate.visible ? null : 0 }))
  const released = selectSurfaceMemoryReleases(candidates, { nowMs: 300_000 })
  expect(released.has(target.regionId)).toBe(true)
  expect(released.has(other.regionId)).toBe(false)
  await render(released)
}
beforeAll(async () => { await import('../src/renderer/src/features/git/diff/GitBranchDiffPane') })
beforeEach(() => {
  localStorage.clear(); commitDiff.mockReset().mockResolvedValue(fixed); branchDiff.mockReset().mockResolvedValue(fixed)
  Object.assign(window, { agentmux: { git: { commitDiff, branchDiff } } })
  useAppStore.setState({ config, loading: false, tabs: {}, layouts: { repo: createWorkspaceLayout('group', []) }, activeWorkspaceId: 'repo', editorRegionDiffs: {} })
  useAppStore.getState().openBranchDiff('repo', descriptor); target = newestDiff('fixed.ts')
  useAppStore.getState().openBranchDiff('repo', { ...descriptor, file: { path: 'other.ts', origPath: null } }); other = newestDiff('other.ts')
  const dirty = createWorkbenchTab('dirty-tab', { kind: 'file', regionId: 'dirty-file', workspaceId: 'repo', path: 'dirty.ts' })
  useAppStore.setState(state => ({ tabs: { ...state.tabs, [dirty.id]: dirty },
    documents: { 'repo\0dirty.ts': { path: 'dirty.ts', content: 'unsaved text', revision: 'r1' } }, dirtyDocuments: { 'repo\0dirty.ts': true },
    editorRegionDiffs: { [other.regionId]: { loading: false, diff: fixed, error: null }, 'dirty-file': { loading: false, diff: fixed, error: null } } }))
  useAppStore.getState().focusRegion('repo', target.tabId, target.regionId, 'navigation', 'group')
})
afterEach(async () => {
  if (root) await act(async () => root!.unmount()); root = undefined; element?.remove()
  useAppStore.setState(initial, true); vi.restoreAllMocks()
})

it('reclaims only the budgeted hidden Diff payload through the real Workbench consumer', async () => {
  await render()
  await vi.waitFor(() => expect(useAppStore.getState().editorRegionDiffs[target.regionId]?.diff).toEqual(fixed))
  const before = useAppStore.getState()
  await hideAndRelease()
  const after = useAppStore.getState()
  expect(after.editorRegionDiffs).not.toHaveProperty(target.regionId)
  expect(after.editorRegionDiffs[other.regionId]).toBe(before.editorRegionDiffs[other.regionId])
  expect(after.editorRegionDiffs['dirty-file']).toBe(before.editorRegionDiffs['dirty-file'])
  expect(after.tabs).toEqual(before.tabs)
  expect(after.tabs[target.tabId]!.regions[target.regionId]).toMatchObject({ comparison: descriptor })
  expect(after.documents).toBe(before.documents); expect(after.dirtyDocuments).toBe(before.dirtyDocuments)
  expect(element.querySelector(`[data-git-diff-region="${target.regionId}"]`)).toBeNull()
  expect(commitDiff).toHaveBeenCalledExactlyOnceWith('repo', descriptor)
  expect(branchDiff).not.toHaveBeenCalled()
  await act(async () => useAppStore.getState().releaseBranchDiff(target.regionId))
  expect(useAppStore.getState()).toBe(after)
})

it.each(['commit', 'branch'] as const)('rejects a late hidden %s read and rebuilds its original descriptor when visible again', async kind => {
  const comparison: GitDiffDescriptor = kind === 'commit' ? descriptor : {
    snapshot: { hostId: 'local', repoPath: _hygiene_fixturePath("repo"), mode: 'merge-base', baseBranch: 'main', targetBranch: 'feature',
      baseOid: 'b'.repeat(40), targetOid: 'a'.repeat(40), comparisonBaseOid: 'c'.repeat(40) }, file: descriptor.file
  }
  const state = useAppStore.getState(), tab = state.tabs[target.tabId]!, surface = tab.regions[target.regionId]!
  if (surface.kind !== 'git-diff') throw new Error('Expected the original Diff fixture')
  useAppStore.setState({ tabs: { ...state.tabs, [tab.id]: { ...tab, regions: { ...tab.regions, [surface.regionId]: { ...surface, comparison } } } } })
  const bridge = kind === 'commit' ? commitDiff : branchDiff
  let resolve!: (diff: GitFileDiff) => void
  bridge.mockReturnValueOnce(new Promise(done => { resolve = done }))
  await render(); await vi.waitFor(() => expect(bridge).toHaveBeenCalledTimes(1))
  await hideAndRelease()
  expect(useAppStore.getState().editorRegionDiffs).not.toHaveProperty(target.regionId)
  await act(async () => resolve(fixed))
  expect(useAppStore.getState().editorRegionDiffs).not.toHaveProperty(target.regionId)
  await act(async () => useAppStore.getState().focusRegion('repo', target.tabId, target.regionId, 'navigation', 'group'))
  await render()
  await vi.waitFor(() => expect(bridge).toHaveBeenCalledTimes(2))
  expect(bridge.mock.calls).toEqual([['repo', comparison], ['repo', comparison]])
  await vi.waitFor(() => expect(element.querySelector(`[data-git-diff-region="${target.regionId}"]`)?.textContent).toContain('fixed old|fixed new'))
})

it('does not reclaim dirty file data or an unrelated missing Region through the Git Diff action', () => {
  const before = useAppStore.getState()
  before.releaseBranchDiff('dirty-file'); before.releaseBranchDiff('missing-region')
  expect(useAppStore.getState()).toBe(before)
  expect(before.documents['repo\0dirty.ts']?.content).toBe('unsaved text')
})
