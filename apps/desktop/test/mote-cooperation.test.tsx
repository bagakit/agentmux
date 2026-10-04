// @vitest-environment happy-dom
import { act, createElement } from 'react'
import type { FileReadParams, FileReadResult } from '@agentmux/core'
import { parseMoteBehaviorDocument, serializeMoteBehaviorDocument, DEFAULT_MOTE_BEHAVIOR, MOTE_BEHAVIOR_LINK } from '../src/renderer/src/lib/mote-behavior'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMoteApp, moteClick, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { defaultAgent, defaultTab, customMoteId, customTab, scratchWorkspace, moteTopics } from './fixtures/mote-workface'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '../src/shared/scratch-topics'
import { documentKey } from '../src/renderer/src/lib/workbench-tabs'
import { openMoteDiscussionDraft } from '../src/renderer/src/lib/mote-materials-actions'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { warmLauncherId } from '../src/renderer/src/lib/warm-terminal-preview'
import { directoryIdentity, homeZoneId } from '../src/shared/space-addresses'
vi.mock('../src/renderer/src/components/EditorPane', () => ({ EditorPane: () => createElement('div', { 'data-original-editor': true }) }))
let app: MoteAppFixture, disk: string, diskRevision: string, soulDisk: string, soulRevision: string
const rootPath = scratchTopicDirectoryName(PMO_TEAMS_TOPIC_ID), path = rootPath + '/BEHAVIOR.md', revision = 'sha256:' + 'a'.repeat(64)
beforeEach(() => {
  disk = DEFAULT_MOTE_BEHAVIOR; soulDisk = '# Original SOUL\nKeep my existing words.\n\n' + MOTE_BEHAVIOR_LINK + '\n'; diskRevision = revision
  soulRevision = revision
  app = createMoteApp(); useAppStore.setState({ toolsOpen: true, explorerCollapsed: { [SCRATCH_WORKSPACE_ID]: false } })
  useLauncherState.setState({ drafts: {} })
  vi.spyOn(api.files, 'readPublic').mockImplementation(async params => publicRead(params))
  vi.spyOn(api.files, 'read').mockImplementation(async (_workspace, requested) => ({ status: 'read', document: { path: requested, content: requested === path ? disk : soulDisk, revision: requested === path ? diskRevision : soulRevision } }))
  vi.spyOn(api.files, 'write').mockImplementation(async (_workspace, input) => { if (input.path === path) disk = input.content; else soulDisk = input.content; diskRevision = 'sha256:' + 'b'.repeat(64); return { status: 'written', revision: diskRevision } })
  vi.spyOn(api.files, 'readDirectory').mockResolvedValue([]); vi.spyOn(api.files, 'observe').mockResolvedValue(); vi.spyOn(api.files, 'unobserve').mockResolvedValue()
})
afterEach(async () => { await app.dispose() })
const details = () => app.container.querySelector<HTMLElement>('[data-mote-details]')!
async function text(selector: string, value: string) {
  const input = document.querySelector<HTMLTextAreaElement>(selector)!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
}
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === name)!
const action = (name: string) => document.querySelector<HTMLButtonElement>('[aria-label="' + name + '"]')!
const dialog = () => document.querySelector<HTMLElement>('.mote-behavior-dialog')!
const publicRead = (params: FileReadParams): FileReadResult => ({ resource: { ...params.expectedResource, zoneId: params.zoneId, zonePath: scratchWorkspace.path + '/' + rootPath, path: rootPath + '/' + params.path }, result: { status: 'read', document: { path: rootPath + '/' + params.path, content: params.path === 'BEHAVIOR.md' ? disk : soulDisk, revision: params.path === 'BEHAVIOR.md' ? diskRevision : soulRevision } } })
async function studio() { await moteClick(action('Edit behavior settings')) }
async function trial() { await studio(); await moteClick(action('Try a cooperation question')) }
async function choices() { for (const value of ['I', 'N', 'F', 'J']) await moteClick(dialog().querySelector<HTMLInputElement>('input[value="' + value + '"]')!) }
const scope = () => ({ workspace: scratchWorkspace, topic: moteTopics.find(topic => topic.id === PMO_TEAMS_TOPIC_ID)!, rootPath })

describe('original Mote cooperation Editor and explicit new Launcher', () => {
  it('prepares a real editable new Launcher in the same Zone and Group without clearing old inputs or operating a Run', async () => {
    const groupId = warmLauncherId({ tabGroupId: 'mote-group', regionId: undefined })
    const groupDraft = { prompt: 'Retained Group unsent', browser: 'https://example.test/original', note: 'An original unmaterialized note.', names: { agentName: 'Original Group Agent', tabName: 'Original Group Tab' }, optionsByProvider: {} }
    useLauncherState.setState({ drafts: { [groupId]: groupDraft } })
    await app.mount(); const before = useAppStore.getState()
    await trial(); await text('[aria-label="Cooperation trial question"]', 'Help me compare two designs.'); await moteClick(button('Prepare new discussion'))
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
    await trial(); await text('[aria-label="Cooperation trial question"]', 'My question with no executor'); await moteClick(button('Prepare new discussion'))
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
  it('saves selected preferences in BEHAVIOR while preserving original SOUL and reopening all selected choices', async () => {
    const original = '# My original SOUL\nKeep all custom content exactly.\n\n## Cooperation preferences\nOld preference remains.\n\n## Idea feedback\nOriginal note and revision remain.\n'; soulDisk = original + MOTE_BEHAVIOR_LINK + '\n'

    const write = vi.mocked(api.files.write)
    await app.mount(); expect(details().querySelector('.mote-behavior-summary select, .mote-behavior-summary textarea')).toBeNull(); expect(details().textContent).toContain('Choose how we work together.')
    await studio(); await choices(); await moteClick(action('Extra preferences')); await text('[aria-label="Custom cooperation preferences"]', 'Use concrete examples.'); await moteClick(button('Save'))
    const state = useAppStore.getState(), key = documentKey(SCRATCH_WORKSPACE_ID, path), doc = state.documents[key]!
    expect(soulDisk.startsWith(original)).toBe(true); expect(doc.content).toContain('Use concrete examples.'); expect(doc.revision).toBe(diskRevision)
    expect(state.dirtyDocuments[key]).not.toBe(true); expect(write).toHaveBeenCalledTimes(1); expect(details().textContent).toContain('MBTI style · INFJ'); expect(parseMoteBehaviorDocument(doc.content)).toMatchObject({ status: 'valid', code: 'INFJ' })
    const tab = Object.values(state.tabs).find(tab => Object.values(tab.regions).some(region => region.kind === 'file' && region.path === path))!
    expect(write).toHaveBeenCalledExactlyOnceWith(SCRATCH_WORKSPACE_ID, { path, content: doc.content, expectedRevision: revision })
    expect(useAppStore.getState().dirtyDocuments[key]).not.toBe(true); expect(details().textContent).toContain('MBTI style · INFJ')
    expect(details().textContent).not.toContain('Save there to apply it')
    await studio(); expect(dialog().querySelector<HTMLInputElement>('input[value="N"]')!.checked).toBe(true); expect(dialog().textContent).toContain('MBTI style · INFJ'); expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
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
    const read = vi.mocked(api.files.read), write = vi.mocked(api.files.write); await app.mount(); const before = useAppStore.getState()
    expect(details().querySelector('.mote-behavior-summary select, .mote-behavior-summary textarea')).toBeNull()
    const ideasAction = details().querySelector<HTMLButtonElement>('[aria-label="View ideas and saved materials"]')
    expect(ideasAction).not.toBeNull(); await moteClick(ideasAction!)
    expect(details().querySelector('[aria-label="Mote ideas"]')).not.toBeNull()
    await moteClick(button('Profile'))
    await studio(); await choices(); await moteClick(action('Extra preferences')); await text('[aria-label="Custom cooperation preferences"]', 'Uncommitted choice'); await moteClick(button('Cancel'))
    expect(document.querySelector('[aria-label="Custom cooperation preferences"]')).toBeNull(); expect(useAppStore.getState().tabs).toBe(before.tabs)
    expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled(); expect(app.launch).not.toHaveBeenCalled()
  })
  it('stages behavior for a confirmed empty Mote in its exact existing Group without creating a discussion', async () => {
    const state = useAppStore.getState(), tabs = Object.fromEntries(Object.entries(state.tabs).filter(([, tab]) => tab.topicId !== PMO_TEAMS_TOPIC_ID))
    const spaceId = directoryIdentity(scratchWorkspace.hostId, scratchWorkspace.path + '/' + rootPath)
    useAppStore.setState({ tabs, layouts: { ...state.layouts, [SCRATCH_WORKSPACE_ID]: { ...state.layouts[SCRATCH_WORKSPACE_ID]!,
      groups: state.layouts[SCRATCH_WORKSPACE_ID]!.groups.map(group => ({ ...group, tabOrder: group.tabOrder.filter(id => !!tabs[id]), activeTabId: null })) } },
      workbenchSpaceSelection: { workspaceId: SCRATCH_WORKSPACE_ID, spaceId, zoneId: homeZoneId(spaceId), groupId: 'mote-group', topicId: PMO_TEAMS_TOPIC_ID, tabId: null, regionId: null } })
    await app.mount(); await studio(); await choices(); await moteClick(button('Save'))
    const current = useAppStore.getState(), selected = current.workbenchSpaceSelection!
    expect(current.documents[documentKey(SCRATCH_WORKSPACE_ID, path)]).toBeDefined(); expect(selected.tabId).not.toBeNull()
    const file = current.tabs[selected.tabId!]!
    expect(selected.groupId).toBe('mote-group'); expect(file.topicId).toBe(PMO_TEAMS_TOPIC_ID)
    expect(file.regions[selected.regionId!]).toMatchObject({ kind: 'file', workspaceId: SCRATCH_WORKSPACE_ID, path })
    expect(Object.keys(current.tabs)).toHaveLength(Object.keys(tabs).length + 1)
    expect(parseMoteBehaviorDocument(current.documents[documentKey(SCRATCH_WORKSPACE_ID, path)]!.content)).toMatchObject({ status: 'valid', code: 'INFJ' })
    expect(vi.mocked(api.files.write)).toHaveBeenCalledTimes(1); expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
  })
  it('keeps a saved unknown target distinct from an empty Mote and does not stage through another Group', async () => {
    const original = useAppStore.getState(), selected = original.workbenchSpaceSelection!
    const tabs = Object.fromEntries(Object.entries(original.tabs).filter(([, tab]) => tab.topicId !== PMO_TEAMS_TOPIC_ID))
    useAppStore.setState({ tabs, layouts: { ...original.layouts, [SCRATCH_WORKSPACE_ID]: { ...original.layouts[SCRATCH_WORKSPACE_ID]!,
      groups: original.layouts[SCRATCH_WORKSPACE_ID]!.groups.map(group => ({ ...group, tabOrder: group.tabOrder.filter(id => !!tabs[id]), activeTabId: null })) } },
      workbenchSpaceSelection: { ...selected, tabId: 'saved-unknown-target', regionId: 'saved-unknown-region' } })
    await app.mount(); const state = useAppStore.getState()
    await studio(); await choices(); await moteClick(button('Save'))
    expect(Object.keys(useAppStore.getState().documents)).toHaveLength(0); expect(useAppStore.getState().tabs).toBe(state.tabs)
    expect(document.querySelector('.mote-behavior-dialog')).not.toBeNull(); expect(vi.mocked(api.files.write)).not.toHaveBeenCalled(); expect(app.launch).not.toHaveBeenCalled()
  })
  it('retains later explicit choices and extra text while the initial saved read is pending', async () => {
    await app.mount()
    disk = serializeMoteBehaviorDocument(disk, { engagement: 'E', information: 'S', decisions: 'T', approach: 'P', custom: 'Old saved extra.' })
    let finish!: (value: FileReadResult) => void, captured!: FileReadParams
    vi.mocked(api.files.readPublic).mockImplementationOnce(params => { captured = params; return new Promise(resolve => { finish = resolve }) })
    await studio(); await choices(); await moteClick(action('Extra preferences')); await text('[aria-label="Custom cooperation preferences"]', 'Later unsent preference.')
    await act(async () => finish(publicRead(captured))); await settleMoteApp()
    expect(dialog().textContent).toContain('MBTI style · INFJ')
    expect(dialog().querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Later unsent preference.')
    expect(useAppStore.getState().documents[documentKey(SCRATCH_WORKSPACE_ID, path)]).toBeUndefined(); expect(api.files.write).not.toHaveBeenCalled()
  })
  it('keeps unknown Save unconfirmed until the original Check saved file verifies the same attempt', async () => {
    await app.mount(); await studio(); await choices(); /* Save follows the controlled receipt loss below. */
    const state = useAppStore.getState(), key = documentKey(SCRATCH_WORKSPACE_ID, path)
    vi.mocked(api.files.write).mockImplementation(async (_workspace, input) => { if (input.path === path) disk = input.content; else soulDisk = input.content; diskRevision = 'sha256:' + 'e'.repeat(64); return { status: 'unknown', code: 'RECEIPT_LOST', message: 'The write receipt is unconfirmed.' } })
    await moteClick(button('Save'))
    const tab = Object.values(useAppStore.getState().tabs).find(tab => Object.values(tab.regions).some(region => region.kind === 'file' && region.path === path))!
    expect(dialog()).not.toBeNull(); expect(dialog().textContent).toContain('Saving is unconfirmed')
    expect(useAppStore.getState().documentIssues[key]?.kind).toBe('write-unknown')
    expect(details().querySelector('.mote-behavior-summary__tag')).toBeNull(); expect(details().textContent).toContain('Saved behavior is unconfirmed')
    expect(details().textContent).not.toContain('Save there to apply it')
    await act(async () => state.saveDocument(tab.id, tab.layout.activeRegionId)); expect(api.files.write).toHaveBeenCalledTimes(1)
    await act(async () => state.reloadDocument(tab.id, tab.layout.activeRegionId)); await settleMoteApp()
    expect(useAppStore.getState().documentIssues[key]).toBeUndefined(); expect(useAppStore.getState().dirtyDocuments[key]).toBe(false)
    expect(api.files.write).toHaveBeenCalledTimes(1); expect(details().textContent).toContain('MBTI style · INFJ')
    expect(details().textContent).not.toContain('Save there to apply it')
    await moteClick(action('Close behavior settings')); await studio(); expect(dialog().querySelector<HTMLInputElement>('input[value="I"]')!.checked).toBe(true)
    expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent'); expect(app.stop).not.toHaveBeenCalled()
  })
  it('preserves an existing unsaved original Editor paragraph when reviewing a behavior block', async () => {
    await app.mount(); await studio(); await moteClick(action('Open original behavior file'))
    const state = useAppStore.getState(), key = documentKey(SCRATCH_WORKSPACE_ID, path)
    const tab = Object.values(state.tabs).find(tab => Object.values(tab.regions).some(region => region.kind === 'file' && region.path === path))!
    const originalDraft = disk + '\nAn original unsaved paragraph.\n'
    await act(async () => state.updateDocument(tab.id, originalDraft, tab.layout.activeRegionId))
    await studio(); await choices(); await moteClick(button('Save'))
    expect(useAppStore.getState().documents[key]!.content).toBe(originalDraft)
    expect(dialog().textContent).toContain('MBTI style · INFJ')
    expect(dialog().textContent).toContain('unsaved or unconfirmed draft')
    expect(disk).not.toContain('agentmux:mote-behavior:'); expect(api.files.write).not.toHaveBeenCalled()
  })
  it('refuses later original document edits during the review read and keeps both the form and draft', async () => {
    await app.mount(); await studio(); await moteClick(action('Open original behavior file')); await studio(); await choices()
    const state = useAppStore.getState(), key = documentKey(SCRATCH_WORKSPACE_ID, path)
    const tab = Object.values(state.tabs).find(tab => Object.values(tab.regions).some(region => region.kind === 'file' && region.path === path))!
    let finish!: (value: FileReadResult) => void, captured!: FileReadParams
    vi.mocked(api.files.readPublic).mockImplementationOnce(params => { captured = params; return new Promise(resolve => { finish = resolve }) })
    await moteClick(button('Save'))
    const later = disk + '\nLater original Editor input.\n'; await act(async () => state.updateDocument(tab.id, later, tab.layout.activeRegionId))
    await act(async () => finish(publicRead(captured))); await settleMoteApp()
    expect(useAppStore.getState().documents[key]!.content).toBe(later); expect(dialog().textContent).toContain('MBTI style · INFJ')
    expect(dialog().textContent).toContain('unsaved or unconfirmed draft'); expect(api.files.write).not.toHaveBeenCalled()
  })
  it('rejects a late same-Mote read lifetime after rereading without replacing the newer saved choices', async () => {
    await app.mount(); let finish!: (value: FileReadResult) => void, captured!: FileReadParams
    vi.mocked(api.files.readPublic).mockImplementationOnce(params => { captured = params; return new Promise(resolve => { finish = resolve }) })
    await studio(); await moteClick(action('Extra preferences'))
    disk = serializeMoteBehaviorDocument(disk, { engagement: 'I', information: 'N', decisions: 'F', approach: 'J', custom: 'Current saved preference.' })
    // The still-reading request can be explicitly replaced through the same original read owner.
    await moteClick(button('Save')); await moteClick(button('Reread settings'))
    const current = disk; disk = serializeMoteBehaviorDocument(disk, { engagement: 'E', information: 'S', decisions: 'T', approach: 'P', custom: 'STALE FIRST REQUEST' })
    const stale = publicRead(captured); disk = current
    await act(async () => finish(stale)); await settleMoteApp()
    expect(dialog().textContent).toContain('MBTI style · INFJ'); expect(dialog().querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Current saved preference.')
    expect(dialog().textContent).not.toContain('STALE FIRST REQUEST'); expect(api.files.write).not.toHaveBeenCalled()
  })
  it('rejects the first Mote A lifetime after A to B to A while preserving new A choices and both original inputs', async () => {
    await app.mount(); let finish!: (value: FileReadResult) => void, captured!: FileReadParams
    vi.mocked(api.files.readPublic).mockImplementationOnce(params => { captured = params; return new Promise(resolve => { finish = resolve }) })
    await studio(); await choices()
    await act(async () => useAppStore.getState().openScratchTopic(customMoteId, SCRATCH_WORKSPACE_ID, { tabId: customTab.id })); await settleMoteApp()
    await act(async () => useAppStore.getState().openScratchTopic(PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, { tabId: defaultTab.id })); await settleMoteApp()
    await studio(); await choices(); await moteClick(action('Extra preferences')); await text('[aria-label="Custom cooperation preferences"]', 'New A lifetime input.')
    const current = disk; disk = serializeMoteBehaviorDocument(disk, { engagement: 'E', information: 'S', decisions: 'T', approach: 'P', custom: 'OLD A SECRET' })
    const stale = publicRead(captured); disk = current
    await act(async () => finish(stale)); await settleMoteApp()
    expect(dialog().textContent).toContain('MBTI style · INFJ'); expect(dialog().querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('New A lifetime input.')
    expect(dialog().textContent).not.toContain('OLD A SECRET'); expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent')
    expect(useAppStore.getState().agentComposerDrafts['custom-agent']).toBe('Analyst unsent'); expect(api.files.write).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
  })
  it('retains later form input during the review read instead of staging the submitted older preferences', async () => {
    await app.mount(); await studio(); await choices(); await moteClick(action('Extra preferences'))
    await text('[aria-label="Custom cooperation preferences"]', 'Earlier submitted preference.')
    let finish!: (value: FileReadResult) => void, captured!: FileReadParams
    vi.mocked(api.files.readPublic).mockImplementationOnce(params => { captured = params; return new Promise(resolve => { finish = resolve }) })
    await moteClick(button('Save')); await text('[aria-label="Custom cooperation preferences"]', 'Later form input stays here.')
    await act(async () => finish(publicRead(captured))); await settleMoteApp()
    expect(dialog()).not.toBeNull()
    expect(dialog().querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Later form input stays here.')
    expect(dialog().textContent).toContain('later input changed'); expect(useAppStore.getState().documents[documentKey(SCRATCH_WORKSPACE_ID, path)]).toBeUndefined()
    expect(api.files.write).not.toHaveBeenCalled()
    await moteClick(button('Cancel')); await studio(); await choices()
    vi.mocked(api.files.readPublic).mockImplementationOnce(params => { captured = params; return new Promise(resolve => { finish = resolve }) })
    await moteClick(button('Save')); await moteClick(action('Try a cooperation question'))
    await text('[aria-label="Cooperation trial question"]', 'A later trial question stays here.')
    await act(async () => finish(publicRead(captured))); await settleMoteApp()
    expect(dialog()).not.toBeNull(); expect(dialog().querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('A later trial question stays here.')
    expect(useAppStore.getState().documents[documentKey(SCRATCH_WORKSPACE_ID, path)]).toBeUndefined(); expect(api.files.write).not.toHaveBeenCalled()
  })
  it('latches A to B to A within one Renderer publication interval before opening the Editor', async () => {
    await app.mount(); await studio(); await choices()
    let finish!: (value: FileReadResult) => void, captured!: FileReadParams
    vi.mocked(api.files.readPublic).mockImplementationOnce(params => { captured = params; return new Promise(resolve => { finish = resolve }) })
    await moteClick(button('Save'))
    await act(async () => {
      useAppStore.getState().activateTab(SCRATCH_WORKSPACE_ID, 'mote-group', customTab.id)
      useAppStore.getState().activateTab(SCRATCH_WORKSPACE_ID, 'mote-group', defaultTab.id)
    })
    await act(async () => finish(publicRead(captured))); await settleMoteApp()
    expect(dialog()).not.toBeNull()
    expect(dialog().textContent).toContain('MBTI style · INFJ'); expect(dialog().textContent).toContain('selection or later input changed')
    expect(useAppStore.getState().documents[documentKey(SCRATCH_WORKSPACE_ID, path)]).toBeUndefined(); expect(api.files.write).not.toHaveBeenCalled()
    expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent')
  })
})

const legacySoul = `# My original SOUL
Keep the original custom introduction.
<!-- agentmux:mote-behavior:begin v1 INFJ -->
## Collaboration behavior

- Organize your thinking first, then respond with focus and ask when needed.
- Connect the bigger picture, patterns and possibilities; distinguish them from confirmed facts.
- Stay truthful while considering people, relationships and the values that matter to me.
- Once the direction is clear, suggest steps, decision points and completion signals.

### Extra preferences
Keep original examples.

My current directions, original custom SOUL text and extra preferences take priority. These choices do not grant new actions or change factual standards.
<!-- agentmux:mote-behavior:end -->
My original trailing note.
`
async function legacySetup() {
  soulDisk = legacySoul; let exists = false
  vi.mocked(api.files.readPublic).mockImplementation(async params => {
    if (params.path === 'BEHAVIOR.md' && !exists) return { ...publicRead(params), result: { status: 'deleted' } }
    return publicRead(params)
  })
  vi.spyOn(api.files, 'create').mockImplementation(async (_workspace, input) => {
    expect(input).toEqual({ path, kind: 'file' }); if (exists) throw new Error('Already exists')
    exists = true; disk = ''; return { status: 'created' } as never
  })
  vi.mocked(api.files.write).mockImplementation(async (_workspace, input) => {
    const next = 'sha256:' + (await import('node:crypto')).createHash('sha256').update(input.content).digest('hex')
    if (input.path === path) { disk = input.content; diskRevision = next } else { soulDisk = input.content; soulRevision = next }
    return { status: 'written', revision: next }
  })
}
it('explicitly imports the original saved style before linking SOUL and saving newly selected preferences', async () => {
  await legacySetup(); await app.mount()
  expect(details().textContent).toContain('MBTI style · INFJ'); expect(details().textContent).toContain('original SOUL')
  await studio(); expect(dialog().querySelector<HTMLInputElement>('input[value="I"]')!.checked).toBe(true)
  await moteClick(button('Cancel')); expect(api.files.create).not.toHaveBeenCalled(); expect(api.files.write).not.toHaveBeenCalled()
  await studio(); for (const value of ['E', 'N', 'F', 'P']) await moteClick(dialog().querySelector<HTMLInputElement>('input[value="' + value + '"]')!)
  await moteClick(button('Save')); await settleMoteApp()
  expect(api.files.create).toHaveBeenCalledTimes(1)
  expect(vi.mocked(api.files.write).mock.calls.map(([, input]) => input.path)).toEqual([path, rootPath + '/SOUL.md', path])
  expect(parseMoteBehaviorDocument(vi.mocked(api.files.write).mock.calls[0]![1].content)).toMatchObject({ status: 'valid', code: 'INFJ' })
  expect(parseMoteBehaviorDocument(disk)).toMatchObject({ status: 'valid', code: 'ENFP', preferences: { custom: 'Keep original examples.' } })
  expect(soulDisk).toBe('# My original SOUL\nKeep the original custom introduction.\n' + MOTE_BEHAVIOR_LINK + '\nMy original trailing note.\n')
  expect(document.querySelector('.mote-behavior-dialog')).toBeNull(); expect(details().textContent).toContain('MBTI style · ENFP')
  await studio(); for (const value of ['E', 'N', 'F', 'P']) expect(dialog().querySelector<HTMLInputElement>('input[value="' + value + '"]')!.checked).toBe(true)
  expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent'); expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})
it('retains both original files and later choices through an interrupted SOUL link and resumes after original receipt recovery', async () => {
  await legacySetup(); const write = vi.mocked(api.files.write), original = write.getMockImplementation()!
  write.mockImplementation(async (workspace, input) => {
    const result = await original(workspace, input)
    return input.path.endsWith('/SOUL.md') ? { status: 'unknown', code: 'RECEIPT_LOST', message: 'The SOUL receipt is unknown.' } : result
  })
  await app.mount(); await studio(); for (const value of ['E', 'N', 'F', 'P']) await moteClick(dialog().querySelector<HTMLInputElement>('input[value="' + value + '"]')!)
  await moteClick(button('Save')); await settleMoteApp()
  expect(dialog().textContent).toContain('SOUL reference is unconfirmed'); expect(dialog().textContent).toContain('MBTI style · ENFP')
  expect(parseMoteBehaviorDocument(disk)).toMatchObject({ code: 'INFJ' }); expect(write).toHaveBeenCalledTimes(2)
  const state = useAppStore.getState(), soulPath = rootPath + '/SOUL.md', key = documentKey(SCRATCH_WORKSPACE_ID, soulPath)
  const file = Object.values(state.tabs).find(tab => Object.values(tab.regions).some(region => region.kind === 'file' && region.path === soulPath))!
  expect(state.documentIssues[key]?.kind).toBe('write-unknown')
  await act(async () => state.reloadDocument(file.id, file.layout.activeRegionId)); await settleMoteApp()
  expect(useAppStore.getState().documentIssues[key]).toBeUndefined()
  write.mockImplementation(original); await moteClick(button('Reread settings')); await moteClick(button('Save')); await settleMoteApp()
  expect(parseMoteBehaviorDocument(disk)).toMatchObject({ code: 'ENFP' }); expect(document.querySelector('.mote-behavior-dialog')).toBeNull()
})
it('does not fall back to an old style when the new behavior file is damaged', async () => {
  soulDisk = legacySoul; disk = '---\nversion: 2\npreferences: {engagement: E}\n---\nOriginal damaged content'
  await app.mount(); expect(details().querySelector('.mote-behavior-summary__tag')).toBeNull()
  await studio(); await choices(); await moteClick(button('Save'))
  expect(dialog()).not.toBeNull(); expect(api.files.write).not.toHaveBeenCalled(); expect(disk).toContain('version: 2')
})

it('review counter: the original behavior system file is not a recent idea', async () => {
  vi.mocked(api.files.readDirectory).mockResolvedValue([{ name: 'BEHAVIOR.md', path, isDirectory: false, mtimeMs: 1000 }] as never)
  await app.mount(); await settleMoteApp()
  expect(details().querySelector('.mote-details__recent')!.textContent).not.toContain('BEHAVIOR')
  expect(details().querySelector('.mote-details__recent')!.textContent).toContain('0')
})

it('review counter: confirmed custom-only Markdown remains visible in Profile without inventing an MBTI code', async () => {
  disk = '---\nversion: 1\npreferences: {}\n---\nKeep my manual collaboration notes visible.'
  await app.mount(); await settleMoteApp()
  expect(parseMoteBehaviorDocument(disk)).toMatchObject({ status: 'valid', code: null })
  expect(details().textContent).toContain('Keep my manual collaboration notes visible.')
  expect(details().querySelector('.mote-behavior-summary__tag')).toBeNull()
})

it('keeps ordinary user notes in both Profile and Ideas while excluding the behavior system file', async () => {
  vi.mocked(api.files.readDirectory).mockResolvedValue([
    { name: 'BEHAVIOR.md', path, isDirectory: false, mtimeMs: 1000 },
    { name: 'experiment.md', path: rootPath + '/experiment.md', isDirectory: false, mtimeMs: 2000 }
  ] as never)
  await app.mount(); await settleMoteApp()
  expect(details().querySelector('.mote-details__recent')!.textContent).toContain('experiment')
  expect(details().querySelector('.mote-details__recent')!.textContent).not.toContain('BEHAVIOR')
  await moteClick(action('View ideas and saved materials'))
  expect(details().querySelector('.mote-details__notes')!.textContent).toContain('experiment')
  expect(details().querySelector('.mote-details__notes')!.textContent).not.toContain('BEHAVIOR')
})
it('shows a saved partial preference without inventing its missing axes or MBTI code', async () => {
  disk = '---\nversion: 1\npreferences:\n  engagement: I\n---\nKeep these partial notes.'
  await app.mount(); await settleMoteApp()
  expect(details().querySelector('.mote-behavior-summary__choices')!.children).toHaveLength(1)
  expect(details().textContent).toContain('Keep these partial notes.')
  expect(details().querySelector('.mote-behavior-summary__tag')).toBeNull()
})

it('prefills all four saved choices from the original file when opening settings', async () => {
  disk = serializeMoteBehaviorDocument(DEFAULT_MOTE_BEHAVIOR, { engagement: 'I', information: 'N', decisions: 'F', approach: 'J', custom: 'Keep my chosen style.' })
  await app.mount(); await studio()
  expect([...dialog().querySelectorAll<HTMLInputElement>('input:checked')].map(input => input.value)).toEqual(['I', 'N', 'F', 'J'])
  expect(dialog().textContent).toContain('INFJ')
  expect(api.files.write).not.toHaveBeenCalled()
})
