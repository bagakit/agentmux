import { EventEmitter } from 'node:events'
import type { IpcMainInvokeEvent } from 'electron'
import { registerSearchIpc } from '../src/main/search-ipc'
import { assertSenderTrusted, senderTrust } from '../src/main/ipc-sender-trust'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client'
import { createHistoryQueryFixture } from '../../../packages/core/test/helpers/session-history-query'
import { createRendererSearchRead } from '../src/renderer/src/lib/search-read'
import type { AgentMuxPreloadApi } from '../src/shared/contracts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks() })
it('reads original Provider text through public RPC and the actual Renderer bridge with shared exact budget recovery', async () => {
 const f = await createHistoryQueryFixture(cleanups), socket = join(f.root, 'control.sock')
 const server = new AgentMuxControlServer({ socketPath: socket, coreClients: () => [{ hostId: 'local', client: f.client }] })
 await server.start(); cleanups.push(() => server.stop())
 const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socket } }); cleanups.push(() => rpc.dispose())
 const handlers = new Map<string, (event: IpcMainInvokeEvent, ...values: unknown[]) => unknown>()
 const sender = Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false }), event = { sender } as unknown as IpcMainInvokeEvent
 const ipc = registerSearchIpc({ handle: (channel, handler) => { handlers.set(channel, handler as (event: IpcMainInvokeEvent, ...values: unknown[]) => unknown) },
  trust: (channel, event) => assertSenderTrusted(senderTrust(channel, event.sender, sender)), query: (input, signal) => rpc.call('app.search', input, { signal }) })
 cleanups.push(async () => ipc.dispose())
 expect(() => handlers.get('search:query')!({ sender: {} } as IpcMainInvokeEvent, 'foreign', {})).toThrow('Untrusted original global search query sender')
 const transport = vi.fn<AgentMuxPreloadApi['search']['query']>(async (input, context) => {
  const token = crypto.randomUUID(), pending = handlers.get('search:query')!(event, token, input)
  const release = context?.onAbort?.(() => handlers.get('search:cancel')!(event, token))
  try { return JSON.parse(JSON.stringify(await pending)) }
  finally { release?.() }
 })
 const read = createRendererSearchRead(transport)
 const input = { mode: 'history' as const, query: 'needle', hostId: 'local', agentSessionId: f.session.agentSessionId, source: 'native' as const, maxBytes: 4096 }
 const page = await read(input)
 expect(page.hits[0]).toMatchObject({ reference: { hostId: 'local', sourceHostId: 'local', source: 'native' }, page: { items: [{ item: { id: 'record-0' } }] } })
 expect(transport).toHaveBeenCalledTimes(2); expect(transport.mock.calls[1]![0].cursor).toBeTypeOf('string')
 expect(page.coverage.complete).toBe(true); await f.noControls()
})
it('keeps cancellation in Renderer and rejects late transport results without accepting forged source coverage', async () => {
 const controller = new AbortController(), cancel = vi.fn(), release = vi.fn()
 let finish!: (value: never) => void
 const transport = vi.fn<AgentMuxPreloadApi['search']['query']>(async (_, context) => {
  expect(context).not.toHaveProperty('signal'); const cleanup = context!.onAbort!(cancel)
  return await new Promise<never>(resolve => { finish = value => { cleanup(); release(); resolve(value) } })
 })
 const read = createRendererSearchRead(transport), input = { mode: 'history' as const, query: 'needle' }, reason = new Error('This exact search closed')
 const pending = read(input, { signal: controller.signal }), rejected = expect(pending).rejects.toBe(reason)
 controller.abort(reason); finish({} as never); await rejected
 expect(cancel).toHaveBeenCalledOnce(); expect(release).toHaveBeenCalledOnce()
 await expect(read(input, { signal: controller.signal })).rejects.toBe(reason); expect(transport).toHaveBeenCalledOnce()
 const forged = createRendererSearchRead(async () => ({ ok: true, value: { mode: 'history', query: 'needle', scope: {}, hits: [], nextCursor: 'still-pending', budgetBytes: 1024 * 1024,
  coverage: { complete: true, examined: 0, totalSources: 1, completedSources: 0, remainingSources: 1, unavailableCount: 0, unavailable: [] } } }))
 await expect(forged(input)).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
})

it('releases Desktop search ownership while the original exact source discovery is still pending', async () => {
 const f = await createHistoryQueryFixture(cleanups), socket = join(f.root, 'discovery.sock')
 const server = new AgentMuxControlServer({ socketPath: socket, coreClients: () => [{ hostId: 'local', client: f.client }] })
 await server.start(); cleanups.push(() => server.stop())
 const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socket } }); cleanups.push(() => rpc.dispose())
 const handlers = new Map<string, (event: IpcMainInvokeEvent, ...values: unknown[]) => unknown>()
 const sender = Object.assign(new EventEmitter(), { id: 2, isDestroyed: () => false }), event = { sender } as unknown as IpcMainInvokeEvent
 const ipc = registerSearchIpc({ handle: (channel, handler) => { handlers.set(channel, handler as (event: IpcMainInvokeEvent, ...values: unknown[]) => unknown) },
  trust: (channel, event) => assertSenderTrusted(senderTrust(channel, event.sender, sender)), query: (input, signal) => rpc.call('app.search', input, { signal }) })
 cleanups.push(async () => ipc.dispose())
 const read = createRendererSearchRead(async (input, context) => {
  const token = crypto.randomUUID(), pending = handlers.get('search:query')!(event, token, input)
  const release = context?.onAbort?.(() => handlers.get('search:cancel')!(event, token))
  try { return JSON.parse(JSON.stringify(await pending)) } finally { release?.() }
 })
 let entered!: () => void, release!: () => void, received: AbortSignal | undefined
 const ready = new Promise<void>(resolve => { entered = resolve })
 const blocked = new Promise<null>(resolve => { release = () => resolve(null) })
 vi.spyOn(f.store, 'readHistorySource').mockImplementation((_id, signal) => { received = signal; entered(); return blocked })
 const controller = new AbortController(), reason = new Error('Only this Desktop search closed')
 const pending = read({ mode: 'history', query: 'needle', hostId: 'local', agentSessionId: f.session.agentSessionId, source: 'captured' }, { signal: controller.signal })
 const rejected = expect(pending).rejects.toBe(reason)
 try {
  await ready; expect(sender.listenerCount('destroyed')).toBe(1)
  controller.abort(reason); await rejected
  await vi.waitFor(() => { expect(received?.aborted).toBe(true); expect(sender.listenerCount('destroyed')).toBe(0); expect(sender.listenerCount('did-start-navigation')).toBe(0) })
  await f.noControls()
 } finally { release() }
})
