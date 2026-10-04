const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AppConfig } from '../src/shared/contracts'
import type { GitCommitDetailsResult, GitHistoryResult } from '../src/shared/git-contracts'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
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
const history = vi.fn(async (): Promise<GitHistoryResult> => ({ kind: 'ready', snapshot: { hostId: 'local', repoPath: _hygiene_fixturePath("repo"), selectedRef: null, roots: ['a'.repeat(40)], refs: [], checkedAt: 1 }, commits: [details().commit], nextCursor: null, warnings: [] }))
let root: ReturnType<typeof createRoot> | undefined, element: HTMLDivElement
const initial = useAppStore.getState()
async function mount() {
  element = document.createElement('div'); document.body.append(element); root = createRoot(element)
  await act(async () => root!.render(<WorkspaceWorkbench workspaceId="repo" />))
  await vi.waitFor(() => expect(element.querySelector('[aria-label="Git workbench"]')).not.toBeNull())
  return element
}
async function click(selector: string) { const button = element.querySelector<HTMLButtonElement>(selector); expect(button).not.toBeNull(); await act(async () => button!.click()) }
beforeEach(() => {
  localStorage.clear(); commitDetails.mockReset().mockResolvedValue(details()); commitDiff.mockClear(); history.mockClear()
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
  await click('[aria-label="Open diff for new.ts"]')
  await vi.waitFor(() => expect(element.querySelector('[data-commit-canvas]')?.textContent).toBe('fixed old|fixed new'))
  expect(element.querySelector('[data-commit-canvas]')?.getAttribute('data-readonly')).toBe('true')
  expect(commitDiff).toHaveBeenCalledExactlyOnceWith('repo', { kind: 'commit', snapshot: details().snapshot, file: { path: 'new.ts', origPath: 'old.ts' } })
  expect(api.files.read).not.toHaveBeenCalled(); expect(api.files.observe).not.toHaveBeenCalled(); expect(api.files.write).not.toHaveBeenCalled()
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
