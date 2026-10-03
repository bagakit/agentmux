// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileReadParams, FileReadResult, AgentSessionHistoryPage } from '@agentmux/core'
import type { Demand } from '@agentmux/demand'
import { createMoteApp, moteClick, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { defaultAgent, defaultTab, customMoteId, customTab, neighborTab, scratchWorkspace } from './fixtures/mote-workface'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '../src/shared/scratch-topics'
import { documentKey } from '../src/renderer/src/lib/workbench-tabs'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
vi.mock('../src/renderer/src/components/EditorPane', () => ({ EditorPane: () => createElement('div', { 'data-original-editor': true }) }))
let app: MoteAppFixture, initialIdeaContext: boolean
const root = scratchTopicDirectoryName(PMO_TEAMS_TOPIC_ID), path = root + '/saved-direction.md', revision = 'sha256:' + 'f'.repeat(64)
const panel = () => app.container.querySelector<HTMLElement>('[data-mote-details]')!
const button = (name: string) => [...panel().querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === name)!
const publicRead = (params: FileReadParams, content = params.path === 'SOUL.md' ? '# Latest saved SOUL\nUse concrete examples.' : '# The selected saved source.'): FileReadResult => ({
  resource: { ...params.expectedResource, zoneId: params.zoneId, zonePath: scratchWorkspace.path + '/' + root, path: root + '/' + params.path },
  result: { status: 'read', document: { path: root + '/' + params.path, content, revision } }
})
const requestDraft = () => { const state = useAppStore.getState(), selection = state.workbenchSpaceSelection!; return state.agentComposerDrafts[selection.regionId!]! }
async function type(selector: string, value: string) {
  const input = panel().querySelector<HTMLTextAreaElement>(selector)!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) }); await settleMoteApp()
}
async function ideas() { await moteClick(panel().querySelector<HTMLButtonElement>('[aria-label="View ideas and saved materials"]')!); if (!initialIdeaContext) { vi.mocked(api.files.readPublic).mockClear(); initialIdeaContext = true } }
beforeEach(() => {
  initialIdeaContext = false; app = createMoteApp(); useAppStore.setState({ toolsOpen: true, explorerCollapsed: { [SCRATCH_WORKSPACE_ID]: false } })
  useLauncherState.setState({ drafts: {}, persistenceIssue: null })
  vi.spyOn(api.files, 'readDirectory').mockResolvedValue([{ path, name: 'saved-direction.md', isDirectory: false, isSymlink: false, ignored: false }])
  vi.spyOn(api.files, 'observe').mockResolvedValue(); vi.spyOn(api.files, 'unobserve').mockResolvedValue()
})
afterEach(async () => { await app.dispose() })

describe('original Ideas request and feedback owners', () => {
  it('reads only on explicit preparation and creates a real editable sourced request, preserving original work', async () => {
    const read = vi.spyOn(api.files, 'readPublic').mockImplementation(async params => publicRead(params))
    const history = vi.spyOn(api.sessions, 'historyPage'), goals = vi.spyOn(api.demands, 'list')
    await app.mount(); history.mockClear(); goals.mockClear(); await ideas(); expect(read).not.toHaveBeenCalled(); expect(history).not.toHaveBeenCalled(); expect(goals).not.toHaveBeenCalled()
    await moteClick(panel().querySelector<HTMLButtonElement>('.mote-details__note')!); expect(read).toHaveBeenCalledTimes(1)
    const before = useAppStore.getState(); await type('[aria-label="Idea direction"]', 'Find a useful next experiment.'); await moteClick(button('Prepare idea request'))
    expect(read).toHaveBeenLastCalledWith(expect.objectContaining({ path: 'SOUL.md' })); expect(history).not.toHaveBeenCalled(); expect(goals).not.toHaveBeenCalled()
    const request = requestDraft(); expect(request).toContain('Find a useful next experiment.'); expect(request).toContain('# Latest saved SOUL'); expect(request).toContain(path); expect(request).toContain(revision)
    expect(request).toContain('Explain why each relates'); expect(request).toContain('discussion starter'); expect(request).toContain('separate authorization')
    expect(Object.values(useAppStore.getState().tabs).filter(tab => !before.tabs[tab.id])).toHaveLength(1)
    expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent'); expect(useAppStore.getState().sessions).toBe(before.sessions)
    expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
  })
  it('reads the exact Core history identity with a bounded page and only Renderer Session linked Goals', async () => {
    const state = useAppStore.getState(), exact = { ...defaultAgent, control: { ...defaultAgent.control, agentSessionId: 'core-exact-mote' } }
    useAppStore.setState({ sessions: state.sessions.map(session => session.id === defaultAgent.id ? exact : session) })
    vi.spyOn(api.files, 'readPublic').mockImplementation(async params => publicRead(params))
    const page: AgentSessionHistoryPage = { agentSessionId: exact.control.agentSessionId, source: { providerId: exact.providerId, nativeSessionId: 'native-exact' }, nextCursor: null,
      items: [{ id: 'original-message', kind: 'user-message', contentParts: [{ kind: 'text', text: 'Original exact discussion fact.' }] }] }
    const history = vi.spyOn(api.sessions, 'historyPage').mockResolvedValue(page)
    const goal = (id: string, sessionIds: string[]): Demand => ({ id, title: id, description: 'Original goal source.', sessionIds, status: 'in_progress', priority: 'normal', projectId: null, projectName: null, executorId: null, tags: [], plannedStartAt: null, targetAt: null, parentDemandId: null, phaseIndex: null, activities: [], decisions: [], createdAt: 10, updatedAt: 20 })
    vi.spyOn(api.demands, 'list').mockResolvedValue([goal('renderer-linked-goal', [exact.id]), goal('wrong-core-alias-goal', [exact.control.agentSessionId]), goal('neighbor-goal', ['neighbor-agent'])])
    await app.mount(); history.mockClear(); await ideas(); await type('[aria-label="Idea direction"]', 'Use my current exact context.'); await moteClick(panel().querySelector<HTMLInputElement>('[aria-label="Include exact discussion and linked Goals"]')!); await moteClick(button('Prepare idea request'))
    expect(history).toHaveBeenCalledExactlyOnceWith({ hostId: exact.control.hostId, agentSessionId: exact.control.agentSessionId }, { limit: 8 })
    expect(requestDraft()).toContain('Original exact discussion fact.'); expect(requestDraft()).toContain('renderer-linked-goal'); expect(requestDraft()).not.toContain('wrong-core-alias-goal'); expect(requestDraft()).not.toContain('neighbor-goal')
    expect(requestDraft()).toContain('rendererSessionId'); expect(requestDraft()).toContain('core-exact-mote'); expect(app.launch).not.toHaveBeenCalled()
  })
  it('keeps a user-authored request usable when saved context is unknown without inventing its content', async () => {
    vi.spyOn(api.files, 'readPublic').mockResolvedValue({ resource: null, result: { status: 'unknown', code: 'FILE_READ_UNCONFIRMED', message: 'Original SOUL unavailable' } })
    vi.spyOn(api.sessions, 'historyPage').mockRejectedValue(new Error('Original history unavailable')); vi.spyOn(api.demands, 'list').mockRejectedValue(new Error('Original Goals unavailable'))
    await app.mount(); await ideas(); await type('[aria-label="Idea direction"]', 'Explore the question I wrote.'); await moteClick(panel().querySelector<HTMLInputElement>('[aria-label="Include exact discussion and linked Goals"]')!); await moteClick(button('Prepare idea request'))
    expect(requestDraft()).toContain('Explore the question I wrote.'); expect(requestDraft()).toContain('Original SOUL unavailable'); expect(requestDraft()).toContain('Original history unavailable'); expect(requestDraft()).not.toContain('Exact note')
    expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent')
  })
  it('keeps later direction input and rejects a pending read rather than opening a stale request', async () => {
    let finish!: (value: FileReadResult) => void, captured!: FileReadParams
    vi.spyOn(api.files, 'readPublic').mockImplementation(params => { captured = params; return new Promise(resolve => { finish = resolve }) })
    await app.mount(); await ideas(); await type('[aria-label="Idea direction"]', 'Earlier direction'); const before = useAppStore.getState()
    await moteClick(button('Prepare idea request')); await type('[aria-label="Idea direction"]', 'Later direction'); await act(async () => finish(publicRead(captured))); await settleMoteApp()
    expect(panel().querySelector<HTMLTextAreaElement>('[aria-label="Idea direction"]')!.value).toBe('Later direction'); expect(panel().textContent).toContain('later input changed')
    expect(useAppStore.getState().tabs).toBe(before.tabs); expect(app.launch).not.toHaveBeenCalled()
  })
  it('latches same-Mote Region A to B to A navigation and retains a separate Mote direction across a late read', async () => {
    let finish!: (value: FileReadResult) => void, captured!: FileReadParams
    const read = vi.fn<(params: FileReadParams) => Promise<FileReadResult>>(params => { captured = params; return new Promise(resolve => { finish = resolve }) })
    vi.spyOn(api.files, 'readPublic').mockImplementation(params => panel()?.querySelector('[aria-label="Idea direction"]') ? read(params) : Promise.resolve(publicRead(params)))
    await app.mount(); await ideas(); await type('[aria-label="Idea direction"]', 'Retained original Mote direction'); const before = useAppStore.getState()
    await moteClick(button('Prepare idea request'))
    await act(async () => { useAppStore.getState().activateTab(SCRATCH_WORKSPACE_ID, 'mote-group', neighborTab.id); useAppStore.getState().activateTab(SCRATCH_WORKSPACE_ID, 'mote-group', defaultTab.id) }); await settleMoteApp()
    await act(async () => finish(publicRead(captured))); await settleMoteApp(); expect(useAppStore.getState().tabs).toBe(before.tabs)
    await moteClick(button('Prepare idea request')); const second = { captured, finish }
    await act(async () => useAppStore.getState().openScratchTopic(customMoteId, SCRATCH_WORKSPACE_ID, { tabId: customTab.id })); await settleMoteApp()
    if (!panel().querySelector('[aria-label="Idea direction"]')) await ideas()
    await type('[aria-label="Idea direction"]', 'Other Mote direction')
    await act(async () => useAppStore.getState().openScratchTopic(PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, { tabId: defaultTab.id })); await settleMoteApp()
    if (!panel().querySelector('[aria-label="Idea direction"]')) await ideas()
    await act(async () => second.finish(publicRead(second.captured))); await settleMoteApp()
    expect(panel().querySelector<HTMLTextAreaElement>('[aria-label="Idea direction"]')!.value).toBe('Retained original Mote direction'); expect(useAppStore.getState().tabs).toBe(before.tabs); expect(read).toHaveBeenCalledTimes(2)
    expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent')
  })
  it('stages specific note feedback after original SOUL and saves only through the original Editor revision protocol', async () => {
    vi.spyOn(api.files, 'readPublic').mockImplementation(async params => publicRead(params))
    const original = '# Original user SOUL\nKeep this paragraph.'
    vi.spyOn(api.files, 'read').mockResolvedValue({ status: 'read', document: { path: root + '/SOUL.md', content: original, revision } })
    const write = vi.spyOn(api.files, 'write').mockResolvedValue({ status: 'written', revision: 'sha256:' + 'a'.repeat(64) })
    await app.mount(); await ideas(); await moteClick(panel().querySelector<HTMLButtonElement>('.mote-details__note')!); await type('[aria-label="Idea feedback comment"]', 'More useful when it compares concrete options.')
    await moteClick(button('Review feedback in SOUL'))
    const state = useAppStore.getState(), key = documentKey(SCRATCH_WORKSPACE_ID, root + '/SOUL.md'), document = state.documents[key]!
    expect(document.content.startsWith(original)).toBe(true); expect(document.content).toContain(path); expect(document.content).toContain(revision); expect(document.content).toContain('More useful when it compares concrete options.')
    expect(state.dirtyDocuments[key]).toBe(true); expect(write).not.toHaveBeenCalled()
    const tab = Object.values(state.tabs).find(tab => Object.values(tab.regions).some(region => region.kind === 'file' && region.path === root + '/SOUL.md'))!
    await act(async () => state.saveDocument(tab.id, tab.layout.activeRegionId)); await settleMoteApp()
    expect(write).toHaveBeenCalledExactlyOnceWith(SCRATCH_WORKSPACE_ID, { path: root + '/SOUL.md', content: document.content, expectedRevision: revision }); expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
  })
})
