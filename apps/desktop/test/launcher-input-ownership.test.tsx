import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, Profiler } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface'
import { useAppStore } from '../src/renderer/src/store'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { encodeSemanticReference, expandSemanticReferences } from '@agentmux/client-ui/composer-semantic-reference'
import { agentCreationFixture } from './helpers/agent-creation-fixture'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const launcherInitial = useLauncherState.getState()
const persistenceOptions = useAppStore.persist.getOptions()
const tabId = 'input-launcher'
const regionId = 'input-region'
const providerCatalog = [
  { id: 'codex', launchOptions: [{ id: 'mode', label: 'Mode', choices: [{ id: 'review', label: 'Review mode' }] }] },
  { id: 'alternate', launchOptions: [{ id: 'mode', label: 'Mode', choices: [{ id: 'inspect', label: 'Inspect mode' }] }] }
]

beforeEach(() => {
  useLauncherState.setState({ sections: {}, drafts: {}, executors: {}, moteTopicId: null })
  useAppStore.setState({ config: { ...composerConfig, executors: { ...composerConfig.executors,
    alternate: { ...composerConfig.executors.codex!, label: 'Alternate', providerId: 'alternate' } } },
    activeWorkspaceId: 'workspace', tabs: { [tabId]: createWorkbenchTab(tabId, { regionId, kind: 'launcher', workspaceId: 'workspace' }) },
    layouts: { workspace: createWorkspaceLayout('input-group', [tabId]) },
    agentComposerDrafts: { [regionId]: 'Keep the complete request' }, launcherNameDrafts: {}, launcherOptionDrafts: {},
    warmTerminal: null, detectExecutors: vi.fn().mockResolvedValue(undefined), prewarmTerminal: vi.fn(),
    providerCatalog: providerCatalog as any, executorDetections: {}, pendingAgentLaunches: {},
    recoveryCandidates: [], error: null, errorNoticeContext: null })
})
afterEach(() => {
  useLauncherState.setState(launcherInitial, true)
  useAppStore.persist.setOptions(persistenceOptions)
})

function RegionOwner() {
  const kind = useAppStore(state => state.tabs[tabId]?.regions[regionId]?.kind)
  return kind === 'launcher'
    ? <NewTabSurface tabGroupId="input-group" tabId={tabId} regionId={regionId} />
    : <div data-pending-owner />
}
async function options() {
  if (!document.querySelector('.launch-refine__panel')) await dom.click('[aria-label="Launch options"]')
}
async function selectMode(value: string) {
  await options()
  const select = document.querySelector<HTMLSelectElement>('[aria-label="Mode"]')!
  await act(async () => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })) })
}
async function writeName(field: 'Agent' | 'Tab', value: string) {
  await options()
  const input = document.querySelector<HTMLInputElement>(`[aria-label="${field} name"]`)!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
function launchResult(id: string) {
  const session = composerSession(id)
  return { created: agentCreationFixture(session), projectionFailures: [], session,
    timeline: { agentSessionId: id, revision: 0, items: [] } }
}

describe('original Launcher input owner', () => {
  it('restores editable names and Provider options after the real pending owner unmounts and launch fails', async () => {
    let reject!: (error: Error) => void
    const launch = vi.spyOn(api.sessions, 'launchAgent').mockImplementation(() => new Promise((_done, fail) => { reject = fail }))
    await dom.render(<RegionOwner />)
    await writeName('Agent', 'My reviewer')
    await writeName('Tab', 'Review tab')
    await selectMode('review')
    expect(useAppStore.getState().launcherNameDrafts[regionId]).toEqual({ agentName: 'My reviewer', tabName: 'Review tab' })
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Close launch options"]')!.click())
    await dom.click('.launcher-launch-button')
    expect(dom.container.querySelector('[data-pending-owner]')).not.toBeNull()
    expect(launch.mock.calls[0]![0].launchOptions).toEqual({ mode: 'review' })
    await act(async () => reject(new Error('Controlled native launch failure')))
    expect(dom.container.querySelector('.tiptap')?.textContent).toBe('Keep the complete request')
    await options()
    expect(document.querySelector<HTMLSelectElement>('[aria-label="Mode"]')!.value).toBe('review')
    expect(document.querySelector<HTMLInputElement>('[aria-label="Agent name"]')!.value).toBe('My reviewer')
    expect(document.querySelector<HTMLInputElement>('[aria-label="Tab name"]')!.value).toBe('Review tab')
  })

  it('keeps selections in their exact Region and Provider when changing the target and returning', async () => {
    const launch = vi.fn().mockResolvedValue(undefined)
    useAppStore.setState({ launchAgent: launch })
    await dom.render(<NewTabSurface tabGroupId="input-group" tabId={tabId} regionId={regionId} />)
    await selectMode('review')
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Close launch options"]')!.click())
    await dom.click('[data-executor-id="alternate"]')
    await dom.click('.launcher-launch-button')
    expect(launch.mock.calls[0]?.[0]).toBe('alternate')
    expect(launch.mock.calls[0]?.[4]).toEqual({})
    await options()
    expect(document.querySelector<HTMLSelectElement>('[aria-label="Mode"]')!.value).toBe('')
    await selectMode('inspect')
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Close launch options"]')!.click())
    await dom.click('.launcher-launch-button')
    expect(launch.mock.calls[1]?.[4]).toEqual({ mode: 'inspect' })
    await dom.click('[data-executor-id="codex"]')
    await options()
    expect(document.querySelector<HTMLSelectElement>('[aria-label="Mode"]')!.value).toBe('review')
    await dom.render(null)
    await dom.render(<NewTabSurface tabGroupId="input-group" tabId={tabId} regionId="other-input-region" />)
    await options()
    expect(document.querySelector<HTMLSelectElement>('[aria-label="Mode"]')!.value).toBe('')
    expect(useAppStore.getState().launcherOptionDrafts[regionId]).toEqual({ codex: { mode: 'review' }, alternate: { mode: 'inspect' } })
  })

  it('rehydrates serialized names and choices through the existing durable Store and displays them', async () => {
    await dom.render(<RegionOwner />)
    await writeName('Agent', 'Durable reviewer')
    await writeName('Tab', 'Durable tab')
    await selectMode('review')
    const options = useAppStore.persist.getOptions()
    const serialized = JSON.stringify({ state: options.partialize!(useAppStore.getState()), version: options.version })
    await dom.render(null)
    useAppStore.persist.setOptions({ storage: { getItem: async () => JSON.parse(serialized), setItem() {}, removeItem() {} } })
    useAppStore.setState({ agentComposerDrafts: {}, launcherNameDrafts: {}, launcherOptionDrafts: {} })
    await act(async () => useAppStore.persist.rehydrate())
    expect(useAppStore.getState().launcherNameDrafts[regionId]).toEqual({ agentName: 'Durable reviewer', tabName: 'Durable tab' })
    expect(useAppStore.getState().launcherOptionDrafts[regionId]).toEqual({ codex: { mode: 'review' } })
    await dom.render(<RegionOwner />)
    await dom.click('[aria-label="Launch options"]')
    expect(document.querySelector<HTMLInputElement>('[aria-label="Agent name"]')!.value).toBe('Durable reviewer')
    expect(document.querySelector<HTMLInputElement>('[aria-label="Tab name"]')!.value).toBe('Durable tab')
    expect(document.querySelector<HTMLSelectElement>('[aria-label="Mode"]')!.value).toBe('review')
    expect(dom.container.querySelector('.tiptap')?.textContent).toBe('Keep the complete request')
  })

  it('consumes exactly the submitted Provider choices and original semantic draft after a successful attachment', async () => {
    const state = useAppStore.getState()
    const draft = `Please use ${encodeSemanticReference({ token: '', label: 'Review', kind: 'skill', reference: _hygiene_fixturePath("repo/SKILL.md") })}`
    state.setAgentComposerDraft(regionId, draft)
    state.setLauncherNameDraft(regionId, 'agentName', '  My reviewer  ')
    state.setLauncherOptionDraft(regionId, 'codex', 'mode', 'review')
    state.setLauncherOptionDraft(regionId, 'alternate', 'mode', 'inspect')
    vi.spyOn(api.sessions, 'launchAgent').mockImplementation(async input => launchResult(input.agentSessionId!))
    await state.launchAgent('codex', expandSemanticReferences(draft), 'input-group', { tabId, regionId },
      useAppStore.getState().launcherOptionDrafts[regionId]!.codex,
      { agentName: 'My reviewer' })
    const attached = useAppStore.getState()
    expect(attached.tabs[tabId]?.regions[regionId]).toMatchObject({ kind: 'agent', phase: 'attached' })
    expect(attached.agentComposerDrafts[regionId]).toBeUndefined()
    expect(attached.launcherNameDrafts[regionId]).toBeUndefined()
    expect(attached.launcherOptionDrafts[regionId]).toEqual({ alternate: { mode: 'inspect' } })
  })

  it('keeps newer original-owner edits when an earlier launch completes late', async () => {
    const state = useAppStore.getState()
    state.setLauncherNameDraft(regionId, 'agentName', 'Original reviewer')
    state.setLauncherOptionDraft(regionId, 'codex', 'mode', 'review')
    let resolve!: (result: ReturnType<typeof launchResult>) => void
    const launch = vi.spyOn(api.sessions, 'launchAgent').mockImplementation(() => new Promise(done => { resolve = done }))
    const pending = state.launchAgent('codex', 'Keep the complete request', 'input-group', { tabId, regionId },
      useAppStore.getState().launcherOptionDrafts[regionId]!.codex, { agentName: 'Original reviewer' })
    useAppStore.getState().setAgentComposerDraft(regionId, 'A newer request')
    useAppStore.getState().setLauncherNameDraft(regionId, 'agentName', 'Newer reviewer')
    useAppStore.getState().setLauncherOptionDraft(regionId, 'codex', 'mode', 'newer-choice')
    resolve(launchResult(launch.mock.calls[0]![0].agentSessionId!))
    await pending
    expect(useAppStore.getState().agentComposerDrafts[regionId]).toBe('A newer request')
    expect(useAppStore.getState().launcherNameDrafts[regionId]?.agentName).toBe('Newer reviewer')
    expect(useAppStore.getState().launcherOptionDrafts[regionId]?.codex).toEqual({ mode: 'newer-choice' })
  })

  it('does not consume a different unsent original draft for a contextual launch', async () => {
    const state = useAppStore.getState()
    state.setLauncherNameDraft(regionId, 'agentName', 'Unsent reviewer')
    state.setLauncherOptionDraft(regionId, 'codex', 'mode', 'review')
    vi.spyOn(api.sessions, 'launchAgent').mockImplementation(async input => launchResult(input.agentSessionId!))
    await state.launchAgent('codex', 'A different context request', 'input-group', { tabId, regionId }, undefined, { agentName: 'Context reviewer' })
    expect(useAppStore.getState().agentComposerDrafts[regionId]).toBe('Keep the complete request')
    expect(useAppStore.getState().launcherNameDrafts[regionId]?.agentName).toBe('Unsent reviewer')
    expect(useAppStore.getState().launcherOptionDrafts[regionId]?.codex).toEqual({ mode: 'review' })
  })

  it('does no retained Launcher React commits for unrelated Agent or Launcher inputs, while its own inputs still update', async () => {
    const paints = vi.fn()
    await dom.render(<div hidden inert><Profiler id="retained-launcher" onRender={paints}><NewTabSurface tabGroupId="input-group" tabId={tabId} regionId={regionId} visible={false} /></Profiler></div>)
    paints.mockClear()
    for (const text of ['a', 'ab', 'abc']) await act(async () => {
      useAppStore.getState().setAgentComposerDraft('unrelated-agent', text)
      useAppStore.getState().setLauncherNameDraft('unrelated-launcher', 'agentName', text)
      useAppStore.getState().setLauncherOptionDraft('unrelated-launcher', 'codex', 'mode', text)
    })
    expect(paints).not.toHaveBeenCalled()
    await act(async () => useAppStore.getState().setAgentComposerDraft(regionId, 'Original owner remains writable'))
    expect(paints).toHaveBeenCalled()
    expect(dom.container.querySelector('.tiptap')?.textContent).toBe('Original owner remains writable')
  })
})
