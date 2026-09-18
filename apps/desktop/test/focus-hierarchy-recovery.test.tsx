// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
const draws = vi.hoisted(() => ({ lanes: 0 }))
vi.mock('../src/renderer/src/components/FocusProjectLanes', async importOriginal => {
  const original = await importOriginal<typeof import('../src/renderer/src/components/FocusProjectLanes')>()
  return { ...original, FocusProjectLanes: (props: Parameters<typeof original.FocusProjectLanes>[0]) => { draws.lanes++; return createElement(original.FocusProjectLanes, props) } }
})
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
const baseline = useAppStore.getState()
let root: Root, container: HTMLDivElement
function session(id: string, path: string, state: 'disconnected' | 'working' | 'done' = 'disconnected'): SessionSnapshot {
  return { id, kind: 'agent', hostId: 'local', workspacePath: path, providerId: 'codex', executorId: 'codex', label: id, processState: state === 'disconnected' ? 'disconnected' : 'running', status: { state, observedAt: 1, source: 'run-process' }, capabilities: {}, control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: id } } } as SessionSnapshot
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  const config = { workspaces: [{ id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: '/scratch', name: 'Scratch', kind: 'folder' }, { id: 'repo', hostId: 'local', path: '/repo', name: 'Product', kind: 'folder' }, { id: 'branch', hostId: 'local', path: '/checkout', name: 'Product feature', kind: 'worktree', repoPath: '/repo', branch: 'feature/compact' }] } as AppConfig
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([{ id: 'launcher:alpha', title: 'Planning', directoryPath: '/scratch/topic--launcher--alpha', topicPath: '', summary: '', collaborators: [] }, { id: 'launcher:beta', title: 'Bug fixes', directoryPath: '/scratch/topic--launcher--beta', topicPath: '', summary: '', collaborators: [] }])
  vi.spyOn(api.workspaces, 'listBranches').mockResolvedValue({ kind: 'git-repository', hostId: 'local', repoPath: '/repo', branches: [{ name: 'feature/compact', worktreePath: '/checkout', workspaceId: 'branch', isCurrent: false }] })
  useAppStore.setState({ config, sessions: [session('one', '/scratch/topic--launcher--alpha'), session('two', '/scratch/topic--launcher--alpha'), session('three', '/scratch/topic--launcher--beta'), session('live', '/checkout', 'working')], timelines: {}, tabs: {}, agentNames: {}, workspaceFileRevisions: {}, agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } } })
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useAppStore.setState(baseline, true); vi.restoreAllMocks() })
const render = () => act(async () => { root.render(createElement(GlobalFocusSurface)); await Promise.resolve() })
it('shows actual named Topic and branch lanes with compact recovery in their own idle groups', async () => {
  await render()
  const lanes = [...container.querySelectorAll<HTMLElement>('[data-lane-id]')]
  expect(lanes).toHaveLength(3)
  expect(lanes.map(lane => lane.querySelector('.focus-project-lanes__heading')!.parentElement!.className)).toEqual(['focus-context-group__header', 'focus-context-group__header', 'focus-context-group__header'])
  expect(lanes.map(lane => lane.querySelector('.focus-project-lanes__axis')!.textContent)).toEqual(['Productfeature/compact', 'ScratchPlanning', 'ScratchBug fixes'])
  expect(container.querySelectorAll('[data-session-id]')).toHaveLength(1)
  const vaults = [...container.querySelectorAll<HTMLButtonElement>('.focus-recovery-toggle')]
  expect(vaults.map(button => button.textContent)).toEqual(['Disconnected2', 'Disconnected1'])
  expect(vaults.map(button => button.closest<HTMLElement>('[data-bucket]')!.dataset.bucket)).toEqual(['idle', 'idle'])
  await act(async () => vaults[0]!.click())
  expect(container.querySelectorAll('[data-session-id]')).toHaveLength(3)
  await act(async () => container.querySelector<HTMLButtonElement>('[data-session-id="two"]')!.click())
  expect(useAppStore.getState().agentFocus.execution.sessionId).toBe('two')
  await act(async () => vaults[0]!.click())
  expect(container.querySelector('[data-session-id="two"]')).toBeTruthy()
  expect(container.querySelector('[data-session-id="one"]')).toBeNull()
})
it('search finds a disconnected Topic context without opening every recovery vault', async () => {
  await render()
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Search contexts"]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Planning'); input.dispatchEvent(new Event('input', { bubbles: true })) })
  expect(container.querySelectorAll('[data-lane-id]')).toHaveLength(1)
  expect([...container.querySelectorAll<HTMLElement>('[data-session-id]')].map(row => row.dataset.sessionId)).toEqual(['one', 'two'])
})
it('keeps a checkout lane after removal and does not requery scopes for unrelated output bytes', async () => {
  await render()
  const branchCalls = vi.mocked(api.workspaces.listBranches).mock.calls.length
  const laneDraws = draws.lanes
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(item => ({ ...item, latestOutputBytes: 99 })) })))
  expect(api.workspaces.listBranches).toHaveBeenCalledTimes(branchCalls)
  expect(draws.lanes).toBe(laneDraws)
  vi.mocked(api.workspaces.listBranches).mockResolvedValue({ kind: 'git-repository', hostId: 'local', repoPath: '/repo', branches: [{ name: 'feature/compact', worktreePath: null, workspaceId: null, isCurrent: false }] })
  await act(async () => { useAppStore.setState(state => ({ config: { ...state.config!, workspaces: state.config!.workspaces.filter(workspace => workspace.id !== 'branch') }, workspaceFileRevisions: { repo: 1 }, sessions: state.sessions.map(item => item.id === 'live' ? { ...item, processState: 'disconnected', status: { ...item.status, state: 'disconnected' } } : item) })); await Promise.resolve() })
  // Root is no longer represented by a Session; its cached checkout evidence still preserves independent identity.
  const orphan = container.querySelector<HTMLElement>('[data-lane-id*="checkout"]')!
  expect(orphan).toBeTruthy(); expect(orphan.textContent).toContain('feature/compact')
  expect(orphan.dataset.recovery).toBe('removed')
  expect(orphan.querySelector('.focus-recovery-toggle')!.textContent).toBe('Disconnected1')
})
