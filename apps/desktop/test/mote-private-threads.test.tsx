// @vitest-environment happy-dom
import { act } from 'react'
import { addTab } from '@agentmux/layout'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { MOTE_CHAT_DEFAULT_VALUES, parseMoteChatResult, type MoteChatGeneration } from '@agentmux/core/mote-chat'
import { AgentMuxControlServer, connectAgentMuxRpc } from '@agentmux/core'
import { createConnectionServices } from '../../../packages/connectors/src/connection-services'
import { MoteChatStore } from '../../../packages/connectors/src/mote-chat-store'
import { nativeHistoryFixture, jsonl } from '../../../packages/core/test/fixtures/native-history-session'
import { desktopConversationReadBridge } from './helpers/conversation-read-bridge'
import { createMoteApp, settleMoteApp } from './fixtures/mote-app'
import { defaultAgent, defaultTab, neighborAgent, moteAgent, moteTopics, scratchWorkspace } from './fixtures/mote-workface'
import { moteConnectionTarget } from '../src/renderer/src/lib/mote-connection-default'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import type { MoteDialoguePage } from '@agentmux/core/mote-dialogue'

const closes: Array<() => unknown | Promise<unknown>> = []
const hosting = { hostId: 'original-bot-host', runtimeId: 'original-bot-runtime' }
const application = { domain: 'signed.example', appId: 'original-private-bot' }
const actor = { application, idType: 'open_id', userId: 'original-person' }
let app: ReturnType<typeof createMoteApp>, core: Awaited<ReturnType<typeof nativeHistoryFixture>>
let target: NonNullable<ReturnType<typeof moteConnectionTarget>>, history: MoteChatStore, chat: MockInstance<typeof api.moteChat.call>
let forbidden: ReturnType<typeof vi.fn>, failRead = false
const wait = (check: () => void) => vi.waitFor(async () => { await settleMoteApp(); check() }, { timeout: 10000 })
const byText = (text: string, within: ParentNode = app.container) => [...within.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === text || b.getAttribute('role') === 'tab' && b.firstChild?.textContent === text)!
async function click(text: string, within?: ParentNode) { const button = byText(text, within); expect(button, text).toBeDefined(); await act(async () => button.click()); await settleMoteApp() }
function generation(id: string, sessionId = core.session.agentSessionId): MoteChatGeneration {
  return { generationId: id, target, application, actor, externalConversationId: 'original-private-room', executionHostId: 'local', agentSessionId: sessionId,
    createOperationId: 'create-' + id, phase: 'ready', createdAt: 100, lastActivityAt: 200 }
}
function seed(value: MoteChatGeneration) {
  history.insertGeneration({ sequence: 0, laneKey: value.generationId, connectionId: 'original-private-bot', configurationRevision: 1,
    authorizedBy: { kind: 'user', id: 'original-device-person' }, generation: value, prepared: null, dispatched: true, binding: null, grant: null })
}
beforeEach(async () => {
  app = createMoteApp(); failRead = false
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { constructor(readonly cb: IntersectionObserverCallback) {} observe(target: Element) { this.cb([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver) } disconnect() {} unobserve() {} })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1000, 700))
  Element.prototype.scrollIntoView = vi.fn()
  core = await nativeHistoryFixture('claude', jsonl([
    { type: 'user', uuid: 'original-person-input', sessionId: 'native-main', message: { role: 'user', content: '我在飞书里的原问题' } },
    { type: 'assistant', uuid: 'original-private-answer', sessionId: 'native-main', message: { role: 'assistant', content: '小脏手的原完整回复' } }
  ])); closes.push(core.close)
  await desktopConversationReadBridge(core, closes)
  target = moteConnectionTarget({ workspace: scratchWorkspace, topic: moteTopics[0]!, rootPath: moteTopics[0]!.directoryPath }, useAppStore.getState().spaceZoneBindings)!
  expect(target).toBeTruthy()
  forbidden = vi.fn(async () => { throw Error('Reading private history must not create or prepare an Agent') })
  const services = await createConnectionServices({ directory: join(core.root, 'original-connections'), adapters: [], moteChat: {
    agents: { prepare: forbidden, create: forbidden, inspect: forbidden, prepareInput: forbidden, activity: forbidden }, assertTarget: async original => { expect(original).toEqual(target) }
  } }); closes.push(() => services.close())
  history = new MoteChatStore(await services.openDatabase())
  history.saveConfiguration({ target, revision: 1, values: { ...MOTE_CHAT_DEFAULT_VALUES, enabled: false, connection: { connectionId: 'original-private-bot', application } }, creator: actor })
  history.savePerson({ key: 'original-person', spaceId: target.spaceId, person: { actor, creator: true, revision: 1, total: null, used: 2, remaining: null, name: '飞书里的原来用户' } })
  seed(generation('original-generation'))
  const server = new AgentMuxControlServer({ socketPath: join(core.root, 'original-chat.sock'), moteChat: services.moteChat! })
  await server.start(); closes.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); closes.push(() => rpc.dispose())
  chat = vi.spyOn(api.moteChat, 'call').mockImplementation(async (method, input, owner) => {
    expect(owner).toEqual(hosting)
    if (failRead && method === 'space.mote.chat.inspect') throw Error('Original hosting read unavailable')
    return parseMoteChatResult(method, await rpc.call(method, input), input) as never
  })
  useAppStore.setState({ manualConnectionSelections: { ...useAppStore.getState().manualConnectionSelections, lark: hosting } })
  vi.spyOn(api.connections, 'hostingTarget').mockRejectedValue(Error('Do not borrow the default Host'))
  vi.spyOn(api.files, 'readDirectory').mockResolvedValue([])
  const current = { hostId: 'local', sessionId: defaultAgent.id, displayWorkspaceId: scratchWorkspace.id, groupId: 'mote-group', tabId: defaultTab.id, regionId: defaultTab.layout.activeRegionId }
  vi.spyOn(api.moteDialogue, 'read').mockImplementation(async input => ({ main: { target: input.target, identity: { hostId: 'local', moteId: moteTopics[0]!.id }, status: 'ready', current,
    resource: null, documentRevision: 'original-document', roleRevision: 'original-role', issue: null }, links: [], incarnation: 'original-work-links', throughSequence: 0, next: null,
    coverage: 'linked-sources-only', sourceStatus: 'read', sourceIssue: null }) as MoteDialoguePage)
  vi.spyOn(api.moteDialogue, 'inspectRecovery').mockResolvedValue({ operation: null })
  vi.spyOn(api.moteDialogue, 'ensureRecovery').mockRejectedValue(Error('No recovery from reading'))
  await app.mount()
  await act(async () => { void useAppStore.getState().executeControl({ schemaVersion: 5, operation: 'focus', requestId: 'show-original-mote', inputPolicy: 'preserve', target: { kind: 'mote', spaceId: target.spaceId } }) })
  await wait(() => expect(app.container.querySelector('[data-mote-space-id]')).toBeTruthy())
})
afterEach(async () => { await app?.dispose(); for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function openPrivate() {
  await click('Threads'); await click('私聊')
  await wait(() => expect(app.container.querySelector('[data-mote-chat-generation="original-generation"]')).toBeTruthy())
}
function unchanged() { expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled(); expect(forbidden).not.toHaveBeenCalled(); expect(core.controls.map(c => c.mock.calls.length)).toEqual([0,0,0,0,0,0]) }

it('opens old private conversations from actual Threads and renders both original input and original reply through public Core', async () => {
  const drafts = useAppStore.getState().agentComposerDrafts, sessions = useAppStore.getState().sessions
  const originalMetadata = await core.store.readMetadata(core.session.agentSessionId)
  await openPrivate()
  expect(chat.mock.calls.some(([method, input]) => method === 'space.mote.chat.history' && 'target' in input && JSON.stringify(input.target) === JSON.stringify(target) && !Object.hasOwn(input, 'actor'))).toBe(true)
  const row = app.container.querySelector('[data-mote-chat-generation="original-generation"]')!
  expect(row.textContent).toContain('飞书里的原来用户')
  // Wide entry already reads the first original: no View messages step.
  await wait(() => expect(app.container.querySelector('.mote-conversation-browser__pane:not([hidden])')?.textContent).toContain('小脏手的原完整回复'))
  expect(app.container.querySelector('.mote-conversation-browser__pane:not([hidden])')?.textContent).toContain('我在飞书里的原问题')
  await wait(() => expect(vi.mocked(api.conversation.readAgentConversation).mock.calls.some(([input]) => input.agentSessionId !== defaultAgent.id)).toBe(true))
  const privateReads = vi.mocked(api.conversation.readAgentConversation).mock.calls.filter(([input]) => input.agentSessionId !== defaultAgent.id)
  expect(privateReads.length).toBeGreaterThan(0)
  expect(privateReads.every(([input]) => input.hostId === 'local' && input.agentSessionId === core.session.agentSessionId)).toBe(true)
  const reader = vi.mocked(api.conversation.readAgentConversation)
  const originalIndex = reader.mock.calls.findIndex(([input]) => input.agentSessionId === core.session.agentSessionId)
  await writeFile('.local/state/mote-conversation-pane-review/private-conversation-sample.json', JSON.stringify({ page: await reader.mock.results[originalIndex]!.value, generation: generation('original-generation'), target, hosting, actor }))
  const privatePanel = app.container.querySelector('[role="tabpanel"][aria-label="私聊"]')!
  expect(privatePanel.textContent).not.toContain('Original work provenance unavailable')
  await click('工作'); await click('私聊'); await wait(() => expect(app.container.querySelector('.mote-conversation-browser__pane:not([hidden])')?.textContent).toContain('小脏手的原完整回复'))
  expect(useAppStore.getState().agentComposerDrafts).toBe(drafts); expect(useAppStore.getState().sessions).toBe(sessions)
  expect((await core.bytes()).native).toEqual(core.before.native)
  expect(await core.store.readMetadata(core.session.agentSessionId)).toEqual(originalMetadata); unchanged()
})

it('keeps read originals when the hosting owner fails, refuses an unknown owner without borrowing local and keeps reading passive', async () => {
  await openPrivate(); const row = app.container.querySelector('[data-mote-chat-generation="original-generation"]')!
  await act(async () => row.closest<HTMLButtonElement>('button')!.click()); await wait(() => expect(app.container.querySelector('.mote-conversation-browser__pane:not([hidden])')?.textContent).toContain('小脏手的原完整回复'))
  failRead = true; await click('刷新私聊')
  await wait(() => expect(app.container.textContent).toContain('Original hosting read unavailable'))
  expect(app.container.querySelector('.mote-conversation-browser__pane:not([hidden])')?.textContent).toContain('小脏手的原完整回复')
  const count = chat.mock.calls.length
  const defaultOwnerReads = vi.mocked(api.connections.hostingTarget).mock.calls.length
  await act(async () => useAppStore.setState({ manualConnectionSelections: { ...useAppStore.getState().manualConnectionSelections, lark: null } }))
  await wait(() => expect(app.container.textContent).toContain('原机器人托管 Host 尚未确认'))
  expect(chat.mock.calls).toHaveLength(count); expect(api.connections.hostingTarget).toHaveBeenCalledTimes(defaultOwnerReads); unchanged()
})

it('paginates only the original Mote history and does not read unopened Agent conversations', async () => {
  seed(generation('older-a', 'unopened-a')); seed(generation('older-b', 'unopened-b')); seed(generation('older-c', 'unopened-c'))
  await click('Threads'); await click('私聊')
  await wait(() => expect(app.container.querySelectorAll('[data-mote-chat-generation]')).toHaveLength(3))
  const selected = app.container.querySelector('.mote-conversation-browser__choice[aria-current="page"] [data-mote-chat-generation]')!.getAttribute('data-mote-chat-generation')
  await wait(() => expect(vi.mocked(api.conversation.readAgentConversation).mock.calls.some(([input]) => input.agentSessionId !== defaultAgent.id)).toBe(true))
  const privateReads = vi.mocked(api.conversation.readAgentConversation).mock.calls.filter(([input]) => input.agentSessionId !== defaultAgent.id)
  expect(privateReads.length).toBeGreaterThan(0)
  expect(privateReads.every(([input]) => input.agentSessionId === (selected === 'original-generation' ? core.session.agentSessionId : 'unopened-' + selected!.slice(-1)))).toBe(true)
  await click('Earlier conversations')
  await wait(() => expect(app.container.querySelectorAll('[data-mote-chat-generation]')).toHaveLength(4))
  expect(chat.mock.calls.filter(([m]) => m === 'space.mote.chat.history').map(([,p]) => 'target' in p ? p.target : undefined)).toEqual([target,target])
  expect(chat.mock.calls.find(([m,p]) => m === 'space.mote.chat.history' && 'cursor' in p && p.cursor)).toBeTruthy()
  unchanged()
})

it('reads retained original history even when the current chat configuration is absent', async () => {
  history.database.prepare('DELETE FROM mote_chat_configuration').run()
  await openPrivate()
  const row = app.container.querySelector('[data-mote-chat-generation="original-generation"]')!
  await act(async () => row.closest<HTMLButtonElement>('button')!.click())
  await wait(() => expect(app.container.querySelector('.mote-conversation-browser__pane:not([hidden])')?.textContent).toContain('小脏手的原完整回复'))
  expect(app.container.querySelector('.mote-conversation-browser__pane:not([hidden])')?.textContent).toContain('我在飞书里的原问题'); unchanged()
})


it('members directly read their exact original Sessions without navigating and only the selected Reader observes', async () => {
  const otherId = 'second-member-agent', other = moteAgent(otherId, moteTopics[0]!.id)
  for (const id of [defaultAgent.id, neighborAgent.id, otherId]) {
    const transcriptPath = join(core.root, id + '.jsonl'), nativeId = 'native-' + id
    await writeFile(transcriptPath, jsonl([
      { type: 'user', uuid: id + '-input', sessionId: nativeId, message: { role: 'user', content: '我在飞书里的原问题' } },
      { type: 'assistant', uuid: id + '-answer', sessionId: nativeId, message: { role: 'assistant', content: '小脏手的原完整回复' } }
    ]))
    await core.store.compareAndSwap(null, { ...core.session, agentSessionId: id, run: { runId: 'original-run-' + id }, nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: nativeId, transcriptPath } })
  }
  const otherTab = { ...createWorkbenchTab('second-member-tab', { kind: 'agent', phase: 'attached', workspaceId: scratchWorkspace.id, regionId: 'second-member-region', sessionId: otherId }, 'Other goal'), topicId: moteTopics[0]!.id }
  await act(async () => useAppStore.setState(state => ({ sessions: [...state.sessions, other], tabs: { ...state.tabs, [otherTab.id]: otherTab }, layouts: { ...state.layouts, [scratchWorkspace.id]: addTab(state.layouts[scratchWorkspace.id]!, 'mote-group', otherTab.id) } })))
  const tabs = useAppStore.getState().tabs, drafts = useAppStore.getState().agentComposerDrafts
  await click('Threads')
  const readsBefore = vi.mocked(api.conversation.readAgentConversation).mock.calls.length
  await settleMoteApp()
  expect(vi.mocked(api.conversation.readAgentConversation).mock.calls.slice(readsBefore).some(([input]) => input.agentSessionId === neighborAgent.id)).toBe(false)
  await click('成员')
  await wait(() => expect(app.container.querySelector('.mote-cooperation--threads .mote-session-conversation')?.textContent).toContain('小脏手的原完整回复'))
  expect(useAppStore.getState().tabs).toBe(tabs)
  const originalReader = app.container.querySelector('.mote-cooperation--threads .mote-session-conversation')
  await act(async () => useAppStore.setState({ tabs: Object.fromEntries(Object.entries(tabs).filter(([id]) => id !== 'second-member-tab' && id !== 'neighbor-tab')) }))
  await wait(() => expect(app.container.querySelectorAll('.mote-cooperation--threads [data-mote-member]')).toHaveLength(0))
  expect(app.container.querySelector('.mote-cooperation--threads .mote-session-conversation')).toBe(originalReader)
  expect(originalReader?.textContent).toContain('小脏手的原完整回复')
  expect(app.container.querySelector('.mote-cooperation--threads')?.textContent).toContain('原列表来源暂未确认')
  await act(async () => useAppStore.setState({ tabs }))
  const selected = app.container.querySelector('.mote-cooperation--threads .mote-conversation-browser__choice[aria-current="page"] [data-mote-member]')!
  expect(selected.getAttribute('data-mote-member')).toBe(neighborAgent.id)
  const next = app.container.querySelector(`[data-mote-member="${otherId}"]`)!
  await act(async () => next.closest<HTMLButtonElement>('button')!.click())
  await wait(() => expect(app.container.querySelector('.mote-cooperation--threads .mote-conversation-browser__pane:not([hidden]) [data-mote-session-conversation]')?.getAttribute('data-mote-session-conversation')).toBe(JSON.stringify({ hostId: 'local', agentSessionId: otherId })))
  await wait(() => expect(app.container.querySelector('.mote-cooperation--threads .mote-conversation-browser__pane:not([hidden])')?.textContent).toContain('小脏手的原完整回复'))
  const observe = vi.mocked(api.conversation.observeConversation), observations = await Promise.all(observe.mock.results.filter(result => result.type === 'return').map(result => result.value).map(promise => Promise.resolve(promise).catch(() => null)))
  expect(observations.filter(handle => handle?.agentSessionId === neighborAgent.id).length).toBeGreaterThan(0)
  expect(observations.filter(handle => handle?.agentSessionId === neighborAgent.id).every(handle => handle!.closed.aborted)).toBe(true)
  expect(observations.some(handle => handle?.agentSessionId === otherId && !handle.closed.aborted)).toBe(true)
  await click('工作')
  expect(observations.filter(handle => handle?.agentSessionId === otherId).every(handle => handle!.closed.aborted)).toBe(true)
  expect(useAppStore.getState().tabs).toBe(tabs); expect(useAppStore.getState().agentComposerDrafts).toBe(drafts); unchanged()
})

it('narrow private reading takes one row click and returns directly to its original selected list', async () => {
  vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue(new DOMRect(0, 0, 400, 700))
  await openPrivate()
  const reads = vi.mocked(api.conversation.readAgentConversation)
  expect(reads.mock.calls.some(([input]) => input.agentSessionId === core.session.agentSessionId)).toBe(false)
  const row = app.container.querySelector('[data-mote-chat-generation="original-generation"]')!
  await act(async () => row.closest<HTMLButtonElement>('button')!.click())
  await wait(() => expect(app.container.querySelector('.mote-conversation-browser__pane:not([hidden])')?.textContent).toContain('小脏手的原完整回复'))
  expect(app.container.querySelector('.mote-conversation-browser__list')?.hasAttribute('hidden')).toBe(true)
  const scroll = app.container.querySelector<HTMLElement>('.mote-session-conversation__scroll')!
  Object.defineProperties(scroll, { clientHeight: { configurable: true, value: 100 }, scrollHeight: { configurable: true, value: 700 } })
  const bounds = vi.mocked(HTMLElement.prototype.getBoundingClientRect).getMockImplementation()!
  vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute('data-mote-conversation-tail') ? new DOMRect(0, 700 - scroll.scrollTop, 400, 0) : bounds.call(this)
  })
  await act(async () => { scroll.scrollTop = 600; scroll.dispatchEvent(new Event('scroll')); scroll.scrollTop = 73; scroll.dispatchEvent(new Event('scroll')) })
  await act(async () => app.container.querySelector<HTMLButtonElement>('[aria-label="返回对话列表"]')!.click())
  expect(app.container.querySelector('.mote-conversation-browser__list')?.hasAttribute('hidden')).toBe(false)
  expect(app.container.querySelector('.mote-conversation-browser__detail')?.hasAttribute('hidden')).toBe(true)
  await act(async () => row.closest<HTMLButtonElement>('button')!.click())
  expect(scroll.scrollTop).toBe(73); unchanged()
})
