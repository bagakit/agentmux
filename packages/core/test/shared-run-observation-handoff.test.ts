import { afterEach, expect, it, vi } from 'vitest'
import { attachmentFixture, bytes, output } from './helpers/run-attachment-fixture.js'
import { hostedTestClient } from './helpers/hosted-runtime-port.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { AgentMuxError } from '../src/errors.js'
import type { AgentMuxClientEvent, AgentMuxStoredAgentSession } from '../src/types.js'
import type { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of cleanup.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  vi.restoreAllMocks()
  if (errors.length) throw new AggregateError(errors, 'Private shared-reader cleanup failed')
})
async function fixture(agent = false) {
  const h = await attachmentFixture(); cleanup.push(h.close)
  if (agent) {
    const value: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'original-agent', providerId: 'codex', executorId: 'codex',
      hostId: 'local', workspacePath: process.cwd(), run: { runId: 'run-a' }, retiredRuns: [], hookBindingId: 'private-hook', hookToken: 'private-token',
      capabilityHash: 'a'.repeat(64), createdAt: 1, updatedAt: 1 }
    await (h.core as unknown as { store: AgentMuxMemoryAgentSessionStore }).store.compareAndSwap(null, value)
    await h.inner.registry.load('local')
  }
  const first = await hostedTestClient(h.core); cleanup.push(first.dispose)
  const events: AgentMuxClientEvent[] = []; first.sdk.onEvent(event => events.push(event))
  const second = await connectHostedAgentMux({ rpc: first.port, consumerId: 'other-original-reader' }); cleanup.push(() => second.dispose())
  return { ...h, first, second, received: events }
}
function retain(h: Awaited<ReturnType<typeof fixture>>, value: Uint8Array) {
  const run = h.runs.get('run-a')!, chunk = output(run.latest, value)
  run.latest = chunk.end_byte; run.replay.push(chunk); return chunk
}
const observedText = (events: AgentMuxClientEvent[]) => events.filter(event => event.type === 'terminal-output').map(event => event.data).join('')
const failures = (events: AgentMuxClientEvent[]) => events.filter(event => event.type === 'attachment-state' && event.state === 'unavailable')

it.each(['terminal', 'agent'] as const)('shared observation preserves the original %s reader while another obtains a fresh cut', async kind => {
  const h = await fixture(kind === 'agent'), view = kind === 'agent' ? 'terminal' : 'raw'
  const secondEvents: AgentMuxClientEvent[] = []; h.second.onEvent(event => secondEvents.push(event))
  if (kind === 'agent') await h.first.sdk.reattachAgent('original-agent', 0, view)
  else await h.first.sdk.attachTerminal('run-a', 0, view)
  const original = h.latest('run-a')
  const retained = retain(h, bytes('retained-before-the-new-cut'))
  if (kind === 'agent') {
    const subscribe = h.first.port.subscribe.bind(h.first.port); let corrupt = true
    vi.spyOn(h.first.port, 'subscribe').mockImplementation(async (method, params, handlers) => await subscribe(method, params, {
      ...handlers, onEvent(event) {
        if (method === 'runtime.attachment-watch' && event.type === 'snapshot' && corrupt) {
          corrupt = false; handlers.onEvent({ ...event, data: { ...event.data, index: event.data.index + 1 } }); return
        }
        handlers.onEvent(event)
      }
    }))
    await expect(h.second.reattachAgent('original-agent', 0, view)).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
  }
  const fresh = await h.second.refreshRunAttachment({ runId: 'run-a' }, 0, view)
  expect(fresh.run.latestOutputBytes).toBe(retained.end_byte)
  if (view === 'terminal') expect(fresh.terminal.type).toBe('basic-vt')
  else expect(fresh.replay.map(chunk => chunk.data).join('')).toBe('retained-before-the-new-cut')
  const candidate = h.latest('run-a')
  expect(candidate).not.toBe(original)
  original.push({ type: 'output', chunk: retained })
  original.push({ type: 'resized', size: { cols: 100, rows: 32 }, through_byte: retained.end_byte, resize_revision: 4 })
  const live = retain(h, bytes(':live-after-cut'))
  for (const stream of h.streams.get('run-a')!) stream.push({ type: 'output', chunk: live })
  await vi.waitFor(() => expect(observedText(h.received)).toBe('retained-before-the-new-cut:live-after-cut'))
  await vi.waitFor(() => expect(observedText(secondEvents)).toBe(':live-after-cut'))
  expect(candidate.detach).toHaveBeenCalledOnce(); expect(original.detach).not.toHaveBeenCalled()
  expect(failures(h.received)).toEqual([])
  expect(h.received.filter(event => event.type === 'terminal-snapshot')).toEqual([])
  expect(h.received.find(event => event.type === 'terminal-resized')).toMatchObject({ cols: 100, rows: 32, throughByte: retained.end_byte })
  expect(h.sdk.attach.mock.calls.length + h.sdk.attachTerminal.mock.calls.length).toBe(kind === 'agent' ? 3 : 2)
  expect(h.runs.get('run-a')!.input).toBe(0)
})

it('shared observation closes its temporary snapshot candidate without consuming the original decoder carry', async () => {
  const h = await fixture(); await h.first.sdk.attachTerminal('run-a')
  const original = h.latest('run-a')
  original.push({ type: 'output', chunk: retain(h, Uint8Array.from([0x41, 0xe4, 0xb8])) })
  await vi.waitFor(() => expect(observedText(h.received)).toBe('A'))
  const attach = h.sdk.attach.getMockImplementation()!
  let release!: () => void
  h.sdk.attach.mockImplementationOnce(async (...args) => { await new Promise<void>(resolve => { release = resolve }); return await attach(...args) })
  const refreshing = h.second.refreshRunAttachment({ runId: 'run-a' }, 0, 'raw')
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  original.push({ type: 'output', chunk: retain(h, Uint8Array.from([0xad, 0xf0, 0x9f, 0x98])) })
  await vi.waitFor(() => expect(observedText(h.received)).toBe('A中'))
  release(); await refreshing
  expect(h.latest('run-a').detach).toHaveBeenCalledOnce()
  original.push({ type: 'output', chunk: retain(h, Uint8Array.from([0x80, 0x42])) })
  await vi.waitFor(() => expect(observedText(h.received)).toBe('A中😀B'))
  expect(failures(h.received)).toEqual([]); expect(original.detach).not.toHaveBeenCalled()
})

it('shared observation uses the current unavailable fact after a slow candidate opening and ignores the retired pump', async () => {
  const h = await fixture(); await h.first.sdk.attachTerminal('run-a')
  const original = h.latest('run-a'), attach = h.sdk.attach.getMockImplementation()!
  let release!: () => void
  h.sdk.attach.mockImplementationOnce(async (...args) => { await new Promise<void>(resolve => { release = resolve }); return await attach(...args) })
  const refreshing = h.second.refreshRunAttachment({ runId: 'run-a' }, 0)
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  original.end(new Error('actual old reader ended'))
  await vi.waitFor(() => expect(h.adapter.hasAttachment('run-a')).toBe(false))
  release(); await refreshing
  const replacement = h.latest('run-a')
  expect(replacement.detach).not.toHaveBeenCalled()
  original.push({ type: 'output', chunk: output(0, bytes('foreign-old')) })
  original.push({ type: 'resized', size: { cols: 9, rows: 9 }, through_byte: 0, resize_revision: 99 })
  replacement.push({ type: 'output', chunk: retain(h, bytes('current-live')) })
  await vi.waitFor(() => expect(observedText(h.received)).toBe('current-live'))
  expect(h.received.some(event => event.type === 'terminal-resized' && event.cols === 9)).toBe(false)
  expect(h.adapter.hasAttachment('run-a')).toBe(true)
})

it('shared observation refuses a false live handoff when the original ends during candidate cleanup', async () => {
  const h = await fixture(); await h.first.sdk.attachTerminal('run-a')
  const original = h.latest('run-a'), attach = h.sdk.attach.getMockImplementation()!
  h.sdk.attach.mockImplementationOnce(async (...args) => {
    const value = await attach(...args)
    value.detach = vi.fn(async () => {
      original.end(new AgentMuxError('the actual original stream ended', 'CTXMUX_ATTACHMENT_UNCONFIRMED'))
      await vi.waitFor(() => expect(h.adapter.hasAttachment('run-a')).toBe(false))
    })
    return value
  })
  await expect(h.second.refreshRunAttachment({ runId: 'run-a' }, 0)).rejects.toMatchObject({ code: 'CTXMUX_ATTACHMENT_UNCONFIRMED' })
  expect(failures(h.received)).toHaveLength(1)
  expect(h.adapter.hasAttachment('run-a')).toBe(false)
})

it('shared observation rejects a superseded opening without closing its original live owner', async () => {
  const h = await fixture(); await h.first.sdk.attachTerminal('run-a')
  const original = h.latest('run-a'), attach = h.sdk.attach.getMockImplementation()!
  let release!: () => void
  h.sdk.attach.mockImplementationOnce(async (...args) => { await new Promise<void>(resolve => { release = resolve }); return await attach(...args) })
  const pending = h.core.refreshRunAttachment({ runId: 'run-a' }).catch(error => error)
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  await h.core.refreshRunAttachment({ runId: 'run-a' })
  release(); expect(await pending).toMatchObject({ code: 'CONTROL_CANCELLED' })
  expect(original.detach).not.toHaveBeenCalled()
  original.push({ type: 'output', chunk: retain(h, bytes('still-original')) })
  await vi.waitFor(() => expect(observedText(h.received)).toBe('still-original'))
})

it('shared observation rejects a foreign snapshot and preserves the original stream', async () => {
  const h = await fixture(); await h.first.sdk.attachTerminal('run-a')
  const original = h.latest('run-a'), attach = h.sdk.attach.getMockImplementation()!
  h.sdk.attach.mockImplementationOnce(async (...args) => {
    const value = await attach(...args); value.snapshot.run.id = 'foreign-run'; return value
  })
  await expect(h.second.refreshRunAttachment({ runId: 'run-a' }, 0)).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION_BINDING' })
  expect(h.latest('run-a').detach).toHaveBeenCalledOnce()
  expect(original.detach).not.toHaveBeenCalled()
  original.push({ type: 'output', chunk: retain(h, bytes('retained-original')) })
  await vi.waitFor(() => expect(observedText(h.received)).toBe('retained-original'))
})
