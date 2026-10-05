const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { type Root } from 'react-dom/client'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import {composerConfig,composerSession} from './helpers/composer-dom-fixture'
import {scratchTopicsScope} from '../src/renderer/src/lib/scratch-topic-snapshots'
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
  const base=composerSession(id);return {...base,workspacePath:path,processState:state==='disconnected'?'interrupted':'running',status:{state,source:'native-hook',observedAt:1}} as SessionSnapshot
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  const config = { ...composerConfig, workspaces: [{ id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: _hygiene_fixturePath("scratch"), name: 'Scratch', kind: 'folder' }, { id: 'repo', hostId: 'local', path: _hygiene_fixturePath("repo"), name: 'Product', kind: 'folder' }, { id: 'branch', hostId: 'local', path: _hygiene_fixturePath("checkout"), name: 'Product feature', kind: 'worktree', repoPath: _hygiene_fixturePath("repo"), branch: 'feature/compact' }] } as AppConfig
  const topics=[{ id: 'launcher:alpha', title: 'Planning', directoryPath: _hygiene_fixturePath("scratch/topic--launcher--alpha"), topicPath: '', summary: '', collaborators: [] }, { id: 'launcher:beta', title: 'Bug fixes', directoryPath: _hygiene_fixturePath("scratch/topic--launcher--beta"), topicPath: '', summary: '', collaborators: [] }]
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue(topics)
  vi.spyOn(api.workspaces, 'listBranches').mockResolvedValue({ kind: 'git-repository', hostId: 'local', repoPath: _hygiene_fixturePath("repo"), branches: [{ name: 'feature/compact', worktreePath: _hygiene_fixturePath("checkout"), workspaceId: 'branch', isCurrent: false }] })
  useAppStore.setState({ config, sessions: [session('one', _hygiene_fixturePath("scratch/topic--launcher--alpha")), session('two', _hygiene_fixturePath("scratch/topic--launcher--alpha")), session('three', _hygiene_fixturePath("scratch/topic--launcher--beta")), session('live', _hygiene_fixturePath("checkout"), 'working')], timelines: {}, tabs: {}, scratchTopicSnapshots:{[SCRATCH_WORKSPACE_ID]:{scope:scratchTopicsScope(config.workspaces[0]!),revision:0,topics,error:null,reading:false}}, agentNames: {}, workspaceFileRevisions: {}, agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } } })
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useAppStore.setState(baseline, true); vi.restoreAllMocks() })
const render = () => act(async () => { root.render(createElement(GlobalFocusSurface)); await Promise.resolve() })
it('keeps original branch and named Topic identities on the same board after interruption',async()=>{
  await render()
  const lanes=[...container.querySelectorAll<HTMLElement>('[data-lane-id]')]
  expect(lanes).toHaveLength(3)
  expect(lanes.map(lane=>[...lane.querySelectorAll('.focus-project-lanes__label')].map(label=>label.textContent).join('')).sort()).toEqual(['Productfeature/compact','Planning','Bug fixes'].sort())
  expect([...container.querySelectorAll<HTMLElement>('.focus-context[data-session-id]')].map(row=>row.dataset.sessionId).sort()).toEqual(['live','one','two','three'].sort())
  expect(container.querySelector('[aria-label="Disconnected projects"]')).toBeNull()
  const original=container.querySelector('[data-session-id="one"]')
  await act(async()=>container.querySelector<HTMLButtonElement>('[data-session-id="two"]')!.click())
  expect(useAppStore.getState().agentFocus.execution.sessionId).toBe('two');expect(container.querySelector('[data-session-id="one"]')).toBe(original)
})

it('search finds an interrupted Topic directly in its original Recovery group', async () => {
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
  vi.mocked(api.workspaces.listBranches).mockResolvedValue({ kind: 'git-repository', hostId: 'local', repoPath: _hygiene_fixturePath("repo"), branches: [{ name: 'feature/compact', worktreePath: null, workspaceId: null, isCurrent: false }] })
  await act(async () => { useAppStore.setState(state => ({ config: { ...state.config!, workspaces: state.config!.workspaces.filter(workspace => workspace.id !== 'branch') }, workspaceFileRevisions: { repo: 1 }, sessions: state.sessions.map(item => item.id === 'live' ? { ...item, processState: 'interrupted', status: { ...item.status, state: 'disconnected' } } : item) })); await Promise.resolve() })
  // Root is no longer represented by a Session; its cached checkout evidence still preserves independent identity.
  const orphan = container.querySelector<HTMLElement>('[data-lane-id*="checkout"]')!
  expect(orphan).toBeTruthy(); expect(orphan.textContent).toContain('feature/compact')
  expect(orphan.dataset.recovery).toBe('removed')
  expect(orphan.closest('.focus-project-board')).not.toBeNull();expect(orphan.querySelector('[data-bucket="idle"]')).not.toBeNull()
  expect([...orphan.querySelectorAll<HTMLElement>('[data-session-id]')].map(row => row.dataset.sessionId)).toEqual(['live'])
})
