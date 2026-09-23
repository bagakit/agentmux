// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { SpaceCreateMenu } from '../src/renderer/src/components/SpaceCreateMenu'
import { SpaceTopicsTree } from '../src/renderer/src/components/SpaceTopicsTree'
import { SurfaceSwitch } from '../src/renderer/src/components/TopRowChrome'
import type { SessionSnapshot } from '../src/shared/contracts'
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { GlobalBoardSurface } from '../src/renderer/src/components/GlobalBoardSurface'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { DEFAULT_MOTE_SOUL, DEFAULT_PMO_TEAMS_TOPIC_WIKI, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'

const initial = useAppStore.getState()
const roots: ReturnType<typeof createRoot>[] = []
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount() })
  vi.restoreAllMocks()
  useAppStore.setState(initial, true)
  localStorage.clear()
  document.body.replaceChildren()
})
function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  return { root, container }
}

it('shows Mote consistently in the real Space tree, creation menu and fixed navigation', async () => {
  const { root, container } = mount()
  const workspace = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', name: 'Topics', path: '/tmp/mote-name-proof', kind: 'folder' as const }
  const create = vi.fn(async () => 'launcher:new-mote')
  const openTopic = vi.fn(async () => {})
  const ensure = vi.spyOn(api.scratch, 'ensureMote').mockResolvedValue({ id: 'launcher:leader', directoryPath: 'topic--launcher--leader', topicPath: 'topic--launcher--leader/topic.md', title: 'Mote', summary: '', collaborators: [] })
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([])
  useAppStore.setState({ config: { ...initial.config!, version: 9, workspaces: [workspace], hosts: [], executors: {} }, sessions: [], tabs: {}, layouts: {}, pinnedItems: {}, collapsedProjectGroups: {}, workspaceFileRevisions: {}, mainSurface: 'board', createScratchTopic: create, openScratchTopic: openTopic })
  const focus = useAppStore.getState().agentFocus
  await act(async () => root.render(createElement('div', {},
    createElement(SurfaceSwitch, { onOpenSettings: vi.fn() }),
    createElement(SpaceTopicsTree, { workspace, icons: {}, onChangeIcon: () => {} }),
    createElement(SpaceCreateMenu, { onOpenFolder: async () => {} })
  )))
  const launcher = container.querySelector<HTMLButtonElement>('.pmo-teams-topic-compact-launcher button')!
  const moteRow = container.querySelector<HTMLButtonElement>('.space-mote-row')!
  expect(launcher.getAttribute('aria-label')).toBe('Open Mote')
  expect(launcher.title).toBe('Open Mote')
  expect(moteRow.textContent).toBe('Mote')
  expect(moteRow.getAttribute('aria-label')).toBe('Open Mote')
  await act(async () => container.querySelector('.surface-navigation__slot--launcher')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
  expect(document.querySelector('[role="tooltip"] strong')?.textContent).toBe('Mote')
  await act(async () => launcher.click())
  expect(launcher.getAttribute('aria-label')).toBe('Close Mote')
  expect(useAppStore.getState().mainSurface).toBe('board')
  expect(useAppStore.getState().agentFocus).toEqual(focus)
  await act(async () => { moteRow.click(); await Promise.resolve() })
  expect(ensure).toHaveBeenCalledExactlyOnceWith(SCRATCH_WORKSPACE_ID, 'launcher:leader')
  expect(openTopic).toHaveBeenCalledExactlyOnceWith('launcher:leader', SCRATCH_WORKSPACE_ID)
  await act(async () => container.querySelector('button[aria-label="Add Space"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  const menuItems = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
  expect(menuItems.map(item => item.textContent)).toEqual(['Open Folder As a Project', 'Create Another Topic', 'Create Mote'])
  await act(async () => { menuItems[2]!.click(); await Promise.resolve() })
  expect(create).toHaveBeenCalledExactlyOnceWith('mote')
  expect(DEFAULT_MOTE_SOUL).toContain('Default role: PMO')
  expect(DEFAULT_PMO_TEAMS_TOPIC_WIKI).toContain('# Mote Guide')
})

it('passes Mote product identity and PMO role through the real New Goal action', async () => {
  const { root, container } = mount()
  const createDemand = vi.fn(async () => 'demand:mote-name')
  const requestDemandPmoTask = vi.fn(async () => 'launcher:goal-context')
  useAppStore.setState({ config: { ...initial.config!, workspaces: [], executors: {} }, sessions: [], demands: {}, selectedDemandId: null, createDemand, requestDemandPmoTask })
  await act(async () => root.render(createElement(GlobalBoardSurface)))
  const newGoal = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'New Goal')
  expect(newGoal).toBeDefined()
  await act(async () => { newGoal!.click(); await Promise.resolve() })
  expect(createDemand).not.toHaveBeenCalled()
  const intent = container.querySelector<HTMLTextAreaElement>('[aria-label="Goal intent"]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(intent, 'Make Mote goal discussion readable'); intent.dispatchEvent(new Event('input', { bubbles: true })) })
  const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]')!
  await act(async () => { submit.click(); await Promise.resolve() })
  expect(createDemand).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ description: 'Make Mote goal discussion readable' }))
  expect(requestDemandPmoTask).toHaveBeenCalledExactlyOnceWith('demand:mote-name', 'grill')
})


it('names the existing coordination attention shortcut Mote while retaining its Session', async () => {
  const { root, container } = mount()
  const focusPmoSession = vi.fn()
  const workspace = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', name: 'Topics', path: '/tmp/mote-name-proof', kind: 'folder' as const }
  const session = {
    id: 'existing-mote-session', kind: 'agent', providerId: 'codex', executorId: 'codex', hostId: 'local',
    workspacePath: '/tmp/mote-name-proof/topic--launcher--leader', label: 'Existing collaborator',
    createdAt: 1, updatedAt: 1, processState: 'running', latestOutputBytes: 0,
    status: { state: 'waiting', source: 'native-hook', observedAt: 1 },
    capabilities: {}, control: { kind: 'agent', hostId: 'local', agentSessionId: 'existing-mote-session', run: { runId: 'existing-mote-run' } }
  } as SessionSnapshot
  useAppStore.setState({ config: { ...initial.config!, workspaces: [workspace] }, sessions: [session], tabs: {}, agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } }, focusPmoSession })
  await act(async () => root.render(createElement(GlobalFocusSurface)))
  const attention = container.querySelector<HTMLButtonElement>('.focus-pmo-attention')
  expect(attention).not.toBeNull()
  expect(attention!.textContent).toBe('Mote · 1 to review Open context ↗')
  await act(async () => attention!.click())
  expect(focusPmoSession).toHaveBeenCalledExactlyOnceWith('existing-mote-session')
  expect(useAppStore.getState().sessions).toEqual([session])
})
