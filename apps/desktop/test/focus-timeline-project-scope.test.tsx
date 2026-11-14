// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { WorkspaceSidebar } from '../src/renderer/src/components/WorkspaceSidebar'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '@agentmux/layout'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import { initializeSpatialControlFixture } from './helpers/spatial-control-owner-fixture'
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))
const dom = composerDOM()
const key = (project: string, host = 'local') => JSON.stringify([host, project])
const scope = () => JSON.parse(dom.container.querySelector<HTMLElement>('.recent-focus')!.dataset.focusProjectScope!)
const projectKeys = () => [...dom.container.querySelectorAll<HTMLElement>('[data-timeline-project]')].map(row => row.dataset.timelineProject)
const click = async (selector: string) => { const node = document.querySelector<HTMLButtonElement>(selector); expect(node, selector).not.toBeNull(); await act(async () => node!.click()) }
async function scene() {
  const workspaces = ['alpha', 'beta', 'empty'].map(id => ({ ...composerConfig.workspaces[0]!, id, name: id, path: composerConfig.workspaces[0]!.path + '/' + id }))
  workspaces.push({ ...workspaces[0]!, id: 'checkout', name: 'feature checkout', path: workspaces[0]!.path + '/worktree', repoPath: workspaces[0]!.path, branch: 'feature' } as typeof workspaces[number])
  workspaces.push({ ...workspaces[0]!, id: 'other-host', name: 'alpha', hostId: 'remote' })
  const sessions = workspaces.filter(workspace => workspace.id !== 'empty').map(workspace => ({ ...composerSession('agent-' + workspace.id), workspacePath: workspace.path, hostId: workspace.hostId,
    label: 'Task ' + workspace.id, status: { state: 'working' as const, source: 'native-hook' as const, observedAt: Date.now() },
    semanticStatus: { state: 'working' as const, source: 'native-hook' as const, observedAt: Date.now(), stateEnteredAt: Date.now() - 1000 },
    control: { ...composerSession('agent-' + workspace.id).control, hostId: workspace.hostId } }))
  const tabs = Object.fromEntries(sessions.map((session, index) => { const workspace = workspaces.find(workspace => workspace.path === session.workspacePath && workspace.hostId === session.hostId)!; const tab = createWorkbenchTab('tab-' + index, { kind: 'agent', phase: 'attached', regionId: 'r-' + index, workspaceId: workspace.id, sessionId: session.id }); return [tab.id, tab] }))
  const now = Date.now()
  useAppStore.setState({ config: { ...composerConfig, workspaces, hosts: [...composerConfig.hosts, { id: 'remote', kind: 'ssh', label: 'Other Host', target: 'private.invalid' } as typeof composerConfig.hosts[number]] },
    mainSurface: 'agents', activeWorkspaceId: 'alpha', selectedSpaceMount: null, sessions, tabs,
    layouts: Object.fromEntries(workspaces.map(workspace => [workspace.id, createWorkspaceLayout('g-' + workspace.id, Object.values(tabs).filter(tab => tab.workspaceId === workspace.id).map(tab => tab.id))])),
    timelines: Object.fromEntries(sessions.map(session => [session.id, { agentSessionId: session.id, revision: 1, items: [] }])),
    agentNames: {}, workbenchSpaceSelection: null,
    agentFocus: { execution: { sessionId: 'agent-beta', history: [{ sessionId: 'retained-alpha', focusedAt: now - 1000,
      identity: { name: 'Retained Alpha', kind: 'agent', providerId: 'codex', hostId: 'local', workspacePath: workspaces[0]!.path, project: { id: 'alpha', name: 'alpha' } } }] }, pmo: { sessionId: null } },
    agentComposerDrafts: { 'agent-alpha': 'Original unsent draft' } })
  vi.spyOn(api.spatial, 'read').mockResolvedValue({ schemaVersion: 1, revision: 1, graph: desktopSpatialGraph(useAppStore.getState(), []) })
  await initializeSpatialControlFixture()
  const history = vi.spyOn(api.conversation, 'readAgentConversation'), resync = vi.spyOn(useAppStore.getState(), 'resyncTimeline')
  await dom.render(<><WorkspaceSidebar /><GlobalFocusSurface /></>)
  return { before: useAppStore.getState(), history, resync }
}
it('uses the selected ProjectRail resource rather than MRU, groups its checkout and separates same-name Hosts', async () => {
  await scene()
  expect(scope()).toEqual([key('alpha')])
  expect(projectKeys()).toEqual([key('alpha')])
  expect(dom.container.querySelectorAll('[data-focus-current="true"]')).toHaveLength(0)
  expect(dom.container.querySelector('[data-focus-timeline-id="agent-checkout"]')).not.toBeNull()
  expect(dom.container.querySelector('[data-focus-timeline-id="retained-alpha"]')).not.toBeNull()
  expect(dom.container.querySelector('[data-focus-timeline-id="agent-other-host"]')).toBeNull()
  await act(async () => useAppStore.setState({ activeWorkspaceId: 'checkout' }))
  expect(scope()).toEqual([key('alpha')])
  await act(async () => useAppStore.setState({ activeWorkspaceId: 'other-host' }))
  expect(scope()).toEqual([key('other-host', 'remote')])
})
it('the original ProjectRail click changes scope with no current Region, preserving the window and original draft', async () => {
  const { before } = await scene()
  await click('[aria-label="Previous focus window"]')
  const timeline = dom.container.querySelector<HTMLElement>('.recent-focus')!, start = timeline.dataset.windowStart
  const beta = [...dom.container.querySelectorAll<HTMLButtonElement>('.project-rail-row')].find(row => row.textContent?.includes('beta'))!
  expect(beta).not.toBeUndefined()
  await act(async () => beta.click())
  expect(useAppStore.getState().activeWorkspaceId).toBe('beta')
  expect(scope()).toEqual([key('beta')])
  expect(useAppStore.getState().workbenchSpaceSelection).toBeNull()
  expect(dom.container.querySelector('.recent-focus')).toBe(timeline)
  expect(timeline.dataset.windowStart).toBe(start)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
})
it('explicit Focus project selection wins over the rail and clear restores Follow without changing other local filters', async () => {
  await scene()
  const project = [...dom.container.querySelectorAll<HTMLElement>('[data-project-group-key]')].find(node => node.dataset.projectGroupKey === key('beta'))
  const beta = project?.querySelector<HTMLButtonElement>('.focus-project-frame__heading .focus-project-lanes__axis')!
  expect(beta).not.toBeNull(); expect(beta?.textContent).toContain('beta'); await act(async () => beta.click())
  expect(scope()).toEqual([key('beta')])
  await act(async () => useAppStore.setState({ activeWorkspaceId: 'empty' }))
  expect(scope()).toEqual([key('beta')])
  await click('[aria-label="Remove Project filter"]')
  expect(scope()).toEqual([key('empty')])
  expect(projectKeys()).toEqual([])
  expect(dom.container.querySelector('.recent-focus__empty')?.textContent).toContain('this project scope')
  await click('[aria-label="Show all timeline projects"]')
  expect(scope()).toEqual([])
  expect(projectKeys().length).toBeGreaterThan(1)
  await click('[aria-label="Follow selected project"]')
  expect(scope()).toEqual([key('empty')])
})
it('local text conditions do not erase project history or start reading the unrelated MRU', async () => {
  const { history } = await scene()
  expect(history.mock.calls.some(([input]) => input.agentSessionId === 'agent-beta')).toBe(false)
  const retained = dom.container.querySelector('[data-focus-timeline-id="retained-alpha"]')
  const input = dom.container.querySelector<HTMLInputElement>('[aria-label="Search contexts"]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'No matching current card'); input.dispatchEvent(new Event('input', { bubbles: true })) })
  expect(dom.container.querySelector('[data-focus-timeline-id="retained-alpha"]')).toBe(retained)
  expect(scope()).toEqual([key('alpha')])
})
it('unknown or mounted-source project selection never borrows the old local project', async () => {
  await scene()
  await act(async () => useAppStore.setState({ activeWorkspaceId: 'not-confirmed' }))
  expect(scope()).toEqual([])
  await act(async () => useAppStore.setState({ activeWorkspaceId: 'alpha', selectedSpaceMount: 'unavailable-original-source' }))
  expect(scope()).toEqual([])
})

it('the original multi-project filter supplies a union and retains an unavailable selected key without falling back', async () => {
  await scene()
  const trigger = dom.container.querySelector<HTMLButtonElement>('[aria-label="Focus filters"]')!
  await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' })))
  for (const id of ['alpha', 'beta']) {
    const option = [...document.querySelectorAll<HTMLElement>('[data-focus-project]')].find(node => node.dataset.focusProject === key(id))!
    expect(option).not.toBeUndefined(); await act(async () => option.click())
  }
  expect(scope()).toEqual([key('alpha'), key('beta')])
  expect(new Set(projectKeys())).toEqual(new Set([key('alpha'), key('beta')]))
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  await act(async () => { const state = useAppStore.getState(); useAppStore.setState({ config: { ...state.config!, workspaces: state.config!.workspaces.filter(workspace => workspace.id !== 'beta') }, sessions: state.sessions.filter(session => session.id !== 'agent-beta') }) })
  expect(scope()).toEqual([key('alpha'), key('beta')])
  expect(dom.container.querySelector('.recent-focus__scope')?.textContent).toContain('beta')
})
