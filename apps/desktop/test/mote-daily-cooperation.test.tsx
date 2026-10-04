import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileReadParams, FileReadResult } from '@agentmux/core'
import { createMoteApp, moteClick, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { defaultAgent, defaultTab, customMoteId, customTab, scratchWorkspace, moteTopics } from './fixtures/mote-workface'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '../src/shared/scratch-topics'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { prepareMoteCooperationDraft } from '../src/renderer/src/lib/mote-cooperation'
import { directoryIdentity, homeZoneId } from '../src/shared/space-addresses'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { documentKey } from '../src/renderer/src/lib/workbench-tabs'

vi.mock('../src/renderer/src/components/EditorPane', () => ({ EditorPane: () => createElement('div') }))
let app: MoteAppFixture
const revision = 'sha256:' + 'a'.repeat(64), root = scratchTopicDirectoryName(PMO_TEAMS_TOPIC_ID)
const originalLaunchAgent = useAppStore.getState().launchAgent
const scope = (id = PMO_TEAMS_TOPIC_ID) => ({ workspace: scratchWorkspace, topic: moteTopics.find(topic => topic.id === id)!, rootPath: scratchTopicDirectoryName(id) })
const read = (params: FileReadParams, content = 'A saved, scoped decision.', rev = revision): FileReadResult => {
  const directory = params.zoneId === homeZoneId(directoryIdentity('local', _hygiene_fixturePath("topics/") + root)) ? root : scratchTopicDirectoryName(customMoteId)
  const path = directory + '/' + params.path
  return { resource: { ...params.expectedResource, zoneId: params.zoneId, zonePath: _hygiene_fixturePath("topics/") + directory, path },
    result: { status: 'read', document: { path, content, revision: rev } } }
}
beforeEach(() => {
  app = createMoteApp()
  useLauncherState.setState({ drafts: {} })
  useAppStore.setState({ agentComposerNotes: { [defaultAgent.id]: 'Original discussion context' } })
  vi.spyOn(api.files, 'readPublic').mockImplementation(async params => read(params))
})
afterEach(async () => { await app.dispose() })
const draft = (selection: { tabId: string; regionId: string }) => useAppStore.getState().agentComposerDrafts[selection.regionId]!
const note = (selection: { tabId: string; regionId: string }) => useAppStore.getState().agentComposerNotes[selection.regionId]!

describe('original Mote natural question and saved material preparation', () => {
  it('prepares a real question and exact saved sources in one new Launcher without starting or clearing original inputs', async () => {
    const before = useAppStore.getState()
    const result = await prepareMoteCooperationDraft(scope(), undefined, { question: 'Help me choose a next step.', materialPaths: [root + '/decision.md', root + '/decision.md'] }, () => true)
    expect(result.sources.map(source => source.path)).toEqual([root + '/SOUL.md', root + '/decision.md'])
    expect(draft(result.selection)).toBe('Help me choose a next step.')
    expect(note(result.selection)).toContain(revision); expect(note(result.selection)).toContain('A saved, scoped decision.')
    expect(note(result.selection)).toContain('not a claim that an Agent used them')
    expect(useAppStore.getState().tabs[result.selection.tabId]!.topicId).toBe(PMO_TEAMS_TOPIC_ID)
    expect(Object.keys(useAppStore.getState().tabs)).toHaveLength(Object.keys(before.tabs).length + 1)
    expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent')
    expect(useAppStore.getState().agentComposerNotes[defaultAgent.id]).toBe('Original discussion context')
    expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
  })
  it('reads a later corrected original revision for the next discussion without editing the earlier draft', async () => {
    const first = await prepareMoteCooperationDraft(scope(), undefined, { question: 'Earlier question' }, () => true), old = draft(first.selection), oldNote = note(first.selection)
    vi.mocked(api.files.readPublic).mockImplementation(async params => read(params, 'Corrected scoped fact.', 'sha256:' + 'b'.repeat(64)))
    const later = await prepareMoteCooperationDraft(scope(), undefined, { question: 'Later question' }, () => true)
    expect(note(later.selection)).toContain('Corrected scoped fact.'); expect(note(later.selection)).toContain('sha256:' + 'b'.repeat(64))
    expect(draft(first.selection)).toBe(old); expect(note(first.selection)).toBe(oldNote); expect(note(later.selection)).not.toContain('A saved, scoped decision.')
  })
  for (const status of ['written', 'unknown'] as const) it(`uses the original Editor Save ${status} fact for the next prepared question without changing old context`, async () => {
    const path = root + '/SOUL.md'; let disk = 'An original saved scoped fact.', diskRevision = revision
    vi.mocked(api.files.readPublic).mockImplementation(async params => read(params, disk, diskRevision))
    vi.spyOn(api.files, 'read').mockImplementation(async () => ({ status: 'read', document: { path, content: disk, revision: diskRevision } }))
    const write = vi.spyOn(api.files, 'write').mockImplementation(async (_workspace, input) => {
      if (status === 'unknown') return { status: 'unknown', code: 'WRITE_UNCONFIRMED', message: 'Original Save outcome is unconfirmed.' }
      disk = input.content; diskRevision = 'sha256:' + 'c'.repeat(64)
      return { status: 'written', revision: diskRevision }
    })
    vi.spyOn(api.files, 'readDirectory').mockResolvedValue([]); vi.spyOn(api.files, 'observe').mockResolvedValue(); vi.spyOn(api.files, 'unobserve').mockResolvedValue()
    const earlier = await prepareMoteCooperationDraft(scope(), undefined, { question: 'Earlier discussion' }, () => true), earlierNote = note(earlier.selection)
    useAppStore.setState({ toolsOpen: true, explorerCollapsed: { [SCRATCH_WORKSPACE_ID]: false } }); await app.mount()
    await moteClick([...app.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Open original SOUL')!)
    const state = useAppStore.getState(), tab = Object.values(state.tabs).find(tab => Object.values(tab.regions).some(region => region.kind === 'file' && region.path === path))!
    const region = Object.values(tab.regions).find(region => region.kind === 'file' && region.path === path)!, key = documentKey(SCRATCH_WORKSPACE_ID, path)
    await act(async () => state.updateDocument(tab.id, 'A human correction in the original Editor.', region.regionId))
    await act(async () => useAppStore.getState().saveDocument(tab.id, region.regionId))
    expect(write).toHaveBeenCalledExactlyOnceWith(SCRATCH_WORKSPACE_ID, { path, content: 'A human correction in the original Editor.', expectedRevision: revision })
    const next = await prepareMoteCooperationDraft(scope(), undefined, { question: 'Next neutral question' }, () => true)
    expect(draft(next.selection)).toBe('Next neutral question'); expect(note(earlier.selection)).toBe(earlierNote)
    expect(note(next.selection)).toContain(diskRevision); expect(note(next.selection)).toContain(disk)
    if (status === 'unknown') {
      expect(useAppStore.getState().documents[key]!.content).toBe('A human correction in the original Editor.')
      expect(useAppStore.getState().dirtyDocuments[key]).toBe(true); expect(useAppStore.getState().documentIssues[key]?.kind).toBe('write-unknown')
      expect(note(next.selection)).not.toContain('A human correction in the original Editor.')
    } else expect(useAppStore.getState().dirtyDocuments[key]).not.toBe(true)
    expect(app.launch).not.toHaveBeenCalled()
  })
  it('keeps unknown and failed original reads truthful while still preparing the user question', async () => {
    vi.mocked(api.files.readPublic).mockResolvedValueOnce({ resource: null, result: { status: 'unknown', code: 'ORIGINAL_UNKNOWN', message: 'Original saved SOUL is unavailable.' } })
      .mockRejectedValueOnce(new Error('Original file read failed.'))
    const result = await prepareMoteCooperationDraft(scope(), undefined, { question: 'My useful question', materialPaths: [root + '/decision.md'] }, () => true)
    expect(result.sources).toHaveLength(2); expect(result.sources[0]).toMatchObject({ path: root + '/SOUL.md', observation: { resource: null, result: { status: 'unknown' } } })
    expect(draft(result.selection)).toBe('My useful question'); expect(note(result.selection)).toContain('Original saved SOUL is unavailable.')
    expect(note(result.selection)).toContain('Original file read failed.'); expect(note(result.selection)).not.toContain('A saved, scoped decision.')
  })
  it('confines selected sources to the exact Mote and keeps the original work for a wrong or excessive material request', async () => {
    const before = useAppStore.getState()
    await expect(prepareMoteCooperationDraft(scope(), undefined, { question: 'Stay here', materialPaths: [scratchTopicDirectoryName(customMoteId) + '/private.md'] }, () => true)).rejects.toThrow('this Mote')
    await expect(prepareMoteCooperationDraft(scope(), undefined, { question: 'Stay here', materialPaths: ['1', '2', '3', '4'].map(path => root + '/' + path) }, () => true)).rejects.toThrow('up to three')
    expect(api.files.readPublic).not.toHaveBeenCalled(); expect(useAppStore.getState().tabs).toBe(before.tabs)
  })
  it('uses the second Mote original resource without borrowing the first Mote saved material', async () => {
    useAppStore.getState().activateTab(SCRATCH_WORKSPACE_ID, 'mote-group', customTab.id)
    const result = await prepareMoteCooperationDraft(scope(customMoteId), undefined, { question: 'Analyst question' }, () => true)
    expect(result.sources.map(source => source.path)).toEqual([scratchTopicDirectoryName(customMoteId) + '/SOUL.md'])
    expect(result.sources[0]!.observation.resource!.zonePath).toBe(_hygiene_fixturePath("topics/") + scratchTopicDirectoryName(customMoteId))
    expect(useAppStore.getState().tabs[result.selection.tabId]!.topicId).toBe(customMoteId)
    expect(note(result.selection)).not.toContain('"moteId":"' + PMO_TEAMS_TOPIC_ID + '"')
    expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent')
  })
  it('rejects a pending read after a later question without replacing drafts or opening an older submitted question', async () => {
    let finish!: (value: FileReadResult) => void, captured!: FileReadParams, current = true
    vi.mocked(api.files.readPublic).mockImplementationOnce(params => { captured = params; return new Promise(resolve => { finish = resolve }) })
    const before = useAppStore.getState(), pending = prepareMoteCooperationDraft(scope(), undefined, { question: 'Older question' }, () => current)
    current = false; finish(read(captured))
    await expect(pending).rejects.toThrow('later question changed')
    expect(useAppStore.getState().tabs).toBe(before.tabs); expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  })
  it('latches A to B to A during an original read and does not silently use the stale A selection', async () => {
    let finish!: (value: FileReadResult) => void, captured!: FileReadParams
    vi.mocked(api.files.readPublic).mockImplementationOnce(params => { captured = params; return new Promise(resolve => { finish = resolve }) })
    const before = useAppStore.getState(), pending = prepareMoteCooperationDraft(scope(), undefined, { question: 'Original A' }, () => true)
    useAppStore.getState().activateTab(SCRATCH_WORKSPACE_ID, 'mote-group', customTab.id)
    useAppStore.getState().activateTab(SCRATCH_WORKSPACE_ID, 'mote-group', defaultTab.id)
    finish(read(captured)); await expect(pending).rejects.toThrow('selection')
    expect(Object.keys(useAppStore.getState().tabs)).toEqual(Object.keys(before.tabs)); expect(app.launch).not.toHaveBeenCalled()
  })
  it('refuses sources corrected during an in-flight preparation rather than claiming the old read is current', async () => {
    let finish!: (value: FileReadResult) => void, captured!: FileReadParams
    vi.mocked(api.files.readPublic).mockImplementationOnce(params => { captured = params; return new Promise(resolve => { finish = resolve }) })
    const before = useAppStore.getState(), pending = prepareMoteCooperationDraft(scope(), undefined, { question: 'Use current facts' }, () => true)
    const key = documentKey(SCRATCH_WORKSPACE_ID, root + '/SOUL.md')
    useAppStore.setState({ documentObservationGenerations: { ...before.documentObservationGenerations, [key]: 1 } })
    finish(read(captured)); await expect(pending).rejects.toThrow('saved materials')
    expect(useAppStore.getState().tabs).toBe(before.tabs)
  })
  it('starts a question in the original exact empty Group without a selected Agent or a required behavior questionnaire', async () => {
    const original = useAppStore.getState(), tabs = Object.fromEntries(Object.entries(original.tabs).filter(([, tab]) => tab.topicId !== PMO_TEAMS_TOPIC_ID))
    const spaceId = directoryIdentity('local', _hygiene_fixturePath("topics/") + root)
    useAppStore.setState({ tabs, layouts: { ...original.layouts, [SCRATCH_WORKSPACE_ID]: { ...original.layouts[SCRATCH_WORKSPACE_ID]!,
      groups: original.layouts[SCRATCH_WORKSPACE_ID]!.groups.map(group => ({ ...group, tabOrder: group.tabOrder.filter(id => !!tabs[id]), activeTabId: null })) } },
      workbenchSpaceSelection: { workspaceId: SCRATCH_WORKSPACE_ID, spaceId, zoneId: homeZoneId(spaceId), groupId: 'mote-group', topicId: PMO_TEAMS_TOPIC_ID, tabId: null, regionId: null } })
    const result = await prepareMoteCooperationDraft(scope(), undefined, { question: 'Begin with this real question' }, () => true)
    expect(result.selection.groupId).toBe('mote-group'); expect(draft(result.selection)).toContain('Begin with this real question')
    expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled()
  })
  it('uses the real Store launch caller to deliver frozen context separately and retain both inputs after an unconfirmed launch', async () => {
    const prepared = await prepareMoteCooperationDraft(scope(), undefined, { question: 'Only my visible question' }, () => true)
    const context = note(prepared.selection), launch = vi.spyOn(api.sessions, 'launchAgent').mockRejectedValue(new Error('Private launch observation unavailable.'))
    useAppStore.setState({ launchAgent: originalLaunchAgent })
    await expect(useAppStore.getState().launchAgent('fixture', draft(prepared.selection), prepared.selection.groupId, prepared.selection)).rejects.toThrow('observation unavailable')
    expect(launch).toHaveBeenCalledOnce()
    expect(launch.mock.calls[0]![0]).toMatchObject({ prompt: 'Only my visible question', agentMuxNote: context, hostId: 'local', workspacePath: _hygiene_fixturePath("topics"), scratchTopicId: PMO_TEAMS_TOPIC_ID })
    expect(context).toContain(revision); expect(context).toContain('A saved, scoped decision.')
    expect(draft(prepared.selection)).toBe('Only my visible question'); expect(note(prepared.selection)).toBe(context)
    expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent')
  })
  it('keeps later context in a newly published Launcher and refuses to overwrite it', async () => {
    const before = useAppStore.getState()
    const unsubscribe = useAppStore.subscribe(current => {
      const tab = Object.values(current.tabs).find(tab => !before.tabs[tab.id])
      if (tab && current.agentComposerNotes[tab.layout.activeRegionId] === undefined)
        useAppStore.setState({ agentComposerNotes: { ...current.agentComposerNotes, [tab.layout.activeRegionId]: 'Later context' } })
    })
    try { await expect(prepareMoteCooperationDraft(scope(), undefined, { question: 'My prepared question' }, () => true)).rejects.toThrow('new Launcher') }
    finally { unsubscribe() }
    const tab = Object.values(useAppStore.getState().tabs).find(tab => !before.tabs[tab.id])!
    expect(note({ tabId: tab.id, regionId: tab.layout.activeRegionId })).toBe('Later context')
    expect(draft({ tabId: tab.id, regionId: tab.layout.activeRegionId })).toBeUndefined(); expect(app.launch).not.toHaveBeenCalled()
  })
  it('does not attach frozen context after later input arrives during the original draft setter publication', async () => {
    const before = useAppStore.getState(); let replaced = false
    const unsubscribe = useAppStore.subscribe(current => {
      const tab = Object.values(current.tabs).find(tab => !before.tabs[tab.id])
      if (tab && !replaced && current.agentComposerDrafts[tab.layout.activeRegionId] === 'My prepared question') {
        replaced = true; current.setAgentComposerDraft(tab.layout.activeRegionId, 'Later original input')
      }
    })
    try { await expect(prepareMoteCooperationDraft(scope(), undefined, { question: 'My prepared question' }, () => true)).rejects.toThrow('new Launcher') }
    finally { unsubscribe() }
    const tab = Object.values(useAppStore.getState().tabs).find(tab => !before.tabs[tab.id])!
    expect(draft({ tabId: tab.id, regionId: tab.layout.activeRegionId })).toBe('Later original input')
    expect(note({ tabId: tab.id, regionId: tab.layout.activeRegionId })).toBeUndefined()
  })
  it('refuses context for a new Launcher whose original resource changes during the draft setter publication', async () => {
    const before = useAppStore.getState(); let retargeted = false
    const unsubscribe = useAppStore.subscribe(current => {
      const tab = Object.values(current.tabs).find(tab => !before.tabs[tab.id])
      if (tab && !retargeted && current.agentComposerDrafts[tab.layout.activeRegionId] === 'Keep the original resource') {
        retargeted = true; useAppStore.setState({ config: { ...current.config!, workspaces: current.config!.workspaces.map(workspace =>
          workspace.id === SCRATCH_WORKSPACE_ID ? { ...workspace, path: _hygiene_fixturePath("another-original-resource") } : workspace) } })
      }
    })
    try { await expect(prepareMoteCooperationDraft(scope(), undefined, { question: 'Keep the original resource' }, () => true)).rejects.toThrow('new Launcher') }
    finally { unsubscribe() }
    const tab = Object.values(useAppStore.getState().tabs).find(tab => !before.tabs[tab.id])!
    expect(draft({ tabId: tab.id, regionId: tab.layout.activeRegionId })).toBe('Keep the original resource')
    expect(note({ tabId: tab.id, regionId: tab.layout.activeRegionId })).toBeUndefined(); expect(app.launch).not.toHaveBeenCalled()
  })
  it('consumes the real Profile question caller and original helper from typed user input to the accurate editable Launcher', async () => {
    const createGoal = vi.spyOn(api.demands, 'create')
    useAppStore.setState({ toolsOpen: true, explorerCollapsed: { [SCRATCH_WORKSPACE_ID]: false } })
    await app.mount()
    const question = app.container.querySelector<HTMLTextAreaElement>('[aria-label="A question for this Mote"]')!
    expect(question).not.toBeNull()
    expect(app.container.querySelector('[aria-label="Prepare this question in a new discussion"]')).toBeNull()
    expect(createGoal).not.toHaveBeenCalled(); expect(app.launch).not.toHaveBeenCalled()
    expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(question, 'My real first question')
      question.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const before = useAppStore.getState()
    await moteClick(app.container.querySelector<HTMLButtonElement>('[aria-label="Prepare this question in a new discussion"]')!)
    const state = useAppStore.getState(), tab = Object.values(state.tabs).find(tab => !before.tabs[tab.id])!
    expect(tab).toBeDefined(); expect(state.agentComposerDrafts[tab.layout.activeRegionId]).toBe('My real first question')
    expect(state.agentComposerNotes[tab.layout.activeRegionId]).toContain(revision)
    expect(state.agentComposerDrafts[defaultAgent.id]).toBe('Default unsent'); expect(app.launch).not.toHaveBeenCalled(); expect(createGoal).not.toHaveBeenCalled()
  })
  it('keeps later real Profile input while its original file read is pending', async () => {
    useAppStore.setState({ toolsOpen: true, explorerCollapsed: { [SCRATCH_WORKSPACE_ID]: false } }); await app.mount()
    const question = app.container.querySelector<HTMLTextAreaElement>('[aria-label="A question for this Mote"]')!
    const type = async (value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(question, value)
      question.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await type('An earlier question')
    let finish!: (value: FileReadResult) => void, captured!: FileReadParams
    vi.mocked(api.files.readPublic).mockImplementationOnce(params => { captured = params; return new Promise(resolve => { finish = resolve }) })
    const before = useAppStore.getState()
    await moteClick(app.container.querySelector<HTMLButtonElement>('[aria-label="Prepare this question in a new discussion"]')!)
    await type('My later question stays here')
    await act(async () => finish(read(captured))); await settleMoteApp()
    expect(question.value).toBe('My later question stays here'); expect(useAppStore.getState().tabs).toBe(before.tabs)
    expect(app.container.textContent).toContain('later question changed'); expect(app.launch).not.toHaveBeenCalled()
  })
  it('preserves actual Profile question and original work after Mote A to B to A while its saved read is pending', async () => {
    useAppStore.setState({ toolsOpen: true, explorerCollapsed: { [SCRATCH_WORKSPACE_ID]: false } }); await app.mount()
    const question = app.container.querySelector<HTMLTextAreaElement>('[aria-label="A question for this Mote"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(question, 'Original A question')
      question.dispatchEvent(new Event('input', { bubbles: true }))
    })
    let finish!: (value: FileReadResult) => void, captured!: FileReadParams
    vi.mocked(api.files.readPublic).mockImplementationOnce(params => { captured = params; return new Promise(resolve => { finish = resolve }) })
    const before = useAppStore.getState()
    await moteClick(app.container.querySelector<HTMLButtonElement>('[aria-label="Prepare this question in a new discussion"]')!)
    await act(async () => useAppStore.getState().openScratchTopic(customMoteId, SCRATCH_WORKSPACE_ID, { tabId: customTab.id })); await settleMoteApp()
    await act(async () => useAppStore.getState().openScratchTopic(PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, { tabId: defaultTab.id })); await settleMoteApp()
    await act(async () => finish(read(captured))); await settleMoteApp()
    expect(Object.keys(useAppStore.getState().tabs)).toEqual(Object.keys(before.tabs))
    expect(app.container.querySelector<HTMLTextAreaElement>('[aria-label="A question for this Mote"]')!.value).toBe('Original A question')
    expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent')
    expect(useAppStore.getState().agentComposerDrafts['custom-agent']).toBe('Analyst unsent'); expect(app.launch).not.toHaveBeenCalled()
  })
})
