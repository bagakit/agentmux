import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, Profiler } from 'react'
import type { Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { AppConfig, SessionSnapshot, AgentTimelineSnapshot } from '../src/shared/contracts'
import { createClientUiRoot } from './helpers/client-ui-render'
import { WorkspaceSidebar } from '../src/renderer/src/components/WorkspaceSidebar'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { directoryIdentity } from '../src/shared/space-addresses'
import * as recency from '../src/renderer/src/lib/space-folder-icon-recency'
import * as roster from '../src/renderer/src/lib/agent-roster'
import { ProjectActivity } from '../src/renderer/src/components/ProjectActivity'
import * as activityGroups from '../src/renderer/src/lib/activity-groups'
import { useDirectorySessions } from '../src/renderer/src/lib/workbench-session-subscriptions'
import { useTopicSessions } from '../src/renderer/src/lib/topic-session-subscriptions'
import { moteAgent, moteTopics, moteSessions, scratchWorkspace, seedMoteWorkface } from './fixtures/mote-workface'

const initial = useAppStore.getState()
const workspaces: AppConfig['workspaces'] = [
  ...Array.from({ length: 12 }, (_, index) => ({ id: `project-${index}`, name: `Project ${index}`, hostId: 'local', path: (_hygiene_fixturePath("repos/project-") + (index) + ""), kind: 'folder' as const })),
  { id: 'branch-0', name: 'Topic branch', hostId: 'local', path: _hygiene_fixturePath("worktrees/feature"), repoPath: _hygiene_fixturePath("repos/project-0"), branch: 'feature', kind: 'worktree' },
  { id: 'nested', name: 'Nested', hostId: 'local', path: _hygiene_fixturePath("repos/project-0/nested"), kind: 'folder' },
  { id: 'foreign', name: 'Foreign twin', hostId: 'farm', path: _hygiene_fixturePath("repos/project-0"), kind: 'folder' }
]
const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }, { id: 'farm', kind: 'ssh', label: 'Farm', hostname: 'test.invalid' }],
  executors: {}, workspaces, appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
function agent(id: string, path: string, hostId = 'local'): Extract<SessionSnapshot, { kind: 'agent' }> {
  const base = moteAgent(id, null)
  return { ...base, hostId, workspacePath: path, semanticStatus: { state: 'working', source: 'native-hook', observedAt: 2 }, control: { ...base.control, hostId } }
}
let root: Root, container: HTMLDivElement, renders: number
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const sessions = workspaces.flatMap(workspace => [agent(workspace.id + '-one', workspace.path, workspace.hostId), agent(workspace.id + '-two', workspace.path, workspace.hostId)])
  sessions.push(...Array.from({ length: 200 }, (_, index) => agent('outside-' + index, _hygiene_fixturePath("other/") + index)))
  useAppStore.setState({ ...initial, config, sessions, agentNames: {}, timelines: {}, projectGroups: [
    { groupId: 'work', name: 'Work', projectIds: [directoryIdentity('local', _hygiene_fixturePath("repos/project-0")), directoryIdentity('farm', _hygiene_fixturePath("repos/project-0"))] },
    { groupId: 'review', name: 'Review', projectIds: [directoryIdentity('local', _hygiene_fixturePath("repos/project-0")), directoryIdentity('local', _hygiene_fixturePath("repos/project-1"))] }
  ], collapsedProjectGroups: {}, spaceObjectIcons: {}, pinnedItems: { [directoryIdentity('local', _hygiene_fixturePath("repos/project-0"))]: ['feature'] }, activeWorkspaceId: 'project-0', mainSurface: 'workbench', loading: false }, true)
  vi.spyOn(api.git, 'projectIdentity').mockImplementation(async id => { const workspace = workspaces.find(item => item.id === id)!; return { kind: 'known', hostId: workspace.hostId, repoPath: workspace.path, identities: [] } })
  vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'directory', icon: null })
  container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container); renders = 0
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useAppStore.setState(initial, true); vi.restoreAllMocks() })
async function mount(visible = true) {
  await act(async () => root.render(<Profiler id="project-rail" onRender={() => { renders += 1 }}><WorkspaceSidebar visible={visible} /></Profiler>))
  expect(container.querySelectorAll('[data-space-folder]').length).toBeGreaterThan(12)
  expect(container.querySelectorAll('[data-project-group-member]')).toHaveLength(4)
  renders = 0
}
let observedAt = Date.now()
async function update(id: string, state: 'working' | 'waiting' = 'working') {
  const session = useAppStore.getState().sessions.find(item => item.id === id)!
  expect(session).toBeTruthy()
  await act(async () => useAppStore.getState().applyEvent({ type: 'core', hostId: session.hostId, event: { type: 'agent-status', agentSessionId: id, state, evidence: { source: 'native-hook', observedAt: ++observedAt } } }))
}
it('nonempty project directory avoids unrelated Session fanout and eager closed rosters', async () => {
  await mount()
  const recent = vi.spyOn(recency, 'folderLastActivityAt'), agents = vi.spyOn(roster, 'buildAgentRoster')
  for (let index = 0; index < 20; index += 1) await update('outside-' + index)
  console.info('T002-fixed-cost', JSON.stringify({ unrelatedEvents: 20, committedRenders: renders, folderRecencyCalls: recent.mock.calls.length, closedRosterCalls: agents.mock.calls.length, projects: 14, groups: 2, sessions: useAppStore.getState().sessions.length }))
  expect(renders).toBe(0)
  expect(recent).not.toHaveBeenCalled()
  expect(agents).not.toHaveBeenCalled()
  expect(document.querySelector('.project-activity-menu')).toBeNull()
})

function projectFolder(hostId: string, path: string) {
  const block = [...container.querySelectorAll<HTMLElement>('[data-space-folder]')].find(row => row.dataset.spaceFolder === directoryIdentity(hostId, path))
  expect(block).toBeTruthy()
  return block!
}
function timeline(id: string, title: string): AgentTimelineSnapshot {
  return { agentSessionId: id, revision: 1, items: [{ id: 'call-' + id, agentSessionId: id, kind: 'tool_call', status: 'streaming', source: 'native-hook', createdAt: 1, updatedAt: 2, title }] }
}
async function pointerOpen(trigger: HTMLElement) {
  await act(async () => trigger.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', buttons: 0 })))
  expect(document.querySelector('.project-activity-menu')).not.toBeNull()
}

it('a related exact worktree update wakes only its own recency consumers and preserves same-path foreign Host', async () => {
  await mount()
  const recent = vi.spyOn(recency, 'folderLastActivityAt'), agents = vi.spyOn(roster, 'buildAgentRoster')
  const tabs = useAppStore.getState().tabs, layouts = useAppStore.getState().layouts, drafts = useAppStore.getState().agentComposerDrafts
  await update('branch-0-one', 'waiting')
  expect(recent).toHaveBeenCalledTimes(3) // Folder plus both real group aliases.
  expect(recent.mock.calls.every(([owned]) => owned.length === 4 && owned.every(session => session.hostId === 'local' && [_hygiene_fixturePath("repos/project-0"), _hygiene_fixturePath("worktrees/feature")].includes(session.workspacePath)))).toBe(true)
  expect(projectFolder('local', _hygiene_fixturePath("repos/project-0")).querySelector('.project-activity')?.getAttribute('aria-label')).toContain('1 Needs you')
  expect(projectFolder('farm', _hygiene_fixturePath("repos/project-0")).querySelector('.project-activity')?.getAttribute('aria-label')).not.toContain('Needs you')
  expect(agents).not.toHaveBeenCalled()
  expect(useAppStore.getState().tabs).toBe(tabs); expect(useAppStore.getState().layouts).toBe(layouts); expect(useAppStore.getState().agentComposerDrafts).toBe(drafts)
})

it('collapsed Folder descendants, path groups, Host sections and manual groups retain current attention', async () => {
  await mount()
  await act(async () => useAppStore.setState({ collapsedProjectGroups: { ['project:' + directoryIdentity('local', _hygiene_fixturePath("repos/project-0"))]: true, 'project-group:work': true } }))
  expect([...container.querySelectorAll('[data-space-folder]')].some(element => (element as HTMLElement).dataset.spaceFolder === directoryIdentity('local', _hygiene_fixturePath("repos/project-0/nested")))).toBe(false)
  await update('nested-one', 'waiting')
  const parent = projectFolder('local', _hygiene_fixturePath("repos/project-0"))
  expect(parent.querySelector('.project-activity')?.getAttribute('aria-label')).toContain('1 Needs you')
  expect(parent.querySelector('.project-rail-row')?.getAttribute('title')).toContain('6 sessions')
  // The manual group has registered Project0, not its separate nested Project.
  expect(container.querySelector('[data-project-group="work"] .project-activity')?.getAttribute('aria-label')).not.toContain('Needs you')
  await update('foreign-one', 'waiting')
  expect(container.querySelector('[data-project-group="work"] .project-activity')?.getAttribute('aria-label')).toContain('1 Needs you')
  expect(container.querySelectorAll('[data-project-group="work"] [data-project-group-member]')).toHaveLength(0)
  await act(async () => useAppStore.setState({ collapsedProjectGroups: { 'space:folders': true, 'space:folders:farm': true } }))
  expect(container.querySelectorAll('[data-space-folder]')).toHaveLength(0)
  for (const host of ['local', 'farm']) expect(container.querySelector('[data-folder-host="' + host + '"] .project-activity')?.getAttribute('aria-label')).toContain('1 Needs you')
  await act(async () => useAppStore.setState({ collapsedProjectGroups: { [_hygiene_fixturePath("repos")]: true } }))
  // Use the actual path-derived disclosure key rather than inventing a prefix-owned identity.
  const pathGroup = [...container.querySelectorAll<HTMLButtonElement>('.project-rail-group__header')].find(element => element.textContent?.includes('repos'))!
  expect(pathGroup).toBeTruthy()
  await act(async () => pathGroup.click())
  expect(pathGroup.getAttribute('aria-expanded')).toBe('false')
  expect(pathGroup.closest('[data-space-entry]')?.querySelector('.project-activity')?.getAttribute('aria-label')).toContain('1 Needs you')
})

it('selection, branch pins and unavailable group references keep original identity without rebuilding unchanged Activity', async () => {
  await mount()
  const groupings = vi.spyOn(activityGroups, 'buildActivityGroups'), recent = vi.spyOn(recency, 'folderLastActivityAt')
  await act(async () => useAppStore.setState({ activeWorkspaceId: 'branch-0' }))
  expect(projectFolder('local', _hygiene_fixturePath("repos/project-0")).querySelector('[data-workspace-id]')?.getAttribute('data-workspace-id')).toBe('branch-0')
  expect(container.querySelectorAll('[data-project-group-member][aria-current="page"]')).toHaveLength(2)
  expect(groupings).not.toHaveBeenCalled(); expect(recent).not.toHaveBeenCalled()
  const select = vi.fn(async (_id: string) => {})
  await act(async () => useAppStore.setState({ selectWorkspace: select }))
  await act(async () => container.querySelector<HTMLButtonElement>('[data-space-pin-owner][title="feature"]')!.click())
  expect(select).toHaveBeenCalledWith('branch-0')
  const originalGroup = useAppStore.getState().projectGroups
  await act(async () => useAppStore.setState({ config: { ...config, workspaces: workspaces.filter(workspace => workspace.hostId !== 'farm') } }))
  const unavailable = [...container.querySelectorAll<HTMLButtonElement>('[data-project-group-member]')].find(element => element.dataset.projectGroupMember === directoryIdentity('farm', _hygiene_fixturePath("repos/project-0")))!
  expect(unavailable.getAttribute('aria-disabled')).toBe('true'); expect(unavailable.title).toContain(_hygiene_fixturePath("repos/project-0"))
  expect(useAppStore.getState().projectGroups).toBe(originalGroup)
})

it('closed Activity keeps own tooltip but defers names/rosters; opening reads current facts and exact original Session', async () => {
  await mount()
  const agents = vi.spyOn(roster, 'buildAgentRoster')
  const trigger = projectFolder('local', _hygiene_fixturePath("repos/project-0")).querySelector<HTMLButtonElement>('.project-activity')!
  const groups = vi.spyOn(activityGroups, 'buildActivityGroups')
  await act(async () => useAppStore.setState(state => ({ agentNames: { ...state.agentNames, 'project-0-one': 'Current own name' }, timelines: { ...state.timelines, 'project-0-one': timeline('project-0-one', 'Current own tool') } })))
  expect(trigger.title).toContain('Current own tool'); expect(agents).not.toHaveBeenCalled(); expect(groups).not.toHaveBeenCalled()
  const select = vi.fn(async (_id: string) => {}); await act(async () => useAppStore.setState({ selectSession: select }))
  await pointerOpen(trigger)
  expect(agents.mock.calls.length).toBeGreaterThan(0)
  expect(document.querySelector('.project-activity-menu')?.textContent).toContain('Current own tool')
  expect([...document.querySelectorAll('.project-activity-group__avatars [title]')].some(element => element.getAttribute('title')?.includes('Current own name'))).toBe(true)
  const originalSummary = [...document.querySelectorAll<HTMLElement>('.project-activity-group__summary')].find(element => element.textContent?.includes('Current own tool'))!
  expect(originalSummary).toBeTruthy()
  await act(async () => originalSummary.click())
  expect(select).toHaveBeenCalledWith('project-0-one')
})

it('a retained inactive Sidebar preserves query/scroll/workface and ignores even its own Session updates', async () => {
  await mount()
  const search = container.querySelector<HTMLInputElement>('[aria-label="Find Spaces"]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'Project'); search.dispatchEvent(new Event('input', { bubbles: true })) })
  const tree = container.querySelector<HTMLElement>('.space-tree')!; tree.scrollTop = 127
  const tabs = useAppStore.getState().tabs, drafts = useAppStore.getState().agentComposerDrafts
  await act(async () => root.render(<Profiler id="project-rail" onRender={() => { renders += 1 }}><WorkspaceSidebar visible={false} /></Profiler>))
  const recent = vi.spyOn(recency, 'folderLastActivityAt'), agents = vi.spyOn(roster, 'buildAgentRoster')
  renders = 0
  for (let index = 0; index < 10; index += 1) await update('project-' + index + '-one', 'waiting')
  expect(renders).toBe(0); expect(recent).not.toHaveBeenCalled(); expect(agents).not.toHaveBeenCalled()
  await act(async () => root.render(<Profiler id="project-rail" onRender={() => { renders += 1 }}><WorkspaceSidebar visible /></Profiler>))
  expect(search.value).toBe('Project'); expect(tree.scrollTop).toBe(127)
  expect(projectFolder('local', _hygiene_fixturePath("repos/project-0")).querySelector('.project-activity')?.getAttribute('aria-label')).toContain('1 Needs you')
  expect(useAppStore.getState().tabs).toBe(tabs); expect(useAppStore.getState().agentComposerDrafts).toBe(drafts)
})

it('inactive SpaceTopicsTree stops original Mote presence while retaining Category/Mote objects', async () => {
  seedMoteWorkface()
  useAppStore.setState({ config: { ...config, workspaces: [scratchWorkspace, ...workspaces] }, sessions: [...moteSessions, ...workspaces.map(workspace => agent(workspace.id, workspace.path, workspace.hostId))], projectGroups: [], projectRailOpen: true })
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue(moteTopics)
  await act(async () => root.render(<Profiler id="project-rail" onRender={() => { renders += 1 }}><WorkspaceSidebar visible={false} /></Profiler>))
  expect(container.querySelector('.space-motes-section')?.textContent).toContain('Quiet collaborator')
  const agents = vi.spyOn(roster, 'buildAgentRoster'); renders = 0
  await update('default-agent', 'waiting')
  await act(async () => useAppStore.setState(state => ({ timelines: { ...state.timelines, 'default-agent': timeline('default-agent', 'Hidden Mote output') } })))
  expect(renders).toBe(0); expect(agents).not.toHaveBeenCalled()
  await act(async () => root.render(<WorkspaceSidebar visible />))
  expect(container.querySelector('.space-motes-section .project-activity')?.getAttribute('aria-label')).toContain('Needs you')
})

it('the actual Sidebar retains an expanded work line across hiding without consuming hidden updates', async () => {
  await mount()
  const trigger = projectFolder('local', _hygiene_fixturePath("repos/project-0")).querySelector<HTMLButtonElement>('.project-activity')!
  await pointerOpen(trigger)
  const disclosures = [...document.querySelectorAll<HTMLButtonElement>('.project-activity-group__disclosure')]
  expect(disclosures.length).toBeGreaterThan(0)
  for (const disclosure of disclosures) await act(async () => disclosure.click())
  expect(document.querySelectorAll('.project-activity-group--expanded').length).toBe(disclosures.length)
  await act(async () => root.render(<Profiler id="project-rail" onRender={() => { renders += 1 }}><WorkspaceSidebar visible={false} /></Profiler>))
  expect(projectFolder('local', _hygiene_fixturePath("repos/project-0")).querySelector('.project-activity')).toBe(trigger)
  expect(document.querySelector('.project-activity-menu')).toBeNull()
  const agents = vi.spyOn(roster, 'buildAgentRoster'), recent = vi.spyOn(recency, 'folderLastActivityAt'); renders = 0
  await update('project-0-one', 'waiting')
  await act(async () => useAppStore.setState(state => ({ agentNames: { ...state.agentNames, 'project-0-one': 'Current after reveal' },
    timelines: { ...state.timelines, 'project-0-one': timeline('project-0-one', 'Current hidden tool') } })))
  expect(renders).toBe(0); expect(agents).not.toHaveBeenCalled(); expect(recent).not.toHaveBeenCalled()
  await act(async () => root.render(<Profiler id="project-rail" onRender={() => { renders += 1 }}><WorkspaceSidebar visible /></Profiler>))
  expect(projectFolder('local', _hygiene_fixturePath("repos/project-0")).querySelector('.project-activity')).toBe(trigger)
  expect(document.querySelectorAll('.project-activity-group--expanded').length).toBe(disclosures.length)
  expect(document.querySelector('.project-activity-menu')?.textContent).toContain('Current hidden tool')
  expect(document.querySelector('.project-activity-menu')?.textContent).toContain('Current after reveal')
})

it('the actual Mote directory retains its Activity and expanded work line while hidden', async () => {
  seedMoteWorkface()
  useAppStore.setState({ config: { ...config, workspaces: [scratchWorkspace, ...workspaces] }, sessions: moteSessions, projectGroups: [], projectRailOpen: true })
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue(moteTopics)
  await act(async () => root.render(<Profiler id="project-rail" onRender={() => { renders += 1 }}><WorkspaceSidebar visible /></Profiler>))
  const trigger = container.querySelector<HTMLButtonElement>('.space-motes-section .project-activity')!
  expect(trigger).toBeTruthy(); await pointerOpen(trigger)
  const disclosures = [...document.querySelectorAll<HTMLButtonElement>('.project-activity-group__disclosure')]
  expect(disclosures.length).toBeGreaterThan(0)
  for (const disclosure of disclosures) await act(async () => disclosure.click())
  await act(async () => root.render(<Profiler id="project-rail" onRender={() => { renders += 1 }}><WorkspaceSidebar visible={false} /></Profiler>))
  expect(container.querySelector('.space-motes-section .project-activity')).toBe(trigger)
  expect(document.querySelector('.project-activity-menu')).toBeNull()
  const agents = vi.spyOn(roster, 'buildAgentRoster'); renders = 0
  await update('default-agent', 'waiting')
  expect(renders).toBe(0); expect(agents).not.toHaveBeenCalled()
  await act(async () => root.render(<Profiler id="project-rail" onRender={() => { renders += 1 }}><WorkspaceSidebar visible /></Profiler>))
  expect(container.querySelector('.space-motes-section .project-activity')).toBe(trigger)
  expect(document.querySelectorAll('.project-activity-group--expanded').length).toBe(disclosures.length)
  expect(trigger.getAttribute('aria-label')).toContain('Needs you')
})

it('retained Activity visible=false stops its open-menu clock and subscriptions, then catches up without a Store write', async () => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  const sessions = [agent('project-0-one', _hygiene_fixturePath("repos/project-0")), agent('project-0-two', _hygiene_fixturePath("repos/project-0"))]
  const intervals = vi.spyOn(globalThis, 'setInterval'), clears = vi.spyOn(globalThis, 'clearInterval')
  await act(async () => root.render(<ProjectActivity sessions={sessions} />))
  await pointerOpen(container.querySelector<HTMLButtonElement>('.project-activity')!)
  expect(intervals).toHaveBeenCalledTimes(1)
  await act(async () => root.render(<ProjectActivity sessions={sessions} visible={false} />))
  expect(clears).toHaveBeenCalledWith(intervals.mock.results[0]!.value); expect(document.querySelector('.project-activity-menu')).toBeNull()
  const agents = vi.spyOn(roster, 'buildAgentRoster')
  await act(async () => useAppStore.setState(state => ({ agentNames: { ...state.agentNames, 'project-0-one': 'While hidden' }, timelines: { ...state.timelines, 'project-0-one': timeline('project-0-one', 'While hidden tool') } })))
  expect(agents).not.toHaveBeenCalled()
  await act(async () => root.render(<ProjectActivity sessions={sessions} visible />))
  expect(container.querySelector('.project-activity')?.getAttribute('title')).toContain('While hidden tool')
  expect(document.querySelector('.project-activity-menu')?.textContent).toContain('While hidden tool')
  expect(intervals).toHaveBeenCalledTimes(2)
})

it('a hidden directory changing its actual Host cannot borrow the old visible scope', async () => {
  const path = _hygiene_fixturePath("repos/project-0")
  function Scope({ hostId, visible }: { hostId: string; visible: boolean }) {
    const directory = useDirectorySessions([{ hostId, path }], visible)
    const topic = useTopicSessions(hostId, [path], [], visible)
    return <><output data-directory>{directory.map(session => session.id).join(',')}</output><output data-topic>{topic.map(session => session.id).join(',')}</output></>
  }
  await act(async () => root.render(<Scope hostId="local" visible />))
  expect(container.querySelector('[data-directory]')?.textContent).toContain('project-0-one')
  expect(container.querySelector('[data-topic]')?.textContent).toContain('project-0-one')
  await act(async () => root.render(<Scope hostId="local" visible={false} />))
  expect(container.querySelector('[data-directory]')?.textContent).toContain('project-0-one')
  await act(async () => root.render(<Scope hostId="farm" visible={false} />))
  expect(container.querySelector('[data-directory]')?.textContent).toBe('')
  expect(container.querySelector('[data-topic]')?.textContent).toBe('')
  await act(async () => root.render(<Scope hostId="farm" visible />))
  expect(container.querySelector('[data-directory]')?.textContent).toBe('foreign-one,foreign-two')
  expect(container.querySelector('[data-topic]')?.textContent).toBe('foreign-one,foreign-two')
})
