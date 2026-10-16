// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { appendFile } from 'node:fs/promises'
import { nativeHistoryFixture, jsonl } from '../../../packages/core/test/fixtures/native-history-session'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { createClientUiRoot } from './helpers/client-ui-render'
import { desktopConversationReadBridge } from './helpers/conversation-read-bridge'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { FocusConversationReadingScene, focusReadingLocation, type FocusReadingRoute } from './fixtures/focus-conversation-reading'

// Use the installed browser build: its native Panel registration is part of the
// real Workbench route. The server fallback does not mount Region children.
vi.mock('react-resizable-panels', async () => {
  const { createRequire } = await import('node:module')
  return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js')
})

const initial = useAppStore.getState(), closes: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  getSelection()?.removeAllRanges()
  for (const close of closes.splice(0).reverse()) await close()
  useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
const row = (id: string, content: string) => ({ type: 'assistant', uuid: id, sessionId: 'native-main', message: { role: 'assistant', content } })
const pause = async (ms = 25) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) })
const wait = (assertion: () => void) => vi.waitFor(async () => { await pause(); assertion() }, { timeout: 8000, interval: 25 })

async function fixture(route: FocusReadingRoute, rows = [row('original-answer', 'The original **selected words** remain readable.')]) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  HTMLElement.prototype.scrollIntoView = vi.fn()
  const f = await nativeHistoryFixture('claude', jsonl(rows)); closes.push(f.close)
  await desktopConversationReadBridge(f, closes)
  vi.spyOn(api.workspaces, 'listBranches').mockResolvedValue({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: f.root })
  vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'repository', icon: null })
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([])
  const legacy = [vi.spyOn(api.sessions, 'historyPage'), vi.spyOn(api.sessions, 'timeline')]
  const agent = { ...composerSession(f.session.agentSessionId, 'claude'), executorId: 'claude', workspacePath: f.root,
    nativeHandle: f.session.nativeHandle!, control: { kind: 'agent' as const, hostId: 'local', agentSessionId: f.session.agentSessionId, run: f.session.run } }
  const location = focusReadingLocation
  const tab = createWorkbenchTab(location.tabId, { regionId: location.regionId, workspaceId: location.displayWorkspaceId, kind: 'agent', phase: 'attached', sessionId: agent.id })
  const layout = { root: { type: 'leaf' as const, groupId: location.groupId }, groups: [{ id: location.groupId, tabOrder: [tab.id], activeTabId: tab.id, recentTabIds: [tab.id] }], activeGroupId: location.groupId }
  useAppStore.setState({ config: { ...composerConfig, workspaces: [{ id: location.displayWorkspaceId, name: 'Reading project', hostId: 'local', path: f.root, kind: 'folder' }] },
    sessions: [agent], timelines: {}, tabs: { [tab.id]: tab }, layouts: { [location.displayWorkspaceId]: layout },
    mainSurface: 'agents', activeWorkspaceId: location.displayWorkspaceId, viewModes: { [agent.id]: 'activity' },
    agentNames: { [agent.id]: 'Reading conversation' }, agentComposerDrafts: { [agent.id]: 'Original unsent draft', [location.regionId]: 'Original Region draft' },
    pendingAgentLaunches: {}, recoveryCandidates: [], runtimeOwnershipWarnings: [], providerCatalog: [], scratchTopicSnapshots: {},
    agentFocus: { execution: { sessionId: agent.id, reference: location, history: [] }, pmo: { sessionId: null } },
    focusTimelineHeight: 96, notificationEvents: [], error: null })
  const host = document.createElement('div'); document.body.append(host); const root = createClientUiRoot(host)
  closes.push(async () => { await act(async () => root.unmount()); host.remove() })
  const actualRead = f.client.readAgentConversation.bind(f.client), actualChanges = f.client.readConversationChanges.bind(f.client)
  const reads = vi.spyOn(f.client, 'readAgentConversation'), changes = vi.spyOn(f.client, 'readConversationChanges')
  const render = async () => act(async () => root.render(<FocusConversationReadingScene route={route} />))
  const panel = () => { const panel = host.querySelector('.global-session-workspace'); expect(panel).not.toBeNull(); return panel! }
  const feed = () => { const node = panel().querySelector<HTMLElement>('.activity-feed'); expect(node).not.toBeNull(); return node! }
  const assertRoute = () => {
    expect(host.querySelector('[data-focus-reading-route]')?.getAttribute('data-focus-reading-route')).toBe(route)
    expect(panel().querySelector('.agent-surface[data-agent-surface-mode="activity"]')).not.toBeNull()
    if (route === 'projection') { expect(panel().querySelector('.focused-tab-workspace')).not.toBeNull(); expect(panel().querySelector(`[data-workbench-region-id="${location.regionId}"]`)).not.toBeNull(); expect(panel().querySelector('.global-session-region')).toBeNull() }
    else expect(panel().querySelector(`.global-session-region[data-session-id="${agent.id}"]`)).not.toBeNull()
  }
  const unchanged = () => {
    expect(useAppStore.getState().sessions).toEqual([agent]); expect(useAppStore.getState().tabs[tab.id]).toEqual(tab)
    expect(useAppStore.getState().layouts[location.displayWorkspaceId]).toEqual(layout)
    expect(useAppStore.getState().agentComposerDrafts[agent.id]).toBe('Original unsent draft')
    expect(useAppStore.getState().agentComposerDrafts[location.regionId]).toBe('Original Region draft')
    expect(legacy.map(value => value.mock.calls.length)).toEqual([0, 0]); expect(f.controls.map(value => value.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
  }
  return { f, agent, host, reads, changes, actualRead, actualChanges, render, panel, feed, assertRoute, unchanged }
}

it.each(['projection', 'observation'] as const)('actual Focus %s reads pending → failure → original Retry → accepted content through public RPC and IPC', async route => {
  const h = await fixture(route), originalRead = h.actualRead
  let fail = true, release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  h.reads.mockImplementation(async (...args) => { await gate; if (fail) throw Object.assign(Error('Isolated original conversation read unavailable'), { code: 'CONTROL_UNAVAILABLE' }); return originalRead(...args) })
  closes.push(() => release())
  await h.render(); await wait(() => expect(h.reads.mock.calls.length).toBeGreaterThan(0)); h.assertRoute()
  expect(h.feed().textContent).toContain('Reading conversation…')
  expect(h.feed().textContent).not.toContain('Reading interrupted'); expect(h.feed().querySelector('[role="slider"]')).toBeNull()
  const scene = h.feed().querySelector('.activity-feed__empty-reading[data-read-state="pending"]')!
  expect(scene.getAttribute('aria-busy')).toBe('true')
  expect(scene.querySelector('.activity-feed__reading-landscape')?.getAttribute('aria-hidden')).toBe('true')
  expect(scene.querySelector('.activity-feed__reading-caption')?.textContent).toBe('Reading conversation…')
  await act(async () => release()); await wait(() => expect(h.feed().textContent).toContain('Reading interrupted'))
  expect(h.feed().textContent).toContain('Isolated original conversation read unavailable')
  expect(h.feed().textContent).toContain('Retry the source above to continue reading.')
  expect(h.feed().textContent).not.toContain('Reading conversation…')
  expect(h.feed().querySelector('.activity-feed__reading-landscape'), 'A source failure ends the pending decorative scene').toBeNull()
  expect(h.feed().querySelector('.activity-feed__empty-reading')?.hasAttribute('aria-busy')).toBe(false)
  const retries = [...h.feed().querySelectorAll<HTMLButtonElement>('button')].filter(button => button.textContent === 'Retry')
  expect(retries.length).toBeGreaterThan(0); expect(h.feed().querySelector('.activity-feed__empty-reading button')).toBeNull()
  const calls = h.reads.mock.calls.length; await pause(180); expect(h.reads).toHaveBeenCalledTimes(calls)
  fail = false
  await act(async () => retries[0]!.click())
  await wait(() => expect(h.feed().querySelector('[data-native-record-id="original-answer"]')).not.toBeNull())
  expect(h.reads.mock.calls.length).toBeGreaterThan(calls)
  expect(h.feed().textContent).not.toContain('Reading interrupted'); expect(h.feed().textContent).not.toContain('Reading conversation…')
  expect(h.feed().textContent).toContain('The original selected words remain readable.')
  expect(h.feed().querySelector('.activity-feed__empty-reading'), 'Accepted content replaces the complete initial scene').toBeNull()
  h.assertRoute(); h.unchanged()
})

it('actual projected Focus retains the exact body, selection, focused control and source-call count while a later read is pending and fails', async () => {
  const h = await fixture('projection'); await h.render()
  await wait(() => expect(h.feed().querySelector('[data-native-record-id="original-answer"] strong')).not.toBeNull()); h.assertRoute()
  const body = h.feed().querySelector('[data-native-record-id="original-answer"] strong')!, range = document.createRange()
  const control = h.panel().querySelector<HTMLButtonElement>('.agent-region-header__more, button')!
  const originalChanges = h.actualChanges, frontendChanges = vi.spyOn(api.conversation, 'readConversationChanges')
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }); closes.push(() => release())
  h.changes.mockImplementation(async (...args) => { await gate; throw Object.assign(Error('Later original read unavailable'), { code: 'CONTROL_UNAVAILABLE' }) })
  await act(async () => appendFile(h.f.path, jsonl([row('new-answer', 'New independently recorded answer.')])))
  await wait(() => expect(frontendChanges.mock.calls.length).toBeGreaterThan(0))
  // A selected range intentionally holds new reads. Establish the selection
  // only after the real later request is pending, then verify it survives.
  range.selectNodeContents(body); getSelection()!.addRange(range); control.focus()
  const retained = () => { expect(body.isConnected).toBe(true); expect(getSelection()!.getRangeAt(0)).toBe(range); expect(range.toString()).toBe('selected words'); expect(document.activeElement).toBe(control); expect(h.feed().textContent).not.toContain('Reading interrupted'); expect(h.feed().textContent).not.toContain('Reading conversation…'); expect(h.feed().querySelector('.activity-feed__empty-reading')).toBeNull() }
  retained()
  const pendingStatus = h.feed().querySelector('.activity-ruler__pending[role="status"]')
  expect(pendingStatus, 'Later reads retain their existing ruler status rather than inserting an empty scaffold').not.toBeNull()
  expect(pendingStatus!.textContent).toContain('Reading records')
  const calls = frontendChanges.mock.calls.length
  await act(async () => useAppStore.setState({ timelines: { unrelated: { agentSessionId: 'unrelated', revision: 1, items: [] } } }))
  await pause(180); expect(frontendChanges).toHaveBeenCalledTimes(calls); retained()
  await act(async () => release()); await wait(() => expect(h.feed().textContent).toContain('Later original read unavailable')); retained()
  h.changes.mockImplementation(originalChanges); h.unchanged()
})

it('actual observed Focus distinguishes an accepted empty source from pending and interrupted reading', async () => {
  const h = await fixture('observation', []); await h.render(); await wait(() => expect(h.reads.mock.calls.length).toBeGreaterThan(0))
  await wait(() => expect(h.feed().textContent).toContain('No structured activity yet. Terminal remains available.'))
  expect(h.feed().textContent).not.toContain('Reading conversation…'); expect(h.feed().textContent).not.toContain('Reading interrupted')
  expect(h.feed().querySelector('.activity-feed__empty-reading'), 'An accepted empty source is a result rather than pending work').toBeNull()
  expect(h.feed().querySelector('[role="slider"]')).toBeNull(); h.assertRoute(); h.unchanged()
})
