// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { useAppStore } from '../src/renderer/src/store'
import { addWorkbenchRegion } from '../src/renderer/src/lib/workbench-tabs'
import { requestPmoTeamsTopicFloatingOpen } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { createMoteApp, moteClick, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { customMoteId, customTab, defaultAgent, defaultTab, neighborAgent, neighborTab, ordinaryTopicId, ordinaryTab } from './fixtures/mote-workface'

let app: MoteAppFixture
beforeEach(() => { app = createMoteApp() })
afterEach(async () => { await app.dispose() })
function scope() {
  const node = app.container.querySelector<HTMLElement>('.workspace-workbench-registry [data-mote-workface]')
  expect(node).not.toBeNull(); return node!
}
function tabs(node: HTMLElement) { return [...node.querySelectorAll<HTMLButtonElement>('.mote-conversations button.workbench-tab')] }

describe('original Mote chat workface consumer', () => {
  it('gives one Mote its own two workfaces and preserves the original input across a real Topic and Folder transition', async () => {
    await app.mount()
    expect(scope().dataset.moteWorkface).toBe(PMO_TEAMS_TOPIC_ID)
    expect(tabs(scope()).map(node => node.dataset.workbenchTabId)).toEqual([defaultTab.id, neighborTab.id])
    const input = scope().querySelector('[aria-label="Message Agent"]')
    expect(input).not.toBeNull()
    expect(input!.textContent).toContain('Default unsent')
    const before = useAppStore.getState()
    expect(before.agentComposerDrafts[defaultAgent.id]).toBe('Default unsent')
    await act(async () => useAppStore.getState().openScratchTopic(ordinaryTopicId, SCRATCH_WORKSPACE_ID, { tabId: ordinaryTab.id }))
    await settleMoteApp()
    expect(app.container.querySelector('.workspace-workbench-registry [data-mote-workface]')).toBeNull()
    expect(app.container.querySelector('.workspace-workbench-registry .workbench-tab-strip')).not.toBeNull()
    await act(async () => useAppStore.setState({ activeWorkspaceId: 'project' }))
    await settleMoteApp()
    await act(async () => useAppStore.getState().openScratchTopic(PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, { tabId: defaultTab.id }))
    await settleMoteApp()
    expect(scope().querySelector('[aria-label="Message Agent"]')).toBe(input)
    expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(useAppStore.getState().sessions).toBe(before.sessions)
    expect(useAppStore.getState().viewModes).toBe(before.viewModes)
    expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled()
  })

  it('keeps multiple Session Regions inside the same Tab and selects the original exact Region', async () => {
    const split = addWorkbenchRegion(defaultTab, 'default-region', 'right', { kind: 'agent', phase: 'attached', workspaceId: SCRATCH_WORKSPACE_ID, regionId: 'second-original-region', sessionId: neighborAgent.id })
    useAppStore.setState(state => ({ tabs: { ...state.tabs, [defaultTab.id]: split } }))
    await app.mount()
    const regions = [...scope().querySelectorAll<HTMLButtonElement>('[data-mote-session-region]')]
    expect(regions.map(node => node.dataset.moteSessionId)).toEqual([defaultAgent.id, neighborAgent.id])
    expect(tabs(scope()).map(node => node.dataset.workbenchTabId)).toEqual([defaultTab.id, neighborTab.id])
    const original = useAppStore.getState().agentComposerDrafts
    await moteClick(regions[0]!)
    expect(useAppStore.getState().tabs[defaultTab.id]?.layout.activeRegionId).toBe('default-region')
    expect(useAppStore.getState().agentComposerDrafts).toBe(original)
    expect(Object.keys(useAppStore.getState().tabs[defaultTab.id]!.regions)).toEqual(['default-region', 'second-original-region'])
  })

  it('uses the original Tab controls in Float without changing the background layout or view preference', async () => {
    useAppStore.setState({ activeWorkspaceId: 'project', mainSurface: 'board' })
    await app.mount()
    await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: defaultTab.id }))
    await settleMoteApp()
    const before = useAppStore.getState()
    expect(tabs(app.panel()).map(node => node.dataset.workbenchTabId)).toEqual([defaultTab.id, neighborTab.id])
    await moteClick(tabs(app.panel())[1]!)
    expect(app.panel().dataset.moteTargetTab).toBe(neighborTab.id)
    const after = useAppStore.getState()
    expect(after.activeWorkspaceId).toBe('project'); expect(after.mainSurface).toBe('board')
    expect(after.layouts).toBe(before.layouts)
    expect(after.agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(after.viewModes).toBe(before.viewModes)
    expect(app.panel().querySelector('[aria-label="Close Other goal"]')).not.toBeNull()
    await moteClick(app.panel().querySelector<HTMLButtonElement>('[data-mote-topic-id="' + customMoteId + '"]')!)
    expect(tabs(app.panel()).map(node => node.dataset.workbenchTabId)).toEqual([customTab.id])
    expect(app.panel().querySelector('[data-mote-session-id="' + defaultAgent.id + '"]')).toBeNull()
  })
})
