// @vitest-environment happy-dom
import { fixturePath as _tailFixturePath, fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core/control'
import { createClientUiRoot } from './helpers/client-ui-render'
import { installGitHistoryViewport } from './helpers/git-history-viewport'
import { selectHistoryReference } from './helpers/git-history-reference'
import type { AppConfig } from '../src/shared/contracts'
import type { GitCommitDetailsResult, GitHistoryResult } from '../src/shared/git-contracts'
import { useAppStore } from '../src/renderer/src/store'
import { GitHistoryProvider } from '../src/renderer/src/features/git/history/GitHistoryContext'
import { GitWorkbenchPane } from '../src/renderer/src/features/git/GitWorkbenchPane'
import { WorkspaceGitTool } from '../src/renderer/src/components/WorkspaceGitTool'

vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
vi.mock('../src/renderer/src/components/BranchesPanel', () => ({ BranchesPanel: () => null }))
vi.mock('../src/renderer/src/components/ChangesPanel', () => ({ ChangesPanel: () => null }))
vi.mock('../src/renderer/src/features/git/diff/GitDiffCanvas', () => ({ GitDiffCanvas: () => null }))
const workspace = { id: 'repository', hostId: 'local', path: _tailFixturePath("fixture/repository"), name: 'Repository', kind: 'folder' as const }
const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Local' }], executors: {}, workspaces: [workspace],
  appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
const firstOid = 'a'.repeat(40), nextOid = 'b'.repeat(40)
const scope = { hostId: 'local', repoPath: workspace.path }
const fixed = { ...scope, commitOid: firstOid, parentOid: nextOid }
const first = { oid: firstOid, parents: [nextOid], subject: 'First selection', author: 'Example Author', authoredAt: null, refs: [] }
const next = { ...first, oid: nextOid, parents: [], subject: 'Next selection' }
const historyPage: GitHistoryResult = { kind: 'ready', snapshot: { ...scope, roots: [firstOid], selectedRef: null, refs: [], checkedAt: _tailFixtureEpoch(0, 0, 1) }, commits: [first, next], nextCursor: null }
const history = vi.fn(async () => historyPage)
function commitResult(input: { oid: string; parentOid?: string }): GitCommitDetailsResult { return { kind: 'ready',
  snapshot: { ...scope, commitOid: input.oid, parentOid: input.parentOid ?? null },
  commit: { ...(input.oid === firstOid ? first : next), oid: input.oid, message: input.oid === firstOid ? first.subject : next.subject, authorEmail: '', committer: 'Example Author', committedAt: null }, entries: [], warnings: [] } }
const commitDetails = vi.fn(async (_workspaceId: string, input: { oid: string; parentOid?: string }) => commitResult(input))
const initial = useAppStore.getState()
let host: HTMLDivElement, root: ReturnType<typeof createClientUiRoot>
function Review({ visible }: { visible: boolean }) {
  const tabs = useAppStore(state => state.tabs)
  return <main hidden={!visible}>{Object.values(tabs).flatMap(tab => Object.values(tab.regions)).filter(region => region.kind === 'git').map(surface => <GitWorkbenchPane key={surface.regionId} surface={surface} visible={visible} />)}</main>
}
async function render(visible = true, reviewVisible = true, mounted = true) {
  await act(async () => root.render(<GitHistoryProvider workspace={workspace}><aside data-sidebar><WorkspaceGitTool workspace={workspace} visible={visible} /></aside>{mounted && <Review visible={reviewVisible} />}</GitHistoryProvider>))
}
async function select(oid: string) {
  const row = host.querySelector<HTMLElement>(`[data-history-oid="${oid}"]`)
  expect(row).not.toBeNull()
  await act(async () => row!.click())
}
beforeEach(() => {
  installGitHistoryViewport()
  localStorage.clear()
  history.mockReset().mockResolvedValue(historyPage)
  commitDetails.mockReset().mockImplementation(async (_workspaceId, input) => commitResult(input))
  Object.assign(window, { agentmux: { git: { history, commitDetails } } })
  useAppStore.setState({ config, tabs: {}, layouts: { repository: createWorkspaceLayout('group', []) }, activeWorkspaceId: workspace.id,
    workspaceTool: 'git', workspaceGitView: 'history', toolsOpen: true, mainSurface: 'workbench', editorRegionDiffs: {} })
  host = document.createElement('div'); document.body.append(host); root = createClientUiRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove()
  useAppStore.setState(initial, true); vi.restoreAllMocks()
})

it('keeps the Space tree visible and reuses repository review without replacing an independent fixed target', async () => {
  const independent = useAppStore.getState().openGitWorkbench(workspace.id, fixed)
  await render(); await select(firstOid)
  const review = Object.values(useAppStore.getState().tabs).find(tab => tab.id !== independent.tabId)!
  expect(review).toBeDefined()
  const originalTree = host.querySelector('.git-history-panel')
  expect(originalTree?.closest('[data-sidebar]')).not.toBeNull()
  expect(host.querySelector('[aria-label="Open repository history"]')).toBeNull()
  expect(host.querySelector('main .git-history-panel')).toBeNull()
  expect(host.querySelector('.git-history-expanded')).toBeNull()
  await select(nextOid)
  expect(Object.keys(useAppStore.getState().tabs)).toEqual([independent.tabId, review.id])
  expect(useAppStore.getState().tabs[review.id]!.regions[review.layout.activeRegionId]).toMatchObject({ selection: { commitOid: nextOid, parentOid: null }, history: { reference: null } })
  expect(useAppStore.getState().tabs[review.id]!.regions[review.layout.activeRegionId]).not.toHaveProperty('history.focusOid')
  expect(useAppStore.getState().tabs[independent.tabId]!.regions[independent.regionId]).toMatchObject({ selection: { commitOid: firstOid, parentOid: nextOid } })
  expect(host.querySelector('.git-history-panel')).toBe(originalTree)
  expect(host.querySelectorAll('.git-history-panel')).toHaveLength(1)
  expect(history).toHaveBeenCalledTimes(1)
})

it('does not start a history reader for a visible review with its tree hidden', async () => {
  useAppStore.getState().openGitHistory(workspace.id, scope, null, fixed)
  await render(false)
  expect(history).not.toHaveBeenCalled()
  expect(commitDetails).toHaveBeenCalledExactlyOnceWith(workspace.id, { oid: firstOid, parentOid: nextOid })
  expect(host.querySelector('main')?.textContent).toContain('First selection')
  await render()
  expect(history).toHaveBeenCalledExactlyOnceWith(workspace.id, { ref: null })
  await render(false); await render()
  expect(history).toHaveBeenCalledTimes(2)
  expect(history).toHaveBeenLastCalledWith(workspace.id, { ref: null, limit: 1 })
})

it('reveals the same Space Git tool through the public repository navigation owner without choosing a commit', async () => {
  useAppStore.setState({ workspaceTool: 'agents', workspaceGitView: 'changes', toolsOpen: false })
  const request = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'repository-history-navigation', operation: 'open.git' as const,
    workspaceId: workspace.id, expectedResource: { hostId: workspace.hostId, workspacePath: workspace.path } }
  await act(async () => { await useAppStore.getState().executeControl(request) })
  const state = useAppStore.getState(), surfaces = Object.values(state.tabs).flatMap(tab => Object.values(tab.regions))
  expect(state).toMatchObject({ workspaceTool: 'git', workspaceGitView: 'history', toolsOpen: true })
  expect(surfaces).toHaveLength(1)
  expect(surfaces[0]).toMatchObject({ kind: 'git', selection: null, history: { reference: null } })
  await render()
  expect(host.querySelector('main .git-history-panel')).toBeNull()
  expect(host.querySelector('main')?.textContent).toContain('Select a commit')
  expect(commitDetails).not.toHaveBeenCalled()
})

it('rejects the wrong public resource without changing tools or dropping existing work', async () => {
  const opened = useAppStore.getState().openGitWorkbench(workspace.id, fixed)
  useAppStore.setState({ workspaceTool: 'agents', toolsOpen: false })
  await expect(useAppStore.getState().executeControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'wrong-history-resource', operation: 'open.git',
    workspaceId: workspace.id, expectedResource: { hostId: workspace.hostId, workspacePath: _tailFixturePath("fixture/other") } })).rejects.toThrow('resource changed')
  expect(useAppStore.getState()).toMatchObject({ workspaceTool: 'agents', toolsOpen: false })
  expect(Object.keys(useAppStore.getState().tabs)).toEqual([opened.tabId])
  expect(history).not.toHaveBeenCalled()
})

it.each([false, true])('retains later tool navigation after a public Git read with fixed target %s', async fixedTarget => {
  let finish!: (result: any) => void
  const pendingRead = new Promise<any>(resolve => { finish = resolve })
  if (fixedTarget) commitDetails.mockReturnValueOnce(pendingRead)
  else history.mockReturnValueOnce(pendingRead)
  const originalTabs = useAppStore.getState().tabs
  const pendingOpen = useAppStore.getState().executeControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
    requestId: fixedTarget ? 'late-commit-navigation' : 'late-repository-navigation', operation: 'open.git', workspaceId: workspace.id,
    expectedResource: { hostId: workspace.hostId, workspacePath: workspace.path }, ...(fixedTarget ? { oid: firstOid, parentOid: nextOid } : {}) })
  const rejected = expect(pendingOpen).rejects.toMatchObject({ code: 'CONTROL_CANCELLED' })
  useAppStore.getState().setWorkspaceTool('agents')
  if (fixedTarget) finish(commitResult({ oid: firstOid, parentOid: nextOid }))
  else finish(historyPage)
  await rejected
  expect(useAppStore.getState().workspaceTool).toBe('agents')
  expect(useAppStore.getState().tabs).toBe(originalTabs)
})

it('does not revive a superseded presentation when navigation leaves and returns to the same final tool', async () => {
  let finish!: (result: GitHistoryResult) => void
  history.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  const pending = useAppStore.getState().executeControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
    requestId: 'superseded-history-navigation', operation: 'open.git', workspaceId: workspace.id,
    expectedResource: { hostId: workspace.hostId, workspacePath: workspace.path } })
  const rejected = expect(pending).rejects.toMatchObject({ code: 'CONTROL_CANCELLED' })
  useAppStore.getState().setWorkspaceTool('agents')
  useAppStore.getState().setWorkspaceTool('git')
  finish(historyPage); await rejected
  expect(useAppStore.getState().tabs).toEqual({})
})

it.each(['commit', 'reference', 'file', 'parent'])('does not replace a newer same-Region %s choice after a public commit read', async change => {
  const opened = useAppStore.getState().openGitHistory(workspace.id, scope, null, fixed)
  let finish!: (result: GitCommitDetailsResult) => void
  commitDetails.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  const pending = useAppStore.getState().executeControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
    requestId: 'same-region-newer-' + change, operation: 'open.git', workspaceId: workspace.id, oid: firstOid, parentOid: nextOid,
    expectedResource: { hostId: workspace.hostId, workspacePath: workspace.path } })
  const rejected = expect(pending).rejects.toMatchObject({ code: 'CONTROL_CANCELLED' })
  if (change === 'commit') useAppStore.getState().selectGitCommit(opened.regionId, { ...fixed, commitOid: nextOid, parentOid: null })
  if (change === 'reference') useAppStore.getState().selectGitHistoryReference(opened.regionId, 'refs/heads/newer')
  if (change === 'file') useAppStore.getState().selectGitFile(opened.regionId, { path: 'newer.ts', origPath: null })
  if (change === 'parent') useAppStore.getState().selectGitCommit(opened.regionId, { ...fixed, parentOid: null })
  const selection = useAppStore.getState().tabs[opened.tabId]!.regions[opened.regionId]
  finish(commitResult({ oid: firstOid, parentOid: nextOid })); await rejected
  expect(Object.keys(useAppStore.getState().tabs)).toEqual([opened.tabId])
  expect(useAppStore.getState().tabs[opened.tabId]!.regions[opened.regionId]).toBe(selection)
})

it('does not cancel an exact public target for unrelated Session observations', async () => {
  let finish!: (result: GitHistoryResult) => void
  history.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  const pending = useAppStore.getState().executeControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
    requestId: 'unrelated-session-observation', operation: 'open.git', workspaceId: workspace.id,
    expectedResource: { hostId: workspace.hostId, workspacePath: workspace.path } })
  for (let index = 0; index < 100; index += 1) useAppStore.setState(state => ({ sessions: [...state.sessions] }))
  finish(historyPage)
  await expect(pending).resolves.toMatchObject({ operation: 'open.git', read: { kind: 'ready' } })
  expect(Object.keys(useAppStore.getState().tabs)).toHaveLength(1)
})

it('does not treat an equivalent descriptor clone or a display title update as a new Git reading target', async () => {
  const opened = useAppStore.getState().openGitHistory(workspace.id, scope, null, fixed)
  let finish!: (result: GitCommitDetailsResult) => void
  commitDetails.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  const pending = useAppStore.getState().executeControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
    requestId: 'same-reading-target-new-projection', operation: 'open.git', workspaceId: workspace.id, oid: firstOid, parentOid: nextOid,
    expectedResource: { hostId: workspace.hostId, workspacePath: workspace.path } })
  useAppStore.setState(state => {
    const tab = state.tabs[opened.tabId]!, surface = tab.regions[opened.regionId]!
    if (surface.kind !== 'git') throw new Error('Expected the original Git reading target')
    return { tabs: { ...state.tabs, [tab.id]: { ...tab, title: 'Updated display title', regions: { ...tab.regions,
      [surface.regionId]: { ...surface, scope: { ...surface.scope }, selection: surface.selection ? { ...surface.selection } : null,
        history: surface.history ? { ...surface.history } : undefined } } } } }
  })
  finish(commitResult({ oid: firstOid, parentOid: nextOid }))
  await expect(pending).resolves.toMatchObject({ operation: 'open.git', read: { kind: 'ready' } })
})

it('keeps a newer range through pending, failure and review visibility changes, including All', async () => {
  const firstRef = 'refs/heads/first', otherRef = 'refs/remotes/origin/other'
  const refs = [{ name: firstRef, kind: 'local' as const, oid: firstOid }, { name: otherRef, kind: 'remote' as const, oid: nextOid }]
  history.mockResolvedValue({ ...historyPage, snapshot: { ...historyPage.snapshot, selectedRef: firstRef, refs } } as GitHistoryResult)
  const opened = useAppStore.getState().openGitHistory(workspace.id, scope, firstRef, fixed)
  await render()
  expect(history).toHaveBeenLastCalledWith(workspace.id, { ref: firstRef })
  await render(true, false)
  let finish!: (result: GitHistoryResult) => void
  history.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  await selectHistoryReference(host, otherRef)
  expect(useAppStore.getState().tabs[opened.tabId]!.regions[opened.regionId]).toMatchObject({ history: { reference: otherRef } })
  await render(true, true)
  expect(host.querySelector('[aria-label="History reference"]')?.getAttribute('data-value')).toBe(otherRef)
  history.mockRejectedValueOnce(new Error('All ranges observation unavailable'))
  await selectHistoryReference(host, '')
  expect(useAppStore.getState().tabs[opened.tabId]!.regions[opened.regionId]).toMatchObject({ history: { reference: null } })
  await act(async () => finish({ ...historyPage, snapshot: { ...historyPage.snapshot, selectedRef: otherRef, refs } } as GitHistoryResult))
  expect(host.querySelector('[aria-label="History reference"]')?.getAttribute('data-value')).toBe('')
  expect(host.textContent).toContain('All ranges observation unavailable')
  const button = host.querySelector<HTMLButtonElement>('main [aria-label="View repository history"]')!
  await act(async () => button.click())
  expect(host.querySelector('[aria-label="History reference"]')?.getAttribute('data-value')).toBe('')
  expect(useAppStore.getState().tabs[opened.tabId]!.regions[opened.regionId]).toMatchObject({ history: { reference: null } })
})

it('does not recenter the tree when an ordinary visible row opens details', async () => {
  const commits = Array.from({ length: 100 }, (_, index) => ({ ...first, oid: (index + 1).toString(16).padStart(40, '0'), parents: [], subject: `Commit ${index}` }))
  history.mockResolvedValue({ ...historyPage, commits } as GitHistoryResult)
  await render()
  const scroller = host.querySelector<HTMLElement>('.git-history-scroll')!
  await act(async () => { scroller.scrollTop = 1200; scroller.dispatchEvent(new Event('scroll')) })
  const row = host.querySelector<HTMLElement>('[data-history-index="50"]')!
  expect(row).not.toBeNull()
  await act(async () => row.click())
  expect(scroller.scrollTop).toBe(1200)
  expect(history).toHaveBeenCalledTimes(1)
  const tab = Object.values(useAppStore.getState().tabs)[0]!
  expect(tab.regions[tab.layout.activeRegionId]).not.toHaveProperty('history.focusOid')
})

it('adopts a live range when a retained review remounts rather than replaying its older descriptor', async () => {
  const oldRef = 'refs/heads/old', liveRef = 'refs/heads/live'
  const refs = [{ name: oldRef, kind: 'local' as const, oid: firstOid }, { name: liveRef, kind: 'local' as const, oid: nextOid }]
  history.mockImplementation(async (_workspaceId?: string, input?: { ref?: string | null }) => ({ ...historyPage,
    snapshot: { ...historyPage.snapshot, refs, selectedRef: input?.ref ?? null } } as GitHistoryResult))
  const opened = useAppStore.getState().openGitHistory(workspace.id, scope, oldRef, fixed)
  await render()
  await render(true, true, false)
  await selectHistoryReference(host, liveRef)
  expect(useAppStore.getState().tabs[opened.tabId]!.regions[opened.regionId]).toMatchObject({ history: { reference: oldRef } })
  const reads = history.mock.calls.length
  await render()
  expect(host.querySelector('[aria-label="History reference"]')?.getAttribute('data-value')).toBe(liveRef)
  expect(useAppStore.getState().tabs[opened.tabId]!.regions[opened.regionId]).toMatchObject({ history: { reference: liveRef } })
  expect(history).toHaveBeenCalledTimes(reads)
})

it('keeps a newly observed repository readable without rebinding the saved review', async () => {
  const opened = useAppStore.getState().openGitHistory(workspace.id, scope, null, fixed)
  const changed = { ...historyPage, snapshot: { ...historyPage.snapshot, repoPath: _tailFixturePath("fixture/new-repository") } } as GitHistoryResult
  history.mockResolvedValue(changed)
  await render()
  const before = useAppStore.getState().tabs[opened.tabId]!.regions[opened.regionId]
  expect(host.querySelector('[data-sidebar] [data-history-oid]')).not.toBeNull()
  await select(nextOid)
  expect(useAppStore.getState().tabs[opened.tabId]!.regions[opened.regionId]).toEqual(before)
  const scopes = Object.values(useAppStore.getState().tabs).flatMap(tab => Object.values(tab.regions)).filter(surface => surface.kind === 'git').map(surface => surface.scope.repoPath)
  expect(scopes).toEqual([workspace.path, _tailFixturePath("fixture/new-repository")])
})

it.each([false, true])('restores the visible repository range regardless of hidden descriptor mount order %s', async reverse => {
  const oldRef = 'refs/heads/old-only', currentRef = 'refs/heads/current'
  const original = useAppStore.getState().openGitHistory(workspace.id, scope, oldRef, fixed)
  const currentScope = { ...scope, repoPath: _tailFixturePath("fixture/current-repository") }
  const current = useAppStore.getState().openGitHistory(workspace.id, currentScope, currentRef)
  const originalSurface = useAppStore.getState().tabs[original.tabId]!.regions[original.regionId]!
  const currentSurface = useAppStore.getState().tabs[current.tabId]!.regions[current.regionId]!
  if (originalSurface.kind !== 'git' || currentSurface.kind !== 'git') throw new Error('Expected both original Git descriptors')
  const surfaces = reverse ? [currentSurface, originalSurface] : [originalSurface, currentSurface]
  history.mockImplementation(async (_workspaceId?: string, input?: { ref?: string | null }) => ({ ...historyPage,
    snapshot: { ...historyPage.snapshot, ...currentScope, selectedRef: input?.ref ?? null,
      refs: [{ name: currentRef, kind: 'local', oid: firstOid }] } } as GitHistoryResult))
  await act(async () => root.render(<GitHistoryProvider workspace={workspace}><aside data-sidebar><WorkspaceGitTool workspace={workspace} visible /></aside>
    {surfaces.map(surface => <GitWorkbenchPane key={surface.regionId} surface={surface} visible={surface.regionId === current.regionId} />)}</GitHistoryProvider>))
  expect(history).toHaveBeenCalledExactlyOnceWith(workspace.id, { ref: currentRef })
  expect(host.querySelector('[aria-label="History reference"]')?.getAttribute('data-value')).toBe(currentRef)
  expect(useAppStore.getState().tabs[original.tabId]!.regions[original.regionId]).toBe(originalSurface)
})

it('restores a sole retained hidden review before the Space tree reads its first page', async () => {
  const reference = 'refs/heads/saved'
  const opened = useAppStore.getState().openGitHistory(workspace.id, scope, reference, fixed)
  history.mockResolvedValue({ ...historyPage, snapshot: { ...historyPage.snapshot, selectedRef: reference,
    refs: [{ name: reference, kind: 'local', oid: firstOid }] } } as GitHistoryResult)
  await render(true, false)
  expect(history).toHaveBeenCalledExactlyOnceWith(workspace.id, { ref: reference })
  expect(useAppStore.getState().tabs[opened.tabId]!.regions[opened.regionId]).toMatchObject({ history: { reference } })
})

it('does not write an implicit All range over ambiguous hidden saved reviews', async () => {
  const original = useAppStore.getState().openGitHistory(workspace.id, scope, 'refs/heads/original', fixed)
  const currentScope = { ...scope, repoPath: _tailFixturePath("fixture/current-repository") }
  const other = useAppStore.getState().openGitHistory(workspace.id, currentScope, 'refs/heads/other')
  const originalSurface = useAppStore.getState().tabs[original.tabId]!.regions[original.regionId]
  const otherSurface = useAppStore.getState().tabs[other.tabId]!.regions[other.regionId]
  history.mockResolvedValue({ ...historyPage, snapshot: { ...historyPage.snapshot, ...currentScope } } as GitHistoryResult)
  await render(true, false)
  expect(history).toHaveBeenCalledExactlyOnceWith(workspace.id, { ref: null })
  expect(useAppStore.getState().tabs[original.tabId]!.regions[original.regionId]).toBe(originalSurface)
  expect(useAppStore.getState().tabs[other.tabId]!.regions[other.regionId]).toBe(otherSurface)
})
