// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMoteApp, moteClick, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { defaultAgent, defaultTab, scratchWorkspace, moteTopics } from './fixtures/mote-workface'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '../src/shared/scratch-topics'
import { documentKey } from '../src/renderer/src/lib/workbench-tabs'
import { openMoteDiscussionDraft } from '../src/renderer/src/lib/mote-materials-actions'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { warmLauncherId } from '../src/renderer/src/lib/warm-terminal-preview'
vi.mock('../src/renderer/src/components/EditorPane', () => ({ EditorPane: () => createElement('div', { 'data-original-editor': true }) }))
let app: MoteAppFixture
const rootPath = scratchTopicDirectoryName(PMO_TEAMS_TOPIC_ID), path = rootPath + '/SOUL.md', revision = 'sha256:' + 'a'.repeat(64)
beforeEach(() => {
  app = createMoteApp(); useAppStore.setState({ toolsOpen: true, explorerCollapsed: { [SCRATCH_WORKSPACE_ID]: false } })
  useLauncherState.setState({ drafts: {} })
  vi.spyOn(api.files, 'readDirectory').mockResolvedValue([]); vi.spyOn(api.files, 'observe').mockResolvedValue(); vi.spyOn(api.files, 'unobserve').mockResolvedValue()
})
afterEach(async () => { await app.dispose() })
const details = () => app.container.querySelector<HTMLElement>('[data-mote-details]')!
async function text(selector: string, value: string) {
  const input = details().querySelector<HTMLTextAreaElement>(selector)!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
}
const button = (name: string) => [...details().querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === name)!
const scope = () => ({ workspace: scratchWorkspace, topic: moteTopics.find(topic => topic.id === PMO_TEAMS_TOPIC_ID)!, rootPath })

describe('original Mote cooperation Editor and explicit new Launcher', () => {
  it('prepares a real editable new Launcher in the same Zone and Group without clearing old inputs or operating a Run', async () => {
    const groupId = warmLauncherId({ tabGroupId: 'mote-group', regionId: undefined })
    const groupDraft = { prompt: 'Retained Group unsent', browser: 'https://example.test/original', note: 'An original unmaterialized note.', names: { agentName: 'Original Group Agent', tabName: 'Original Group Tab' }, optionsByProvider: {} }
    useLauncherState.setState({ drafts: { [groupId]: groupDraft } })
    await app.mount(); const before = useAppStore.getState()
    await text('[aria-label="Try a cooperation question"]', 'Help me compare two designs.'); await moteClick(button('Prepare new discussion'))
    expect(useLauncherState.getState().drafts[groupId]).toEqual(groupDraft)
    const after = useAppStore.getState(), created = Object.values(after.tabs).filter(tab => !before.tabs[tab.id])
    expect(created).toHaveLength(1); const tab = created[0]!, region = tab.regions[tab.layout.activeRegionId]!
    expect(tab.topicId).toBe(PMO_TEAMS_TOPIC_ID); expect(tab.workspaceId).toBe(SCRATCH_WORKSPACE_ID); expect(region.kind).toBe('launcher')
    expect(after.layouts[SCRATCH_WORKSPACE_ID]?.groups.find(group => group.id === 'mote-group')?.activeTabId).toBe(tab.id)
    expect(after.workbenchSpaceSelection).toMatchObject({ tabId: tab.id, regionId: region.regionId, groupId: 'mote-group', ...tab.space })
    expect(after.agentComposerDrafts[region.regionId]).toBe('Help me compare two designs.')
    for (const [key, value] of Object.entries(before.agentComposerDrafts)) expect(after.agentComposerDrafts[key]).toBe(value)
    expect(after.sessions).toBe(before.sessions); expect(after.tabs[defaultTab.id]).toBe(before.tabs[defaultTab.id]); expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
  })
  it('keeps the exact new Launcher and question when no executor is configured', async () => {
    useAppStore.setState({ config: { ...useAppStore.getState().config!, executors: {} } }); await app.mount()
    await text('[aria-label="Try a cooperation question"]', 'My question with no executor'); await moteClick(button('Prepare new discussion'))
    const state = useAppStore.getState(), selected = state.workbenchSpaceSelection!, tab = state.tabs[selected.tabId!]!
    expect(tab.regions[selected.regionId!]?.kind).toBe('launcher'); expect(state.agentComposerDrafts[selected.regionId!]).toBe('My question with no executor')
    expect(state.agentComposerDrafts[defaultAgent.id]).toBe('Default unsent'); expect(app.launch).not.toHaveBeenCalled()
  })
  it('retains later input in the returned Launcher and refuses to borrow an old Tab', async () => {
    await app.mount(); const before = useAppStore.getState()
    const unsubscribe = useAppStore.subscribe(current => {
      const tab = Object.values(current.tabs).find(candidate => !before.tabs[candidate.id])
      if (tab && current.agentComposerDrafts[tab.layout.activeRegionId] === undefined) current.setAgentComposerDraft(tab.layout.activeRegionId, 'Later user input')
    })
    let result: ReturnType<typeof openMoteDiscussionDraft> = null
    await act(async () => { result = openMoteDiscussionDraft(scope(), 'Original trial question') })
    unsubscribe(); expect(result).toBeNull()
    const tab = Object.values(useAppStore.getState().tabs).find(candidate => !before.tabs[candidate.id])!
    expect(useAppStore.getState().agentComposerDrafts[tab.layout.activeRegionId]).toBe('Later user input')
    expect(useAppStore.getState().reportError).toHaveBeenCalled(); expect(app.launch).not.toHaveBeenCalled()
    await act(async () => useAppStore.setState({ openLauncher: () => defaultTab.id }))
    await act(async () => { expect(openMoteDiscussionDraft(scope(), 'Must not reach old Session')).toBeNull() }); expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent')
  })
  it('stages selected preferences after the untouched original SOUL and saves through the actual Editor revision protocol', async () => {
    const original = '# My original SOUL\nKeep all custom content exactly.\n'
    vi.spyOn(api.files, 'read').mockResolvedValue({ status: 'read', document: { path, content: original, revision } })
    const write = vi.spyOn(api.files, 'write').mockResolvedValue({ status: 'written', revision: 'sha256:' + 'b'.repeat(64) })
    await app.mount(); expect(details().textContent).toContain('new Sessions'); expect(details().textContent).toContain('current directions take priority')
    await moteClick(button('Adjust cooperation')); await text('[aria-label="Custom cooperation preferences"]', 'Use concrete examples.'); await moteClick(button('Review in editor'))
    const state = useAppStore.getState(), key = documentKey(SCRATCH_WORKSPACE_ID, path), doc = state.documents[key]!
    expect(doc.content.startsWith(original)).toBe(true); expect(doc.content).toContain('Use concrete examples.'); expect(doc.revision).toBe(revision)
    expect(state.dirtyDocuments[key]).toBe(true); expect(write).not.toHaveBeenCalled()
    const tab = Object.values(state.tabs).find(tab => Object.values(tab.regions).some(region => region.kind === 'file' && region.path === path))!
    await act(async () => state.saveDocument(tab.id, tab.layout.activeRegionId)); await settleMoteApp()
    expect(write).toHaveBeenCalledExactlyOnceWith(SCRATCH_WORKSPACE_ID, { path, content: doc.content, expectedRevision: revision })
    expect(useAppStore.getState().dirtyDocuments[key]).not.toBe(true); expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
  })
  it('refuses a new Launcher whose execution resource changes during publication without replacing its later target', async () => {
    await app.mount(); const before = useAppStore.getState()
    const unsubscribe = useAppStore.subscribe(current => {
      const tab = Object.values(current.tabs).find(candidate => !before.tabs[candidate.id])
      const region = tab?.regions[tab.layout.activeRegionId]
      if (tab && region?.kind === 'launcher' && region.workspaceId === SCRATCH_WORKSPACE_ID) {
        current.setLauncherExecutionWorkspace({ tabId: tab.id, regionId: region.regionId }, 'project')
      }
    })
    let result: ReturnType<typeof openMoteDiscussionDraft> = null
    await act(async () => { result = openMoteDiscussionDraft(scope(), 'Must stay in original Mote') }); unsubscribe()
    expect(result!).toBeNull()
    const tab = Object.values(useAppStore.getState().tabs).find(candidate => !before.tabs[candidate.id])!
    const region = tab.regions[tab.layout.activeRegionId]!
    expect(region.workspaceId).toBe('project'); expect(useAppStore.getState().agentComposerDrafts[region.regionId]).toBeUndefined()
    expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent'); expect(app.launch).not.toHaveBeenCalled()
  })
  it('can skip preferences without writing or opening anything', async () => {
    const read = vi.spyOn(api.files, 'read'), write = vi.spyOn(api.files, 'write'); await app.mount(); const before = useAppStore.getState()
    await moteClick(button('Adjust cooperation')); await text('[aria-label="Custom cooperation preferences"]', 'Uncommitted choice'); await moteClick(button('Skip for now'))
    expect(details().querySelector('[aria-label="Custom cooperation preferences"]')).toBeNull(); expect(useAppStore.getState().tabs).toBe(before.tabs)
    expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled(); expect(app.launch).not.toHaveBeenCalled()
  })
})
