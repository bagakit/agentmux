// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { folderSpaceFacts } from '@agentmux/core/space-folder'
import { formatSpaceAddress } from '@agentmux/core/sharing'
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { FocusProjectPreferences } from '../src/renderer/src/components/FocusProjectPreferences'
import { FocusProjectActions } from '../src/renderer/src/components/FocusProjectActions'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import { initializeSpatialControlFixture } from './helpers/spatial-control-owner-fixture'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { moteTopic, scratchWorkspace, ordinaryTopicId } from './fixtures/mote-workface'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'

vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))
vi.mock('../src/renderer/src/components/RecentFocusTimeline', () => ({ RecentFocusTimeline: () => null }))
const dom = composerDOM()
const project = { ...composerConfig.workspaces[0]!, id: 'root-project', name: 'Original project' }
const checkout = { ...project, id: 'checkout', name: 'Feature checkout', path: project.path + '/checkout', repoPath: project.path, branch: 'feature' }
const other = { ...project, id: 'other-project', name: 'Other project', path: project.path + '/other' }
const topic = { ...moteTopic(ordinaryTopicId, 'Original Topic', false), kind: 'topic' as const }
function Harness() {
  const active = useAppStore(state => state.mainSurface === 'agents')
  return <GlobalFocusSurface visible={active} />
}
beforeEach(async () => {
  const workspaces = [project, checkout, other, scratchWorkspace]
  const actor = (id: string, path: string) => {
    const status = { state: 'working' as const, source: 'native-hook' as const, observedAt: Date.now(), stateEnteredAt: Date.now() }
    return { ...composerSession(id), workspacePath: path, status, semanticStatus: status }
  }
  const sessions = [actor('checkout-agent', checkout.path), actor('other-agent', other.path), actor('topic-agent', topic.directoryPath)]
  const tab = (id: string, workspaceId: string, sessionId: string) => createWorkbenchTab(id, { kind: 'agent', phase: 'attached', regionId: 'region-' + id, workspaceId, sessionId })
  const rootTab = createWorkbenchTab('root-tab', { kind: 'launcher', regionId: 'root-region', workspaceId: project.id })
  const tabs = { 'root-tab': rootTab, 'checkout-tab': tab('checkout-tab', checkout.id, sessions[0]!.id),
    'other-tab': tab('other-tab', other.id, sessions[1]!.id), 'topic-tab': { ...tab('topic-tab', scratchWorkspace.id, sessions[2]!.id), topicId: topic.id } }
  useAppStore.setState({ loading: false, config: { ...composerConfig, workspaces, focus: { recentActivityHours: 48 } }, sessions, tabs,
    activeWorkspaceId: other.id, mainSurface: 'agents', timelines: {}, agentNames: {}, agentSteerQueues: {},
    layouts: Object.fromEntries(workspaces.map(workspace => [workspace.id, createWorkspaceLayout('group-' + workspace.id, Object.values(tabs).filter(tab => tab.workspaceId === workspace.id).map(tab => tab.id))])),
    agentComposerDrafts: { 'checkout-agent': 'Keep original Agent input', 'root-region': 'Keep original Launcher input' },
    agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } }, spaceZoneBindings: {}, topicCategories: [],
    scratchTopicSnapshots: { [scratchWorkspace.id]: { scope: scratchTopicsScope(scratchWorkspace), revision: 1, reading: false, error: null, topics: [topic] } } })
  vi.spyOn(api.spatial, 'read').mockResolvedValue({ schemaVersion: 1, revision: 1, graph: desktopSpatialGraph(useAppStore.getState(), [topic]) })
  vi.spyOn(api.workspaces, 'listBranches').mockImplementation(async workspaceId => ({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: workspaces.find(item => item.id === workspaceId)?.path ?? project.path }))
  vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'directory', icon: null })
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([topic])
  vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await initializeSpatialControlFixture([topic])
})
function button(label: string) { const node = document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`); expect(node, label).not.toBeNull(); return node! }
async function click(label: string) { await act(async () => button(label).click()) }
async function note(text: string) {
  const appearance=document.querySelector<HTMLButtonElement>('[aria-label="Project appearance"]')
  if(appearance?.getAttribute('aria-expanded')==='false') await act(async()=>appearance.click())
  const field = document.querySelector<HTMLInputElement>('[aria-label="Project note"]')!; expect(field).not.toBeNull()
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, text); field.dispatchEvent(new Event('input', { bubbles: true })) })
}
function unchanged(before: ReturnType<typeof useAppStore.getState>) {
  for (const key of ['sessions', 'tabs', 'layouts', 'agentComposerDrafts', 'agentFocus', 'agentSteerQueues'] as const) expect(useAppStore.getState()[key]).toBe(before[key])
}

it('the actual default project menu is a compact action surface and appearance expansion keeps its unsaved draft',async()=>{
 const save=vi.spyOn(api.config,'save')
 await dom.render(<Harness/>);await click('Project preferences · Original project')
 const panel=document.querySelector<HTMLElement>('[data-focus-project-preferences]')!
 expect(panel.classList.contains('tab-context-menu')).toBe(true)
 expect(panel.querySelector('[aria-label="Project note"]')).toBeNull()
 expect(panel.querySelector('[aria-label="Pin project"]')).toBeNull()
 expect(panel.querySelector('.focus-project-preferences__actions')).toBeNull()
 for(const name of ['Copy project address','Open project in Space']){
  const action=button(name);expect(action.classList.contains('tab-context-menu__item')).toBe(true);expect(action.classList.contains('small-button')).toBe(false)
 }
 const tasks=[...panel.querySelectorAll<HTMLButtonElement>('[data-mote-task-action-id]')]
 expect(tasks).toHaveLength(3)
 for(const task of tasks){
  expect(task.classList.contains('tab-context-menu__item')).toBe(true)
  expect(task.querySelector('small')).toBeNull()
  expect(task.getAttribute('aria-description')).toBeTruthy();expect(task.title).toBe(task.getAttribute('aria-description'))
 }
 await note('Original unsaved appearance draft')
 expect(panel.querySelector('.focus-project-preferences__actions')).not.toBeNull()
 expect(panel.querySelector('[aria-label="Pin project"]')).not.toBeNull()
 await click('Project appearance');expect(panel.querySelector('[aria-label="Project note"]')).toBeNull()
 await click('Project appearance');expect(panel.querySelector<HTMLInputElement>('[aria-label="Project note"]')?.value).toBe('Original unsaved appearance draft')
 expect(save).not.toHaveBeenCalled()
})

it('the actual non-active project menu copies its canonical root Space address without navigating or touching original work', async () => {
  const select = vi.spyOn(useAppStore.getState(), 'selectWorkspace'), launch = vi.spyOn(useAppStore.getState(), 'openLauncher')
  await dom.render(<Harness />); await click('Project preferences · Original project')
  const before = useAppStore.getState()
  expect(dom.container.querySelector('[data-project-id="root-project"][data-lane-id]')).not.toBeNull()
  await click('Copy project address')
  expect(api.ui.writeClipboardText).toHaveBeenCalledExactlyOnceWith(formatSpaceAddress({ spaceId: folderSpaceFacts(project).space.spaceId }))
  expect(useAppStore.getState().activeWorkspaceId).toBe(other.id)
  expect(select).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled(); unchanged(before)
})

it('the actual worktree project opens its registered root in Space and preserves unsaved preference and original drafts', async () => {
  const select = vi.spyOn(useAppStore.getState(), 'selectWorkspace'), launch = vi.spyOn(useAppStore.getState(), 'openLauncher'), start = vi.spyOn(useAppStore.getState(), 'launchAgent'), send = vi.spyOn(useAppStore.getState(), 'send')
  await dom.render(<Harness />); await click('Project preferences · Original project'); await note('My unsaved project route')
  const before = useAppStore.getState()
  await click('Open project in Space')
  expect(select).toHaveBeenCalledExactlyOnceWith(project.id)
  expect(useAppStore.getState().activeWorkspaceId).toBe(project.id); expect(useAppStore.getState().mainSurface).toBe('workbench')
  expect(document.querySelector('[data-focus-project-preferences]')).toBeNull()
  expect(launch).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled(); unchanged(before)
  await act(async () => useAppStore.setState({ mainSurface: 'agents' })); await click('Project preferences · Original project')
  expect(document.querySelector<HTMLInputElement>('[aria-label="Project note"]')?.value).toBe('My unsaved project route')
})

it('a real clipboard rejection remains visible in the menu and retries through the shared clipboard owner', async () => {
  vi.mocked(api.ui.writeClipboardText).mockRejectedValueOnce(new Error('Original clipboard unavailable'))
  const report = vi.spyOn(useAppStore.getState(), 'reportError')
  await dom.render(<Harness />); await click('Project preferences · Original project'); await note('Keep this unsaved note')
  const before = useAppStore.getState()
  await click('Copy project address')
  expect(report).toHaveBeenCalled(); expect(document.querySelector('[data-focus-project-preferences]')?.textContent).toContain('Original clipboard unavailable')
  expect(document.querySelector<HTMLInputElement>('[aria-label="Project note"]')?.value).toBe('Keep this unsaved note')
  await click('Copy project address'); expect(api.ui.writeClipboardText).toHaveBeenCalledTimes(2); unchanged(before)
})

it.each(['path', 'host', 'duplicate'] as const)('an already opened original menu rejects a same-ID changed %s instead of copying or selecting a substitute', async change => {
  const select = vi.spyOn(useAppStore.getState(), 'selectWorkspace')
  await dom.render(<FocusProjectPreferences name={project.name} projectKey={JSON.stringify([project.hostId, project.id])} actions={<FocusProjectActions project={project} />} />)
  await click('Project preferences · Original project')
  const current = useAppStore.getState().config!, replacement = change === 'path' ? { ...project, path: project.path + '/replacement' } : { ...project, hostId: 'other-host' }
  await act(async () => useAppStore.setState({ config: { ...current, workspaces: change === 'duplicate' ? [...current.workspaces, replacement] : current.workspaces.map(item => item.id === project.id ? replacement : item) } }))
  const before = useAppStore.getState()
  await click('Copy project address'); await click('Open project in Space')
  expect(select).not.toHaveBeenCalled(); expect(api.ui.writeClipboardText).not.toHaveBeenCalled()
  expect(document.querySelector('[data-focus-project-preferences]')?.textContent).toContain('original project registration changed')
  expect(useAppStore.getState().activeWorkspaceId).toBe(other.id); unchanged(before)
})

it('the actual Collection menu does not borrow a member Project address or Space action', async () => {
  await dom.render(<Harness />)
  const collection = dom.container.querySelector<HTMLElement>('[data-focus-collection]')!; expect(collection).not.toBeNull()
  const trigger = collection.querySelector<HTMLButtonElement>('[aria-label^="Collection preferences"]')!; expect(trigger).not.toBeNull()
  await act(async () => trigger.click())
  expect(document.querySelector('[data-focus-project-preferences]')).not.toBeNull()
  expect(document.querySelector('[aria-label="Project appearance"]')).toBeNull()
  expect(document.querySelector('.focus-project-preferences__actions')).toBeNull()
  expect(document.querySelector('[aria-label="Project note"]')).toBeNull()
  expect(document.querySelector('[aria-label="Copy project address"]')).toBeNull()
  expect(document.querySelector('[aria-label="Open project in Space"]')).toBeNull()
})
