// @vitest-environment happy-dom
import { act } from 'react'
import { selectHistoryReference } from './helpers/git-history-reference'
import { installGitHistoryViewport } from './helpers/git-history-viewport'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { SurfaceToolDock } from '../src/renderer/src/components/SurfaceToolDock'
import { GitHistoryProvider, gitWorkspaceKey } from '../src/renderer/src/features/git/history/GitHistoryContext'
import { api } from '../src/renderer/src/lib/api'
import { directoryIdentity, workspaceZoneId } from '../src/shared/space-addresses'
import { useAppStore, restorePersistedUiState } from '../src/renderer/src/store'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import type { GitHistoryResult, GitStatusResult } from '../src/shared/git-contracts'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
import * as zoneFileActions from '../src/renderer/src/lib/workspace-zone-file-actions'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import type { WorkspaceRecord } from '../src/shared/contracts'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


const dom = composerDOM()
const root = { ...composerConfig.workspaces[0]!, repoPath: composerConfig.workspaces[0]!.path, branch: 'main' }
const other = { ...root, id: 'feature-workspace', kind: 'worktree' as const, name: 'Feature work', path: fixturePath('feature-worktree'), branch: 'feature' }
const config = { ...composerConfig, workspaces: [root, other] }
const spaceId = directoryIdentity(root.hostId, root.path)
const status = vi.fn<(workspaceId: string) => Promise<GitStatusResult>>()
const history = vi.fn<(workspaceId: string, input: { ref?: string | null }) => Promise<GitHistoryResult>>()
const commit = vi.fn(async () => undefined)

beforeEach(() => {
  installGitHistoryViewport()
  useAppStore.setState({ config, activeWorkspaceId: root.id, workspaceTool: 'files-branches', workspaceGitView: 'changes',
    gitCommitDrafts: {}, workbenchSpaceSelection: null, spaceZoneBindings: {}, topicCategories: [],
    sessions: [composerSession()], tabs: {}, layouts: { [root.id]: createWorkspaceLayout('root-group'), [other.id]: createWorkspaceLayout('other-group') } })
  status.mockReset().mockImplementation(async workspaceId => ({ kind: 'git-repository', hostId: root.hostId, repoPath: root.path,
    repoRelativePrefix: '', branch: workspaceId === root.id ? 'main' : 'feature',
    changes: [{ path: workspaceId === root.id ? 'root.ts' : 'feature.ts', origPath: null, index: 'M', worktree: ' ', staged: true, unstaged: false, untracked: false }] }))
  history.mockReset().mockImplementation(async (_workspaceId, input) => ({ kind: 'ready', snapshot: {
    hostId: root.hostId, repoPath: root.path, roots: ['a'.repeat(40)], checkedAt: _historyFixtureEpoch(0, 0, 1), selectedRef: input.ref ?? null,
    refs: [{ name: 'refs/heads/main', kind: 'local', oid: 'a'.repeat(40) }, { name: 'refs/heads/feature', kind: 'local', oid: 'b'.repeat(40) }]
  }, commits: [], nextCursor: null }))
  commit.mockClear()
  Object.defineProperty(window, 'agentmux', { configurable: true, value: { git: { status, history, commit, aheadBehind: async () => null } } })
})

async function render(workspace: WorkspaceRecord = root) {
  await dom.render(<GitHistoryProvider workspace={workspace}><SurfaceToolDock workspace={workspace} /></GitHistoryProvider>)
}
async function tool(id: string) { await dom.click(`[data-space-tool="${id}"]`) }
async function view(label: string) {
  const button = visible<HTMLButtonElement>('[aria-label="Git view"] button').find(value => value.textContent === label)
  expect(button).toBeDefined()
  await act(async () => button!.click())
}
function visible<ElementType extends HTMLElement = HTMLElement>(selector: string) {
  return [...dom.container.querySelectorAll<ElementType>(selector)].filter(element => !element.closest('[hidden]'))
}
async function draft(message: string) {
  const textarea = visible<HTMLTextAreaElement>('.commit-box textarea')[0]!
  expect(textarea).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, message)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('Space Zone navigation and Git on the actual Dock', () => {
  it('keeps Zone navigation and Git as different peer tools without nested source-control views', async () => {
    await render()
    expect([...dom.container.querySelectorAll('[data-space-tool]')].map(button => button.getAttribute('aria-label'))).toEqual(['Files + Zones', 'Agents', 'Git'])
    expect(visible('[aria-label="Git view"]')).toHaveLength(0)
    expect(visible('.workspace-zones-panel')).toHaveLength(1)
    const summary = visible<HTMLButtonElement>('.workspace-changes-summary')[0]!
    expect(summary.closest('.workspace-zones-footer')).not.toBeNull()
    expect(summary.closest('.workspace-zones-panel')).not.toBeNull()
    expect(summary.dataset.workspaceId).toBe(root.id)
    expect(summary.querySelector('strong')?.textContent).toBe('1 changed file')
    expect(summary.querySelector('small')?.textContent).toBe('Current folder · main')
    expect(history).not.toHaveBeenCalled()
    const branches = vi.spyOn(api.workspaces, 'listBranches')
    await dom.click('[aria-label="Open changes for this Zone"]')
    expect(useAppStore.getState().workspaceTool).toBe('git')
    expect(visible('[aria-label="Git view"]')).toHaveLength(1)
    expect(visible('.file-explorer')).toHaveLength(0)
    expect(visible('.changes-panel')).toHaveLength(1)
    expect(branches).not.toHaveBeenCalled()
  })

  it('opens existing worktree management from Files without creating a worktree or changing the original Zone and workface', async () => {
    const branches = vi.spyOn(api.workspaces, 'listBranches').mockResolvedValue({ kind: 'git-repository', hostId: root.hostId, repoPath: root.path, branches: [] })
    const create = vi.spyOn(api.workspaces, 'createWorktreeForBranch'), open = vi.spyOn(api.workspaces, 'openBranch')
    await render()
    const before = useAppStore.getState()
    await dom.click('[aria-label="Manage worktrees"]')
    expect(useAppStore.getState().workspaceTool).toBe('git')
    expect(useAppStore.getState().workspaceGitView).toBe('branches')
    expect(visible('[aria-label="Git view"] [aria-selected="true"]')[0]?.textContent).toBe('Branches')
    expect(branches.mock.calls.every(([workspaceId]) => workspaceId === root.id)).toBe(true)
    expect(branches).toHaveBeenCalled()
    expect(useAppStore.getState().workbenchSpaceSelection).toBe(before.workbenchSpaceSelection)
    expect(useAppStore.getState().tabs).toBe(before.tabs)
    expect(useAppStore.getState().sessions).toBe(before.sessions)
    expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(create).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
    expect(history).not.toHaveBeenCalled()
  })

  it('keeps the Changes footer on the explicitly selected resource and opens that exact worktree scope', async () => {
    const zoneId = workspaceZoneId(spaceId, other.id)
    useAppStore.setState({ workbenchSpaceSelection: { spaceId, zoneId, workspaceId: root.id,
      topicId: null, tabId: null, groupId: null, regionId: null } })
    await render()
    const summary = visible<HTMLButtonElement>('.workspace-changes-summary')[0]!
    expect(summary.closest('.workspace-zones-panel')).not.toBeNull()
    expect(summary.dataset.workspaceId).toBe(other.id)
    expect(summary.querySelector('strong')?.textContent).toBe('1 changed file')
    expect(summary.querySelector('small')?.textContent).toBe('Current worktree · feature')
    expect(summary.title).toContain(`${other.path} · ${other.hostId}`)
    expect(status.mock.calls.every(([workspaceId]) => workspaceId === other.id)).toBe(true)
    const before = useAppStore.getState()
    await act(async () => summary.click())
    expect(useAppStore.getState().workspaceTool).toBe('git')
    expect(useAppStore.getState().workspaceGitView).toBe('changes')
    expect(visible('[data-git-workspace]')[0]?.getAttribute('data-git-workspace')).toBe(other.id)
    expect(useAppStore.getState().workbenchSpaceSelection).toBe(before.workbenchSpaceSelection)
    expect(useAppStore.getState().activeWorkspaceId).toBe(root.id)
    expect(useAppStore.getState().tabs).toBe(before.tabs)
    expect(useAppStore.getState().sessions).toBe(before.sessions)
  })

  it('does not move the Zone or changes target when selecting a History reference', async () => {
    await render()
    await tool('git')
    const before = useAppStore.getState()
    await view('History')
    await selectHistoryReference(dom.container, 'refs/heads/feature')
    expect(history.mock.calls.at(-1)).toEqual([root.id, { ref: 'refs/heads/feature' }])
    expect(useAppStore.getState().workbenchSpaceSelection).toBe(before.workbenchSpaceSelection)
    expect(useAppStore.getState().sessions).toBe(before.sessions)
    await view('Changes')
    expect(visible('[data-git-workspace]')[0]?.getAttribute('data-git-workspace')).toBe(root.id)
    expect(visible('.workspace-git-path')[0]?.textContent).toBe(root.path)
    expect(dom.container.querySelector('[aria-label="Stage root.ts"]')).toBeNull()
    await tool('files-branches')
    await tool('git')
    await view('History')
    expect(visible('[aria-label="History reference"]')[0]?.getAttribute('data-value')).toBe('refs/heads/feature')
  })

  it('preserves commit drafts across tools and isolates them by original resource', async () => {
    await render()
    await tool('git')
    await draft('Root draft')
    await tool('agents')
    await tool('git')
    expect(visible<HTMLTextAreaElement>('.commit-box textarea')[0]?.value).toBe('Root draft')
    await act(async () => useAppStore.setState({ workbenchSpaceSelection: { spaceId, zoneId: workspaceZoneId(spaceId, other.id),
      workspaceId: root.id, topicId: null, tabId: null, groupId: null, regionId: null } }))
    expect(visible('[data-git-workspace]')[0]?.getAttribute('data-git-workspace')).toBe(other.id)
    expect(visible<HTMLTextAreaElement>('.commit-box textarea')[0]?.value).toBe('')
    await draft('Feature draft')
    await act(async () => useAppStore.setState({ workbenchSpaceSelection: null }))
    expect(visible<HTMLTextAreaElement>('.commit-box textarea')[0]?.value).toBe('Root draft')
    expect(useAppStore.getState().gitCommitDrafts[gitWorkspaceKey(other)]).toBe('Feature draft')
  })

  it('retains unknown Zone identity without directing Changes writes at the project root', async () => {
    const zoneId = 'retained-unavailable-zone'
    useAppStore.setState({ spaceZoneBindings: { [zoneId]: { spaceId, workspaceId: 'missing-resource' } },
      workbenchSpaceSelection: { spaceId, zoneId, workspaceId: root.id, topicId: null, tabId: null, groupId: null, regionId: null } })
    await render()
    expect(visible('.workspace-changes-summary')).toHaveLength(0)
    expect(visible('[role="status"]').filter(element => /unavailable/i.test(element.textContent ?? ''))).toHaveLength(1)
    await tool('git')
    expect(visible('.changes-panel')).toHaveLength(0)
    expect(visible('[role="status"]').some(element => /unavailable|unconfirmed/i.test(element.textContent ?? ''))).toBe(true)
    expect(status).not.toHaveBeenCalled()
    expect(useAppStore.getState().workbenchSpaceSelection?.zoneId).toBe(zoneId)
    expect(commit).not.toHaveBeenCalled()
  })

  it('commits only to the selected Zone resource and preserves unrelated drafts', async () => {
    useAppStore.getState().setGitCommitDraft(gitWorkspaceKey(root), 'Keep root draft')
    useAppStore.setState({ workbenchSpaceSelection: { spaceId, zoneId: workspaceZoneId(spaceId, other.id),
      workspaceId: root.id, topicId: null, tabId: null, groupId: null, regionId: null } })
    await render()
    await tool('git')
    await draft('Commit feature change')
    await dom.click('.commit-box button[type="submit"]')
    expect(commit).toHaveBeenCalledExactlyOnceWith(other.id, 'Commit feature change')
    expect(useAppStore.getState().gitCommitDrafts[gitWorkspaceKey(root)]).toBe('Keep root draft')
    expect(useAppStore.getState().gitCommitDrafts[gitWorkspaceKey(other)]).toBeUndefined()
  })

  it('opens a Changes diff through the exact foreign Zone instead of the active display directory', async () => {
    useAppStore.setState({ workbenchSpaceSelection: { spaceId, zoneId: workspaceZoneId(spaceId, other.id),
      workspaceId: root.id, topicId: null, tabId: null, groupId: null, regionId: null } })
    const open = vi.spyOn(zoneFileActions, 'openWorkspaceZoneFile').mockResolvedValue(undefined)
    const legacy = vi.spyOn(useAppStore.getState(), 'openFileDiff')
    await render()
    await tool('git')
    const button = visible<HTMLButtonElement>('[title="Open diff for feature.ts"]')[0]!
    expect(button).toBeDefined()
    await act(async () => button.click())
    expect(open).toHaveBeenCalledExactlyOnceWith(root, 'feature.ts', 'diff')
    expect(legacy).not.toHaveBeenCalled()
    expect(useAppStore.getState().activeWorkspaceId).toBe(root.id)
  })

  it('clears the previous Zone presentation only on an explicit worktree activation', async () => {
    useAppStore.setState({ workbenchSpaceSelection: { spaceId, zoneId: workspaceZoneId(spaceId, root.id),
      workspaceId: root.id, topicId: null, tabId: null, groupId: null, regionId: null }, workbenchNavigationInputPolicy: 'target' })
    const before = useAppStore.getState()
    useAppStore.getState().activateWorkspaceSelection({ workspace: other, config })
    expect(useAppStore.getState().workbenchSpaceSelection).toBeNull()
    expect(useAppStore.getState().activeWorkspaceId).toBe(other.id)
    expect(useAppStore.getState().workbenchNavigationInputPolicy).toBeNull()
    expect(useAppStore.getState().sessions).toBe(before.sessions)
    expect(useAppStore.getState().tabs).toBe(before.tabs)
  })

  it('persists the original content preference, new Git view and resource drafts without replacement identities', () => {
    useAppStore.getState().setWorkspaceTool('git')
    useAppStore.getState().setWorkspaceGitView('history')
    useAppStore.getState().setGitCommitDraft(gitWorkspaceKey(other), 'Saved draft')
    const saved = useAppStore.persist.getOptions().partialize!(useAppStore.getState())
    const restored = restorePersistedUiState(config, saved)
    expect(restored).toMatchObject({ workspaceTool: 'git', workspaceGitView: 'history', gitCommitDrafts: { [gitWorkspaceKey(other)]: 'Saved draft' } })
    expect(restorePersistedUiState(config, { workspaceTool: 'files-branches' }).workspaceTool).toBe('files-branches')
    expect(restorePersistedUiState(config, { workspaceTool: 'git', gitCommitDrafts: { invalid: 42 } } as never).gitCommitDrafts).toEqual({})
  })

  it('keeps public File focus input-preserving and grants target input only to an explicit GUI File action', async () => {
    vi.spyOn(api.files, 'read').mockImplementation(async (_workspaceId, path) => ({ status: 'read', document: { path, content: 'original policy body', revision: 'policy' } }))
    const open = vi.spyOn(useAppStore.getState(), 'openFile')
    const result = await useAppStore.getState().executeControl({ schemaVersion: 5, requestId: crypto.randomUUID(), operation: 'open.file',
      zoneId: workspaceZoneId(spaceId, root.id), spaceId, path: 'policy-public.ts', focus: true })
    expect(result.operation).toBe('open.file')
    expect(open.mock.calls[0]![5]?.inputPolicy).toBe('preserve')
    expect(useAppStore.getState().workbenchNavigationInputPolicy).toBe('preserve')
    expect(useAppStore.getState().regionCaretFocus).toBeNull()
    await zoneFileActions.openWorkspaceZoneFile(root, 'policy-ui.ts')
    expect(open.mock.calls.at(-1)![5]?.inputPolicy).toBe('target')
    expect(useAppStore.getState().workbenchNavigationInputPolicy).toBe('target')
    expect(useAppStore.getState().regionCaretFocus?.regionId).toBe(useAppStore.getState().workbenchSpaceSelection?.regionId)
  })

  it('does not read unrelated Git resources on Session updates or while Git is hidden', async () => {
    await render()
    const reads = status.mock.calls.length
    await act(async () => useAppStore.setState({ sessions: Array.from({ length: 120 }, (_, index) => composerSession(`unrelated-${index}`)) }))
    expect(status).toHaveBeenCalledTimes(reads)
    expect(history).not.toHaveBeenCalled()
    expect(status.mock.calls.every(([id]) => id === root.id)).toBe(true)
  })

  it('keeps the original worktree form while hiding its portal and pausing unrelated reads', async () => {
    vi.spyOn(api.workspaces, 'listBranches').mockResolvedValue({ kind: 'git-repository', hostId: root.hostId, repoPath: root.path,
      branches: [{ name: 'new-worktree', worktreePath: null, workspaceId: null, isCurrent: false }] })
    const create = vi.spyOn(api.workspaces, 'createWorktreeForBranch')
    await render()
    await tool('git')
    await view('Branches')
    await dom.click('.branch-row__open')
    const input = document.querySelector<HTMLInputElement>('.branch-create-dialog label input')!
    expect(input).not.toBeNull()
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, fixturePath('my-worktree-draft'))
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => useAppStore.getState().setWorkspaceTool('files-branches'))
    expect(document.querySelector('.branch-create-dialog')).toBeNull()
    await tool('git')
    expect(document.querySelector<HTMLInputElement>('.branch-create-dialog label input')?.value).toBe(fixturePath('my-worktree-draft'))
    const scratch = { ...root, id: SCRATCH_WORKSPACE_ID, path: fixturePath('scratch'), name: 'Scratch' }
    await act(async () => useAppStore.setState({ config: { ...config, workspaces: [...config.workspaces, scratch] }, activeWorkspaceId: scratch.id }))
    await render(scratch)
    expect(document.querySelector('.branch-create-dialog')).toBeNull()
    await act(async () => useAppStore.setState({ activeWorkspaceId: root.id }))
    await render(root)
    expect(document.querySelector<HTMLInputElement>('.branch-create-dialog label input')?.value).toBe(fixturePath('my-worktree-draft'))
    expect(create).not.toHaveBeenCalled()
  })

  it('adopts a late worktree receipt without replacing a newer Zone or input target', async () => {
    vi.spyOn(api.workspaces, 'listBranches').mockResolvedValue({ kind: 'git-repository', hostId: root.hostId, repoPath: root.path,
      branches: [{ name: 'feature', worktreePath: other.path, workspaceId: other.id, isCurrent: false }] })
    let complete!: (result: { workspace: typeof other; config: typeof config }) => void
    vi.spyOn(api.workspaces, 'openBranch').mockImplementation(() => new Promise(resolve => { complete = resolve }))
    await render()
    await tool('git')
    await view('Branches')
    await dom.click('.branch-row__open')
    const later = { spaceId, zoneId: workspaceZoneId(spaceId, root.id), workspaceId: root.id,
      topicId: null, tabId: null, groupId: null, regionId: null }
    await act(async () => useAppStore.setState({ workbenchSpaceSelection: later, workbenchNavigationInputPolicy: 'target' }))
    await act(async () => complete({ workspace: other, config }))
    expect(useAppStore.getState().activeWorkspaceId).toBe(root.id)
    expect(useAppStore.getState().workbenchSpaceSelection).toBe(later)
    expect(useAppStore.getState().workbenchNavigationInputPolicy).toBe('target')
    expect(useAppStore.getState().config?.workspaces.some(value => value.id === other.id)).toBe(true)
  })

  it.each(['tools-hidden', 'settings-covered'] as const)('does not reveal a late branch receipt while %s', async reason => {
    const selected = { spaceId, zoneId: workspaceZoneId(spaceId, root.id), workspaceId: root.id,
      topicId: null, tabId: null, groupId: null, regionId: null }
    useAppStore.setState({ workbenchSpaceSelection: selected, workbenchNavigationInputPolicy: 'target', toolsOpen: true })
    vi.spyOn(api.workspaces, 'listBranches').mockResolvedValue({ kind: 'git-repository', hostId: root.hostId, repoPath: root.path,
      branches: [{ name: 'feature', worktreePath: other.path, workspaceId: other.id, isCurrent: false }] })
    let complete!: (result: { workspace: typeof other; config: typeof config }) => void
    vi.spyOn(api.workspaces, 'openBranch').mockImplementation(() => new Promise(resolve => { complete = resolve }))
    await render()
    await tool('git')
    await view('Branches')
    await dom.click('.branch-row__open')
    if (reason === 'tools-hidden') await act(async () => useAppStore.setState({ toolsOpen: false }))
    else await dom.render(<GitHistoryProvider workspace={root}><SurfaceToolDock workspace={root} visible={false} /></GitHistoryProvider>)
    await act(async () => complete({ workspace: other, config }))
    expect(useAppStore.getState().activeWorkspaceId).toBe(root.id)
    expect(useAppStore.getState().workbenchSpaceSelection).toBe(selected)
    expect(useAppStore.getState().workbenchNavigationInputPolicy).toBe('target')
  })
})
