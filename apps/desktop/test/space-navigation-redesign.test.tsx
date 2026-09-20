// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { ScratchTopicSnapshot, SessionSnapshot, WorkspaceRecord } from '../src/shared/contracts'
import { SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID, scratchTopicDirectoryName } from '../src/shared/scratch-topics'
import { WorkspaceSidebar } from '../src/renderer/src/components/WorkspaceSidebar'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
const initial = useAppStore.getState()
const scratch: WorkspaceRecord = { id: SCRATCH_WORKSPACE_ID, name: 'Topics', hostId: 'local', path: '/topics', kind: 'folder' }
const alpha: WorkspaceRecord = { id: 'alpha', name: 'Alpha', hostId: 'local', path: '/work/alpha', kind: 'folder' }
const child: WorkspaceRecord = { id: 'child', name: 'Child', hostId: 'local', path: '/work/alpha/child', kind: 'folder' }
let root: Root | undefined
let container: HTMLDivElement
function topic(id: string, title: string, mote = false): ScratchTopicSnapshot {
  const path = scratchTopicDirectoryName(id)
  return { id, title, summary: 'Shared knowledge', directoryPath: path, topicPath: `${path}/topic.md`, collaborators: [],
    ...(mote ? { soul: { path: `${path}/SOUL.md`, content: 'Identity', version: '1' } } : {}) }
}
function agent(id: string, path: string, state: SessionSnapshot['status']['state'], hostId = 'local'): SessionSnapshot {
  return { id, kind: 'agent', providerId: 'codex', executorId: 'codex', hostId, workspacePath: path,
    label: id, createdAt: 1, updatedAt: 1, agentSessionUpdatedAt: 1, processState: 'running', latestOutputBytes: 0,
    status: { state, source: 'native-hook', observedAt: 1 },
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'respond', providerResume: true, replyCorrelation: 'none' },
    control: { kind: 'agent', hostId, agentSessionId: id, run: { runId: `run-${id}` } } } as SessionSnapshot
}
async function mount(topics: ScratchTopicSnapshot[], sessions: SessionSnapshot[] = []) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'directory', icon: null })
  const list = vi.spyOn(api.scratch, 'listTopics').mockResolvedValue(topics)
  useAppStore.setState({ config: { ...initial.config!, version: 9, hosts: [], executors: {}, workspaces: [scratch, alpha, child] },
    sessions, tabs: {}, layouts: {}, activeWorkspaceId: 'alpha', mainSurface: 'workbench', pinnedItems: {},
    scratchTopicOrder: [], collapsedProjectGroups: {}, workspaceFileRevisions: {}, timelines: {}, agentNames: {}, providerCatalog: [] })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => root!.render(createElement(WorkspaceSidebar)))
  return list
}
function button(selector: string): HTMLButtonElement {
  const node = container.querySelector<HTMLButtonElement>(selector)
  expect(node, selector).not.toBeNull()
  return node!
}
function heat(selector: string) { return button(selector).closest('.project-rail-entry')!.querySelector<HTMLButtonElement>('.project-activity') }
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined; container?.remove(); vi.restoreAllMocks(); useAppStore.setState(initial, true)
})

it('creates each category through its existing owner without toggling or selecting another Space', async () => {
  await mount([topic('view:a', 'A'), topic('view:mote', 'Researcher', true)])
  const create = vi.fn(async () => topic('view:new', 'New'))
  const openFolder = vi.fn(async () => {})
  const select = vi.fn(async () => {})
  await act(async () => useAppStore.setState({ createScratchTopic: create, openProjectFolder: openFolder, selectWorkspace: select }))
  expect([...container.querySelectorAll('.space-section-label')].map((node) => node.textContent)).toEqual(['Motes2', 'Topics1', 'Folders2'])
  for (const label of ['Create Mote', 'Create Topic', 'Open Folder']) await act(async () => button(`[aria-label="${label}"]`).click())
  expect(create.mock.calls).toEqual([['mote'], [undefined]])
  expect(openFolder).toHaveBeenCalledOnce()
  expect(select).not.toHaveBeenCalled()
  expect(useAppStore.getState().collapsedProjectGroups).toEqual({})
  expect(container.querySelector('.sidebar__section-heading')).toBeNull()
  expect(container.querySelector('.space-tree-search [aria-label="Use compact project spacing"]')).not.toBeNull()
})

it('projects relative Topic directories onto exact same-host absolute Session paths and keeps order independent of heat', async () => {
  const a = topic('view:a', 'Alpha notes'), b = topic('view:b', 'Beta notes')
  const path = `${scratch.path}/${a.directoryPath}`
  const sessions = [agent('waiting', path, 'waiting'), agent('error', path, 'error'), agent('working', path, 'working'),
    agent('different-host', path, 'waiting', 'studio'), agent('nearby', `${path}-neighbor`, 'waiting'),
    agent('mote', `${scratch.path}/${scratchTopicDirectoryName(PMO_TEAMS_TOPIC_ID)}`, 'working')]
  await mount([b, a], sessions)
  const labels = () => [...container.querySelectorAll('.space-topic-row')].map((node) => node.textContent)
  expect(labels()).toEqual(['Beta notes', 'Alpha notes'])
  expect(heat('[data-space-nav="topic:view:b"]')).toBeNull()
  const activity = heat('[data-space-nav="topic:view:a"]')!
  expect(activity).not.toBeNull()
  expect(activity.getAttribute('aria-label')).toContain('1 Needs you · 1 Error · 1 Working')
  expect(activity.getAttribute('aria-label')).toContain('Topic · Alpha notes')
  expect([...activity.querySelectorAll('.project-activity__metric')].map((node) => node.textContent)).toEqual(['1', '1'])
  expect(heat('.space-mote-row')!.getAttribute('aria-label')).toContain('1 Working')
  await act(async () => useAppStore.setState({ sessions: sessions.map((session) => ({ ...session, status: { ...session.status, state: 'working' } })) }))
  expect(labels()).toEqual(['Beta notes', 'Alpha notes'])
  expect(heat('[data-space-nav="topic:view:a"]')!.getAttribute('aria-label')).toContain('3 Working')
  await act(async () => button('[aria-label="Collapse Topics"]').click())
  expect(container.querySelectorAll('.space-topic-row')).toHaveLength(0)
  expect(container.querySelector('.space-topics-heading .project-activity')!.getAttribute('aria-label')).toContain('3 Working')
})

it('pins and unpins Topics and Motes with the same durable owner used by the overview', async () => {
  await mount([topic('view:a', 'Alpha notes'), topic('view:mote', 'Researcher', true)])
  const original = useAppStore.getState().sessions
  await act(async () => button('[aria-label="Pin Alpha notes"]').click())
  await act(async () => button('[aria-label="Pin Researcher"]').click())
  expect(useAppStore.getState().pinnedItems[SCRATCH_WORKSPACE_ID]).toEqual(['view:a', 'view:mote'])
  expect(button('[aria-label="Unpin Alpha notes"]').getAttribute('aria-pressed')).toBe('true')
  expect(button('[aria-label="Unpin Researcher"]').classList.contains('space-pin--pinned')).toBe(true)
  await act(async () => button('[aria-label="Unpin Alpha notes"]').click())
  expect(useAppStore.getState().pinnedItems[SCRATCH_WORKSPACE_ID]).toEqual(['view:mote'])
  expect(button('[aria-label="Pin Alpha notes"]').getAttribute('aria-pressed')).toBe('false')
  expect(useAppStore.getState().sessions).toEqual(original)
})

it('rolls hidden descendant attention into the real collapsed Folder without duplicate Sessions', async () => {
  const sessions = [agent('parent', alpha.path, 'working'), agent('child-waiting', child.path, 'waiting'), agent('child-error', child.path, 'error')]
  await mount([], sessions)
  expect(heat('[data-workspace-id="alpha"]')!.getAttribute('aria-label')).toContain('1 Working')
  expect(heat('[data-workspace-id="child"]')!.getAttribute('aria-label')).toContain('1 Needs you · 1 Error')
  await act(async () => button('[aria-label="Collapse Alpha"]').click())
  expect(container.querySelector('[data-workspace-id="child"]')).toBeNull()
  expect(heat('[data-workspace-id="alpha"]')!.getAttribute('aria-label')).toContain('1 Needs you · 1 Error · 1 Working')
  await act(async () => button('[aria-label="Collapse Folders"]').click())
  expect(container.querySelector('.space-folders-heading .project-activity')!.getAttribute('aria-label')).toContain('1 Needs you · 1 Error · 1 Working')
  expect(useAppStore.getState().sessions).toEqual(sessions)
})

it('does not rescan unrelated Sessions as the number of Topic consumers grows', async () => {
  let reads = 0
  const unrelated = Array.from({ length: 120 }, (_, index) => {
    const session = agent(`elsewhere-${index}`, '/elsewhere', 'working')
    // Exclude store persistence serialization from this renderer consumer work probe.
    Object.defineProperty(session, 'workspacePath', { enumerable: false, get: () => { reads += 1; return '/elsewhere' } })
    return session
  })
  const list = await mount([topic('view:a', 'A')], unrelated)
  expect(unrelated).toHaveLength(120)
  expect(reads).toBe(240) // One location index in Folders and one shared Topic owner index.
  expect(container.querySelectorAll('.project-activity')).toHaveLength(0)
  list.mockResolvedValue(Array.from({ length: 80 }, (_, index) => topic(`view:t${index}`, `Topic ${index}`)))
  await act(async () => useAppStore.setState({ workspaceFileRevisions: { [SCRATCH_WORKSPACE_ID]: 1 } }))
  expect(container.querySelectorAll('.space-topic-row')).toHaveLength(80)
  expect(reads).toBe(240)
  expect(container.querySelectorAll('.project-activity')).toHaveLength(0)
})
