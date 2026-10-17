import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
const native = vi.hoisted(() => ({ options: [] as unknown[], shown: 0, focused: 0 }))
vi.mock('electron', async () => { const { EventEmitter } = await import('node:events'); return { Notification: class extends EventEmitter {
  static isSupported() { return true }
  constructor(options: unknown) { super(); native.options.push(options) }
  show() { native.shown++ }
  close() { this.emit('close') }
} } })
import { AgentMuxHostedRuntimeService } from '../../../packages/core/src/hosted-runtime-service.js'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client.js'
import { connectHostedAgentMux } from '../../../packages/core/src/hosted-client.js'
import { parseHostedMessageEvent } from '../../../packages/core/src/hosted-value.js'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { hostedTestOwner } from '../../../packages/core/test/helpers/hosted-runtime-port.js'
import { createA2AMessageNotifier } from '../src/renderer/src/lib/a2a-message-notifier.js'
import { createAgentNotifier } from '../src/main/agent-notifier.js'
import type { AppConfig, RuntimeEvent, SessionSnapshot } from '../src/shared/contracts.js'
import type { AgentMuxClientEvent } from '../../../packages/core/src/types.js'

const closes: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); native.options = []; native.shown = 0; vi.restoreAllMocks() })
const session = (id: string) => ({ id: `desktop-${id}`, kind: 'agent', hostId: 'local', label: `Agent ${id}`,
  control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}` } } }) as SessionSnapshot
const config = { a2a: { notifications: 'follow-global' }, notifications: { mode: 'standard', sound: false } } as AppConfig
const created = (sequence: number, extra = {}) => ({ type: 'core', hostId: 'local', event: {
  type: 'agent-message-changed', messageId: `mid-${sequence}`, sequence, messageSequence: sequence, live: true,
  recordKind: 'message', senderSessionId: 'sender', recipientSessionId: 'reader', ...extra
} }) as RuntimeEvent

it('only live background original creations notify once; receipt/catch-up/boot/mute and the visible recipient remain quiet', async () => {
  const notify = vi.fn(async () => {}), owner = createA2AMessageNotifier(notify)
  const input = { config, sessions: [session('reader'), session('sender')], ready: true, windowFocused: false, visibleSessionIds: new Set<string>() }
  await owner.observe({ ...input, event: created(1) })
  expect(notify).toHaveBeenCalledOnce(); expect(notify).toHaveBeenLastCalledWith({ sessionId: 'desktop-reader', title: 'New Agent message', body: 'Agent sender → Agent reader', mode: 'standard', sound: false })
  await owner.observe({ ...input, event: created(1) })
  for (const recordKind of ['delivery', 'delivery-issue', 'a2a-notification', 'a2a-notification-result']) await owner.observe({ ...input, event: created(9, { recordKind, messageSequence: 2 }) })
  await owner.observe({ ...input, event: created(3, { live: false }) })
  await owner.observe({ ...input, ready: false, event: created(4) })
  await owner.observe({ ...input, event: created(4) })
  await owner.observe({ ...input, windowFocused: true, visibleSessionIds: new Set(['desktop-reader']), event: created(5) })
  await owner.observe({ ...input, config: { ...config, a2a: { notifications: 'silent' } }, event: created(6) })
  await owner.observe({ ...input, event: created(6) })
  await owner.observe({ ...input, event: created(7, { senderSessionId: 'reader' }) })
  await owner.observe({ ...input, event: { ...created(8), hostId: 'another-host' } })
  expect(notify).toHaveBeenCalledOnce()
  await owner.observe({ ...input, windowFocused: true, config: { ...config, a2a: { notifications: 'notify' }, notifications: { mode: 'off', sound: true } }, event: created(10) })
  expect(notify).toHaveBeenCalledTimes(2); expect(notify.mock.calls.at(-1)?.[0]).toMatchObject({ mode: 'standard', sound: true })
})

it('strict Host event decoding rejects missing or inconsistent authority without interpreting presentation strings', () => {
  const event = created(2).event
  expect(() => parseHostedMessageEvent(event)).not.toThrow()
  for (const extra of [{ recordKind: undefined }, { live: undefined }, { messageSequence: undefined }, { messageSequence: 3 }, { recordKind: 'message', sequence: 4 }, { recordKind: 'delivery' }, { title: 'New message' }])
    expect(() => parseHostedMessageEvent({ ...event, ...extra })).toThrow()
})

it('a cross-process original journal write reaches the actual public Hosted consumer and Main Notification.show without opening a mailbox', async () => {
  const f = await rpcOwnerFixture(['reader', 'sender']); closes.push(f.close)
  const service = new AgentMuxHostedRuntimeService(f.client, f.store.path, () => hostedTestOwner(f.client)); closes.push(() => service.dispose())
  const server = new AgentMuxControlServer({ coreClients: f.coreClients, hostedRuntime: () => service }, join(f.root, 'notify.sock'))
  await server.start(); closes.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); closes.push(() => rpc.dispose())
  const hosted = await connectHostedAgentMux({ rpc, waitForReady: true }); closes.push(() => hosted.dispose())
  const host = createAgentNotifier({ window: { isDestroyed: () => false, isMinimized: () => false, focus: () => native.focused++ } as never, onActivate: () => {} }); closes.push(() => host.dispose())
  const delivered: Promise<void>[] = [], owner = createA2AMessageNotifier(async request => { expect(host.notify(request)).toMatchObject({ status: 'shown' }) })
  const events: AgentMuxClientEvent[] = []
  closes.push(hosted.onEvent(event => { events.push(event); delivered.push(owner.observe({ event: { type: 'core', hostId: 'local', event }, config,
    sessions: [session('reader'), session('sender')], ready: true, windowFocused: false, visibleSessionIds: new Set() })) }))
  // The Host lease activates observation independently of all list/read methods.
  const coreEvents: AgentMuxClientEvent[] = []; closes.push(f.client.onEvent(event => { coreEvents.push(event) }, { observeMessages: true }))
  await vi.waitFor(() => expect(coreEvents.some(event => event.type === 'agent-message-observation' && event.state === 'available')).toBe(true))
  const writer = async (mode: string, id: string) => promisify(execFile)(process.execPath, [join(import.meta.dirname, '../../../packages/core/test/fixtures/message-journal-writer.mjs'),
    pathToFileURL(join(import.meta.dirname, '../../../packages/core/dist/index.js')).href, mode, f.client.agentMessageQueuePath(), id], { timeout: 10000 })
  await writer('append', 'original-arrival')
  await vi.waitFor(() => expect(native.shown).toBe(1)); await Promise.all(delivered)
  expect(events.find(event => event.type === 'agent-message-changed')).toMatchObject({ recordKind: 'message', messageSequence: 1, sequence: 1, live: true, messageId: 'original-arrival' })
  expect(native.options).toEqual([{ title: 'New Agent message', body: 'Agent sender → Agent reader', silent: true, timeoutType: 'default' }])
  const cliEvents = async () => JSON.parse((await promisify(execFile)(process.execPath, [join(import.meta.dirname, '../../../packages/core/bin/amux'),
    '--endpoint', `unix:${server.path}`, 'message', 'events', '--host', 'local', '--participant', 'reader', '--message-id', 'original-arrival'],
    { timeout: 10000, env: { ...process.env, AGENTMUX_ENV: undefined, AGENTMUX_AGENT_SESSION_ID: undefined, AGENTMUX_AGENT_CAPABILITY: undefined } })).stdout).result
  const createdEvents = await cliEvents()
  expect(createdEvents.events.map((event: { kind: string }) => event.kind)).toEqual(['message'])
  expect(createdEvents.events[0].messages).toEqual([expect.objectContaining({ messageId: 'original-arrival', senderSessionId: 'sender', recipientSessionId: 'reader' })])
  await writer('delivery', 'original-arrival')
  await vi.waitFor(() => expect(events.filter(event => event.type === 'agent-message-changed')).toHaveLength(2)); await Promise.all(delivered)
  expect(native.shown).toBe(1); expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  const updatedEvents = await cliEvents()
  expect(updatedEvents.events.map((event: { kind: string }) => event.kind)).toEqual(['message', 'delivery'])
  expect(updatedEvents.events[1]).toMatchObject({ state: 'failed', messages: createdEvents.events[0].messages })
  await hosted.listMessages({ participantSessionId: 'reader', direction: 'incoming', limit: 1 })
  await hosted.dispose()
  await writer('append', 'while-hosted-reader-closed')
  const reopened = await connectHostedAgentMux({ rpc, waitForReady: true }); closes.push(() => reopened.dispose())
  closes.push(reopened.onEvent(event => { delivered.push(owner.observe({ event: { type: 'core', hostId: 'local', event }, config,
    sessions: [session('reader'), session('sender')], ready: true, windowFocused: false, visibleSessionIds: new Set() })) }))
  await writer('append', 'after-hosted-reconnect')
  await vi.waitFor(() => expect(native.shown).toBe(2)); await Promise.all(delivered)
  expect(native.options).toHaveLength(2)
}, 20000)
