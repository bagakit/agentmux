import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LauncherMoteAction } from '../src/renderer/src/components/LauncherMoteAction'
import { useAppStore } from '../src/renderer/src/store'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { createWorkbenchTab, addWorkbenchRegion } from '../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '@agentmux/layout'
import { requestPmoTeamsTopicFloatingClose, readPmoTeamsTopicFloatingState, requestPmoTeamsTopicFloatingOpen } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { api } from '../src/renderer/src/lib/api'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, type ScratchTopicSnapshot } from '../src/shared/scratch-topics'
import { topicSpaceIconTarget } from '../src/renderer/src/lib/space-object-appearance'
import { DEFAULT_MOTE_FACE } from '../src/shared/mote-avatars'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
const dom = composerDOM(), sourcePrompt = 'Implement the task\nKeep this exact second line', oldMoteDraft = 'Unsent Mote thought'
const scratch = { id: SCRATCH_WORKSPACE_ID, name: 'No Project', hostId: 'local', path: _hygiene_fixturePath("scratch"), kind: 'folder' as const }
beforeEach(async () => { await act(async () => { requestPmoTeamsTopicFloatingOpen({ targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: 'mote' }); requestPmoTeamsTopicFloatingClose(); useLauncherState.setState({ sections: {}, drafts: {}, executors: {}, moteTopicId: null, persistenceIssue: null }) }) })
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
function createButton() { return dom.container.querySelector<HTMLButtonElement>('.launcher-mote__create')! }
function expectDrafts() { expect(useAppStore.getState().agentComposerDrafts).toEqual({ 'source-region': sourcePrompt, 'selected-mote': oldMoteDraft, 'mote-region': oldMoteDraft }); expect(useAppStore.getState().activeWorkspaceId).toBe('workspace') }
const designMote: ScratchTopicSnapshot = { id: 'launcher:design', directoryPath: 'topic--launcher--design', topicPath: 'topic--launcher--design/topic.md', title: 'Design partner with a long readable name', summary: '', collaborators: [], soul: { path: 'topic--launcher--design/SOUL.md', content: 'Design help', version: 'v1' }, moteArchive: { state: 'active', version: 'design-active' } }
const primaryMote: ScratchTopicSnapshot = { ...designMote, id: PMO_TEAMS_TOPIC_ID, title: 'Mote', directoryPath: 'topic--launcher--leader', moteArchive: { state: 'active', version: 'primary' } }
async function catalog(topics: ScratchTopicSnapshot[] = [primaryMote, designMote]) {
  await act(async () => useAppStore.setState({ scratchTopicSnapshots: { [SCRATCH_WORKSPACE_ID]: { scope: JSON.stringify(['local', _hygiene_fixturePath("scratch")]), revision: 0, reading: false, error: null, topics } } }))
}
async function choose(name: string) {
  await act(async () => dom.container.querySelector('[aria-label^="Choose Mote:"]')!.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', buttons: 0 })))
  const choice = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.includes(name))
  expect(choice).toBeDefined(); await act(async () => choice!.click())
}

describe('explicit selected Mote creation request', () => {
  it('queues one complete request through the actual send owner and preserves both independent drafts', async () => {
    await mount(); expect(createButton().textContent).toBe('Create with Mote'); expect(dom.container.querySelector('.launcher-mote__target')?.textContent).toBe('Mote')
    await act(async () => { createButton().click(); createButton().click() })
    const queue = useAppStore.getState().agentSteerQueues['selected-mote']
    expect(queue).toHaveLength(1); expect(queue![0]!.text).toContain('Help me create an Agent'); expect(queue![0]!.text).toContain(("Project: Project\nHost: local\nWorking directory: " + _hygiene_fixturePath("repo") + "\n\n")+sourcePrompt)
    expect(queue![0]!.runId).toBe('run-selected-mote'); expect(queue![0]!.origin).toBe('manual'); expectDrafts(); expect(createButton().textContent).toBe('Request queued'); expect(readPmoTeamsTopicFloatingState()).toMatchObject({ open: true, targetTabId: 'mote' })
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
    const original = useAppStore.getState().tabs.mote!
    const changed = addWorkbenchRegion(original, 'mote-region', 'right', { regionId: 'other-region', kind: 'launcher', workspaceId: SCRATCH_WORKSPACE_ID })
    await act(async () => useAppStore.setState({ tabs: { ...useAppStore.getState().tabs, mote: { ...changed, layout: { ...changed.layout, activeRegionId: 'other-region' } } } })); await act(async () => release())
    expect(launch).toHaveBeenCalledTimes(1); expect(readPmoTeamsTopicFloatingState()?.open).toBe(false); expectDrafts()
  })
  it('creates the exact chosen input when that Mote has no Tab yet, without cancelling its own discovery', async () => {
    await mount(); await catalog(); await choose(designMote.title)
    const open = vi.fn().mockImplementation(async (topicId: string) => {
      const state = useAppStore.getState()
      const mote = { ...createWorkbenchTab('new-mote', { regionId: 'new-mote-region', kind: 'agent', phase: 'attached', workspaceId: SCRATCH_WORKSPACE_ID, sessionId: 'new-mote-agent' }), topicId }
      useAppStore.setState({ tabs: { ...state.tabs, 'new-mote': mote }, layouts: { ...state.layouts, [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('mote-group', ['mote', 'new-mote']) }, sessions: [...state.sessions, composerSession('new-mote-agent')] })
      // Let React observe the newly discovered Tab before continuing the same request.
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    await act(async () => useAppStore.setState({ openScratchTopic: open }))
    await act(async () => { createButton().click(); await new Promise(resolve => setTimeout(resolve, 10)) })
    expect(open).toHaveBeenCalledWith(designMote.id, SCRATCH_WORKSPACE_ID, { reveal: false })
    expect(useAppStore.getState().agentSteerQueues['new-mote-agent']).toHaveLength(1)
    expect(readPmoTeamsTopicFloatingState()).toMatchObject({ open: true, targetTopicId: designMote.id, targetTabId: 'new-mote' })
    expect(useAppStore.getState().agentComposerDrafts['source-region']).toBe(sourcePrompt)
  })
  it('opens an empty request without ensuring, sending or starting an Agent', async () => {
    await mount('agent', ''); const send = vi.spyOn(useAppStore.getState(), 'send'), launch = vi.fn(); await act(async () => useAppStore.setState({ launchAgent: launch }))
    await act(async () => createButton().click()); expect(api.scratch.ensureMote).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled(); expect(readPmoTeamsTopicFloatingState()).toMatchObject({ open: true, targetTabId: 'mote' }); expect(useAppStore.getState().agentComposerDrafts['selected-mote']).toBe(oldMoteDraft)
  })
  it('does not retarget a pending request after the selected Mote changes', async () => {
    await mount(); let release!: () => void; vi.mocked(api.scratch.ensureMote).mockImplementation(async () => { await new Promise<void>(r => { release = r }); return {} as never })
    await act(async () => createButton().click()); await act(async () => { useLauncherState.getState().selectMote('another-mote') }); await act(async () => release())
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
    await act(async () => useAppStore.setState({ tabs: { ...useAppStore.getState().tabs, 'other-mote': other }, sessions: [...useAppStore.getState().sessions, composerSession('other-agent')], layouts: { ...useAppStore.getState().layouts, [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('mote-group', ['mote', 'other-mote']) }, scratchTopicSnapshots: { [SCRATCH_WORKSPACE_ID]: { scope: JSON.stringify(['local', _hygiene_fixturePath("scratch")]), revision: 0, reading: false, error: null, topics: [topic] } } }))
    await act(async () => dom.container.querySelector('[aria-label="Choose Mote: Mote"]')!.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', buttons: 0 })))
    const choice = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.includes('Design partner'))
    expect(choice).toBeDefined(); await act(async () => choice!.click())
    expect(dom.container.querySelector('.launcher-mote__target')?.textContent).toBe('Design partner'); await act(async () => createButton().click())
    expect(useAppStore.getState().agentSteerQueues['selected-mote']).toBeUndefined(); expect(useAppStore.getState().agentSteerQueues['other-agent']).toHaveLength(1); expect(useAppStore.getState().agentSteerQueues['other-agent']![0].text).toContain(sourcePrompt); expectDrafts()
  })
  it('remembers the last explicit choice across new Launchers and a durable preference read, independently of floating navigation', async () => {
    await mount(); await catalog(); await choose(designMote.title)
    const saved = localStorage.getItem('agentmux-launcher')!
    expect(JSON.parse(saved).state.moteTopicId).toBe(designMote.id)
    expect(readPmoTeamsTopicFloatingState()).toMatchObject({ open: false, targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: 'mote' })
    await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTopicId: PMO_TEAMS_TOPIC_ID }))
    await dom.render(<LauncherMoteAction key="new-launcher" workspace={{ ...composerConfig.workspaces[0]!, id: 'another-project' }} prompt="" />)
    expect(dom.container.querySelector('.launcher-mote__target')?.textContent).toBe(designMote.title)
    await act(async () => { useLauncherState.setState({ moteTopicId: null }); localStorage.setItem('agentmux-launcher', saved); await useLauncherState.persist.rehydrate() })
    expect(dom.container.querySelector('.launcher-mote__target')?.textContent).toBe(designMote.title)
    await choose('Mote'); expect(useLauncherState.getState().moteTopicId).toBe(PMO_TEAMS_TOPIC_ID)
  })
  it('uses the exact selected Mote image in both the chooser and create button, then replaces it with the next Mote face', async () => {
    await mount(); await catalog()
    const objectKey = topicSpaceIconTarget(scratch, designMote).key
    const dataUrl = 'data:image/png;base64,selected-avatar'
    const read = vi.spyOn(api.scratch, 'readMoteAvatar').mockResolvedValue({ dataUrl } as never)
    await act(async () => useAppStore.setState({ spaceObjectIcons: { [objectKey]: { kind: 'image', fileName: 'mote-avatar.png' }, [topicSpaceIconTarget(scratch, primaryMote).key]: DEFAULT_MOTE_FACE } }))
    await act(async () => dom.container.querySelector('[aria-label^="Choose Mote:"]')!.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', buttons: 0 })))
    const choice = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.includes(designMote.title))!
    expect(choice.querySelector('img')?.getAttribute('src')).toBe(dataUrl)
    await act(async () => choice.click())
    expect(createButton().querySelector('img')?.getAttribute('src')).toBe(dataUrl)
    expect(read).toHaveBeenCalledWith(SCRATCH_WORKSPACE_ID, designMote.id, { kind: 'image', fileName: 'mote-avatar.png' }, objectKey)
    await choose('Mote'); expect(createButton().querySelector('img')).toBeNull(); expect(createButton().querySelector('.mote-face')).not.toBeNull()
  })
  it('keeps an archived default identity and a usable creation path when every Mote is archived', async () => {
    await mount(); await catalog([primaryMote, designMote].map(mote => ({ ...mote, moteArchive: { state: 'archived', version: 'archived-' + mote.id } })))
    expect(dom.container.querySelector('.launcher-mote__target')?.textContent).toBe('Mote')
    expect(dom.container.querySelector('.launcher-mote__archive[role="status"]')?.textContent).toContain('Archived')
    expect(dom.container.querySelector('.launcher-mote__archive button')?.textContent).toBe('Restore Mote')
    expect(createButton().disabled).toBe(false)
    await act(async () => dom.container.querySelector('[aria-label^="Choose Mote:"]')!.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', buttons: 0 })))
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    expect(items.map(item => item.textContent)).toEqual(['No active Motes']); expect(items[0]!.getAttribute('aria-disabled')).toBe('true')
    await act(async () => items[0]!.closest('[role="menu"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    await act(async () => createButton().click()); expect(useAppStore.getState().agentSteerQueues['selected-mote']).toHaveLength(1); expectDrafts()
  })
  it('retains a saved archived long-name Mote and reports a restore failure without disabling creation or selecting another', async () => {
    await mount(); await catalog([primaryMote, { ...designMote, moteArchive: { state: 'archived', version: 'archived' } }])
    await act(async () => useLauncherState.getState().selectMote(designMote.id))
    const restore = vi.spyOn(useAppStore.getState(), 'setMoteArchived').mockRejectedValue(new Error('Directory write failed'))
    await act(async () => (dom.container.querySelector('.launcher-mote__archive button') as HTMLButtonElement).click())
    expect(restore).toHaveBeenCalledWith(SCRATCH_WORKSPACE_ID, designMote.id, false, topicSpaceIconTarget(scratch, designMote).key, 'archived')
    expect(dom.container.textContent).toContain('Directory write failed'); expect(createButton().disabled).toBe(false)
    expect(dom.container.querySelector('.launcher-mote__target')?.textContent).toBe(designMote.title)
    expect(useLauncherState.getState().moteTopicId).toBe(designMote.id)
    await act(async () => useAppStore.setState({ scratchTopicSnapshots: { [SCRATCH_WORKSPACE_ID]: { ...useAppStore.getState().scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]!, error: 'Directory unavailable' } } }))
    expect(dom.container.querySelectorAll('.service-window')).toHaveLength(1)
    expect(dom.container.textContent).toContain('Directory unavailable'); expect(dom.container.textContent).toContain('Directory write failed')
    expect(dom.container.textContent).toContain(`Restore for ${designMote.title} was not confirmed`)
    expect(dom.container.textContent).not.toContain('Mote archive state is unconfirmed'); expect(createButton().disabled).toBe(false)
  })
  it('announces unknown archive state and keeps the selected creation input usable', async () => {
    await mount(); await catalog([{ ...primaryMote, moteArchive: { state: 'unknown', issue: 'Archive metadata unreadable' } }])
    expect(dom.container.textContent).toContain('Mote archive state is unconfirmed'); expect(dom.container.textContent).toContain('Archive metadata unreadable')
    expect(dom.container.querySelector('.launcher-mote__archive')).toBeNull(); expect(createButton().disabled).toBe(false)
    await act(async () => createButton().click()); expect(useAppStore.getState().agentSteerQueues['selected-mote']).toHaveLength(1)
  })
  it('retains the exact saved target while its directory is unavailable, reports the failure and still offers the one active Mote', async () => {
    await mount(); await act(async () => {
      useLauncherState.getState().selectMote('launcher:unread')
      useAppStore.setState({ scratchTopicSnapshots: { [SCRATCH_WORKSPACE_ID]: { scope: JSON.stringify(['local', _hygiene_fixturePath("scratch")]), revision: 0, reading: false, error: 'Directory unavailable', topics: null } } })
    })
    expect(dom.container.querySelector('.launcher-mote__target')?.textContent).toBe('Saved Mote')
    expect(dom.container.textContent).toContain('Mote directory read needs attention'); expect(dom.container.textContent).toContain('Directory unavailable')
    expect(createButton().disabled).toBe(false); expect(useLauncherState.getState().moteTopicId).toBe('launcher:unread')
    const retry = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Retry directory')!
    await act(async () => retry.click()); expect(useAppStore.getState().refreshScratchTopics).toHaveBeenCalledWith(SCRATCH_WORKSPACE_ID, true)
    await choose('Mote'); expect(useLauncherState.getState().moteTopicId).toBe(PMO_TEAMS_TOPIC_ID)
  })
  it('keeps a saved target missing from a confirmed directory read and offers a visible retry', async () => {
    await mount(); await catalog([primaryMote]); await act(async () => useLauncherState.getState().selectMote(designMote.id))
    expect(dom.container.textContent).toContain('selected Mote was not found'); expect(dom.container.textContent).toContain('Retry directory')
    expect(useLauncherState.getState().moteTopicId).toBe(designMote.id); expect(createButton().disabled).toBe(false)
  })
  it('keeps a choice usable in memory when saving fails and exposes the Launcher persistence issue', async () => {
    await mount(); await catalog()
    const write = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('Storage full') })
    await choose(designMote.title)
    expect(dom.container.querySelector('.launcher-mote__target')?.textContent).toBe(designMote.title)
    expect(useLauncherState.getState().persistenceIssue).toContain('selected Mote could not be saved')
    expect(createButton().disabled).toBe(false); write.mockRestore()
  })
  it('defaults Browser and Note to collapsed while respecting explicit expanded and hidden preferences', async () => {
    const { NewTabSurface } = await import('../src/renderer/src/components/NewTabSurface')
    await mount(); await dom.render(<NewTabSurface tabGroupId="source-group" tabId="source" regionId="source-region" visible={false} />)
    expect(dom.container.querySelector('[aria-label="Expand Browser"]')).not.toBeNull(); expect(dom.container.querySelector('[aria-label="Expand Note"]')).not.toBeNull(); expect(dom.container.querySelector('[aria-label="Browser address or search"]')).toBeNull()
    await act(async () => { useLauncherState.getState().setSection('workspace', 'browser', 'expanded'); useLauncherState.getState().setSection('workspace', 'note', 'hidden') })
    expect(dom.container.querySelector('[aria-label="Browser address or search"]')).not.toBeNull(); expect(dom.container.querySelector('[aria-label="Restore Note"]')).not.toBeNull(); expect(useAppStore.getState().agentComposerDrafts['source-region']).toBe(sourcePrompt)
  })
})
