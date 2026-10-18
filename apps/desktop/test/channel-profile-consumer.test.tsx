// @vitest-environment happy-dom
import { act } from 'react'
import { mkdir, writeFile } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { URL as NodeURL } from 'node:url'
import type { AgentSessionUserMessage } from '@agentmux/core'
import { projectSessionUserMessages } from '@agentmux/core'
import { channelMetadataFixture, actorSubject, groupSubject } from '../../../packages/connectors/test/fixtures/channel-metadata.js'
import { registerConnectorIpc } from '../src/main/connector-ipc'
import { ChannelMetadataPanel } from '../src/renderer/src/components/settings/ChannelMetadataPanel'
import { ConversationMessage } from '@agentmux/client-ui/components/ConversationMessage'
import { createSpeakerResolver, speakerOfUserMessage } from '@agentmux/client-ui/conversation-speaker'
import { channelProfileKey, useChannelActorProfiles } from '../src/renderer/src/lib/use-channel-actor-profiles'
import { useConnectorRoomName } from '../src/renderer/src/lib/use-connector-room-name'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM, composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import { useAppStore } from '../src/renderer/src/store'

const bridge = vi.hoisted(() => ({ api: null as any, handlers: new Map<string, (...args: any[]) => Promise<any>>(), listeners: new Map<string, Set<(...args: any[]) => void>>() }))
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: (_name: string, value: unknown) => { bridge.api = value } },
  webFrame: { getZoomFactor: () => 1 }, ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) => bridge.handlers.get(channel)!({ sender: 'original-renderer' }, ...args),
    on: (channel: string, listener: (...args: any[]) => void) => { const values = bridge.listeners.get(channel) ?? new Set(); values.add(listener); bridge.listeners.set(channel, values) },
    removeListener: (channel: string, listener: (...args: any[]) => void) => bridge.listeners.get(channel)?.delete(listener), send() {}
  } }))
import '../src/preload/index'
const dom = composerDOM(), cleanup: Array<() => void | Promise<void>> = []
let f: Awaited<ReturnType<typeof channelMetadataFixture>>, calls: Array<{ method: string; input: any }> = []
beforeEach(async () => {
  vi.stubGlobal('URL', NodeURL)
  f = await channelMetadataFixture(cleanup); calls = []
  const release = registerConnectorIpc({ handleWithEvent: (channel, handler) => { bridge.handlers.set(channel, handler) },
    assertTrusted: (_channel, event) => { expect(event.sender).toBe('original-renderer') }, socketPath: f.server.path, secrets: f.services.secrets,
    metadata: { subscribe: f.services.onChannelMetadataChanged, publish: change => { for (const listener of bridge.listeners.get('connections:metadataChanged') ?? []) listener({}, change) } } })
  cleanup.push(release)
  vi.spyOn(api.connections, 'call').mockImplementation(async (method: any, input: any) => { calls.push({ method, input }); return bridge.api.connections.call(method, input) })
  vi.spyOn(api.connections, 'onMetadataChanged').mockImplementation(listener => bridge.api.connections.onMetadataChanged(listener))
  await f.submit('ui-profile')
  await vi.waitFor(async () => expect((await f.get()).entry.observation.profile?.name).toBe('Original native person'))
})
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); bridge.handlers.clear(); bridge.listeners.clear(); vi.unstubAllGlobals() })
async function click(text: string) {
  const button = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text)
  expect(button, text).toBeDefined(); await act(async () => button!.click())
}
it('native sender -> original profile cache -> public RPC -> registered IPC/preload -> mounted SessionPane original-record reader and exact renamed group', async () => {
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  let messages: AgentSessionUserMessage[] = []
  await vi.waitFor(async () => { messages = projectSessionUserMessages({ agentSessionId: 'original-agent', timeline: await f.client.sessionTimeline('original-agent') }); expect(messages.some(message => message.author.kind === 'external')).toBe(true) })
  await mkdir('.local/channel-protocol/T-005', { recursive: true })
  await writeFile('.local/channel-protocol/T-005/public-scene.json', JSON.stringify({ messages, connection: (await f.sdk.call('connection.inspect', { connectionId: f.config.connectionId })).connection, binding: (await f.sdk.call('connection.binding.ls', { executionHostId: 'local', agentSessionId: 'original-agent' })).bindings[0], actor: await f.get(), group: await f.get(groupSubject) }, null, 2))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const original = f.client.agentSession('original-agent')
  const session = { ...composerSession('original-agent', 'claude'), workspacePath: f.root, nativeHandle: original.nativeHandle, control: { kind: 'agent' as const, hostId: 'local', agentSessionId: 'original-agent', run: original.run } }
  useAppStore.setState({ loading: false, config: { ...composerConfig, executors: { claude: { ...composerConfig.executors.codex!, providerId: 'claude', command: 'claude' } }, workspaces: [{ ...composerConfig.workspaces[0]!, path: f.root }] }, sessions: [session], viewModes: { 'original-agent': 'activity' }, timelines: { 'original-agent': await f.client.sessionTimeline('original-agent') } })
  const reads: Array<{ method: string; input: unknown; result?: any; error?: string }> = []
  for (const method of ['readAgentConversation', 'readConversationChanges', 'observeConversation', 'releaseConversationView'] as const) vi.spyOn(api.conversation, method).mockImplementation(async (...args: any[]) => {
    try { const result = await (f.client[method] as any)(...args); if (method !== 'observeConversation') reads.push({ method, input: args[0], result }); return result }
    catch (error) { reads.push({ method, input: args[0], error: String(error) }); throw error }
  })
  function OriginalGroup() { const name = useConnectorRoomName({ ...f.input, application: f.config.application, revision: 1 } as any); return <h2 data-group-name>{name.label}</h2> }
  const frame = (visible: boolean) => <><OriginalGroup /><SessionPane sessionId="original-agent" surfaceKind="agent" interactiveResize={false} visible={visible} linkOrigin={{ workspaceId: 'workspace', tabGroupId: 'test-group', tabId: 'tab', regionId: 'original-region' }} /></>
  await dom.render(frame(true))
  const external = messages.find(message => message.author.kind === 'external')!
  let originalRecord: HTMLElement | undefined
  await vi.waitFor(() => {
    originalRecord = [...dom.container.querySelectorAll<HTMLElement>('.conversation-submission-record')].find(node => node.dataset.submissionId === external.rawId)
    expect(originalRecord).toBeDefined()
    expect(JSON.parse(originalRecord!.dataset.conversationAuthor!)).toEqual(external.author)
  })
  const originalEvent = reads.filter(read => read.method === 'readAgentConversation').flatMap(read => read.result.items).find((entry: any) =>
    entry.kind === 'item' && entry.item.event.reference.source.kind === 'captured' && entry.item.event.reference.source.recordId === external.rawId)?.item.event
  expect(originalEvent?.author).toEqual(external.author)
  // The real feed initially folds original captured submissions. Open this exact
  // source record through its ordinary reader control before inspecting its card.
  expect(originalRecord!.querySelector('details')!.open).toBe(false)
  await act(async () => originalRecord!.querySelector('summary')!.click())
  await vi.waitFor(() => { expect(dom.container.querySelector('[data-speaker-role=external] .log-turn__sender')?.textContent).toBe('Original native person'); expect(dom.container.querySelector('[data-group-name]')?.textContent).toBe('Original native group') })
  expect(dom.container.querySelector('[data-speaker-role=external] .log-turn__node img')?.getAttribute('src')).toBe('https://cdn.example/person.png')
  f.source('Renamed person', 'Renamed original group')
  await f.sdk.call('connection.metadata.refresh', { connectionId: f.config.connectionId, expectedConnectionRevision: 1, subject: actorSubject })
  await f.transport.receive({ schema: '2.0', header: { event_id: 'ui-native-rename', event_type: 'im.chat.updated_v1', app_id: f.config.application.appId }, event: { chat_id: groupSubject.externalConversationId } })
  expect(f.transport.ack().at(-1)).toEqual({ code: 200 })
  await vi.waitFor(() => { expect(dom.container.querySelector('[data-speaker-role=external] .log-turn__sender')?.textContent).toBe('Renamed person'); expect(dom.container.querySelector('[data-group-name]')?.textContent).toBe('Renamed original group') })
  expect(calls.filter(call => call.method === 'connection.metadata.get' && call.input.subject.kind === 'actor')).toHaveLength(2)
  // A later display-read failure must keep the last observed name and the
  // authenticated original message, while making this read's uncertainty visible.
  vi.mocked(api.connections.call).mockImplementation(async (method: any, input: any) => {
    calls.push({ method, input })
    if (method === 'connection.metadata.get' && input.subject.kind === 'actor') throw Error('Local profile read unavailable')
    return bridge.api.connections.call(method, input)
  })
  f.source('New cache value while the display read is unavailable', 'Renamed original group')
  await f.sdk.call('connection.metadata.refresh', { connectionId: f.config.connectionId, expectedConnectionRevision: 1, subject: actorSubject })
  await vi.waitFor(() => expect(calls.filter(call => call.method === 'connection.metadata.get' && call.input.subject.kind === 'actor')).toHaveLength(3))
  const detail = dom.container.querySelector<HTMLButtonElement>('[data-speaker-role=external] button[aria-label="Message details"]')!
  await act(async () => detail.click())
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Saved · current read unconfirmed'))
  expect(dom.container.querySelector('[data-speaker-role=external] .log-turn__sender')?.textContent).toBe('Renamed person')
  expect(JSON.parse(originalRecord!.dataset.conversationAuthor!)).toEqual(external.author)
  await dom.render(frame(false))
  const hiddenReads = calls.filter(call => call.method === 'connection.metadata.get' && call.input.subject.kind === 'actor').length
  await f.sdk.call('connection.metadata.refresh', { connectionId: f.config.connectionId, expectedConnectionRevision: 1, subject: actorSubject })
  expect(calls.filter(call => call.method === 'connection.metadata.get' && call.input.subject.kind === 'actor')).toHaveLength(hiddenReads)
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})
it('mounted cache management refreshes and clears exact metadata through IPC while preserving original records and bindings', async () => {
  const connection = (await f.sdk.call('connection.inspect', { connectionId: f.config.connectionId })).connection!
  await dom.render(<ChannelMetadataPanel connection={connection} active />)
  const details = dom.container.querySelector('details')!
  await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')) })
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Original native person'))
  f.source('Updated via real UI', 'Original native group')
  await click('Refresh')
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Updated via real UI'))
  let before = await f.client.sessionTimeline('original-agent')
  await vi.waitFor(async () => { before = await f.client.sessionTimeline('original-agent'); expect(before.items.some(item => !!item.authorExternal)).toBe(true) })
  await click('Clear saved profile')
  await vi.waitFor(() => expect(dom.container.textContent).toContain('No saved profile'))
  expect((await f.get()).entry.observation.profile).toBeNull()
  const originalInputs = (timeline: typeof before) => timeline.items.filter(item => item.authorExternal).map(({ id, content, authorExternal }) => ({ id, content, authorExternal }))
  expect(originalInputs(await f.client.sessionTimeline('original-agent'))).toEqual(originalInputs(before))
  expect((await f.sdk.call('connection.binding.ls', { executionHostId: 'local', agentSessionId: 'original-agent' })).bindings).toHaveLength(1)
  const clear = calls.find(call => call.method === 'connection.metadata.clear')!
  expect(clear.input).toMatchObject({ subject: actorSubject, expectedConnectionRevision: 1, expectedCacheRevision: expect.any(String) })
})

it('unavailable display notifications preserve the actual recorded sender and readable cached profile', async () => {
  let messages: AgentSessionUserMessage[] = []
  await vi.waitFor(async () => {
    messages = projectSessionUserMessages({ agentSessionId: 'original-agent', timeline: await f.client.sessionTimeline('original-agent') })
    expect(messages.some(message => message.author.kind === 'external')).toBe(true)
  })
  const original = messages.find(message => message.author.kind === 'external')!
  vi.mocked(api.connections.onMetadataChanged).mockImplementation(() => { throw Error('Notification port unavailable') })
  function OriginalSender() {
    const profiles = useChannelActorProfiles(messages, true)
    return <ConversationMessage messageId={original.id} content={original.content} speaker={speakerOfUserMessage(original)}
      inputSource={original.source} recordedIdentity describeSpeaker={createSpeakerResolver({ lookupExternal: author => profiles.get(channelProfileKey(author)) })} />
  }
  await dom.render(<OriginalSender />)
  await vi.waitFor(() => expect(dom.container.querySelector('.log-turn__sender')?.textContent).toBe('Original native person'))
  await dom.click('button[aria-label="Message details"]')
  expect(dom.container.textContent).toContain('Live profile updates unavailable')
  expect(dom.container.textContent).toContain('Saved · current read unconfirmed')
  expect(dom.container.querySelector('[data-speaker-role=external]')).not.toBeNull()
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})
