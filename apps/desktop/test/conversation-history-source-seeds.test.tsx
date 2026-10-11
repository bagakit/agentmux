// @vitest-environment happy-dom
import { fixtureEpoch } from '../../../test/fixture-values.mjs'
import '../../mobile/test/device-locks'
import { act, createRef } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import type { AgentTimelineItem } from '@agentmux/core'
import type { ComposerInsertionHandle } from '@agentmux/client-ui/composer-insertion'
import { consumeConversationWindowPage, projectConversationWindow } from '@agentmux/core/conversation'
import { nativeHistoryFixture, jsonl } from '../../../packages/core/test/fixtures/native-history-session'
import { AgentMuxHostedRuntimeService } from '../../../packages/core/src/hosted-runtime-service'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client'
import { connectHostedAgentMux } from '../../../packages/core/src/hosted-client'
import { MobileConversationSurface } from '../../mobile/src/conversation/MobileConversationSurface'
import { createBrowserPlatform } from '../../mobile/src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../../mobile/src/recovery/device-workface'
import { desktopConversationReadBridge } from './helpers/conversation-read-bridge'
import { createClientUiRoot } from './helpers/client-ui-render'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { useComposerInputHistory } from '../src/renderer/src/lib/use-composer-input-history'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'

const closes: Array<() => unknown | Promise<unknown>> = []
let originalStore: ReturnType<typeof useAppStore.getState>
const prose = 'One request and its two original source records.'
const wait = (check: () => void) => vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) }); check() }, { timeout: 6000, interval: 20 })
beforeEach(async () => {
  originalStore = useAppStore.getState()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  Element.prototype.scrollIntoView = vi.fn()
  localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface())
})
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close()
  useAppStore.setState(originalStore, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
function mount() {
  const host = document.createElement('div'); document.body.append(host)
  const root = createClientUiRoot(host)
  closes.push(async () => { await act(async () => root.unmount()); host.remove() })
  return { host, root }
}
async function seed() {
  const f = await nativeHistoryFixture('claude', jsonl([{ type: 'user', uuid: 'original-native', sessionId: 'native-main',
    message: { role: 'user', content: prose } }]))
  closes.push(f.close)
  const item: AgentTimelineItem = { id: 'original-captured', agentSessionId: f.session.agentSessionId,
    kind: 'user_message', source: 'user', status: 'complete', title: 'Original input', content: prose,
    authorHuman: true, publicContent: 'confirmed', createdAt: fixtureEpoch(0, 0, 1), updatedAt: fixtureEpoch(0, 0, 1),
    conversation: { sameEvent: { hostId: 'local', agentSessionId: f.session.agentSessionId,
      source: { kind: 'native', providerId: 'claude', nativeSessionId: 'native-main', recordId: 'original-native' } } } }
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.session.agentSessionId, item })
  return f
}

it('the actual Composer history hook keeps two original seeds beside one canonical input entity without a third alias', async () => {
  const f = await seed(); await desktopConversationReadBridge(f, closes)
  const session = { ...composerSession(f.session.agentSessionId, 'claude'),
    control: { kind: 'agent' as const, hostId: 'local', agentSessionId: f.session.agentSessionId, run: f.session.run } }
  const timeline = await f.client.sessionTimeline(f.session.agentSessionId)
  useAppStore.setState({ config: composerConfig, sessions: [session], timelines: { [session.id]: timeline }, agentComposerHistory: {}, agentComposerDrafts: { [session.id]: 'Keep the unsent draft' } })
  const query = vi.spyOn(api.sessions, 'readHistory').mockImplementation((reference, input, options) => f.client.readAgentSessionHistory({ ...input, ...reference }, options))
  let history!: ReturnType<typeof useComposerInputHistory>
  const insertion = createRef<ComposerInsertionHandle>()
  function Consumer() {
    history = useComposerInputHistory({ sessionId: session.id, control: session.control, visible: true, readOnly: false, insertion, timeline })
    return <output>{history.entries.join('|')}</output>
  }
  const { root } = mount(); await act(async () => root.render(<Consumer />))
  await act(async () => history.setFocused(true))
  await wait(() => { expect(history.history.complete).toBe(true); expect(api.conversation.readAgentConversation).toHaveBeenCalled() })
  const read = vi.mocked(api.conversation.readAgentConversation).mock.results[0]!.value
  await act(async () => { await read })
  const accepted = consumeConversationWindowPage(await read)
  expect(accepted.kind).toBe('complete')
  if (accepted.kind !== 'complete') throw Error('The bounded public frame must complete')
  const reading = projectConversationWindow(accepted.snapshot)
  expect(reading.inputs).toHaveLength(1)
  expect(reading.inputs[0]!.source.kind).toBe('native')
  await wait(() => expect(api.conversation.observeConversation).toHaveBeenCalled())
  await act(async () => { await Promise.all(vi.mocked(api.conversation.observeConversation).mock.results.map(result => result.value)) })
  expect(query).toHaveBeenCalledTimes(2)
  const sourceIds = reading.originalRecords.flatMap(record => record.input ? [record.input.id] : []).sort()
  expect(sourceIds).toEqual(['captured:original-captured', 'native:claude:native-main:original-native'])
  expect(history.history.messages.map(message => message.id).sort(), 'History seeds must share the original source-query identities').toEqual(sourceIds)
  expect(history.entries, 'Arrow recall consumes original history once per source record').toEqual([prose, prose])
  expect(reading.inputs[0]!.author).toEqual({ kind: 'human' })
  expect(history.history.messages.find(message => message.source.kind === 'native')!.author).toEqual({ kind: 'unknown' })
  expect(useAppStore.getState().agentComposerDrafts[session.id]).toBe('Keep the unsent draft')
  expect(f.controls.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})

it('the actual Mobile surface passes raw source seeds to Mailbox queries and details without changing canonical conversation identity', async () => {
  const f = await seed()
  // Runtime activity is an unavailable controlled observation leaf. No Run control is exercised.
  vi.spyOn(f.client, 'connect').mockResolvedValue()
  vi.spyOn(f.client, 'statusAgent').mockRejectedValue(new Error('Activity observation unavailable in the isolated reader'))
  const hosted = new AgentMuxHostedRuntimeService(f.client, null, () => ({ runtimeId: 'original-isolated-runtime', ownerInstanceId: 'original-isolated-owner', protocolVersion: 2, processId: process.pid, availability: 'connected', ctxmux: null })); closes.push(() => hosted.dispose())
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'mobile-seeds.sock'), coreClients: () => [{ hostId: 'local', client: f.client }], hostedRuntime: () => hosted })
  await server.start(); closes.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); closes.push(() => rpc.dispose())
  const client = await connectHostedAgentMux({ rpc, waitForReady: false }); closes.push(() => client.dispose())
  const query = vi.spyOn(client, 'readAgentSessionHistory'), openTerminal = vi.fn()
  const { root, host } = mount()
  await act(async () => root.render(<MobileConversationSurface client={client} agentSessionId={f.session.agentSessionId}
    connection={{ state: 'connected', message: 'Original Host connected' }} platform={createBrowserPlatform()} onShowTerminal={openTerminal} />))
  await wait(() => expect(host.querySelectorAll('[data-native-record-id="original-native"]')).toHaveLength(1))
  const trigger = host.querySelector<HTMLButtonElement>('.mobile-message-tools__trigger')!
  expect(trigger).not.toBeNull(); await act(async () => trigger.click())
  const panel = () => document.querySelector<HTMLElement>('.mobile-message-tools')!
  await wait(() => { expect(query).toHaveBeenCalledTimes(2); expect(panel().textContent).toContain('已查完可用记录') })
  const rows = () => [...panel().querySelectorAll<HTMLElement>('[data-input-history-id]')]
  expect(rows().map(row => row.dataset.inputHistoryId).sort(), 'Mailbox history keeps two source records without a canonical alias row').toEqual(['captured:original-captured', 'native:claude:native-main:original-native'])
  const native = rows().find(row => row.dataset.inputHistoryId!.startsWith('native:'))!, details = native.querySelector('details')!
  await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')) })
  await wait(() => expect(native.querySelector('[data-message-id="native:claude:native-main:original-native"]')).not.toBeNull())
  const body = native.querySelector<HTMLElement>('[data-message-id]')!
  const pages = await Promise.all(query.mock.results.map(result => result.value))
  expect(pages.find(page => page.source === 'native')!.userMessages![0]!.author).toEqual({ kind: 'unknown' })
  expect(body.dataset.messageSourceKey).toBe(JSON.stringify([f.session.agentSessionId, 'native', 'claude', 'native-main', 'original-native']))
  expect(body.dataset.conversationEventId, 'Original details remain source records, not entity aliases').toBeUndefined()
  expect(body.textContent).toContain(prose)
  expect(openTerminal).not.toHaveBeenCalled()
  expect(client.agentSession(f.session.agentSessionId).run).toEqual(f.session.run)
  expect(f.controls.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})
