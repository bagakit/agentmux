// @vitest-environment happy-dom
import { act } from 'react'
import { appendFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { fixtureIso } from '../scripts/lib/fixture-values.mjs'
import { nativeHistoryFixture, jsonl } from '../../../packages/core/test/fixtures/native-history-session'
import type { AgentConversationReadPage, ConversationChangesPage } from '@agentmux/core'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import { inspectConversationConsumers } from '../src/renderer/src/lib/conversation-consumer-observation'
import { api } from '../src/renderer/src/lib/api'
import { createClientUiRoot } from './helpers/client-ui-render'
import { desktopConversationReadBridge } from './helpers/conversation-read-bridge'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { FocusConversationReadingScene, focusReadingLocation } from './fixtures/focus-conversation-reading'

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
const pause = async (ms = 20) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) })
const wait = (assertion: () => void, timeout = 45000) => vi.waitFor(async () => { await pause(); assertion() }, { timeout, interval: 20 })

async function fixture(count: number, step = 3_600_000, role: 'assistant' | 'user' = 'assistant') {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  HTMLElement.prototype.scrollIntoView = vi.fn()
  const rows = Array.from({ length: count }, (_, index) => ({ type: role, uuid: `answer-${index}`, sessionId: 'native-main', timestamp: fixtureIso(index * step),
    message: { role, content: `Original answer ${index}: **selected words** remain readable.` } }))
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
  const pages: AgentConversationReadPage[] = [], originalRead = f.client.readAgentConversation.bind(f.client)
  const reads = vi.spyOn(f.client, 'readAgentConversation').mockImplementation(async (...args) => { const page = await originalRead(...args); pages.push(page); return page })
  const sourceReads = vi.spyOn(f.client, 'sessionHistoryPage')
  const changePages: ConversationChangesPage[] = [], originalChanges = f.client.readConversationChanges.bind(f.client)
  vi.spyOn(f.client, 'readConversationChanges').mockImplementation(async (...args) => { const page = await originalChanges(...args); changePages.push(page); return page })
  const frontendReads = vi.spyOn(api.conversation, 'readAgentConversation')
  const changes = vi.spyOn(api.conversation, 'readConversationChanges')
  const sample = () => inspectConversationConsumers({hostId: 'local', agentSessionId: agent.id}).consumers.find(value => !value.viewport.hidden)
  const host = document.createElement('div'); document.body.append(host); const root = createClientUiRoot(host)
  closes.push(async () => { await act(async () => root.unmount()); host.remove() })
  const feed = () => host.querySelector<HTMLElement>('.global-session-workspace .activity-feed')!
  const earlier = () => feed().querySelector<HTMLButtonElement>('.activity-feed__reading-action')!
  const completed = () => pages.filter(page => page.window.complete).at(-1)!
  const unchanged = async (expectedNative = f.before.native) => {
    expect(useAppStore.getState().sessions).toEqual([agent]); expect(useAppStore.getState().tabs[tab.id]).toEqual(tab)
    expect(useAppStore.getState().layouts[location.displayWorkspaceId]).toEqual(layout)
    expect(useAppStore.getState().agentComposerDrafts[agent.id]).toBe('Original unsent draft')
    expect(useAppStore.getState().agentComposerDrafts[location.regionId]).toBe('Original Region draft')
    expect(legacy.map(value => value.mock.calls.length)).toEqual([0, 0]); expect(f.controls.map(value => value.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
    expect((await f.bytes()).native).toEqual(expectedNative)
    const stored = (await f.store.load()).find(value => value.agentSessionId === agent.id)!
    expect(stored.run).toEqual(f.session.run); expect(stored.nativeHandle).toEqual(f.session.nativeHandle)
  }
  return { f, reads, sourceReads, frontendReads, originalRead, pages, changePages, completed, sample, changes, host, feed, earlier, unchanged,
    render: async () => act(async () => root.render(<FocusConversationReadingScene route="projection" />)) }
}

async function chooseRange(feed: HTMLElement, value: string) {
  const trigger = feed.querySelector<HTMLButtonElement>('.conversation-ruler__window[aria-label^="History window:"]')!
  expect(trigger).not.toBeNull()
  await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
  await wait(() => expect(document.querySelector('[role="menuitemradio"]')).not.toBeNull())
  const option = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(node => node.textContent === (value === 'all' ? 'All · bounded reading' : `${value} reading window`))!
  expect(option).toBeDefined(); await act(async () => option.click())
}

it('actual Focus stops automatic fill at its unchanged count bound and Core outside boundary without manufacturing a failed-read bar', async () => {
  const h = await fixture(1400); await h.render()
  await wait(() => { expect(h.sample()?.accepted?.recordCount).toBe(100); expect(h.sample()?.accepted?.revision).toBeGreaterThanOrEqual(2); expect(h.sample()?.loading).toBe(false) })
  await chooseRange(h.feed(), 'all')
  await wait(() => { expect(h.completed()?.window.itemCount).toBe(1200); expect(h.sample()?.accepted?.recordCount).toBe(1200); expect(h.sample()?.loading).toBe(false) })
  expect(h.earlier()?.textContent).toBe('Earlier')
  expect(h.completed().window.navigation.older).not.toBeNull()
  expect(h.completed().window.outside.newer).toBeNull()
  const calls = h.reads.mock.calls.length
  await pause(140); expect(h.reads).toHaveBeenCalledTimes(calls)
  expect(h.feed().querySelector('.activity-feed__read-notice')).toBeNull()
  expect(h.feed().textContent).not.toContain('bounded reading window')
  expect(h.feed().querySelector('[data-read-error]')).toBeNull()
  // Explicit older navigation uses the same real view and makes Core retain an
  // exact newer-outside boundary. The following range change is a new demand.
  await act(async () => h.earlier().click())
  await wait(() => expect(h.completed().window.outside.newer).not.toBeNull())
  const beforeRange = h.reads.mock.calls.length
  await chooseRange(h.feed(), '24h'); await chooseRange(h.feed(), 'all'); await pause(140)
  expect(h.reads).toHaveBeenCalledTimes(beforeRange)
  expect(h.feed().querySelector('.activity-feed__read-notice')).toBeNull()
  expect(h.feed().textContent).not.toContain('bounded reading window')
  expect(h.earlier().textContent).toBe('Earlier'); expect(h.earlier().disabled).toBe(false)
  expect(h.completed().window.itemCount).toBeLessThanOrEqual(1200)
  await h.unchanged()
})

it('actual automatic rejection stays in the original Earlier button with its full cause and retries its original continuation once while retaining body, Range and focus', async () => {
  const h = await fixture(180, 1000)
  const cause = 'The original native continuation is temporarily unavailable; retain its displayed records and retry this operation.'
  let failure = true, blocked = false, release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }); closes.push(() => release())
  h.reads.mockImplementation(async (...args) => {
    if (args[0].cursor && !blocked) { blocked = true; await gate; if (failure) throw Object.assign(Error(cause), { code: 'CONTROL_UNAVAILABLE' }) }
    const page = await h.originalRead(...args); h.pages.push(page); return page
  })
  await h.render()
  await wait(() => { expect(blocked).toBe(true); expect(h.feed().querySelector('[data-native-record-id="answer-179"] strong')).not.toBeNull() })
  const button = h.earlier(), body = h.feed().querySelector('[data-native-record-id="answer-179"] strong')!, range = document.createRange()
  range.selectNodeContents(body); getSelection()!.addRange(range)
  const control = h.host.querySelector<HTMLButtonElement>('.global-session-workspace .agent-region-header__more, .global-session-workspace button')!; control.focus()
  const retained = () => { expect(body.isConnected).toBe(true); expect(getSelection()!.getRangeAt(0)).toBe(range); expect(range.toString()).toBe('selected words'); expect(document.activeElement).toBe(control) }
  expect(button.getAttribute('aria-busy')).toBe('true'); retained()
  await act(async () => release())
  await wait(() => { const sample = h.sample(); expect(Math.max(sample?.accepted?.revision ?? 0, sample?.pending?.revision ?? 0)).toBeGreaterThanOrEqual(2); expect(sample?.loading).toBe(false); expect(sample?.inFlight).toBe(false) })
  expect(h.changes.mock.calls.length).toBeGreaterThan(0)
  expect(h.sample()?.error?.message).toBe(cause)
  expect(h.earlier().getAttribute('data-read-error')).toBe('true')
  expect(h.earlier()).toBe(button); expect(button.textContent).toContain('Retry loading earlier'); expect(button.textContent).toContain(cause); expect(button.disabled).toBe(false)
  expect(h.feed().querySelector('.activity-feed__read-notice')).toBeNull()
  expect([...h.feed().querySelectorAll('button')].filter(node => /Retry/.test(node.textContent ?? ''))).toEqual([button])
  retained()
  const failed = h.frontendReads.mock.calls.at(-1)![0], calls = h.frontendReads.mock.calls.length, sourceCalls = h.sourceReads.mock.calls.length
  const nativeCursor = (await h.sourceReads.mock.results[0]!.value).nextCursor
  const currentPage = (await Promise.all(h.changes.mock.results.map(row => row.value))).filter(page => page.window.id === h.sample()?.watch.windowId && page.window.complete).at(-1)!
  expect(currentPage).toBeDefined(); expect(currentPage.window.navigation.older).not.toBeNull()
  await pause(140); expect(h.frontendReads).toHaveBeenCalledTimes(calls)
  failure = false; await act(async () => button.click())
  await wait(() => { expect(h.sample()?.loading).toBe(false); expect(h.sourceReads).toHaveBeenCalledTimes(sourceCalls + 1) })
  expect(h.sourceReads).toHaveBeenCalledTimes(sourceCalls + 1)
  expect(h.frontendReads.mock.calls[calls]![0]).toEqual({ ...failed, cursor: currentPage.window.navigation.older })
  expect(h.sourceReads.mock.calls[sourceCalls]![1]?.cursor).toBe(nativeCursor)
  expect(h.frontendReads.mock.calls.slice(calls).every(call => Boolean(call[0].cursor))).toBe(true)
  expect(h.earlier()?.getAttribute('data-read-error') ?? null).toBeNull()
  expect(h.feed().querySelector('.activity-feed__read-notice')).toBeNull(); expect(h.feed().textContent).not.toContain(cause)
  retained(); await h.unchanged()
})

it('actual native input window bounds keep normal range hints in the original Earlier action without a standalone notice', async () => {
  const h = await fixture(180, 3_600_000, 'user'); await h.render()
  await wait(() => { expect(h.sample()?.accepted?.recordCount).toBe(100); expect(h.sample()?.loading).toBe(false); expect(h.earlier()?.disabled).toBe(false) })
  expect(h.completed().window.navigation.older).not.toBeNull()
  expect(h.feed().textContent).toContain('Original answer 179:')
  expect(h.earlier().title).toBe('Read earlier conversation and process records in the original sequence')
  expect(h.feed().querySelector('.activity-feed__read-notice')).toBeNull()
  // Real native arrivals advance both existing current consumers. The input
  // consumer must itself cross Core's bound; the reading window's newer-outside
  // flag and an assistant-only empty input set cannot prove this condition.
  await act(async () => appendFile(h.f.path, jsonl(Array.from({length: 1300}, (_, index) => ({type: 'user', uuid: `new-input-${index}`, sessionId: 'native-main', timestamp: fixtureIso((180 + index) * 3_600_000), message: {role: 'user', content: `Recent input ${index}.`}})))))
  const appendedNative = (await h.f.bytes()).native
  const inputBoundary = () => h.changePages.filter(page => page.window.complete && page.window.id !== h.sample()?.watch.windowId && page.window.outside.older && !page.more).at(-1)
  await wait(() => { expect(inputBoundary()).toBeDefined(); expect(h.feed().textContent).toContain('Recent input 1299.'); expect(h.sample()?.loading).toBe(false) }, 75000)
  const actual = inputBoundary()!
  expect(actual.window.outside.older).not.toBeNull(); expect(actual.window.itemCount).toBeGreaterThan(100); expect(actual.window.itemCount).toBeLessThanOrEqual(1200)
  expect(actual.scope.sources).toContainEqual({kind: 'native', providerId: 'claude', nativeSessionId: 'native-main'})
  expect(h.earlier()).not.toBeNull(); expect(h.earlier().disabled).toBe(false)
  expect(h.earlier().title).toBe('Read earlier conversation and process records in the original sequence')
  expect(h.feed().querySelector('.activity-feed__read-notice')).toBeNull()
  expect(h.feed().textContent).not.toContain('This window keeps recent conversation and process records.')
  expect(h.feed().querySelector('[data-read-error]')).toBeNull()
  expect(h.feed().querySelector('summary')?.textContent).toContain('source coverage')
  await h.unchanged(appendedNative)
})
