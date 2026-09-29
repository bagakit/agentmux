// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LauncherMoteAction } from '../src/renderer/src/components/LauncherMoteAction'
import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface'
import { useAppStore } from '../src/renderer/src/store'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { createWorkbenchTab, addWorkbenchRegion } from '../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '@agentmux/layout'
import { requestPmoTeamsTopicFloatingClose, readPmoTeamsTopicFloatingState, requestPmoTeamsTopicFloatingOpen } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { api } from '../src/renderer/src/lib/api'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
const dom = composerDOM(), sourcePrompt = 'Implement the task\nKeep this exact second line', oldMoteDraft = 'Unsent Mote thought'
const scratch = { id: SCRATCH_WORKSPACE_ID, name: 'No Project', hostId: 'local', path: '/scratch', kind: 'folder' as const }
beforeEach(async () => { await act(async () => { requestPmoTeamsTopicFloatingOpen({ targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: 'mote' }); requestPmoTeamsTopicFloatingClose(); useLauncherState.setState({ sections: {}, drafts: {}, executors: {}, persistenceIssue: null }) }) })
async function mount(kind: 'agent' | 'launcher' = 'agent', prompt = sourcePrompt) {
  const source = createWorkbenchTab('source', { regionId: 'source-region', kind: 'launcher', workspaceId: 'workspace' })
  const target = { ...createWorkbenchTab('mote', kind === 'agent' ? { regionId: 'mote-region', kind, phase: 'attached', workspaceId: SCRATCH_WORKSPACE_ID, sessionId: 'selected-mote' } : { regionId: 'mote-region', kind, workspaceId: SCRATCH_WORKSPACE_ID }), topicId: PMO_TEAMS_TOPIC_ID }
  await act(async () => {
    useAppStore.setState({ config: { ...composerConfig, workspaces: [...composerConfig.workspaces, scratch] }, activeWorkspaceId: 'workspace', tabs: { source, mote: target }, layouts: { workspace: createWorkspaceLayout('source-group', ['source']), [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('mote-group', ['mote']) }, sessions: [composerSession('selected-mote')], agentSteerQueues: {}, agentComposerDrafts: { 'source-region': prompt, 'selected-mote': oldMoteDraft, 'mote-region': oldMoteDraft }, refreshScratchTopics: vi.fn().mockResolvedValue(undefined), openScratchTopic: vi.fn().mockResolvedValue(undefined), flushAgentSteerQueue: vi.fn().mockResolvedValue(undefined) })
    vi.spyOn(api.scratch, 'ensureMote').mockResolvedValue({} as never)
    vi.spyOn(api.continuousProgress, 'pauseForInput').mockResolvedValue(undefined)
  })
  await dom.render(<LauncherMoteAction workspace={composerConfig.workspaces[0]} prompt={prompt} sourceTabId="source" sourceRegionId="source-region" />)
}
function createButton() { return dom.container.querySelector<HTMLButtonElement>('.launch-refine__toggle')! }
function expectDrafts() { expect(useAppStore.getState().agentComposerDrafts).toEqual({ 'source-region': sourcePrompt, 'selected-mote': oldMoteDraft, 'mote-region': oldMoteDraft }); expect(useAppStore.getState().activeWorkspaceId).toBe('workspace') }

describe('explicit selected Mote creation request', () => {
  it('queues one complete request through the actual send owner and preserves both independent drafts', async () => {
    await mount(); expect(createButton().textContent).toBe('Create with Mote'); expect(dom.container.querySelector('.launcher-mote__target')?.textContent).toBe('Mote')
    await act(async () => { createButton().click(); createButton().click() })
    const queue = useAppStore.getState().agentSteerQueues['selected-mote']
    expect(queue).toHaveLength(1); expect(queue![0].text).toContain('Help me create an Agent'); expect(queue![0].text).toContain('Project: Project\nHost: local\nWorking directory: /repo\n\n'+sourcePrompt)
    expect(queue![0].runId).toBe('run-selected-mote'); expect(queue![0].origin).toBe('manual'); expectDrafts(); expect(createButton().textContent).toBe('Request queued'); expect(readPmoTeamsTopicFloatingState()).toMatchObject({ open: true, targetTabId: 'mote' })
    await act(async () => createButton().click()); expect(useAppStore.getState().agentSteerQueues['selected-mote']).toHaveLength(1)
  })
  it('starts only the exact original Mote Launcher using the existing public launch action', async () => {
    await mount('launcher'); const launch = vi.fn().mockResolvedValue(undefined); await act(async () => useAppStore.setState({ launchAgent: launch }))
    await act(async () => createButton().click()); expect(launch).toHaveBeenCalledTimes(1); expect(launch).toHaveBeenCalledWith('codex', expect.stringContaining(sourcePrompt), 'mote-group', { tabId: 'mote', regionId: 'mote-region' }); expectDrafts(); expect(useAppStore.getState().agentSteerQueues).toEqual({})
  })
  it('does not open another target Region after the original launch finishes late', async () => {
    await mount('launcher'); let release!: () => void
    const launch = vi.fn().mockImplementation(() => new Promise<void>(r => { release = r }))
    await act(async () => useAppStore.setState({ launchAgent: launch })); await act(async () => createButton().click())
    const original = useAppStore.getState().tabs.mote
    const changed = addWorkbenchRegion(original, 'mote-region', 'right', { regionId: 'other-region', kind: 'launcher', workspaceId: SCRATCH_WORKSPACE_ID })
    await act(async () => useAppStore.setState({ tabs: { ...useAppStore.getState().tabs, mote: { ...changed, layout: { ...changed.layout, activeRegionId: 'other-region' } } } })); await act(async () => release())
    expect(launch).toHaveBeenCalledTimes(1); expect(readPmoTeamsTopicFloatingState()?.open).toBe(false); expectDrafts()
  })
  it('opens an empty request without ensuring, sending or starting an Agent', async () => {
    await mount('agent', ''); const send = vi.spyOn(useAppStore.getState(), 'send'), launch = vi.fn(); await act(async () => useAppStore.setState({ launchAgent: launch }))
    await act(async () => createButton().click()); expect(api.scratch.ensureMote).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled(); expect(readPmoTeamsTopicFloatingState()).toMatchObject({ open: true, targetTabId: 'mote' }); expect(useAppStore.getState().agentComposerDrafts['selected-mote']).toBe(oldMoteDraft)
  })
  it('does not retarget a pending request after the selected Mote changes', async () => {
    await mount(); let release!: () => void; vi.mocked(api.scratch.ensureMote).mockImplementation(async () => { await new Promise<void>(r => { release = r }); return {} as never })
    await act(async () => createButton().click()); await act(async () => { requestPmoTeamsTopicFloatingOpen({ targetTopicId: 'another-mote' }) }); await act(async () => release())
    expect(useAppStore.getState().agentSteerQueues).toEqual({}); expectDrafts(); expect(useAppStore.getState().openScratchTopic).not.toHaveBeenCalled()
  })
  it('preserves both drafts and gives a persistent, honest failure without claiming creation', async () => {
    await mount(); await act(async () => useAppStore.setState({ sessions: [] })); await act(async () => createButton().click())
    expect(dom.container.textContent).toContain('Creation handoff to Mote is unconfirmed'); expect(dom.container.textContent).toContain('could not queue'); expect(dom.container.textContent).not.toContain('Agent created'); expect(useAppStore.getState().agentSteerQueues).toEqual({}); expectDrafts()
  })
  it('lets the user choose a real named Mote and queues only to that exact Agent', async () => {
    await mount()
    const other = { ...createWorkbenchTab('other-mote', { regionId: 'other-region', kind: 'agent', phase: 'attached', workspaceId: SCRATCH_WORKSPACE_ID, sessionId: 'other-agent' }), topicId: 'design-mote' }
    const topic = { id: 'design-mote', directoryPath: 'design-mote', topicPath: 'design-mote/topic.md', title: 'Design partner', summary: '', collaborators: [], soul: { path: 'design-mote/SOUL.md', content: 'Design help', version: 'v1' } }
    await act(async () => useAppStore.setState({ tabs: { ...useAppStore.getState().tabs, 'other-mote': other }, sessions: [...useAppStore.getState().sessions, composerSession('other-agent')], layouts: { ...useAppStore.getState().layouts, [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('mote-group', ['mote', 'other-mote']) }, scratchTopicSnapshots: { [SCRATCH_WORKSPACE_ID]: { scope: JSON.stringify(['local', '/scratch']), revision: 0, reading: false, error: null, topics: [topic] } } }))
    await act(async () => dom.container.querySelector('[aria-label="Choose Mote: Mote"]')!.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', buttons: 0 })))
    const choice = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.includes('Design partner'))
    expect(choice).toBeDefined(); await act(async () => choice!.click())
    expect(dom.container.querySelector('.launcher-mote__target')?.textContent).toBe('Design partner'); await act(async () => createButton().click())
    expect(useAppStore.getState().agentSteerQueues['selected-mote']).toBeUndefined(); expect(useAppStore.getState().agentSteerQueues['other-agent']).toHaveLength(1); expect(useAppStore.getState().agentSteerQueues['other-agent']![0].text).toContain(sourcePrompt); expectDrafts()
  })
  it('defaults Browser and Note to collapsed while respecting explicit expanded and hidden preferences', async () => {
    await mount(); await dom.render(<NewTabSurface tabGroupId="source-group" tabId="source" regionId="source-region" visible={false} />)
    expect(dom.container.querySelector('[aria-label="Expand Browser"]')).not.toBeNull(); expect(dom.container.querySelector('[aria-label="Expand Note"]')).not.toBeNull(); expect(dom.container.querySelector('[aria-label="Browser address or search"]')).toBeNull()
    await act(async () => { useLauncherState.getState().setSection('workspace', 'browser', 'expanded'); useLauncherState.getState().setSection('workspace', 'note', 'hidden') })
    expect(dom.container.querySelector('[aria-label="Browser address or search"]')).not.toBeNull(); expect(dom.container.querySelector('[aria-label="Restore Note"]')).not.toBeNull(); expect(useAppStore.getState().agentComposerDrafts['source-region']).toBe(sourcePrompt)
  })
})
