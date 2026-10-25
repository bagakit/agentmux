// @vitest-environment happy-dom
import { act, useEffect } from 'react'
import { mkdir, writeFile } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { URL as NodeURL } from 'node:url'
import type { AgentSessionUserMessage, AgentTimelineItem } from '@agentmux/core'
import type { AgentMuxClient } from '../../../packages/core/src/client'
import { projectSessionUserMessages } from '@agentmux/core'
import { projectSessionInputs } from '@agentmux/core/conversation'
import { inputMailboxItemKey } from '@agentmux/client-ui/use-agent-input-mailbox'
import { channelMetadataFixture, actorSubject, groupSubject } from '../../../packages/connectors/test/fixtures/channel-metadata.js'
import { registerConnectorIpc } from '../src/main/connector-ipc'
import type { ConnectionHostIpc } from '../src/main/connection-host-ipc'
import { ChannelMetadataPanel } from '../src/renderer/src/components/settings/ChannelMetadataPanel'
import { ConversationMessage } from '@agentmux/client-ui/components/ConversationMessage'
import { InputMailboxRecords, inputMailboxPresentation } from '@agentmux/client-ui/components/InputMailboxRecords'
import { createSpeakerResolver, speakerOfUserMessage } from '@agentmux/client-ui/conversation-speaker'
import { channelProfileKey, useChannelActorProfiles } from '../src/renderer/src/lib/use-channel-actor-profiles'
import { useConnectorRoomName } from '../src/renderer/src/lib/use-connector-room-name'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM, composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import { useAppStore } from '../src/renderer/src/store'
import { desktopConversationReadBridge } from './helpers/conversation-read-bridge'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { activityReadingProps } from './helpers/activity-reading-props'
import { inspectConversationConsumers } from '../src/renderer/src/lib/conversation-consumer-observation'
import { projectMailboxInputs } from '../src/renderer/src/lib/mailbox-input-projection'
import { copyConnectorIdentity } from './helpers/connector-identity-copy'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc'
import { DefaultRestOptions, discordConfig, discordTransport } from '../../../packages/connectors/test/fixtures/discord'

const bridge = vi.hoisted(() => ({ api: null as any, handlers: new Map<string, (...args: any[]) => Promise<any>>(), listeners: new Map<string, Set<(...args: any[]) => void>>() }))
// This reader/metadata test retains the real Terminal slot. Chromium/xterm paint
// is the same controlled leaf as the original mailbox navigation consumers.
const terminals = vi.hoisted(() => ({ mounted: 0, disposed: 0 }))
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: ({ visible, autoFocus }: { visible: boolean; autoFocus: boolean }) => {
  useEffect(() => { ++terminals.mounted; return () => { ++terminals.disposed } }, [])
  return <div data-terminal-witness data-visible={visible} data-auto-focus={autoFocus} />
} }))
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: (_name: string, value: unknown) => { bridge.api = value } },
  webFrame: { getZoomFactor: () => 1 }, ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) => bridge.handlers.get(channel)!({ sender: 'original-renderer' }, ...args),
    on: (channel: string, listener: (...args: any[]) => void) => { const values = bridge.listeners.get(channel) ?? new Set(); values.add(listener); bridge.listeners.set(channel, values) },
    removeListener: (channel: string, listener: (...args: any[]) => void) => bridge.listeners.get(channel)?.delete(listener), send() {}
  } }))
import '../src/preload/index'
const dom = composerDOM(), cleanup: Array<() => void | Promise<void>> = []
let f: Awaited<ReturnType<typeof channelMetadataFixture>>, calls: Array<{ method: string; input: any }> = []
let metadataReady = false, metadataInFlight = 0, metadataChanges = 0
beforeEach(async context => {
  vi.stubGlobal('URL', NodeURL)
  const explicitOwner = context.task.name.startsWith('original Inputs fills') || context.task.name.startsWith('confirmed profile route') || context.task.name.startsWith('profile field observation')
  f = await channelMetadataFixture(cleanup, explicitOwner ? { hostingRuntimeId: 'original-profile-runtime', executionRuntimeId: 'original-execution-runtime' } : undefined); calls = []; metadataReady = false; metadataInFlight = 0; metadataChanges = 0
  terminals.mounted = 0; terminals.disposed = 0
  // This controlled hosting port retains the fixture's actual public RPC owner.
  const hostingTarget = { hostId: 'local', runtimeId: 'original-profile-runtime' }
  const runtime: ConnectionHostIpc = {
    connectionHostingTarget: async (source = 'local') => { expect(source).toEqual(typeof source === 'string' ? 'local' : { runtimeId: hostingTarget.runtimeId }); return { ...hostingTarget } },
    callConnectionHost: async (target, method, params) => {
      expect(target).toEqual(hostingTarget)
      return await f.sdk.call(method, params)
    },
    watchConnectionMetadata: async (target, handlers) => {
      expect(target).toEqual(hostingTarget)
      return await f.sdk.subscribe('connection.metadata.watch', {}, handlers)
    }
  }
  const release = registerConnectorIpc({ runtime, handleWithEvent: (channel, handler) => { bridge.handlers.set(channel, handler) },
    assertTrusted: (_channel, event) => { expect(event.sender).toBe('original-renderer') },
    metadata: { publish: (watchId, change) => { metadataChanges++; for (const listener of bridge.listeners.get('connections:metadataChanged') ?? []) listener({}, { watchId, change }) },
      observation: (watchId, state) => { metadataReady = state === 'ready'; for (const listener of bridge.listeners.get('connections:metadataObservation') ?? []) listener({}, { watchId, state }) } } })
  cleanup.push(() => release.dispose())
  vi.spyOn(api.connections, 'hostingTarget').mockImplementation((...args) => bridge.api.connections.hostingTarget(...args))
  vi.spyOn(api.connections, 'call').mockImplementation(async (...args) => {
    const [method, input] = args
    calls.push({ method, input }); metadataInFlight++
    try { return await bridge.api.connections.call(...args) } finally { metadataInFlight-- }
  })
  vi.spyOn(api.connections, 'onMetadataChanged').mockImplementation((...args) => bridge.api.connections.onMetadataChanged(...args))
  await f.submit('ui-profile')
  await vi.waitFor(async () => expect((await f.get()).entry.observation.profile?.name).toBe('Original native person'))
  await desktopConversationReadBridge(f, cleanup, () => [...f.coreClients(), { hostId: 'other-host', client: f.client }])
  vi.spyOn(api.sessions, 'inputMailbox').mockImplementation(async (reference, input = {}) => {
    // RuntimeController validates the public route and returns the inner UI page.
    const { hostId, ...page } = await f.sdk.call('agent.input.ls', { ...input, ...reference })
    expect(hostId).toBe(reference.hostId)
    return page
  })
  vi.spyOn(api.sessions, 'listMessages').mockImplementation((reference, input) => f.sdk.call('message.ls',
    { ...input, hostId: reference.hostId, participantSessionId: reference.agentSessionId }))
  vi.spyOn(api.sessions, 'readHistory').mockImplementation((reference, input, context) => f.sdk.call('agent.history',
    { ...input, ...reference }, context?.signal ? { signal: context.signal } : {}))
})
afterEach(async () => {
  await dom.render(null)
  for (const close of cleanup.splice(0).reverse()) await close()
  bridge.handlers.clear(); bridge.listeners.clear(); vi.unstubAllGlobals()
})
async function click(text: string) {
  const button = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text)
  expect(button, text).toBeDefined(); await act(async () => button!.click())
}
const actorReads = () => calls.filter(call => call.method === 'connection.metadata.get' && call.input.subject.kind === 'actor')
const submittedRecord = (id: string) => [...dom.container.querySelectorAll<HTMLElement>('[data-submission-id]')].find(node => node.dataset.submissionId === id) ?? null
async function originalMessages() {
  let messages: AgentSessionUserMessage[] = []
  await vi.waitFor(async () => {
    messages = projectSessionUserMessages({ agentSessionId: 'original-agent', timeline: await f.client.sessionTimeline('original-agent') })
    expect(messages.some(message => message.author.kind === 'external' && message.sourceRecord?.record.hostId === 'local')).toBe(true)
  })
  return messages
}
function originalSession(mode: 'terminal' | 'activity') {
  const original = f.client.agentSession('original-agent')
  const session = { ...composerSession('original-agent', 'claude'), workspacePath: f.root, ...(original.nativeHandle ? { nativeHandle: original.nativeHandle } : {}),
    control: { kind: 'agent' as const, hostId: 'local', agentSessionId: 'original-agent', run: original.run } }
  useAppStore.setState({ loading: false, config: { ...composerConfig,
    executors: { claude: { ...composerConfig.executors.codex!, providerId: 'claude', command: 'claude' } },
    workspaces: [{ ...composerConfig.workspaces[0]!, path: f.root }] }, sessions: [session], viewModes: { 'original-agent': mode }, timelines: {} })
  return session
}
async function publishOriginal(item: AgentTimelineItem) {
  const client = f.client as unknown as AgentMuxClient
  await client['persistAndPublishTimeline']({ type: 'upsert', agentSessionId: item.agentSessionId, item },
    { source: 'agentmux', observedAt: item.updatedAt }, f.input.executionHostId)
}
async function openInputs() {
  const panel = dom.container.querySelector<HTMLElement>('.composer-mailbox')!
  expect(panel).not.toBeNull()
  const event = new Event('toggle'); Object.defineProperty(event, 'newState', { value: 'open' })
  await act(async () => panel.dispatchEvent(event))
  await dom.click('[role="tab"][id$="-user-tab"]')
  return panel
}
it.each([{ reference: false, partial: false }, { reference: true, partial: false }, { reference: false, partial: true }])('original Inputs fills missing person/group metadata and reads the frozen native quote through public consumers (%j)', async ({ reference, partial }) => {
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue()
  const request = f.transport.request.getMockImplementation()!
  const native = (id: string, time: number, content: string) => ({ message_id: id, chat_id: 'original-room', msg_type: 'text', create_time: String(time),
    sender: { sender_type: 'user', id_type: 'open_id', id: 'original-external-user' }, body: { content: JSON.stringify({ text: content }) } })
  const messages = [native('metadata-message-ui-profile', 1, 'Earlier original request'),
    { ...native('quoted-middle', 2, reference ? 'Earlier retained context. '.repeat(1200) : 'The review has two outstanding items.'), ...(partial ? { deleted: true } : {}) },
    native('metadata-message-context', 3, 'Please review both items.')]
  f.transport.request.mockImplementation(async input => {
    const url = new URL(input.url!, 'https://native.example')
    if (url.pathname === '/open-apis/im/v1/messages') return { code: 0, data: { items: [...messages].reverse(), has_more: false } }
    if (url.pathname.startsWith('/open-apis/im/v1/messages/')) return { code: 0, data: { items: messages.filter(message => message.message_id === decodeURIComponent(url.pathname.split('/').at(-1)!)) } }
    return request(input)
  })
  await f.submit('context')
  let item: Extract<import('@agentmux/core/agent-input-mailbox').AgentInputMailboxItem, { kind: 'controlled' }> | undefined
  await vi.waitFor(async () => {
    const page = await f.sdk.call('agent.input.ls', { hostId: 'local', agentSessionId: 'original-agent', maxBytes: 128 * 1024 })
    item = page.items.flatMap(entry => entry.kind === 'item' && entry.item.kind === 'controlled' && entry.item.message?.sender.kind === 'external' &&
      entry.item.message.sender.externalMessageId === 'metadata-message-context' ? [entry.item] : [])[0]
    expect(item?.message?.channelQuote?.records).toHaveLength(2)
  })
  expect(item!.message!.channelQuote!.coverage).toBe(partial ? 'partial' : 'complete')
  expect(item!.message!.sender).toMatchObject({ authoritySource: { hostingRuntimeId: 'original-profile-runtime', executionRuntimeId: 'original-execution-runtime' } })
  expect(item!.intent.source).toMatchObject({ kind: 'message', representation: { quote: reference ? 'reference' : 'inline' } })
  f.source('Avery Chen · Platform Engineering', 'Release review · Platform Engineering')
  for (const subject of [actorSubject, groupSubject]) {
    const prior = await f.get(subject)
    await f.sdk.call('connection.metadata.clear', { connectionId: f.config.connectionId, expectedConnectionRevision: 1, subject, expectedCacheRevision: prior.entry.cacheRevision })
  }
  const session = originalSession('terminal')
  await dom.render(<SessionPane sessionId={session.id} surfaceKind="agent" interactiveResize={false} visible
    linkOrigin={{ workspaceId: 'workspace', tabGroupId: 'test-group', tabId: 'tab', regionId: 'original-region' }} />)
  expect(actorReads()).toHaveLength(0)
  const panel = await openInputs(), key = inputMailboxItemKey('local', item!)
  const row = () => [...panel.querySelectorAll<HTMLButtonElement>('.composer-mailbox__row')].find(node => node.dataset.recordKey === key)!
  await vi.waitFor(() => {
    expect(row()?.querySelector('strong')?.textContent).toBe('Avery Chen · Platform Engineering')
    expect(row()?.querySelector('img')?.getAttribute('src')).toBe('https://cdn.example/person.png')
    expect(row()?.querySelector('[data-input-channel]')?.textContent).toContain('Release review · Platform Engineering')
    expect(row()?.querySelector('[data-input-quote]')?.textContent).toBe('2 quoted messages' + (partial ? ' · history gaps' : '') + (reference ? ' · reference' : ''))
  })
  expect(calls.some(call => call.method === 'connection.metadata.refresh' && call.input.subject.kind === 'actor')).toBe(true)
  expect(calls.some(call => call.method === 'connection.metadata.refresh' && call.input.subject.kind === 'conversation')).toBe(true)
  const readsBefore = f.requests().length
  await act(async () => row().querySelector('img')!.dispatchEvent(new Event('error')))
  expect(row().querySelector('img')).toBeNull()
  await f.sdk.call('connection.metadata.refresh', { connectionId: f.config.connectionId, expectedConnectionRevision: 1, subject: actorSubject })
  await vi.waitFor(() => expect(row().querySelector('img')).not.toBeNull())
  expect(f.requests()).toHaveLength(readsBefore + 1)
  const actorCli = await f.cli(['get', '--input', '-'], { connectionId: f.config.connectionId, subject: actorSubject })
  const groupCli = await f.cli(['get', '--input', '-'], { connectionId: f.config.connectionId, subject: groupSubject })
  expect(actorCli.entry.observation.profile.name).toBe('Avery Chen · Platform Engineering')
  expect(groupCli.entry.observation.profile.name).toBe('Release review · Platform Engineering')
  const cli = await runCompiledObjectCli(['--endpoint', 'unix:' + f.server.path, 'message', 'read', '--message-id', item!.message!.messageId,
    '--host', 'local', '--field', 'channelQuote', '--max-bytes', '131072'], objectCliEnvironment(f.root))
  expect(cli.code, cli.stdout + cli.stderr).toBe(0)
  expect(JSON.parse(cli.stdout).result.field.entry.item).toEqual(item!.message!.channelQuote)
  const wire = item!.intent.source.kind === 'message' ? item!.intent.source.promptWire : undefined
  await act(async () => row().click())
  await dom.click('.conversation-input-details__toggle')
  expect(panel.querySelector('.conversation-input-details__body')?.textContent).toContain('Release review · Platform Engineering')
  expect(panel.querySelector('[data-input-quote]')?.textContent).toContain('2 quoted messages')
  await dom.click('[aria-label="Copy message"]')
  expect(copy).toHaveBeenLastCalledWith(wire)
  await dom.click('[aria-label="Back to Inputs"]')
  expect(row()).toBeDefined(); expect([terminals.mounted, terminals.disposed]).toEqual([1, 0])
  const after = await f.sdk.call('agent.input.ls', { hostId: 'local', agentSessionId: 'original-agent', maxBytes: 128 * 1024 })
  expect(after.items.flatMap(entry => entry.kind === 'item' && entry.item.kind === 'controlled' && entry.item.message?.messageId === item!.message!.messageId ? [entry.item.intent.source] : [])).toEqual([item!.intent.source])
  if (!reference && !partial) {
    const timeline = await f.client.sessionTimeline(session.id)
    await mkdir('.local/message-channel-identity', { recursive: true })
    await writeFile('.local/message-channel-identity/scene.json', JSON.stringify({ control: session.control, sourceHostId: timeline.sourceHostId,
      timeline, messages: projectSessionUserMessages({ agentSessionId: session.id, timeline }), mailbox: after,
      actor: await f.get(), group: await f.get(groupSubject), selectedKey: key, wire, terminal: { mounted: terminals.mounted, disposed: terminals.disposed } }, null, 2))
  }
}, 30_000)
it.each([false, true])('profile field observation reaches original Inputs Info with saved=%s', async saved => {
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue()
  const prior = await f.get(), native = f.transport.request.getMockImplementation()!
  f.transport.request.mockImplementation(async input => input.url?.includes('/contact/v3/users/')
    ? { code: 0, data: { user: { open_id: actorSubject.kind === 'actor' ? actorSubject.actor.userId : '' } } } : native(input))
  if (!saved) await f.sdk.call('connection.metadata.clear', { connectionId: f.config.connectionId, expectedConnectionRevision: 1, subject: actorSubject, expectedCacheRevision: prior.entry.cacheRevision })
  const observed = await f.sdk.call('connection.metadata.refresh', { connectionId: f.config.connectionId, expectedConnectionRevision: 1, subject: actorSubject })
  expect(observed.entry.observation).toMatchObject({ state: 'unavailable', freshness: saved ? 'stale' : 'unknown', profile: saved ? prior.entry.observation.profile : null })
  const page = await f.sdk.call('agent.input.ls', { hostId: 'local', agentSessionId: 'original-agent', maxBytes: 128 * 1024 })
  const items = page.items.flatMap(entry => entry.kind === 'item' && entry.item.kind === 'controlled' && entry.item.message?.sender.kind === 'external' ? [entry.item] : [])
  expect(items).toHaveLength(1)
  const item = items[0]!, key = inputMailboxItemKey('local', item)
  const session = originalSession('terminal')
  await dom.render(<SessionPane sessionId={session.id} surfaceKind="agent" interactiveResize={false} visible
    linkOrigin={{ workspaceId: 'workspace', tabGroupId: 'test-group', tabId: 'tab', regionId: 'original-region' }} />)
  const panel = await openInputs()
  const row = () => [...panel.querySelectorAll<HTMLButtonElement>('.composer-mailbox__row')].find(node => node.dataset.recordKey === key)!
  await vi.waitFor(() => expect(actorReads().length).toBeGreaterThan(0), { timeout: 5000 })
  await vi.waitFor(() => expect(metadataInFlight).toBe(0), { timeout: 5000 })
  await vi.waitFor(() => expect(row()?.querySelector('strong')?.textContent).toBe(saved ? 'Original native person' : 'original-external-user · open.feishu.cn'), { timeout: 5000 })
  expect(row().querySelector('img')?.getAttribute('src') ?? null).toBe(saved ? 'https://cdn.example/person.png' : null)
  await act(async () => row().click()); await dom.click('.conversation-input-details__toggle')
  const facts = panel.querySelector('.conversation-input-details__body')!
  expect(facts).not.toBeNull()
  const profile = [...facts.querySelectorAll('dt')].find(node => node.textContent === 'Current profile')?.nextElementSibling
  expect(profile?.textContent).toBe(saved ? 'Original native person · Saved · current read unconfirmed' : 'Name not observed · Not observed')
  expect(facts.textContent).toContain('original-external-user')
  const wire = item.intent.source.kind === 'message' ? item.intent.source.promptWire : undefined
  expect(wire).toEqual(expect.any(String))
  await dom.click('[aria-label="Copy message"]'); expect(copy).toHaveBeenLastCalledWith(wire)
  expect(f.inner.kernel.stop).not.toHaveBeenCalled(); expect([terminals.mounted, terminals.disposed]).toEqual([1, 0])
  const after = await f.sdk.call('agent.input.ls', { hostId: 'local', agentSessionId: 'original-agent', maxBytes: 128 * 1024 })
  expect(after.items.flatMap(entry => entry.kind === 'item' && entry.item.kind === 'controlled' && entry.item.message?.messageId === item.message!.messageId ? [entry.item.intent.source] : [])).toEqual([item.intent.source])
  const timeline = await f.client.sessionTimeline(session.id)
  await mkdir('.local/channel-profile-field-permissions', { recursive: true })
  await writeFile('.local/channel-profile-field-permissions/scene-' + (saved ? 'saved' : 'empty') + '.json', JSON.stringify({ control: session.control,
    sourceHostId: timeline.sourceHostId, timeline, messages: projectSessionUserMessages({ agentSessionId: session.id, timeline }), mailbox: page,
    actor: await f.get(), group: await f.get(groupSubject), selectedKey: key, wire }, null, 2))
}, 30_000)

it('native sender -> original profile cache -> public RPC -> registered IPC/preload -> mounted SessionPane original-record reader and exact renamed group', async () => {
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  let messages: AgentSessionUserMessage[] = []
  await vi.waitFor(async () => { messages = projectSessionUserMessages({ agentSessionId: 'original-agent', timeline: await f.client.sessionTimeline('original-agent') }); expect(messages.some(message => message.author.kind === 'external')).toBe(true) })
  await mkdir('.local/channel-protocol/T-005', { recursive: true })
  await writeFile('.local/channel-protocol/T-005/public-scene.json', JSON.stringify({ messages, connection: (await f.sdk.call('connection.inspect', { connectionId: f.config.connectionId })).connection, binding: (await f.sdk.call('connection.binding.ls', { executionHostId: 'local', agentSessionId: 'original-agent' })).bindings[0], actor: await f.get(), group: await f.get(groupSubject) }, null, 2))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const original = f.client.agentSession('original-agent')
  const session = { ...composerSession('original-agent', 'claude'), workspacePath: f.root, ...(original.nativeHandle ? { nativeHandle: original.nativeHandle } : {}), control: { kind: 'agent' as const, hostId: 'local', agentSessionId: 'original-agent', run: original.run } }
  useAppStore.setState({ loading: false, config: { ...composerConfig, executors: { claude: { ...composerConfig.executors.codex!, providerId: 'claude', command: 'claude' } }, workspaces: [{ ...composerConfig.workspaces[0]!, path: f.root }] }, sessions: [session], viewModes: { 'original-agent': 'activity' }, timelines: { 'original-agent': await f.client.sessionTimeline('original-agent') } })
  const reads: Array<{ method: string; input: unknown; result?: any; error?: string }> = []
  for (const method of ['readAgentConversation', 'readConversationChanges', 'observeConversation', 'releaseConversationView'] as const) {
    const originalRead = vi.mocked(api.conversation[method]).getMockImplementation()!
    vi.mocked(api.conversation[method]).mockImplementation(async (...args: any[]) => {
      try { const result = await (originalRead as any)(...args); if (method !== 'observeConversation') reads.push({ method, input: args[0], result }); return result }
      catch (error) { reads.push({ method, input: args[0], error: String(error) }); throw error }
    })
  }
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
  await vi.waitFor(() => { expect(metadataReady).toBe(true); expect(metadataInFlight).toBe(0) })
  const openedActorReads = calls.filter(call => call.method === 'connection.metadata.get' && call.input.subject.kind === 'actor').length
  expect(openedActorReads).toBeGreaterThan(0)
  f.source('Renamed person', 'Renamed original group')
  await f.sdk.call('connection.metadata.refresh', { connectionId: f.config.connectionId, expectedConnectionRevision: 1, subject: actorSubject })
  if (groupSubject.kind !== 'conversation') throw Error('The original native group subject is required')
  await f.transport.receive({ schema: '2.0', header: { event_id: 'ui-native-rename', event_type: 'im.chat.updated_v1', app_id: f.config.application.appId }, event: { chat_id: groupSubject.externalConversationId } })
  expect(f.transport.ack().at(-1)).toEqual({ code: 200 })
  await vi.waitFor(() => { expect(dom.container.querySelector('[data-speaker-role=external] .log-turn__sender')?.textContent).toBe('Renamed person'); expect(dom.container.querySelector('[data-group-name]')?.textContent).toBe('Renamed original group') })
  expect(calls.filter(call => call.method === 'connection.metadata.get' && call.input.subject.kind === 'actor')).toHaveLength(openedActorReads + 1)
  // A later display-read failure must keep the last observed name and the
  // authenticated original message, while making this read's uncertainty visible.
  vi.mocked(api.connections.call).mockImplementation(async (method: any, input: any, target) => {
    calls.push({ method, input })
    if (method === 'connection.metadata.get' && input.subject.kind === 'actor') throw Error('Local profile read unavailable')
    return bridge.api.connections.call(method, input, target)
  })
  f.source('New cache value while the display read is unavailable', 'Renamed original group')
  await f.sdk.call('connection.metadata.refresh', { connectionId: f.config.connectionId, expectedConnectionRevision: 1, subject: actorSubject })
  await vi.waitFor(() => expect(calls.filter(call => call.method === 'connection.metadata.get' && call.input.subject.kind === 'actor')).toHaveLength(openedActorReads + 2))
  const detail = dom.container.querySelector<HTMLButtonElement>('[data-speaker-role=external] button[aria-label="Message details"]')!
  await act(async () => detail.click())
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Saved · current read unconfirmed'))
  expect(dom.container.querySelector('[data-speaker-role=external] .log-turn__sender')?.textContent).toBe('Renamed person')
  expect(JSON.parse(originalRecord!.dataset.conversationAuthor!)).toEqual(external.author)
  await dom.render(frame(false))
  const hiddenReads = calls.filter(call => call.method === 'connection.metadata.get' && call.input.subject.kind === 'actor').length
  const previousChanges = metadataChanges
  await f.sdk.call('connection.metadata.refresh', { connectionId: f.config.connectionId, expectedConnectionRevision: 1, subject: actorSubject })
  await vi.waitFor(() => expect(metadataChanges).toBeGreaterThan(previousChanges))
  expect(calls.filter(call => call.method === 'connection.metadata.get' && call.input.subject.kind === 'actor')).toHaveLength(hiddenReads)
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})
it('the shared input row and its original detail use the same observed channel avatar and keep identity when images fail', async () => {
  let messages: AgentSessionUserMessage[] = []
  await vi.waitFor(async () => {
    messages = projectSessionUserMessages({ agentSessionId: 'original-agent', timeline: await f.client.sessionTimeline('original-agent') })
    expect(messages.some(message => message.author.kind === 'external')).toBe(true)
  })
  const page = await f.client.readAgentInputMailbox({ agentSessionId: 'original-agent' })
  const item = page.items.flatMap(entry => entry.kind === 'item' ? [entry.item] : [])
    .find(item => inputMailboxPresentation(item).speaker.role === 'external')
  expect(item, 'The original Core journal must contain the external input').toBeDefined()
  const refresh = vi.fn(async () => {}), loadEarlier = vi.fn(async () => {})
  const mailbox = { scope: page.queueId, items: [item!], failures: [], page, loading: false, error: null,
    refresh, loadEarlier, hasMore: false }
  function OriginalInput() {
    const profiles = useChannelActorProfiles(messages.flatMap(message => message.author.kind === 'external' ? [message.author] : []),
      { hostId: f.input.executionHostId, sourceHostId: messages.find(message => message.author.kind === 'external')!.sourceRecord!.record.hostId }, true)
    return <InputMailboxRecords mailbox={mailbox} hostId="local" compact reading={{
      describeSpeaker: createSpeakerResolver({ lookupExternal: author => profiles.get(channelProfileKey(author)) })
    }} />
  }
  await dom.render(<OriginalInput />)
  const row = dom.container.querySelector<HTMLButtonElement>('.composer-mailbox__row')!
  expect(row).not.toBeNull()
  await vi.waitFor(() => expect(row.querySelector('img')?.getAttribute('src')).toBe('https://cdn.example/person.png'))
  expect(row.querySelector('img')?.getAttribute('width')).toBe('18')
  await act(async () => row.click())
  const turn = dom.container.querySelector<HTMLElement>('[data-speaker-role="external"]')!
  expect(turn).not.toBeNull()
  expect(turn.querySelector('.log-turn__node img')?.getAttribute('src')).toBe(row.querySelector('img')!.getAttribute('src'))
  expect(turn.querySelector('.log-turn__node img')?.getAttribute('width')).toBe('20')
  await act(async () => row.querySelector('img')!.dispatchEvent(new Event('error')))
  expect(row.querySelector('img')).toBeNull()
  expect(row.querySelector('strong')?.textContent).toBe('Original native person')
  expect(turn.querySelector('.log-turn__node img')).not.toBeNull()
  await act(async () => turn.querySelector('.log-turn__node img')!.dispatchEvent(new Event('error')))
  expect(turn.querySelector('.log-turn__node img')).toBeNull()
  expect(turn.querySelector('.log-turn__sender')?.textContent).toBe('Original native person')
  expect(refresh).not.toHaveBeenCalled(); expect(loadEarlier).not.toHaveBeenCalled()
  expect(calls.some(call => call.method === 'connection.metadata.refresh')).toBe(false)
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('Terminal Mailbox reads its visible original authors and the Desktop history row and detail share the saved avatar without opening Activity', async () => {
  const original = (await originalMessages()).find(message => message.author.kind === 'external')!
  const originalCaptured = (await f.client.sessionTimeline('original-agent')).items.find(item => item.id === original.rawId)!
  const authorExternal = originalCaptured.authorExternal
  expect(authorExternal, 'The actual original captured record retains its external author').toBeDefined()
  if (!authorExternal) throw Error('The original captured external author is required')
  const record: AgentTimelineItem = { id: 'original-external-history', agentSessionId: 'original-agent', kind: 'user_message',
    source: 'user', title: 'Original external history', status: 'complete', publicContent: 'confirmed',
    content: 'Original recorded external history\nEvery original line is retained.', authorExternal,
    createdAt: original.recordedAt! + 1, updatedAt: original.recordedAt! + 1 }
  await publishOriginal(record)
  const session = originalSession('terminal')
  const originalMailbox = await f.sdk.call('agent.input.ls', { hostId: session.control.hostId, agentSessionId: session.id, limit: 25, maxBytes: 128 * 1024 })
  expect(originalMailbox.hostId).toBe(session.control.hostId)
  expect(originalMailbox.budgetBytes).toBe(128 * 1024)
  const originalInputs = originalMailbox.items.flatMap(entry => entry.kind === 'item' ? [entry.item] : [])
  expect(originalInputs.length).toBe(originalMailbox.items.length)
  const sourceHostId = original.sourceRecord?.record.hostId
  expect(sourceHostId, 'The original record supplies its source Host independently of the SDK route').toBeDefined()
  if (!sourceHostId) throw Error('The original external source Host is required')
  const groups = projectSessionInputs({ hostId: session.control.hostId, sourceHostId,
    agentSessionId: session.id, messages: await originalMessages(), mailbox: originalInputs })
  const journal = projectMailboxInputs({ hostId: session.control.hostId, sourceHostId,
    groups, queued: [] }).journalRows.find(row => row.group.messages.some(message => message.rawId === original.rawId))
  expect(journal, 'The original external input has its actual journal group').toBeDefined()
  expect(journal!.group.author).toEqual(original.author)
  expect(journal!.key).toBe(inputMailboxItemKey(session.control.hostId, journal!.item))
  const frame = (visible: boolean) => <SessionPane sessionId={session.id} surfaceKind="agent" interactiveResize={false} visible={visible}
    linkOrigin={{ workspaceId: 'workspace', tabGroupId: 'test-group', tabId: 'tab', regionId: 'original-region' }} />
  await dom.render(frame(true))
  expect(useAppStore.getState().viewModes[session.id]).toBe('terminal')
  expect(dom.container.querySelector('[data-terminal-witness]')?.getAttribute('data-visible')).toBe('true')
  expect([terminals.mounted, terminals.disposed]).toEqual([1, 0])
  expect(inspectConversationConsumers(session.control).consumers).toHaveLength(0)
  expect(actorReads()).toHaveLength(0)
  const panel = await openInputs()
  await vi.waitFor(() => {
    const journalRow = [...panel.querySelectorAll<HTMLButtonElement>('.composer-mailbox__row')].find(node => node.dataset.recordKey === journal!.key)
    expect(journalRow, 'The real Mailbox must accept the journal page, not only its captured history').toBeDefined()
    expect(journalRow!.querySelector('strong')?.textContent).toBe('Original native person')
    expect(journalRow!.querySelector('img')?.getAttribute('src')).toBe('https://cdn.example/person.png')
    expect(journalRow!.querySelector('img')?.getAttribute('width')).toBe('18')
  })
  let row: HTMLButtonElement | null = null
  await vi.waitFor(() => {
    row = panel.querySelector<HTMLButtonElement>(`.composer-mailbox__row[data-record-key="timeline:${record.id}"]`)
    expect(row, 'The real Desktop MessageHistory branch must contain this unjournaled original').not.toBeNull()
    expect(row!.querySelector('strong')?.textContent).toBe('Original native person')
    expect(row!.querySelector('img')?.getAttribute('src')).toBe('https://cdn.example/person.png')
  })
  expect(row!.querySelector('img')!.getAttribute('width')).toBe('18')
  await act(async () => row!.click())
  const detail = panel.querySelector<HTMLElement>('.composer-mailbox__detail .log-turn')!
  expect(detail, 'The ordinary row selection opens its original Desktop detail').not.toBeNull()
  expect(detail.querySelector('.log-turn__body')?.textContent).toBe(record.content)
  expect(detail.querySelector('.log-turn__node img')?.getAttribute('src')).toBe('https://cdn.example/person.png')
  expect(detail.querySelector('.log-turn__node img')?.getAttribute('width')).toBe('20')
  expect(JSON.parse(detail.dataset.conversationItemRef!)).toEqual({ hostId: 'local', agentSessionId: session.id,
    source: { kind: 'captured', recordId: record.id } })
  const text = detail.querySelector('p')!.firstChild!, range = document.createRange()
  range.setStart(text, 0); range.setEnd(text, 8); window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range)
  await act(async () => detail.querySelector('.log-turn__node img')!.dispatchEvent(new Event('error')))
  expect(detail.querySelector('.log-turn__node img')).toBeNull()
  expect(detail.querySelector('.log-turn__sender')?.textContent).toBe('Original native person')
  expect(window.getSelection()!.toString()).toBe('Original')
  expect(useAppStore.getState().viewModes[session.id]).toBe('terminal')
  expect(inspectConversationConsumers(session.control).consumers).toHaveLength(0)
  const persisted = (await f.client.sessionTimeline(session.id)).items.find(item => item.id === record.id)!
  expect(persisted.authorExternal).toEqual(originalCaptured.authorExternal); expect(persisted.content).toBe(record.content)
  await dom.render(frame(false))
  const hidden = actorReads().length, changed = metadataChanges
  await f.sdk.call('connection.metadata.refresh', { connectionId: f.config.connectionId, expectedConnectionRevision: 1, subject: actorSubject })
  await vi.waitFor(() => expect(metadataChanges).toBeGreaterThan(changed))
  expect(actorReads()).toHaveLength(hidden)
  expect([terminals.mounted, terminals.disposed]).toEqual([1, 0])
  expect(f.inner.kernel.input).toHaveBeenCalledOnce(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  window.getSelection()!.removeAllRanges()
  // The private native visual harness reuses these actual bounded read results;
  // this DTO is not a new reader and is not its test/visual acceptance receipt.
  const timeline = await f.client.sessionTimeline(session.id)
  await mkdir('.local/channel-protocol/T-005', { recursive: true })
  await writeFile('.local/channel-protocol/T-005/public-mailbox-scene.json', JSON.stringify({
    control: session.control, sourceHostId: timeline.sourceHostId, timeline,
    messages: projectSessionUserMessages({ agentSessionId: session.id, timeline }),
    mailbox: await f.sdk.call('agent.input.ls', { hostId: session.control.hostId, agentSessionId: session.id, limit: 25, maxBytes: 128 * 1024 }),
    actor: await f.get(), selectedRecordId: record.id
  }, null, 2))
})

it('Activity demands channel profiles only when Earlier admits the original actor beyond the first input summary window', async () => {
  const external = (await originalMessages()).find(message => message.author.kind === 'external')!
  for (let index = 0; index < 350; index++) await publishOriginal({ id: `later-original-step-${index}`, agentSessionId: 'original-agent',
    kind: 'lifecycle', source: 'native-hook', status: 'complete', title: 'Later original step', content: `Later original step ${index}`,
    createdAt: external.recordedAt! + index + 1, updatedAt: external.recordedAt! + index + 1 })
  const firstSummary = await f.sdk.call('agent.conversation.inspect', { hostId: 'local', agentSessionId: 'original-agent', limit: 100 })
  expect(firstSummary.items.length).toBeGreaterThan(0)
  expect(firstSummary.items.flatMap(entry => entry.kind === 'item' ? entry.item.records : []).some(record => record.original.item.id === external.rawId)).toBe(false)
  const session = originalSession('activity')
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  await dom.render(<SessionPane sessionId={session.id} surfaceKind="agent" interactiveResize={false} visible
    linkOrigin={{ workspaceId: 'workspace', tabGroupId: 'test-group', tabId: 'tab', regionId: 'original-region' }} />)
  await vi.waitFor(() => {
    const consumers = inspectConversationConsumers(session.control).consumers
    expect(consumers).toHaveLength(1)
    expect(consumers[0]!.accepted?.recordCount).toBeGreaterThan(0)
    expect(consumers[0]!.loading || consumers[0]!.inFlight || consumers[0]!.watch.binding).toBe(false)
    expect(submittedRecord(external.rawId)).toBeNull()
  })
  expect(actorReads()).toHaveLength(0)
  // Unknown native timestamps legitimately stop automatic time coverage. Follow
  // the ordinary bounded Earlier pages rather than assuming three auto pages ran.
  for (let page = 0; page < 4 && !submittedRecord(external.rawId); page++) {
    const prior = inspectConversationConsumers(session.control).consumers[0]!.accepted!
    let earlier: HTMLButtonElement | undefined
    await vi.waitFor(() => {
      earlier = [...dom.container.querySelectorAll<HTMLButtonElement>('.activity-feed__reading-entry button')].find(button => button.textContent === 'Earlier')
      expect(earlier, 'The original reader exposes its ordinary Earlier control').toBeDefined()
      expect(earlier!.disabled).toBe(false)
    })
    await act(async () => earlier!.click())
    await vi.waitFor(() => {
      const current = inspectConversationConsumers(session.control).consumers[0]!
      expect(current.loading || current.inFlight || current.watch.binding).toBe(false)
      expect([current.accepted?.id, current.accepted?.revision]).not.toEqual([prior.id, prior.revision])
    })
  }
  let originalRecord: HTMLElement | null = null
  await vi.waitFor(() => {
    originalRecord = submittedRecord(external.rawId)
    expect(originalRecord).not.toBeNull()
    expect(JSON.parse(originalRecord!.dataset.conversationAuthor!)).toEqual(external.author)
  })
  await act(async () => originalRecord!.querySelector('summary')!.click())
  await vi.waitFor(() => {
    expect(originalRecord!.querySelector('.log-turn__sender')?.textContent).toBe('Original native person')
    expect(originalRecord!.querySelector('.log-turn__node img')?.getAttribute('src')).toBe('https://cdn.example/person.png')
  })
  expect(actorReads().length).toBeGreaterThan(0)
  expect(actorReads().every(read => read.input.connectionId === f.config.connectionId && JSON.stringify(read.input.subject) === JSON.stringify(actorSubject))).toBe(true)
  expect(f.inner.kernel.input).toHaveBeenCalledOnce(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('an enabled hidden Activity preparation does not read profiles and a foreign route with literal local source cannot borrow local names', async () => {
  const external = (await originalMessages()).find(message => message.author.kind === 'external')!
  if (external.author.kind !== 'external') throw Error('The original external author is required')
  const author = external.author
  const session = originalSession('terminal')
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  const frame = (hostId: string, shown: boolean) => {
    const props = activityReadingProps({ control: { ...session.control, hostId } })
    return <ActivityView {...props} conversationReading={{ ...props.conversationReading!, enabled: true,
      consumer: { visible: true, activityShown: shown, viewMode: shown ? 'activity' : 'terminal', runId: session.control.run.runId } }} />
  }
  await dom.render(frame('local', false))
  await vi.waitFor(() => {
    const consumer = inspectConversationConsumers(session.control).consumers[0]
    expect(consumer?.accepted?.recordCount).toBeGreaterThan(0)
    expect(consumer?.loading || consumer?.inFlight || consumer?.watch.binding).toBe(false)
    expect(consumer?.gates.activityShown).toBe(false)
  })
  expect(actorReads()).toHaveLength(0)
  await dom.render(frame('local', true))
  const original = submittedRecord(external.rawId)!
  expect(original).not.toBeNull()
  await act(async () => original.querySelector('summary')!.click())
  await vi.waitFor(() => {
    expect(original.querySelector('.log-turn__sender')?.textContent).toBe('Original native person')
    expect(metadataReady).toBe(true); expect(metadataInFlight).toBe(0)
  })
  const localReads = actorReads().length
  expect(localReads).toBeGreaterThan(0)
  await dom.render(frame('other-host', true))
  let foreign: HTMLElement | null = null
  await vi.waitFor(() => {
    const consumer = inspectConversationConsumers({ hostId: 'other-host', agentSessionId: session.id }).consumers[0]
    expect(consumer?.reference.hostId).toBe('other-host')
    expect(consumer?.accepted?.sourceHostId).toBe('local')
    expect(consumer?.loading || consumer?.inFlight || consumer?.watch.binding).toBe(false)
    foreign = submittedRecord(external.rawId)
    expect(foreign).not.toBeNull()
  })
  const disclosure = foreign!.querySelector<HTMLDetailsElement>('details')!
  if (!disclosure.open) await act(async () => disclosure.querySelector('summary')!.click())
  expect(foreign!.querySelector('.log-turn__sender')?.textContent).toBe(`${author.actor.userId} · ${author.actor.application.domain}`)
  expect(foreign!.querySelector('.log-turn__node img')).toBeNull()
  await act(async () => foreign!.querySelector<HTMLButtonElement>('button[aria-label="Message details"]')!.click())
  expect(foreign!.textContent).toContain('Profile metadata is unavailable for this Host or source')
  expect(JSON.parse(foreign!.dataset.conversationAuthor!)).toEqual(external.author)
  // The foreign reader releases its local watch. Keep an independent original
  // local subscriber to witness the real notification without demanding profiles.
  let controlReady = false, controlChanges = 0
  cleanup.push(api.connections.onMetadataChanged(() => { controlChanges++ },
    state => { controlReady = state === 'ready' }, await api.connections.hostingTarget()))
  await vi.waitFor(() => expect(controlReady).toBe(true))
  const changed = metadataChanges
  f.source('A local cache value for the same literal actor', 'Original native group')
  await f.sdk.call('connection.metadata.refresh', { connectionId: f.config.connectionId, expectedConnectionRevision: 1, subject: actorSubject })
  await vi.waitFor(() => expect(metadataChanges).toBeGreaterThan(changed))
  await vi.waitFor(() => expect(controlChanges).toBeGreaterThan(0))
  expect(actorReads()).toHaveLength(localReads)
  expect(foreign!.querySelector('.log-turn__sender')?.textContent).toBe(`${author.actor.userId} · ${author.actor.application.domain}`)
  expect(f.inner.kernel.input).toHaveBeenCalledOnce(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('a same-scope author-set change keeps represented saved profiles on read failure and prunes authors that leave the reading', async () => {
  const original = (await originalMessages()).find(message => message.author.kind === 'external')!
  if (original.author.kind !== 'external') throw Error('The original external author is required')
  const author = original.author, second = { ...author, actor: { ...author.actor, userId: 'second-original-person' } }
  const owner = { hostId: f.input.executionHostId, sourceHostId: original.sourceRecord!.record.hostId }
  const reads: Array<ReadonlyMap<string, { observation?: unknown; issue?: string }>> = []
  function Profiles({ authors }: { authors: readonly typeof author[] }) {
    const profiles = useChannelActorProfiles(authors, owner, true)
    reads.push(profiles)
    return <output>{profiles.get(channelProfileKey(author))?.observation?.profile?.name ?? author.actor.userId}
      {' | '}{profiles.get(channelProfileKey(author))?.issue ?? ''}</output>
  }
  await dom.render(<Profiles authors={[author]} />)
  await vi.waitFor(() => { expect(dom.container.textContent).toBe('Original native person | '); expect(metadataReady).toBe(true); expect(metadataInFlight).toBe(0) })
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const call = vi.mocked(api.connections.call).getMockImplementation()!
  vi.mocked(api.connections.call).mockImplementation(async (method: any, input: any, target) => {
    if (method === 'connection.metadata.get' && input.subject.kind === 'actor') {
      calls.push({ method, input }); await held; throw Error('This exact display read is unavailable')
    }
    return call(method, input, target)
  })
  const before = reads.length
  try {
    await dom.render(<Profiles authors={[author, second]} />)
    expect(dom.container.textContent).toBe('Original native person | ')
    expect(reads.slice(before).length).toBeGreaterThan(0)
    expect(reads.slice(before).every(profiles => profiles.get(channelProfileKey(author))?.observation !== undefined)).toBe(true)
  } finally { await act(async () => release()) }
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Original native person | This exact display read is unavailable'))
  await dom.render(<Profiles authors={[second]} />)
  expect(reads.at(-1)!.has(channelProfileKey(author))).toBe(false)
  expect(f.inner.kernel.input).toHaveBeenCalledOnce(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('late local profile results cannot cross source Host, route Host, visibility or connection identity', async () => {
  const original = (await originalMessages()).find(message => message.author.kind === 'external')!
  if (original.author.kind !== 'external') throw Error('The original external author is required')
  const author = original.author, second = { ...author, connectionId: 'different-original-connection' }
  const local = { hostId: f.input.executionHostId, sourceHostId: original.sourceRecord!.record.hostId }
  let release!: () => void, entered = 0
  const held = new Promise<void>(resolve => { release = resolve })
  const call = vi.mocked(api.connections.call).getMockImplementation()!
  vi.mocked(api.connections.call).mockImplementation(async (method: any, input: any, target) => {
    if (method === 'connection.metadata.get' && input.subject.kind === 'actor') { entered++; await held }
    return call(method, input, target)
  })
  function Sender({ owner, visible = true, current = author }: { owner: typeof local; visible?: boolean; current?: typeof author }) {
    const profiles = useChannelActorProfiles([current], owner, visible)
    return <ConversationMessage messageId={original.id} content={original.content} speaker={speakerOfUserMessage({ author: current })}
      inputSource={original.source} recordedIdentity describeSpeaker={createSpeakerResolver({ lookupExternal: value => profiles.get(channelProfileKey(value)) })} />
  }
  try {
    await dom.render(<Sender owner={local} />)
    await vi.waitFor(() => expect(entered).toBeGreaterThan(0))
    await dom.render(<Sender owner={{ ...local, sourceHostId: 'another-source-host' }} />)
    const sourceReads = entered
    await act(async () => release())
    await vi.waitFor(() => expect(metadataInFlight).toBe(0))
    expect(dom.container.querySelector('.log-turn__sender')?.textContent).toBe(`${author.actor.userId} · ${author.actor.application.domain}`)
    expect(dom.container.querySelector('.log-turn__node img')).toBeNull(); expect(entered).toBe(sourceReads)
    await dom.render(<Sender owner={{ ...local, hostId: 'other-host' }} />)
    expect(dom.container.querySelector('.log-turn__node img')).toBeNull(); expect(entered).toBe(sourceReads)
    await dom.render(<Sender owner={local} visible={false} />)
    expect(entered).toBe(sourceReads)
    await dom.render(<Sender owner={local} current={second} />)
    await vi.waitFor(() => expect(entered).toBeGreaterThan(sourceReads))
    await vi.waitFor(() => expect(metadataInFlight).toBe(0))
    expect(dom.container.querySelector('.log-turn__sender')?.textContent).toBe(`${author.actor.userId} · ${author.actor.application.domain}`)
    expect(dom.container.querySelector('.log-turn__node img')).toBeNull()
    expect(actorReads().at(-1)!.input.connectionId).toBe(second.connectionId)
    expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  } finally { release() }
})

it('released profile watch callbacks cannot start hidden reads or overwrite the current scope', async () => {
  const original = (await originalMessages()).find(message => message.author.kind === 'external')!
  if (original.author.kind !== 'external') throw Error('The original external author is required')
  const author = original.author, owner = { hostId: f.input.executionHostId, sourceHostId: original.sourceRecord!.record.hostId }
  const observers: Array<Parameters<typeof api.connections.onMetadataChanged>> = []
  const subscribe = vi.mocked(api.connections.onMetadataChanged).getMockImplementation()!
  vi.mocked(api.connections.onMetadataChanged).mockImplementation((...args) => { observers.push(args); return subscribe(...args) })
  function Profile({ visible }: { visible: boolean }) {
    const profiles = useChannelActorProfiles([author], owner, visible), profile = profiles.get(channelProfileKey(author))
    return <output>{profile?.observation?.profile?.name ?? author.actor.userId}{' | '}{profile?.issue ?? ''}</output>
  }
  await dom.render(<Profile visible />)
  await vi.waitFor(() => { expect(dom.container.textContent).toBe('Original native person | '); expect(metadataReady).toBe(true); expect(metadataInFlight).toBe(0) })
  expect(observers).toHaveLength(1)
  const previous = observers[0]!
  await dom.render(<Profile visible={false} />)
  const hiddenReads = actorReads().length
  await act(async () => {
    previous[0]({ connectionId: author.connectionId, application: author.actor.application, subject: { kind: 'actor', actor: author.actor } })
    previous[1]!('unavailable')
  })
  expect(actorReads()).toHaveLength(hiddenReads)
  expect(dom.container.textContent).toBe('Original native person | ')
  await dom.render(<Profile visible />)
  await vi.waitFor(() => { expect(observers).toHaveLength(2); expect(metadataInFlight).toBe(0) })
  await act(async () => previous[1]!('unavailable'))
  expect(dom.container.textContent).toBe('Original native person | ')
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('mounted cache management refreshes and clears exact metadata through IPC while preserving original records and bindings', async () => {
  vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  const connection = (await f.sdk.call('connection.inspect', { connectionId: f.config.connectionId })).connection!
  await dom.render(<ChannelMetadataPanel connection={connection} active />)
  const details = dom.container.querySelector('details')!
  await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')) })
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Original native person'))
  await copyConnectorIdentity(dom.container, 'Copy person name', 'Original native person')
  await copyConnectorIdentity(dom.container, 'Copy open_id', 'original-external-user')
  const avatar = dom.container.querySelector<HTMLImageElement>('[data-entity-kind="person"] img')!
  expect(avatar?.getAttribute('src')).toBe('https://cdn.example/person.png')
  await act(async () => avatar.dispatchEvent(new Event('error')))
  expect(dom.container.querySelector('[data-entity-kind="person"] img')).toBeNull()
  expect(dom.container.querySelector('.connector-entity__name')?.textContent).toBe('Original native person')
  f.source('Updated via real UI', 'Original native group')
  await click('Refresh')
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Updated via real UI'))
  let before = await f.client.sessionTimeline('original-agent')
  await vi.waitFor(async () => { before = await f.client.sessionTimeline('original-agent'); expect(before.items.some(item => !!item.authorExternal)).toBe(true) })
  await click('Clear saved profile')
  await vi.waitFor(() => expect(dom.container.textContent).toContain('No saved profile'))
  expect(dom.container.querySelector('[aria-label="Copy person name"]')).toBeNull()
  await copyConnectorIdentity(dom.container, 'Copy open_id', 'original-external-user')
  expect((await f.get()).entry.observation.profile).toBeNull()
  const originalInputs = (timeline: typeof before) => timeline.items.filter(item => item.authorExternal).map(({ id, content, authorExternal }) => ({ id, content, authorExternal }))
  expect(originalInputs(await f.client.sessionTimeline('original-agent'))).toEqual(originalInputs(before))
  expect((await f.sdk.call('connection.binding.ls', { executionHostId: 'local', agentSessionId: 'original-agent' })).bindings).toHaveLength(1)
  const clear = calls.find(call => call.method === 'connection.metadata.clear')!
  expect(clear.input).toMatchObject({ subject: actorSubject, expectedConnectionRevision: 1, expectedCacheRevision: expect.any(String) })
})

it('the actual saved-profile panel cannot show a late person card after switching the original connection subject', async () => {
  const original = (await f.sdk.call('connection.inspect', { connectionId: f.config.connectionId })).connection!
  await f.sdk.call('connection.configure', { operationId: 'separate-profile-subject', expectedRevision: null,
    connection: { ...f.config, connectionId: 'different-profile-subject', application: { ...f.config.application, appId: 'different-profile-application' }, enabled: false } })
  const other = (await f.sdk.call('connection.inspect', { connectionId: 'different-profile-subject' })).connection!
  const call = vi.mocked(api.connections.call).getMockImplementation()!
  let release!: () => void, held = false
  const barrier = new Promise<void>(resolve => { release = resolve })
  vi.mocked(api.connections.call).mockImplementation(async (...args) => {
    const result = await call(...args)
    if (args[0] === 'connection.metadata.ls' && args[1].connectionId === original.config.connectionId) { held = true; await barrier }
    return result
  })
  try {
    await dom.render(<ChannelMetadataPanel connection={original} active />)
    await act(async () => dom.container.querySelector<HTMLElement>('summary')!.click())
    await vi.waitFor(() => expect(held).toBe(true))
    await dom.render(<ChannelMetadataPanel connection={other} active />)
    await vi.waitFor(() => expect(dom.container.textContent).toContain('No saved people profiles yet.'))
    await act(async () => release())
    await vi.waitFor(() => expect(metadataInFlight).toBe(0))
    expect(dom.container.querySelector('[data-entity-kind="person"]')).toBeNull()
    expect(dom.container.textContent).not.toContain('original-external-user')
    expect(dom.container.textContent).not.toContain('Original native person')
    expect(calls.filter(item => item.method === 'connection.metadata.ls').at(-1)!.input.connectionId).toBe(other.config.connectionId)
    expect((await f.get()).entry.observation.profile?.name).toBe('Original native person')
    expect((await f.sdk.call('connection.binding.ls', { executionHostId: 'local', agentSessionId: 'original-agent' })).bindings).toHaveLength(1)
  } finally { release() }
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
    const profiles = useChannelActorProfiles(messages.flatMap(message => message.author.kind === 'external' ? [message.author] : []),
      { hostId: f.input.executionHostId, sourceHostId: original.sourceRecord!.record.hostId }, true)
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

it('confirmed profile route survives a later observation failure while exact Runtime changes retain no foreign profiles', async () => {
  const original = (await originalMessages()).find(message => message.author.kind === 'external')!
  if (original.author.kind !== 'external' || !original.author.authoritySource) throw Error('Original native authority source is required')
  const author = original.author, owner = { hostId: 'local', sourceHostId: 'local' }
  const watched = vi.mocked(api.connections.onMetadataChanged)
  function Person({ visible = true, current = author }: { visible?: boolean; current?: typeof author }) {
    const profiles = useChannelActorProfiles([current, current], undefined, visible), person = profiles.get(channelProfileKey(current))
    return <output>{person?.observation?.profile?.name ?? 'No saved profile'} | {person?.issue}</output>
  }
  await dom.render(<Person />)
  await vi.waitFor(() => expect(dom.container.textContent).toBe('Original native person | '))
  expect(api.connections.hostingTarget).toHaveBeenCalledWith({ runtimeId: author.authoritySource.hostingRuntimeId })
  expect(watched.mock.calls.filter(args => args[2]?.runtimeId === author.authoritySource!.hostingRuntimeId)).toHaveLength(1)
  await dom.render(<Person visible={false} />)
  vi.mocked(api.connections.hostingTarget).mockRejectedValue(Error('Original route observation unavailable'))
  await dom.render(<Person />)
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Original native person | Original route observation unavailable'))
  const before = calls.length
  await dom.render(<Person current={{ ...author, authoritySource: { ...author.authoritySource, hostingRuntimeId: 'different-original-runtime' } }} />)
  await vi.waitFor(() => expect(dom.container.textContent).toContain('No saved profile | Original route observation unavailable'))
  expect(calls).toHaveLength(before)
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('a second native Gateway adapter supplies the same original Inputs person, conversation and quote reading through the shared owner', async () => {
  const { createRequire } = await import('node:module')
  const nativeFetch = createRequire(process.cwd() + '/packages/connectors/node_modules/@discordjs/rest/package.json')('undici').fetch
  const wire = await discordTransport(nativeFetch); cleanup.push(wire.close)
  vi.spyOn(DefaultRestOptions, 'makeRequest').mockImplementation(wire.http.makeRequest)
  const credential = await f.services.secrets.store({ operationId: 'second-native-secret', secret: 'fixture-bot-token' })
  await f.sdk.call('connection.configure', { operationId: 'second-native-configure', expectedRevision: null, connection: { ...discordConfig, credentialRef: credential.credentialRef } })
  expect((await f.sdk.call('connection.test', { connectionId: discordConfig.connectionId })).observation.authentication.state).toBe('ready')
  await f.sdk.call('connection.bind', { ...f.input, operationId: 'second-native-bind', bindingId: 'second-native-binding', connectionId: discordConfig.connectionId, externalConversationId: '300' })
  await f.sdk.call('connection.grant', { ...f.grant, operationId: 'second-native-grant', bindingId: 'second-native-binding', grantId: 'second-native-grant', actor: { application: discordConfig.application, idType: 'snowflake', userId: '400' } })
  await vi.waitFor(() => expect(wire.sessions.length).toBeGreaterThan(0))
  wire.message('700', 'Original second native adapter request')
  let original: import('@agentmux/core/agent-input-mailbox').AgentInputMailboxItem | undefined
  await vi.waitFor(async () => {
    const page = await f.sdk.call('agent.input.ls', { hostId: 'local', agentSessionId: 'original-agent' })
    original = page.items.flatMap(entry => entry.kind === 'item' && entry.item.kind === 'controlled' && entry.item.message?.sender.kind === 'external' && entry.item.message.sender.actor.application.domain === 'discord.com' ? [entry.item] : [])[0]
    expect(original).toBeDefined()
  })
  const session = originalSession('terminal')
  await dom.render(<SessionPane sessionId={session.id} surfaceKind="agent" interactiveResize={false} visible linkOrigin={{ workspaceId: 'workspace', tabGroupId: 'test-group', tabId: 'tab', regionId: 'original-region' }} />)
  const panel = await openInputs(), key = inputMailboxItemKey('local', original!)
  const row = () => [...panel.querySelectorAll<HTMLButtonElement>('.composer-mailbox__row')].find(node => node.dataset.recordKey === key)!
  await vi.waitFor(() => {
    expect(row()?.querySelector('strong')?.textContent).toBe('Original person')
    expect(row()?.querySelector('img')?.getAttribute('src')).toContain('/avatars/400/native_avatar.png')
    expect(row()?.querySelector('[data-input-channel]')?.textContent).toContain('Original channel')
    expect(row()?.querySelector('[data-input-quote]')?.textContent).toBe('0 quoted messages')
  })
  expect(original?.kind === 'controlled' && original.message?.channelQuote).toMatchObject({ coverage: 'complete', records: [] })
  expect(api.connections.onMetadataChanged).toHaveBeenCalledOnce()
  const exactReads = calls.filter(call => call.method === 'connection.metadata.get' && call.input.connectionId === discordConfig.connectionId)
  expect(exactReads.filter(call => call.input.subject.kind === 'actor')).toHaveLength(1)
  // A guild channel has no avatar; the exact visible refresh may notify one
  // further cache read, under the same shared subscription.
  expect(exactReads.filter(call => call.input.subject.kind === 'conversation').length).toBeGreaterThanOrEqual(1)
  expect(exactReads.filter(call => call.input.subject.kind === 'conversation').length).toBeLessThanOrEqual(2)
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 30_000)
