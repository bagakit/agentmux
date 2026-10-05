const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { installGitHistoryViewport } from './helpers/git-history-viewport'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AppConfig } from '../src/shared/contracts'
import type { GitCommitDetailsResult, GitHistoryResult } from '../src/shared/git-contracts'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
vi.mock('../src/renderer/src/components/BranchesPanel', () => ({ BranchesPanel: () => <div>Branches</div> }))
vi.mock('../src/renderer/src/components/ChangesPanel', () => ({ ChangesPanel: () => <div>Changes</div> }))
vi.mock('../src/renderer/src/monaco', () => ({}))
vi.mock('monaco-editor', () => ({
  Uri: { parse: (value: string) => value },
  editor: {
    createModel: (text: string, language: string) => ({ getValue: () => text, setValue: (value: string) => { text = value }, getLanguageId: () => language, dispose() {} }),
    setModelLanguage() {}, setTheme() {},
    createDiffEditor: (host: HTMLElement, options: { readOnly: boolean }) => ({
      createViewModel: (pair: any) => ({ ...pair, dispose() {} }),
      setModel: (pair: any) => { if (pair) { const node = document.createElement('div'); node.setAttribute('data-commit-canvas', 'true'); node.setAttribute('data-readonly', String(options.readOnly)); node.textContent = pair.original.getValue() + '|' + pair.modified.getValue(); host.replaceChildren(node) } },
      updateOptions() {}, dispose() {}
    })
  }
}))
import { useAppStore } from '../src/renderer/src/store'
import { GitHistoryProvider } from '../src/renderer/src/features/git/history/GitHistoryContext'
import { ProjectSourceControl } from '../src/renderer/src/components/ProjectFilesTool'
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'
import { api } from '../src/renderer/src/lib/api'

const workspace = { id: 'repo', name: 'Repository', hostId: 'local', path: _hygiene_fixturePath("repo"), kind: 'folder' as const }
const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Local' }], executors: {}, workspaces: [workspace],
  appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
function details(oid = 'a'.repeat(40), parentOid = 'b'.repeat(40)): Extract<GitCommitDetailsResult, { kind: 'ready' }> {
  return { kind: 'ready', snapshot: { hostId: 'local', repoPath: _hygiene_fixturePath("repo"), commitOid: oid, parentOid },
    commit: { oid, parents: ['b'.repeat(40), 'c'.repeat(40)], subject: 'Complete merge', message: 'Complete merge\n\nThe full message body remains readable.\nSecond paragraph.', author: 'Original Author', committer: 'Original Committer', authoredAt: 10, committedAt: 20, refs: [] },
    entries: [{ path: 'new.ts', origPath: 'old.ts', change: 'renamed' }, { path: 'removed.ts', origPath: null, change: 'deleted' }], warnings: [] }
}
const commitDetails = vi.fn<(id: string, input: any) => Promise<GitCommitDetailsResult>>()
const commitDiff = vi.fn(async () => ({ path: 'new.ts', old: { present: true, binary: false, text: 'fixed old' }, new: { present: true, binary: false, text: 'fixed new' }, binary: false, change: 'modified' }))
const initialHistory = async (): Promise<GitHistoryResult> => ({ kind: 'ready', snapshot: { hostId: 'local', repoPath: _hygiene_fixturePath("repo"), selectedRef: null, roots: ['a'.repeat(40)], refs: [], checkedAt: 1 }, commits: [details().commit], nextCursor: null, warnings: [] })
const history = vi.fn(initialHistory)
let root: ReturnType<typeof createRoot> | undefined, element: HTMLDivElement
const initial = useAppStore.getState()
async function mount() {
  element = document.createElement('div'); document.body.append(element); root = createRoot(element)
  await act(async () => root!.render(<WorkspaceWorkbench workspaceId="repo" />))
  await vi.waitFor(() => expect(element.querySelector('[data-git-workbench-region]')).not.toBeNull())
  return element
}
async function click(selector: string) { const button = element.querySelector<HTMLButtonElement>(selector); expect(button).not.toBeNull(); await act(async () => button!.click()) }
beforeEach(() => {
  installGitHistoryViewport()
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(300)
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function () { return Number.parseFloat(this.querySelector<HTMLElement>('.git-history-window')?.style.height ?? '0') + 24 })
  localStorage.clear(); commitDetails.mockReset().mockResolvedValue(details()); commitDiff.mockClear(); history.mockReset().mockImplementation(initialHistory)
  Object.assign(window, { agentmux: { git: { history, commitDetails, commitDiff, branchDiff: vi.fn() } } })
  useAppStore.setState({ config, loading: false, tabs: {}, layouts: { repo: createWorkspaceLayout('group', []) }, activeWorkspaceId: 'repo', editorRegionDiffs: {} })
  useAppStore.getState().openGitWorkbench('repo', details().snapshot)
  vi.spyOn(api.files, 'read'); vi.spyOn(api.files, 'observe'); vi.spyOn(api.files, 'write')
})
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; element?.remove(); useAppStore.setState(initial, true); vi.restoreAllMocks() })

it('reads full message/all parents and opens a rename via actual workbench/store/readonly canvas', async () => {
  await mount()
  await vi.waitFor(() => expect(element.querySelector('.git-workbench__message')?.textContent).toBe(details().commit.message))
  expect(element.querySelector('.git-workbench__metadata')?.textContent).toContain('c'.repeat(40))
  expect(element.querySelectorAll('.git-workbench__files button')).toHaveLength(2)
  expect(history).not.toHaveBeenCalled()
  expect(element.querySelector('[aria-label="Repository history"]')).toBeNull()
  const tabs = Object.keys(useAppStore.getState().tabs)
  await click('[aria-label="Open diff for new.ts"]')
  await vi.waitFor(() => expect(element.querySelector('[data-commit-canvas]')?.textContent).toBe('fixed old|fixed new'))
  expect(element.querySelector('[data-commit-canvas]')?.getAttribute('data-readonly')).toBe('true')
  expect(Object.keys(useAppStore.getState().tabs)).toEqual(tabs)
  expect(element.querySelector('[aria-label="Commit file diff"]')).not.toBeNull()
  expect(commitDiff).toHaveBeenCalledExactlyOnceWith('repo', { kind: 'commit', snapshot: details().snapshot, file: { path: 'new.ts', origPath: 'old.ts' } })
  expect(api.files.read).not.toHaveBeenCalled(); expect(api.files.observe).not.toHaveBeenCalled(); expect(api.files.write).not.toHaveBeenCalled()
})

it('keeps commit content and fixed diff actions available beside unknown references, then reloads the same selection', async () => {
  const unknown = details()
  unknown.warnings = ['Commit references unavailable. Reload this fixed commit to retry: observation unavailable']
  commitDetails.mockResolvedValueOnce(unknown)
  await mount()
  await vi.waitFor(() => expect(element.querySelector('.git-workbench__warning')?.textContent).toContain('Commit references unavailable'))
  expect(element.querySelector('.git-workbench__message')?.textContent).toBe(unknown.commit.message)
  expect(element.querySelector('[aria-label="Open diff for new.ts"]')).not.toBeNull()
  await click('[aria-label="Reload commit details"]')
  await vi.waitFor(() => expect(element.querySelector('.git-workbench__warning')).toBeNull())
  expect(commitDetails.mock.calls).toEqual([['repo', { oid: 'a'.repeat(40), parentOid: 'b'.repeat(40) }], ['repo', { oid: 'a'.repeat(40), parentOid: 'b'.repeat(40) }]])
})

it('selects a specific merge parent and rereads files against that fixed parent', async () => {
  await mount(); await vi.waitFor(() => expect(element.querySelector('select[aria-label="Comparison parent"]')).not.toBeNull())
  const select = element.querySelector<HTMLSelectElement>('select[aria-label="Comparison parent"]')!
  commitDetails.mockResolvedValueOnce(details(undefined, 'c'.repeat(40)))
  await act(async () => { select.value = 'c'.repeat(40); select.dispatchEvent(new Event('change', { bubbles: true })) })
  await vi.waitFor(() => expect(commitDetails).toHaveBeenLastCalledWith('repo', { oid: 'a'.repeat(40), parentOid: 'c'.repeat(40) }))
  await vi.waitFor(() => expect(element.querySelector<HTMLSelectElement>('select[aria-label="Comparison parent"]')?.value).toBe('c'.repeat(40)))
})

it('ignores a late commit response after another commit is selected', async () => {
  let resolve!: (value: GitCommitDetailsResult) => void
  commitDetails.mockReturnValueOnce(new Promise(done => { resolve = done }))
  await mount(); await vi.waitFor(() => expect(commitDetails).toHaveBeenCalledTimes(1))
  const surface = Object.values(useAppStore.getState().tabs).flatMap(tab => Object.values(tab.regions)).find(region => region.kind === 'git')!
  const next = details('d'.repeat(40)); next.commit.message = 'The newer selection'
  commitDetails.mockResolvedValueOnce(next)
  await act(async () => useAppStore.getState().selectGitCommit(surface.regionId, next.snapshot))
  await vi.waitFor(() => expect(element.querySelector('.git-workbench__message')?.textContent).toBe('The newer selection'))
  await act(async () => resolve(details()))
  expect(element.querySelector('.git-workbench__message')?.textContent).toBe('The newer selection')
})

it('retains the fixed selection on an owner mismatch and retries the same target', async () => {
  const wrong = details(); wrong.snapshot.repoPath = _hygiene_fixturePath("unrelated"); commitDetails.mockResolvedValueOnce(wrong)
  await mount(); await vi.waitFor(() => expect(element.querySelector('[role="alert"]')?.textContent).toContain('repository or comparison parent changed'))
  expect(element.querySelector('.git-workbench__files')).toBeNull()
  await click('.git-history-error button')
  await vi.waitFor(() => expect(element.querySelector('.git-workbench__message')?.textContent).toBe(details().commit.message))
  expect(commitDetails.mock.calls).toEqual([['repo', { oid: 'a'.repeat(40), parentOid: 'b'.repeat(40) }], ['repo', { oid: 'a'.repeat(40), parentOid: 'b'.repeat(40) }]])
})

it('keeps a foreign repository history out of the original Git region and retries its scope', async () => {
  useAppStore.getState().openGitHistory('repo', details().snapshot)
  history.mockResolvedValueOnce({ kind: 'ready', snapshot: { hostId: 'local', repoPath: _hygiene_fixturePath("different-root"), selectedRef: null, roots: ['e'.repeat(40)], refs: [], checkedAt: 1 },
    commits: [{ ...details('e'.repeat(40)).commit, subject: 'Foreign repository must stay hidden' }], nextCursor: null, warnings: [] })
  await mount()
  await vi.waitFor(() => expect(element.querySelector('.git-workbench__history [role="alert"]')?.textContent).toContain('repository changed'))
  expect(element.querySelector('.git-workbench__history')?.textContent).not.toContain('Foreign repository must stay hidden')
  expect(element.querySelectorAll('.git-workbench__history [data-history-oid]')).toHaveLength(0)
  await click('.git-workbench__history [role="alert"] button')
  await vi.waitFor(() => expect(element.querySelectorAll('.git-workbench__history [data-history-oid]')).toHaveLength(1))
})

it.each([{ path: _hygiene_fixturePath("other") }, { hostId: 'another-host' }])('retains the original surface instead of reading a rebound workspace %j', async change => {
  await mount(); await vi.waitFor(() => expect(element.querySelector('.git-workbench__message')).not.toBeNull())
  commitDetails.mockClear(); history.mockClear()
  await act(async () => useAppStore.setState({ config: { ...config, workspaces: [{ ...workspace, ...change }] } }))
  expect(element.querySelector('[role="alert"]')?.textContent).toContain('Original Git workspace unavailable')
  expect(element.querySelector('[role="alert"]')?.textContent).toContain(_hygiene_fixturePath("repo"))
  expect(element.querySelector('[aria-label="Repository history"]')).toBeNull()
  expect(history).not.toHaveBeenCalled(); expect(commitDetails).not.toHaveBeenCalled()
  await act(async () => useAppStore.setState({ config }))
  await vi.waitFor(() => expect(element.querySelector('.git-workbench__message')?.textContent).toBe(details().commit.message))
})

it('shares the actual sidebar reading window with explicit repository history and returns it without rereading', async () => {
  element = document.createElement('div'); document.body.append(element); root = createRoot(element)
  const frame = <GitHistoryProvider workspace={workspace}><ProjectSourceControl workspace={workspace} visible>{content => <aside data-sidebar>{content}</aside>}</ProjectSourceControl><WorkspaceWorkbench workspaceId="repo" /></GitHistoryProvider>
  await act(async () => root!.render(frame))
  await click('[role="tab"][data-surface-mode="history"]')
  await vi.waitFor(() => expect(element.querySelector('[data-sidebar] [data-history-oid]')).not.toBeNull())
  expect(history).toHaveBeenCalledTimes(1)
  await click('[data-sidebar] [data-history-oid]')
  expect(element.querySelector('[aria-label="Git commit details"]')).not.toBeNull()
  expect(element.querySelector('[aria-label="Git repository history"]')).toBeNull()
  expect(history).toHaveBeenCalledTimes(1)
  await click('[data-sidebar] [aria-label="Open repository history"]')
  await vi.waitFor(() => expect(element.querySelector('[aria-label="Git repository history"]')).not.toBeNull())
  expect(element.querySelectorAll('.git-history-panel')).toHaveLength(1)
  expect(element.querySelector('[data-sidebar] .git-history-expanded')).not.toBeNull()
  expect(history).toHaveBeenCalledTimes(1)
  await click('[data-sidebar] .git-history-expanded button:last-child')
  await vi.waitFor(() => expect(element.querySelector('[data-sidebar] [data-history-oid]')).not.toBeNull())
  expect(element.querySelectorAll('.git-history-panel')).toHaveLength(1)
  expect(history).toHaveBeenCalledTimes(1)
})
it('keeps the selected sidebar range when a commit detail explicitly opens repository history', async () => {
  const first = await history.getMockImplementation()!(), reference = 'refs/heads/topic'
  if (first.kind !== 'ready') throw new Error('Fixture must be ready')
  first.snapshot.refs = [{ kind: 'local', name: reference, oid: details().snapshot.commitOid }]
  history.mockImplementation(async (_id?: string, input?: any) => ({ ...first, snapshot: { ...first.snapshot, selectedRef: input?.ref ?? null } }))
  element = document.createElement('div'); document.body.append(element); root = createRoot(element)
  await act(async () => root!.render(<GitHistoryProvider workspace={workspace}><ProjectSourceControl workspace={workspace} visible>{content => <aside data-sidebar>{content}</aside>}</ProjectSourceControl><WorkspaceWorkbench workspaceId="repo" /></GitHistoryProvider>))
  await click('[role="tab"][data-surface-mode="history"]')
  await vi.waitFor(() => expect(element.querySelector('[data-sidebar] [data-history-oid]')).not.toBeNull())
  const referenceSelect = element.querySelector<HTMLSelectElement>('[aria-label="History reference"]')!
  await act(async () => { referenceSelect.value = reference; referenceSelect.dispatchEvent(new Event('change', { bubbles: true })) })
  await vi.waitFor(() => expect(history).toHaveBeenLastCalledWith('repo', { ref: reference }))
  const count = history.mock.calls.length
  await click('[aria-label="View repository history"]')
  await vi.waitFor(() => expect(element.querySelector('[aria-label="Git repository history"]')).not.toBeNull())
  expect(element.querySelector<HTMLSelectElement>('[aria-label="History reference"]')?.value).toBe(reference)
  expect(history).toHaveBeenCalledTimes(count)
})
function longPage(reference: string | null = null): Extract<GitHistoryResult, { kind: 'ready' }> {
  const commits = Array.from({ length: 100 }, (_, index) => ({ ...details((index + 1).toString(16).padStart(40, '0')).commit,
    parents: [(index + 2).toString(16).padStart(40, '0')], subject: `Commit ${index}` }))
  const snapshot = { hostId: 'local', repoPath: _hygiene_fixturePath("repo"), selectedRef: reference, roots: [commits[0]!.oid],
    refs: [{ kind: 'local' as const, name: 'refs/heads/topic', oid: commits[0]!.oid }], checkedAt: 1 }
  return { kind: 'ready', snapshot, commits, nextCursor: { snapshot, offset: 100 }, warnings: [] }
}
it('retains unloaded locate targets without automatically exhausting history', async () => {
  const page = longPage(), commit = details('f'.repeat(40))
  commit.commit.message = 'Saved target outside loaded pages'
  commitDetails.mockResolvedValue(commit)
  history.mockResolvedValue(page)
  useAppStore.getState().openGitHistory('repo', commit.snapshot, null, commit.snapshot)
  await mount()
  await vi.waitFor(() => expect(element.querySelector('.git-workbench__locating')?.textContent).toContain('has not been loaded'))
  await vi.waitFor(() => expect(element.querySelector('.git-workbench__message')?.textContent).toBe(commit.commit.message))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)) })
  expect(history).toHaveBeenCalledTimes(1)
  const next = { ...page, commits: [commit.commit], nextCursor: null }
  history.mockResolvedValueOnce(next)
  await click('.git-workbench__locating button')
  await vi.waitFor(() => expect(element.querySelector('.git-workbench__locating')).toBeNull())
  expect(history).toHaveBeenCalledTimes(2)
})
it('keeps a visible repository window when the active sidebar workspace changes and returns', async () => {
  const other = { ...workspace, id: 'other', path: _hygiene_fixturePath("other"), name: 'Other repository' }, reference = 'refs/heads/topic'
  useAppStore.setState({ config: { ...config, workspaces: [workspace, other] } })
  history.mockImplementation(async (_id?: string, input?: any) => longPage(input?.ref ?? null))
  useAppStore.getState().openGitHistory('repo', details().snapshot)
  element = document.createElement('div'); document.body.append(element); root = createRoot(element)
  const frame = (active: typeof workspace) => <GitHistoryProvider workspace={active}><WorkspaceWorkbench workspaceId="repo" /></GitHistoryProvider>
  await act(async () => root!.render(frame(workspace)))
  await vi.waitFor(() => expect(element.querySelector('[data-history-oid]')).not.toBeNull())
  const select = element.querySelector<HTMLSelectElement>('[aria-label="History reference"]')!
  await act(async () => { select.value = reference; select.dispatchEvent(new Event('change', { bubbles: true })) })
  await vi.waitFor(() => expect(history).toHaveBeenLastCalledWith('repo', { ref: reference }))
  const scroll = element.querySelector<HTMLElement>('.git-history-scroll')!
  await act(async () => { scroll.scrollTop = 1200; scroll.dispatchEvent(new Event('scroll')) })
  const count = history.mock.calls.length
  for (const active of [other, workspace]) {
    await act(async () => root!.render(frame(active)))
    await vi.waitFor(() => expect(element.querySelector<HTMLSelectElement>('[aria-label="History reference"]')?.value).toBe(reference))
    expect(element.querySelector<HTMLElement>('.git-history-scroll')?.scrollTop).toBe(1200)
    expect(element.querySelectorAll('[data-history-oid]').length).toBeLessThan(40)
    expect(history).toHaveBeenCalledTimes(count)
    const surface = Object.values(useAppStore.getState().tabs).flatMap(tab => Object.values(tab.regions)).find(region => region.kind === 'git' && region.history)
    expect(surface?.kind === 'git' && surface.history?.reference).toBe(reference)
  }
})

it.each(['View repository history', 'Locate commit in history'])('keeps an in-flight range choice through %s', async action => {
  const reference = 'refs/heads/topic', page = longPage(reference)
  let finish!: (value: GitHistoryResult) => void
  history.mockResolvedValueOnce(longPage()).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  element = document.createElement('div'); document.body.append(element); root = createRoot(element)
  await act(async () => root!.render(<GitHistoryProvider workspace={workspace}><ProjectSourceControl workspace={workspace} visible>{content => <aside data-sidebar>{content}</aside>}</ProjectSourceControl><WorkspaceWorkbench workspaceId="repo" /></GitHistoryProvider>))
  await click('[role="tab"][data-surface-mode="history"]')
  await vi.waitFor(() => expect(element.querySelector('[data-history-oid]')).not.toBeNull())
  const select = element.querySelector<HTMLSelectElement>('[aria-label="History reference"]')!
  await act(async () => { select.value = reference; select.dispatchEvent(new Event('change', { bubbles: true })) })
  await vi.waitFor(() => expect(history).toHaveBeenCalledTimes(2))
  await click(`[aria-label="${action}"]`)
  await act(async () => finish(page))
  await vi.waitFor(() => expect(element.querySelector<HTMLSelectElement>('[aria-label="History reference"]')?.value).toBe(reference))
  expect(history).toHaveBeenCalledTimes(2)
})
