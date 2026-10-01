// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createWorkspaceLayout, moveTabToNewGroup, addTabOccurrence } from '@agentmux/layout'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab, addWorkbenchRegion } from '../src/renderer/src/lib/workbench-tabs'
import { executionFocusPresentation } from '../src/renderer/src/lib/focus-tab-projection'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { formatTabAddress } from '../src/renderer/src/lib/agent-address'
import { requestPmoTeamsTopicFloatingOpen, requestPmoTeamsTopicFloatingClose, readPmoTeamsTopicFloatingState } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID } from '../src/shared/scratch-topics'
import { seedMoteWorkface, executionAgent, defaultAgent, customAgent, customMoteId, moteTopics } from './fixtures/mote-workface'
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
const baseline = useAppStore.getState()
const sourceId = 'displayed-complete-tab', sourceRegion = 'displayed-agent-region'
const reference = { displayWorkspaceId: 'project', groupId: 'exact-second-group', tabId: sourceId, regionId: sourceRegion }
let root: Root, container: HTMLDivElement, launch: ReturnType<typeof vi.fn>
function Scene() {
  const state = useAppStore()
  const presentation = executionFocusPresentation(state.agentFocus.execution, state.tabs, spatialCatalog(state, moteTopics), choice => state.selectExecutionFocusReference(choice, state.agentFocus.execution))
  return createElement(GlobalFocusSurface, { presentation, regionOnly: true })
}
const button = (label: string) => container.querySelector<HTMLButtonElement>(`.focus-toolbar [aria-label="${label}"]`)!
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 25)) })
const click = (label: string) => act(async () => { expect(button(label)).toBeTruthy(); button(label).click() })
const discussions = () => Object.values(useAppStore.getState().tabs).filter(tab => tab.id.startsWith('launcher:'))
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); localStorage.clear(); useAppStore.setState(baseline, true); seedMoteWorkface()
  const state = useAppStore.getState()
  const agent = createWorkbenchTab(sourceId, { kind: 'agent', phase: 'attached', workspaceId: 'project', regionId: sourceRegion, sessionId: executionAgent.id }, 'Same visible name')
  const source = addWorkbenchRegion(agent, sourceRegion, 'right', { kind: 'file', workspaceId: 'project', regionId: 'source-file', path: 'review.md' })
  const decoy = createWorkbenchTab('ordinary-decoy', { kind: 'agent', phase: 'attached', workspaceId: 'project', regionId: 'decoy-region', sessionId: executionAgent.id }, 'Same visible name')
  const split = moveTabToNewGroup(createWorkspaceLayout('ordinary-group', [decoy.id, source.id]), source.id, 'ordinary-group', 'ordinary-group', 'right', reference.groupId)
  const layout = addTabOccurrence(split, 'ordinary-group', source.id)!
  launch = vi.fn(async () => {})
  useAppStore.setState({ tabs: { ...state.tabs, [source.id]: source, [decoy.id]: decoy },
    layouts: { ...state.layouts, project: { ...layout, activeGroupId: 'ordinary-group' } }, activeWorkspaceId: SCRATCH_WORKSPACE_ID,
    mainSurface: 'agents', agentFocus: { ...state.agentFocus, execution: { sessionId: executionAgent.id, history: [], reference } },
    launchAgent: launch, agentComposerDrafts: { ...state.agentComposerDrafts, [sourceRegion]: 'Source Region unsent' } })
  vi.spyOn(api.scratch, 'ensureMote').mockImplementation(async (_workspace, id) => moteTopics.find(topic => topic.id === id)!)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => root.render(createElement(Scene)))
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); document.getElementById('agentmux-window-overlay-host')?.remove(); localStorage.clear(); vi.restoreAllMocks(); useAppStore.setState(baseline, true) })
it('promotes direct native buttons and views the exact second occurrence instead of the ordinary active Tab', async () => {
  const before = useAppStore.getState()
  const focusRegion = vi.spyOn(before, 'focusRegion')
  expect(button('Chat about this tab with Mote').tagName).toBe('BUTTON')
  expect(button('View in Space').title).toContain('Same visible name')
  await click('View in Space')
  expect(focusRegion).toHaveBeenCalledExactlyOnceWith('project', sourceId, sourceRegion, 'keyboard', reference.groupId)
  const current = useAppStore.getState()
  expect(current.activeWorkspaceId).toBe('project'); expect(current.mainSurface).toBe('workbench')
  expect(current.layouts.project!.activeGroupId).toBe(reference.groupId)
  expect(current.agentFocus.execution.reference).toEqual(reference)
  expect(current.sessions).toBe(before.sessions); expect(current.agentComposerDrafts).toBe(before.agentComposerDrafts)
  await act(async () => button('Focus context actions').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' })))
  expect([...document.querySelectorAll('[role="menuitem"]')].map(item => item.textContent)).not.toContain('Continue in Space')
})
it('creates one exact complete-Tab discussion through the original primary Mote owner and retains both old drafts', async () => {
  const before = useAppStore.getState(), drafts = { ...before.agentComposerDrafts }
  await click('Chat about this tab with Mote'); await settle()
  const created = discussions(); expect(created).toHaveLength(1)
  const tab = created[0]!, prompt = useAppStore.getState().agentComposerDrafts[tab.layout.activeRegionId]!
  expect(tab.topicId).toBe(PMO_TEAMS_TOPIC_ID)
  expect(prompt).toContain(formatTabAddress(sourceId)); expect(prompt).not.toContain(formatTabAddress('ordinary-decoy'))
  expect(prompt).not.toContain('original-run-'); expect(prompt).not.toContain('source-file')
  expect(launch).toHaveBeenCalledExactlyOnceWith('fixture', prompt, 'mote-group', { tabId: tab.id, regionId: tab.layout.activeRegionId })
  for (const [key, value] of Object.entries(drafts)) expect(useAppStore.getState().agentComposerDrafts[key]).toBe(value)
  expect(useAppStore.getState().tabs[sourceId]).toBe(before.tabs[sourceId]); expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(useAppStore.getState().activeWorkspaceId).toBe(before.activeWorkspaceId); expect(useAppStore.getState().mainSurface).toBe('agents')
})
it('captures the existing custom Mote identity, rejects duplicate pending clicks and never reopens after late preparation', async () => {
  let release!: (value: typeof moteTopics[number]) => void
  vi.mocked(api.scratch.ensureMote).mockImplementation(() => new Promise(resolve => { release = resolve }))
  await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTopicId: customMoteId, targetTabId: 'custom-tab' })); await settle()
  await act(async () => { button('Chat about this tab with Mote').click(); button('Chat about this tab with Mote').click() })
  expect(discussions()).toHaveLength(1); expect(api.scratch.ensureMote).toHaveBeenCalledExactlyOnceWith(SCRATCH_WORKSPACE_ID, customMoteId)
  expect(button('Chat about this tab with Mote').disabled).toBe(true)
  const born = discussions()[0]!, prompt = useAppStore.getState().agentComposerDrafts[born.layout.activeRegionId]
  expect(born.topicId).toBe(customMoteId); expect(prompt).toContain(formatTabAddress(sourceId))
  const laterInput = document.createElement('input'); document.body.append(laterInput)
  await act(async () => { requestPmoTeamsTopicFloatingClose({ restoreFocus: false }); useAppStore.setState({ mainSurface: 'board', activeWorkspaceId: 'project' }); laterInput.focus() })
  await act(async () => release(moteTopics.find(topic => topic.id === customMoteId)!)); await settle()
  expect(readPmoTeamsTopicFloatingState()?.open).toBe(false); expect(document.activeElement).toBe(laterInput)
  expect(useAppStore.getState().mainSurface).toBe('board'); expect(useAppStore.getState().activeWorkspaceId).toBe('project')
  expect(useAppStore.getState().agentComposerDrafts[customAgent.id]).toBe('Analyst unsent')
  expect(launch).toHaveBeenCalledExactlyOnceWith('fixture', prompt, 'mote-group', { tabId: born.id, regionId: born.layout.activeRegionId }); laterInput.remove()
})
it('keeps the same newborn discussion and request when Mote preparation rejects or configuration is unconfirmed', async () => {
  await act(async () => useAppStore.setState({ config: { ...useAppStore.getState().config!, executors: {} } }))
  await click('Chat about this tab with Mote'); await settle()
  expect(discussions()).toHaveLength(1); expect(launch).not.toHaveBeenCalled()
  const state = useAppStore.getState(), born = discussions()[0]!
  expect(state.agentComposerDrafts[born.layout.activeRegionId]).toContain(formatTabAddress(sourceId))
  expect(state.agentComposerDrafts[defaultAgent.id]).toBe('Default unsent')
  expect(state.error).toContain('configuration is unconfirmed')
  expect(state.mainSurface).toBe('agents'); expect(state.tabs[sourceId]).toBeTruthy()
})
it('reports an unconfirmed retained occurrence without guessing a different same-SID Tab or creating a discussion', async () => {
  await act(async () => useAppStore.setState({ agentFocus: { ...useAppStore.getState().agentFocus, execution: { sessionId: executionAgent.id, history: [], reference: { ...reference, groupId: 'vanished-group' } } } }))
  const before = useAppStore.getState()
  await click('View in Space'); await click('Chat about this tab with Mote')
  expect(useAppStore.getState().mainSurface).toBe('agents'); expect(useAppStore.getState().activeWorkspaceId).toBe(before.activeWorkspaceId)
  expect(useAppStore.getState().tabs).toBe(before.tabs); expect(discussions()).toHaveLength(0)
  expect(useAppStore.getState().error).toContain('location is unconfirmed'); expect(launch).not.toHaveBeenCalled()
})
it.each(['ordinary', 'unconfirmed'] as const)('does not promote an %s Topic into a Mote or borrow another target', async kind => {
  const topicId = kind === 'ordinary' ? 'launcher:ordinary' : customMoteId
  await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTopicId: topicId, targetTabId: kind === 'ordinary' ? 'ordinary-tab' : 'custom-tab' }))
  if (kind === 'unconfirmed') await act(async () => useAppStore.setState({ scratchTopicSnapshots: {} }))
  const before = useAppStore.getState()
  await click('Chat about this tab with Mote')
  expect(api.scratch.ensureMote).not.toHaveBeenCalled(); expect(discussions()).toHaveLength(0); expect(launch).not.toHaveBeenCalled()
  expect(useAppStore.getState().tabs).toBe(before.tabs); expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(useAppStore.getState().error).toContain('Mote identity is unconfirmed')
})
