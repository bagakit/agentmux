// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import type { AgentMuxRpcCallContext, AgentMuxRpcMethod, AgentMuxRpcParams, AgentMuxRpcResult, AgentMuxRuntimeFence } from '@agentmux/core'
import { createTakeoverOwnerFixture } from '../../../packages/core/test/helpers/takeover-owner'
import { RuntimeController } from '../src/main/runtime-controller'
import { registerAgentTakeoverIpc } from '../src/main/agent-takeover-ipc'
import { assertAppDocumentSender } from '../src/main/ipc-sender-trust'
import { testAppDocumentSources } from './helpers/app-document-fixture'
import type { AgentMuxPreloadApi } from '../src/shared/contracts'

const exposed = vi.hoisted(() => ({ api: null as AgentMuxPreloadApi | null, invoke: vi.fn() }))
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: (_name: string, value: AgentMuxPreloadApi) => { exposed.api = value } },
  ipcRenderer: { invoke: exposed.invoke, on: vi.fn(), removeListener: vi.fn() }, webFrame: { getZoomFactor: () => 1 } }))
import '../src/preload/index'

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })

async function fixture() {
  const owner = await createTakeoverOwnerFixture(cleanup)
  const calls: Array<{ method: AgentMuxRpcMethod; params: unknown; fence?: AgentMuxRuntimeFence }> = []
  let afterRead: (() => Promise<void>) | undefined
  const carrier = { async forwardRpc<M extends AgentMuxRpcMethod>(method: M, params: AgentMuxRpcParams<M>, context: AgentMuxRpcCallContext = {}, fence?: AgentMuxRuntimeFence): Promise<AgentMuxRpcResult<M>> {
    calls.push({ method, params, ...(fence ? { fence } : {}) })
    const result = await owner.rpc.call(method, params, { ...(context.signal ? { signal: context.signal } : {}), ...(fence ? { runtimeFence: fence } : {}) })
    await afterRead?.()
    return result
  } }
  const routes = new Map([['original-host', { client: carrier }]])
  const runtime = Object.assign(Object.create(RuntimeController.prototype), { hosts: routes, hostReconfigurationReservations: new Map() }) as RuntimeController
  const sender = {}, sources = testAppDocumentSources(sender), frame = Reflect.get(sender, 'mainFrame')
  let event = { sender, senderFrame: frame } as IpcMainInvokeEvent
  type Handler = (event: IpcMainInvokeEvent, ...args: any[]) => Promise<unknown>
  const handlers = new Map<string, Handler>()
  registerAgentTakeoverIpc({ runtime, call: (method, input) => owner.rpc.call(method, input),
    handleWithEvent(channel, handler) { handlers.set(channel, async (event, ...args) => {
      assertAppDocumentSender(event, sender as never, sources())
      return handler(event, ...args)
    }) } })
  exposed.invoke.mockImplementation((channel: string, ...args: unknown[]) => handlers.get(channel)!(event, ...args))
  expect(exposed.api?.sessions.owner).toBeTypeOf('function')
  return { ...owner, calls, handlers, routes, carrier, sessions: exposed.api!.sessions,
    afterRead: (read?: () => Promise<void>) => { afterRead = read },
    untrust: () => { event = { sender, senderFrame: { ...frame } } as IpcMainInvokeEvent } }
}

it('the complete preload owner read reaches its exact original Core through production Main and RuntimeController', async () => {
  const f = await fixture(), before = await f.spatial.read()
  expect(await f.sessions.owner('original-host')).toEqual({ owner: f.owner })
  expect(await f.sessions.owner('original-host', f.owner.runtimeId)).toEqual({ owner: f.owner })
  expect(f.calls).toEqual([
    { method: 'runtime.owner.identity', params: {} },
    { method: 'runtime.owner.identity', params: { expectedRuntimeId: f.owner.runtimeId } }
  ])
  expect(await f.spatial.read()).toEqual(before)
  expect(await f.client.readAgentSession(f.source.agentSessionId)).toEqual(f.source)
})

it('the original public Core rejects another Runtime pin and keeps the same source and work', async () => {
  const f = await fixture(), before = await f.spatial.read()
  await expect(f.sessions.owner('original-host', 'another-runtime')).rejects.toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH' })
  expect(await f.sessions.owner('original-host', f.owner.runtimeId)).toEqual({ owner: f.owner })
  expect(await f.spatial.read()).toEqual(before)
  expect(await f.client.readAgentSession(f.source.agentSessionId)).toEqual(f.source)
})

it('another Renderer frame cannot read the original owner through the sessions bridge', async () => {
  const f = await fixture(); f.untrust()
  await expect(f.sessions.owner('original-host')).rejects.toThrow('Untrusted application main document sender')
  expect(f.calls).toEqual([])
})

it('an owner ACK from a replaced carrier remains unconfirmed and can be reread without changing the source', async () => {
  const f = await fixture(), before = await f.spatial.read()
  let release!: () => void, read = false
  const pending = new Promise<void>(resolve => { release = resolve })
  f.afterRead(async () => { read = true; await pending })
  const observed = f.sessions.owner('original-host').then(value => ({ value }), error => ({ code: error.code }))
  await vi.waitFor(() => expect(read).toBe(true))
  f.routes.set('original-host', { client: { ...f.carrier } }); release()
  expect(await observed).toEqual({ code: 'RUNTIME_OWNER_MISMATCH' })
  f.routes.set('original-host', { client: f.carrier }); f.afterRead()
  expect(await f.sessions.owner('original-host', f.owner.runtimeId)).toEqual({ owner: f.owner })
  expect(await f.spatial.read()).toEqual(before)
  expect(await f.client.readAgentSession(f.source.agentSessionId)).toEqual(f.source)
})
