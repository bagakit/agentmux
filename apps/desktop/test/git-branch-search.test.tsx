const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act } from 'react'
import { type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import type { WorkspaceBranchRecord, WorkspaceBranchesSnapshot, WorkspaceRecord } from '../src/shared/contracts'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
})
const fixture = vi.hoisted(() => ({
  snapshot: null as WorkspaceBranchesSnapshot | null,
  loading: false,
  error: null as string | null,
  refresh: vi.fn(),
  state: {
    localHome: _hygiene_fixturePath("home/private"),
    config: { hosts: [{ id: 'local', kind: 'local' }], executors: {}, projects: [], copyPathsAsAbsolute: false },
    sessions: [],
    pinnedItems: {} as Record<string, string[]>,
    togglePinnedItem: vi.fn(),
    activateWorkspaceSelection: vi.fn(),
    removeWorktree: vi.fn(),
    runFanOut: vi.fn()
  }
}))
vi.mock('../src/renderer/src/hooks/useWorkspaceBranches', () => ({
  useWorkspaceBranches: () => ({ snapshot: fixture.snapshot, loading: fixture.loading, error: fixture.error, refresh: fixture.refresh })
}))
vi.mock('../src/renderer/src/hooks/useGitAheadBehind', () => ({ useGitAheadBehind: () => ({ facts: null }) }))
vi.mock('../src/renderer/src/store', () => ({
  useAppStore: Object.assign((select: (state: typeof fixture.state) => unknown) => select(fixture.state), { getState: () => fixture.state })
}))

import { BranchesPanel } from '../src/renderer/src/components/BranchesPanel'
import { api } from '../src/renderer/src/lib/api'
import { workspaceProjectId } from '../src/renderer/src/lib/workspace-projects'

const workspace: WorkspaceRecord = { id: 'branch-search', hostId: 'local', name: 'Private repo', path: _hygiene_fixturePath("repo"), repoPath: _hygiene_fixturePath("repo"), kind: 'folder', branch: 'main' }
const branch = (name: string, extra: Partial<WorkspaceBranchRecord> = {}): WorkspaceBranchRecord => ({ name, isCurrent: false, worktreePath: null, workspaceId: null, ...extra })
const branches = [
  branch('main', { isCurrent: true, worktreePath: _hygiene_fixturePath("repo"), workspaceId: workspace.id }),
  branch('feature/parser', { worktreePath: _hygiene_fixturePath("repo/.worktrees/parser-lane"), workspaceId: 'parser-workspace' }),
  branch('fix/external', { worktreePath: _hygiene_fixturePath("home/private/checkouts/external"), workspaceId: 'external-workspace' }),
  branch('feature/renderer'),
  branch('topic/empty-path', { worktreePath: '' }),
  branch('release/next')
]
let element: HTMLDivElement
let root: Root
let openBranch: MockInstance<typeof api.workspaces.openBranch>
let createWorktree: MockInstance<typeof api.workspaces.createWorktreeForBranch>

async function render(target = workspace) { await act(async () => root.render(<BranchesPanel workspace={target} />)) }
function input() { return element.querySelector<HTMLInputElement>('input[aria-label="Find branch or worktree path"]')! }
function rows() { return [...element.querySelectorAll<HTMLButtonElement>('.branch-row__open')] }
function names() { return rows().map(button => button.querySelector('strong')?.textContent) }
function group(kind: 'worktrees' | 'branches') { return element.querySelector<HTMLElement>(`[data-branch-group="${kind}"]`)! }
function scroll(kind: 'worktrees' | 'branches') { return group(kind).querySelector<HTMLDivElement>('.branch-group__rows')! }
async function query(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), value)
    input().dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function filter(value: string) {
  const select = element.querySelector<HTMLSelectElement>('select[aria-label="Filter branches"]')!
  await act(async () => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })) })
}
async function key(target: Element, value: string, init: KeyboardEventInit = {}) {
  await act(async () => target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...init })))
}
async function clear() {
  const button = element.querySelector<HTMLButtonElement>('[aria-label="Clear branch search and filter"]')
  expect(button).not.toBeNull()
  await act(async () => button!.click())
}
function count() { return element.querySelector('[aria-label="Local branch count"]')!.textContent }

beforeEach(async () => {
  fixture.snapshot = { kind: 'git-repository', hostId: 'local', repoPath: _hygiene_fixturePath("repo"), branches }
  fixture.loading = false; fixture.error = null
  fixture.state.pinnedItems = { [workspaceProjectId(workspace)]: ['feature/renderer', 'feature/parser'] }
  fixture.refresh.mockReset(); fixture.state.togglePinnedItem.mockReset(); fixture.state.activateWorkspaceSelection.mockReset()
  openBranch = vi.spyOn(api.workspaces, 'openBranch').mockResolvedValue({ config: fixture.state.config, workspaceId: 'parser-workspace' } as never)
  createWorktree = vi.spyOn(api.workspaces, 'createWorktreeForBranch').mockResolvedValue({} as never)
  vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
  element = document.createElement('div'); document.body.append(element); root = createClientUiRoot(element)
  await render()
})
afterEach(async () => { await act(async () => root.unmount()); element.remove(); vi.restoreAllMocks() })

it('matches case-insensitive trimmed names while preserving the two original groups and match/total counts', async () => {
  expect(names()).toHaveLength(6); expect(count()).toBe('6 branches')
  await query('  FeAtUrE/  ')
  expect(names()).toEqual(['feature/parser', 'feature/renderer'])
  expect(group('worktrees').querySelector('strong')?.textContent).toBe('feature/parser')
  expect(group('branches').querySelector('strong')?.textContent).toBe('feature/renderer')
  expect(count()).toBe('2 / 6 branches')
  await clear(); expect(names()).toHaveLength(6); expect(count()).toBe('6 branches')
  expect(input().value).toBe(''); expect(document.activeElement).toBe(input())
})

it('finds actual, repo-relative and display-preference paths without changing their original action target', async () => {
  for (const path of [_hygiene_fixturePath("repo/.worktrees/parser-lane"), './.worktrees/parser-lane']) {
    await query(path); expect(names()).toEqual(['feature/parser'])
  }
  await query('~/checkouts/EXTERNAL'); expect(names()).toEqual(['fix/external'])
  expect(rows()[0]!.querySelector('small')?.textContent).toBe('~/checkouts/external')
  await act(async () => rows()[0]!.click())
  expect(openBranch).toHaveBeenCalledExactlyOnceWith(workspace.id, 'fix/external')
  expect(fixture.state.activateWorkspaceSelection).toHaveBeenCalledExactlyOnceWith(await openBranch.mock.results[0]!.value)
  expect(createWorktree).not.toHaveBeenCalled()
})

it('shows and searches a shorter sibling path while keeping its full tooltip and original branch action', async () => {
  const repo = _hygiene_fixturePath("work/repos/repository"), path = _hygiene_fixturePath("work/repos/review-worktree")
  const sibling = branch('feature/review', { worktreePath: path, workspaceId: 'review-workspace' })
  fixture.snapshot = { kind: 'git-repository', hostId: 'local', repoPath: repo, branches: [sibling] }
  await render({ ...workspace, path: repo, repoPath: repo })
  expect(rows()[0]!.querySelector('small')?.textContent).toBe('../review-worktree')
  expect(rows()[0]!.querySelector('small')?.title).toBe(path)
  await query('../review-worktree'); expect(names()).toEqual(['feature/review'])
  await query(path); expect(names()).toEqual(['feature/review'])
  await act(async () => rows()[0]!.click())
  expect(openBranch).toHaveBeenCalledExactlyOnceWith(workspace.id, sibling.name)
  expect(sibling.worktreePath).toBe(path)
  expect(createWorktree).not.toHaveBeenCalled()
})

it('uses current, repo-scoped pinned and real worktree facts as mutually exclusive filters combined with text', async () => {
  await filter('current'); expect(names()).toEqual(['main']); expect(count()).toBe('1 / 6 branches')
  await filter('pinned'); expect(names()).toEqual(['feature/parser', 'feature/renderer'])
  fixture.state.pinnedItems = { [workspaceProjectId({ ...workspace, repoPath: _hygiene_fixturePath("another-repo") })]: ['release/next'] }
  await render(); expect(names()).toEqual([]); expect(count()).toBe('0 / 6 branches')
  await filter('worktree'); expect(names()).toEqual(['main', 'feature/parser', 'fix/external'])
  expect(element.querySelector('[data-branch-group="branches"]')).toBeNull()
  await query('parser'); expect(names()).toEqual(['feature/parser']); expect(count()).toBe('1 / 6 branches')
  await clear(); expect(element.querySelector<HTMLSelectElement>('select')!.value).toBe('all'); expect(names()).toHaveLength(6)
})

it('restores both independent reading positions after multiple search and filter edits', async () => {
  const list = element.querySelector<HTMLDivElement>('.branches-scroll')!
  list.scrollTop = 11; scroll('worktrees').scrollTop = 73; scroll('branches').scrollTop = 121
  await query('feature'); scroll('worktrees').scrollTop = 2; scroll('branches').scrollTop = 4
  await filter('pinned'); await query('renderer')
  await clear()
  expect(list.scrollTop).toBe(11); expect(scroll('worktrees').scrollTop).toBe(73); expect(scroll('branches').scrollTop).toBe(121)
  // The next search captures the new original context, not the previous search's memory.
  scroll('branches').scrollTop = 206; await query('missing'); await key(input(), 'Escape')
  expect(scroll('branches').scrollTop).toBe(206); expect(count()).toBe('6 branches')
})

it('Enter only locates a matching row, reveals a collapsed group, and clear restores its original collapse', async () => {
  await act(async () => group('worktrees').querySelector<HTMLButtonElement>('button')!.click())
  expect(scroll('worktrees')).toBeNull()
  await query('parser'); input().focus(); await key(input(), 'Enter')
  expect(group('worktrees').querySelector('button')!.getAttribute('aria-expanded')).toBe('true')
  expect(document.activeElement).toBe(rows()[0]); expect(names()).toEqual(['feature/parser'])
  expect(rows()[0]!.getAttribute('aria-pressed')).toBe('false')
  expect(openBranch).not.toHaveBeenCalled(); expect(createWorktree).not.toHaveBeenCalled(); expect(document.querySelector('[role="dialog"]')).toBeNull()
  await clear()
  expect(group('worktrees').querySelector('button')!.getAttribute('aria-expanded')).toBe('false')
  expect(scroll('worktrees')).toBeNull(); expect(group('branches').querySelectorAll('.branch-row')).toHaveLength(3)
})

it('does not treat IME or modified Enter as a locate or open request', async () => {
  await query('renderer'); input().focus()
  await key(input(), 'Enter', { isComposing: true }); expect(document.activeElement).toBe(input())
  await key(input(), 'Enter', { ctrlKey: true }); expect(document.activeElement).toBe(input())
  await key(input(), 'Enter', { shiftKey: true }); expect(document.activeElement).toBe(input())
  await key(input(), 'Enter', { keyCode: 229 }); expect(document.activeElement).toBe(input())
  expect(openBranch).not.toHaveBeenCalled(); expect(createWorktree).not.toHaveBeenCalled()
})

it('scopes arrow/Home/End navigation to visible row open buttons and leaves text editing and Pin alone', async () => {
  await query('feature'); input().focus(); await key(input(), 'ArrowDown'); expect(document.activeElement).toBe(input())
  await key(input(), 'Enter'); expect(document.activeElement).toBe(rows()[0])
  await key(rows()[0]!, 'ArrowDown'); expect(document.activeElement).toBe(rows()[1])
  await key(rows()[1]!, 'Home'); expect(document.activeElement).toBe(rows()[0])
  await key(rows()[0]!, 'End'); expect(document.activeElement).toBe(rows()[1])
  await key(rows()[1]!, 'ArrowUp', { metaKey: true }); expect(document.activeElement).toBe(rows()[1])
  const pin = element.querySelector<HTMLButtonElement>('.branch-row__pin')!; pin.focus(); await key(pin, 'ArrowDown'); expect(document.activeElement).toBe(pin)
  const outside = document.createElement('button'); document.body.append(outside); outside.focus(); await key(outside, 'Home'); expect(document.activeElement).toBe(outside); outside.remove()
  expect(openBranch).not.toHaveBeenCalled(); expect(createWorktree).not.toHaveBeenCalled()
})

it('retains explicit pure-branch creation and independent Pin actions after locating', async () => {
  await query('renderer'); await key(input(), 'Enter')
  expect(document.activeElement).toBe(rows()[0]); expect(document.querySelector('[role="dialog"]')).toBeNull()
  await act(async () => element.querySelector<HTMLButtonElement>('.branch-row__pin')!.click())
  expect(fixture.state.togglePinnedItem).toHaveBeenCalledExactlyOnceWith(workspaceProjectId(workspace), 'feature/renderer')
  expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(openBranch).not.toHaveBeenCalled()
  await act(async () => rows()[0]!.click())
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Create worktree')
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('feature/renderer')
  expect(openBranch).not.toHaveBeenCalled(); expect(createWorktree).not.toHaveBeenCalled()
})

it('distinguishes no matches from an empty repository and keeps an immediate clear action', async () => {
  await query('missing'); expect(names()).toEqual([]); expect(count()).toBe('0 / 6 branches')
  expect(element.textContent).toContain('No matching branches'); expect(element.textContent).not.toContain('No local branches')
  const clearEmpty = [...element.querySelectorAll<HTMLButtonElement>('.branches-empty button')][0]!
  await act(async () => clearEmpty.click()); expect(names()).toHaveLength(6)
  fixture.snapshot = { kind: 'git-repository', hostId: 'local', repoPath: _hygiene_fixturePath("repo"), branches: [] }; await render()
  expect(element.textContent).toContain('No local branches'); expect(element.textContent).not.toContain('No matching branches')
})

it('keeps unavailable, non-repository and pending states separate from a filtered empty result', async () => {
  fixture.snapshot = null; fixture.error = 'Private host unavailable'; await render()
  expect(element.textContent).toContain('Branches unavailable'); expect(element.textContent).toContain('Private host unavailable')
  expect(element.querySelector('.branch-search')).toBeNull()
  await act(async () => element.querySelector<HTMLButtonElement>('.branches-empty button')!.click()); expect(fixture.refresh).toHaveBeenCalledOnce()
  fixture.error = null; fixture.loading = true; await render(); expect(element.querySelector('.branches-empty')).toBeNull()
  fixture.loading = false; fixture.snapshot = { kind: 'not-a-git-repository', hostId: 'local', workspacePath: _hygiene_fixturePath("repo") }; await render()
  expect(element.textContent).toContain('Not a Git repository'); expect(element.querySelector('.branch-search')).toBeNull()
})

it.each([{ id: 'other-workspace' }, { path: _hygiene_fixturePath("new") }, { hostId: 'other-host' }])('drops search and reading memory when the workspace resource changes %j', async change => {
  scroll('branches').scrollTop = 111; await query('feature'); await filter('pinned')
  scroll('worktrees').scrollTop = 73
  fixture.snapshot = { kind: 'git-repository', hostId: 'local', repoPath: _hygiene_fixturePath("new"), branches: [branch('new-main', { isCurrent: true, worktreePath: _hygiene_fixturePath("new") })] }
  await render({ ...workspace, ...change, branch: 'new-main' })
  expect(input().value).toBe(''); expect(element.querySelector<HTMLSelectElement>('select')!.value).toBe('all')
  expect(count()).toBe('1 branches'); expect(names()).toEqual(['new-main']); expect(scroll('worktrees').scrollTop).toBe(0)
})
