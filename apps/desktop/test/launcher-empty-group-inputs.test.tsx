import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, Profiler } from 'react'
import type { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: ({ session }: any) => <div data-warm-session={session.id} /> }))
import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface'
import { documentDraft, draftDocument } from '../src/renderer/src/components/InlineComposer'
import { useAppStore, warmTerminalKey } from '../src/renderer/src/store'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { warmLauncherId } from '../src/renderer/src/lib/warm-terminal-preview'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { encodeSemanticReference, expandSemanticReferences } from '../src/renderer/src/lib/composer-semantic-reference'
import type { NoteCreationReceipt } from '../src/renderer/src/lib/note-creation'
import { agentCreationFixture } from './helpers/agent-creation-fixture'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const initialLauncher = useLauncherState.getState()
const persistence = useLauncherState.persist.getOptions()
const groupId = 'empty-group'
const groupOwner = warmLauncherId({ tabGroupId: groupId, regionId: undefined })
const rawPrompt = `Please use ${encodeSemanticReference({ token: '', label: 'Review', kind: 'skill', reference: _hygiene_fixturePath("repo/SKILL.md") })}\nKeep all original edits`
const rawNames = { agentName: '  My reviewer  ', tabName: '  My tab  ' }
const allOptions = { codex: { mode: 'review' }, alternate: { mode: 'inspect' } }
const receipt: NoteCreationReceipt = { intentId: 'original-note-intent', noteId: 'original-note', blockIds: ['original-block'],
  createdAt: 1, draft: 'Original saved thought', path: 'original.amnote', status: 'pending', revealed: false,
  target: { workspaceId: 'workspace', hostId: 'local', workspacePath: _hygiene_fixturePath("repo"), directoryPath: _hygiene_fixturePath("repo"), relativeDirectory: '',
    zoneId: null, sourceSpaceId: null, displayWorkspaceId: 'workspace', groupId }, issue: 'Original Note awaiting confirmation' }
const healthy = composerSession('healthy-other-agent')
const healthyTab = createWorkbenchTab('healthy-tab', { regionId: 'healthy-region', kind: 'agent', phase: 'attached',
  workspaceId: 'other-workspace', sessionId: healthy.id })
const healthyLayout = createWorkspaceLayout('healthy-group', [healthyTab.id])
const warm = { ...composerSession('warm-shell'), kind: 'terminal', providerId: null,
  control: { kind: 'terminal', hostId: 'local', runId: 'healthy-warm-run', run: { runId: 'healthy-warm-run' } } } as any

beforeEach(() => {
  useLauncherState.setState({ sections: { workspace: { browser: 'expanded', note: 'expanded' } }, drafts: {
    [groupOwner]: { browser: 'https://example.test/unfinished?q=original', note: 'Unsent original thought', noteCreation: receipt }
  }, executors: {}, moteTopicId: null, persistenceIssue: null })
  useAppStore.setState({ config: { ...composerConfig, executors: { ...composerConfig.executors,
    alternate: { ...composerConfig.executors.codex!, label: 'Alternate', providerId: 'alternate' } },
    workspaces: [...composerConfig.workspaces, { ...composerConfig.workspaces[0]!, id: 'other-workspace', path: _hygiene_fixturePath("healthy") }] },
    activeWorkspaceId: 'workspace', mainSurface: 'workbench', workbenchSpaceSelection: null, workbenchNavigationInputPolicy: null,
    tabs: { [healthyTab.id]: healthyTab }, layouts: { workspace: createWorkspaceLayout(groupId), 'other-workspace': healthyLayout },
    agentComposerDrafts: { [healthy.id]: 'Healthy unsent message' }, launcherNameDrafts: {}, launcherOptionDrafts: {},
    sessions: [healthy], warmTerminal: { key: warmTerminalKey('local', _hygiene_fixturePath("repo")), ownerLauncherId: groupOwner, session: warm, ready: Promise.resolve(warm) },
    detectExecutors: vi.fn().mockResolvedValue(undefined), executorDetections: {}, pendingAgentLaunches: {}, recoveryCandidates: [],
    providerCatalog: [
      { id: 'codex', launchOptions: [{ id: 'mode', label: 'Mode', choices: [{ id: 'review', label: 'Review mode' }] }] },
      { id: 'alternate', launchOptions: [{ id: 'mode', label: 'Mode', choices: [{ id: 'inspect', label: 'Inspect mode' }] }] }
    ] as any, error: null, errorNoticeContext: null })
  vi.spyOn(api.sessions, 'stop').mockResolvedValue(undefined)
  vi.spyOn(api.sessions, 'launchTerminal').mockRejectedValue(new Error('A healthy shell must be reused'))
})
afterEach(() => { useLauncherState.persist.setOptions(persistence); useLauncherState.setState(initialLauncher, true) })

// Mirrors WorkspaceWorkbench's actual empty Group / bound Launcher branch; neither action nor input owner is mocked.
function GroupOwner() {
  const activeId = useAppStore(state => state.layouts.workspace?.groups.find(group => group.id === groupId)?.activeTabId)
  const tab = useAppStore(state => activeId ? state.tabs[activeId] : undefined)
  if (!tab) return <NewTabSurface tabGroupId={groupId} />
  const surface = tab.regions[tab.layout.activeRegionId]!
  return surface.kind === 'launcher' ? <NewTabSurface key={surface.regionId} tabGroupId={groupId} tabId={tab.id} regionId={surface.regionId} />
    : <div data-agent-owner={surface.regionId} data-phase={surface.kind === 'agent' ? surface.phase : surface.kind}
      data-session={surface.kind === 'agent' ? surface.sessionId : ''} />
}
function editor(selector = '.launcher-composer .tiptap') {
  const element = dom.container.querySelector<HTMLElement & { editor: Editor }>(selector)
  expect(element).not.toBeNull()
  return element!.editor
}
async function options() { if (!document.querySelector('.launch-refine__panel')) await dom.click('[aria-label="Launch options"]') }
async function closeOptions() { if (document.querySelector('.launch-refine__panel')) await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Close launch options"]')!.click()) }
async function mode(value: string) {
  await options()
  const input = document.querySelector<HTMLSelectElement>('[aria-label="Mode"]')!
  await act(async () => { input.value = value; input.dispatchEvent(new Event('change', { bubbles: true })) })
}
async function name(field: 'Agent' | 'Tab', value: string) {
  await options()
  const input = document.querySelector<HTMLInputElement>(`[aria-label="${field} name"]`)!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true })) })
}
async function enterInputs() {
  await act(async () => { editor().commands.setContent(draftDocument(rawPrompt)) })
  await name('Agent', rawNames.agentName); await name('Tab', rawNames.tabName); await mode('review'); await closeOptions()
  await dom.click('[data-executor-id="alternate"]'); await mode('inspect'); await closeOptions()
  await dom.click('[data-executor-id="codex"]')
  expect(useLauncherState.getState().drafts[groupOwner]).toMatchObject({ prompt: rawPrompt, names: rawNames, optionsByProvider: allOptions })
}
function bound() {
  const state = useAppStore.getState(), tabId = state.layouts.workspace!.groups.find(group => group.id === groupId)!.activeTabId!
  const tab = state.tabs[tabId]!, regionId = tab.layout.activeRegionId
  return { state, tab, tabId, regionId, launcherId: warmLauncherId({ tabGroupId: groupId, regionId }) }
}
function preservedWorkfaces() {
  const state = useAppStore.getState()
  expect(state.tabs[healthyTab.id]).toBe(healthyTab); expect(state.layouts['other-workspace']).toBe(healthyLayout)
  expect(state.sessions.find(session => session.id === healthy.id)).toBe(healthy)
  expect(state.agentComposerDrafts[healthy.id]).toBe('Healthy unsent message')
  expect(state.activeWorkspaceId).toBe('workspace'); expect(state.mainSurface).toBe('workbench')
  expect(state.workbenchSpaceSelection).toBeNull(); expect(state.workbenchNavigationInputPolicy).toBeNull()
  expect(state.warmTerminal?.session).toBe(warm)
  expect(api.sessions.stop).not.toHaveBeenCalled(); expect(api.sessions.launchTerminal).not.toHaveBeenCalled()
}
function launchResult(id: string) {
  const session = composerSession(id)
  return { created: agentCreationFixture(session), projectionFailures: [], session, timeline: { agentSessionId: id, revision: 0, items: [] } }
}

describe('first Launcher input ownership', () => {
  it('rehydrates unsubmitted empty Group inputs and keeps unrelated field updates out of its editor', async () => {
    const paints = vi.fn()
    await dom.render(<Profiler id="first-launcher" onRender={paints}><GroupOwner /></Profiler>)
    await enterInputs()
    const state = useLauncherState.getState(), serialized = JSON.stringify({ state: persistence.partialize!(state), version: persistence.version })
    await dom.render(null)
    useLauncherState.persist.setOptions({ storage: { getItem: async () => JSON.parse(serialized), setItem() {}, removeItem() {} } })
    useLauncherState.setState({ drafts: {} })
    await act(async () => useLauncherState.persist.rehydrate())
    await dom.render(<Profiler id="first-launcher" onRender={paints}><GroupOwner /></Profiler>)
    expect(documentDraft(editor().getJSON())).toBe(rawPrompt)
    await options()
    expect(document.querySelector<HTMLInputElement>('[aria-label="Agent name"]')!.value).toBe(rawNames.agentName)
    expect(document.querySelector<HTMLInputElement>('[aria-label="Tab name"]')!.value).toBe(rawNames.tabName)
    expect(document.querySelector<HTMLSelectElement>('[aria-label="Mode"]')!.value).toBe('review')
    expect(useLauncherState.getState().drafts[groupOwner]?.optionsByProvider).toEqual(allOptions)
    paints.mockClear()
    await act(async () => { useLauncherState.getState().setDraft('unrelated-group', 'prompt', 'Other text')
      useLauncherState.getState().setAgentName('unrelated-group', 'agentName', 'Other name')
      useLauncherState.getState().setAgentOption('unrelated-group', 'codex', 'mode', 'review') })
    expect(paints).not.toHaveBeenCalled()
    preservedWorkfaces()
  })

  it('claims raw inputs atomically before real pending unmount and restores the editable Region after native failure', async () => {
    let reject!: (error: Error) => void
    const launch = vi.spyOn(api.sessions, 'launchAgent').mockImplementation(() => new Promise((_done, fail) => { reject = fail }))
    await dom.render(<GroupOwner />); await enterInputs()
    const oldEditor = editor(), publications: any[] = []
    const unsubscribe = useAppStore.subscribe(state => {
      const newTab = Object.values(state.tabs).find(tab => tab.id !== healthyTab.id)
      if (newTab) publications.push({ kind: newTab.regions[newTab.layout.activeRegionId]!.kind,
        prompt: state.agentComposerDrafts[newTab.layout.activeRegionId], names: state.launcherNameDrafts[newTab.layout.activeRegionId],
        options: state.launcherOptionDrafts[newTab.layout.activeRegionId], utility: useLauncherState.getState().drafts[warmLauncherId({ tabGroupId: groupId, regionId: newTab.layout.activeRegionId })] })
    })
    await dom.click('.launcher-launch-button'); unsubscribe()
    const pending = bound()
    expect(publications[0]).toMatchObject({ kind: 'launcher', prompt: rawPrompt, names: rawNames, options: allOptions,
      utility: { browser: 'https://example.test/unfinished?q=original', note: 'Unsent original thought', noteCreation: receipt } })
    expect(dom.container.querySelector('.launcher-composer .tiptap')).toBeNull()
    await vi.waitFor(() => expect(oldEditor.isDestroyed).toBe(true))
    expect(dom.container.querySelector('[data-phase="launching"]')).not.toBeNull()
    expect(launch.mock.calls[0]![0]).toMatchObject({ prompt: expandSemanticReferences(rawPrompt), launchOptions: allOptions.codex,
      agentSessionId: pending.tab.regions[pending.regionId]!.kind === 'agent' ? (pending.tab.regions[pending.regionId] as any).sessionId : undefined })
    await act(async () => reject(new Error('Controlled first native launch failure')))
    expect(bound().regionId).toBe(pending.regionId); expect(editor()).not.toBe(oldEditor)
    expect(documentDraft(editor().getJSON())).toBe(rawPrompt)
    await options()
    expect(document.querySelector<HTMLInputElement>('[aria-label="Agent name"]')!.value).toBe(rawNames.agentName)
    expect(document.querySelector<HTMLInputElement>('[aria-label="Tab name"]')!.value).toBe(rawNames.tabName)
    expect(document.querySelector<HTMLSelectElement>('[aria-label="Mode"]')!.value).toBe('review')
    expect(bound().state.launcherOptionDrafts[pending.regionId]).toEqual(allOptions)
    expect(document.querySelector<HTMLInputElement>('[aria-label="Browser address or search"]')!.value).toBe('https://example.test/unfinished?q=original')
    expect(documentDraft(editor('.launcher-note-composer .tiptap').getJSON())).toBe('Unsent original thought')
    expect(document.querySelector('.launcher-persistence-notice')?.textContent).toContain('Original Note awaiting confirmation')
    await act(async () => {
      const browser = document.querySelector<HTMLInputElement>('[aria-label="Browser address or search"]')!
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(browser, 'https://example.test/new-edit')
      browser.dispatchEvent(new Event('input', { bubbles: true }))
      editor('.launcher-note-composer .tiptap').commands.setContent(draftDocument('New Note edit retained'))
    })
    const updatedReceipt = { ...receipt, status: 'error' as const, issue: 'Late original Note write failed' }
    await act(async () => { useLauncherState.getState().setNoteCreation(groupOwner, updatedReceipt) })
    expect(useLauncherState.getState().drafts[pending.launcherId]?.noteCreation).toBe(updatedReceipt)
    expect(document.querySelector('.launcher-persistence-notice')?.textContent).toContain('Late original Note write failed')
    let completeWrite!: (result: any) => void
    const write = vi.spyOn(api.files, 'write').mockImplementation(() => new Promise(done => { completeWrite = done }))
    let retry!: ReturnType<ReturnType<typeof useAppStore.getState>['retryCreatedNote']>
    await act(async () => { retry = useAppStore.getState().retryCreatedNote(pending.launcherId) })
    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0]![0]).toBe(receipt.target.workspaceId)
    expect(JSON.parse(write.mock.calls[0]![1].content).noteId).toBe(receipt.noteId)
    const retrying = useLauncherState.getState().drafts[pending.launcherId]!.noteCreation!
    expect(retrying.intentId).toBe(receipt.intentId)
    expect(retrying.target.workspacePath).toBe(receipt.target.workspacePath)
    expect(retrying.target.groupId).toBe(receipt.target.groupId)
    await act(async () => { completeWrite({ status: 'error', code: 'TEST_WRITE_FAILED', message: 'Same original Note write failed' }); await retry })
    expect(useLauncherState.getState().drafts[pending.launcherId]!.noteCreation).toBe(useLauncherState.getState().drafts[groupOwner]!.noteCreation)
    expect(useLauncherState.getState().drafts[pending.launcherId]).toMatchObject({ browser: 'https://example.test/new-edit', note: 'New Note edit retained' })
    await name('Agent', 'Edited after failure'); await mode('review')
    await act(async () => { editor().commands.insertContentAt(1, 'New edit: ') })
    expect(bound().state.agentComposerDrafts[pending.regionId]).toBe(`New edit: ${rawPrompt}`)
    expect(bound().state.launcherNameDrafts[pending.regionId]?.agentName).toBe('Edited after failure')
    expect(useLauncherState.getState().drafts[groupOwner]).toMatchObject({ browser: 'https://example.test/unfinished?q=original', note: 'Unsent original thought', noteCreation: { intentId: receipt.intentId, status: 'error' } })
    preservedWorkfaces()
  })

  it('consumes only attached request inputs and returns to an empty Group without resurrecting its submitted primary draft', async () => {
    let resolve!: (result: ReturnType<typeof launchResult>) => void
    const launch = vi.spyOn(api.sessions, 'launchAgent').mockImplementation(() => new Promise(done => { resolve = done }))
    await dom.render(<GroupOwner />); await enterInputs(); await dom.click('.launcher-launch-button')
    const pending = bound(), requestId = launch.mock.calls[0]![0].agentSessionId!
    await act(async () => resolve(launchResult(requestId)))
    expect(dom.container.querySelector('[data-phase="attached"]')?.getAttribute('data-session')).toBe(requestId)
    expect(bound().state.agentComposerDrafts[pending.regionId]).toBeUndefined()
    expect(bound().state.launcherNameDrafts[pending.regionId]).toBeUndefined()
    expect(bound().state.launcherOptionDrafts[pending.regionId]).toEqual({ alternate: allOptions.alternate })
    expect(bound().state.agentNames[requestId]).toBe('My reviewer')
    expect(bound().state.tabs[pending.tabId]?.name).toBe('My tab')
    // Real View close retains the healthy Agent; it is not a handcrafted reset of the Group.
    await act(async () => { await useAppStore.getState().closeTab('workspace', groupId, pending.tabId, { keepAgentSessions: true }) })
    expect(documentDraft(editor().getJSON())).toBe('')
    await options()
    expect(document.querySelector<HTMLInputElement>('[aria-label="Agent name"]')!.value).toBe('')
    expect(document.querySelector<HTMLInputElement>('[aria-label="Tab name"]')!.value).toBe('')
    expect(document.querySelector<HTMLSelectElement>('[aria-label="Mode"]')!.value).toBe('')
    expect(useLauncherState.getState().drafts[groupOwner]).toMatchObject({ browser: 'https://example.test/unfinished?q=original', note: 'Unsent original thought', noteCreation: receipt })
    preservedWorkfaces()
  })
})
