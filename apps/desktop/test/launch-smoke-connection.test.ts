import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxError } from '../../../packages/core/src/errors.js'
import { connectHostedAgentMux } from '../../../packages/core/src/hosted-client.js'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client.js'
import type { AgentMuxHostedRpcPort } from '../../../packages/core/src/hosted-client-contract.js'
import type { AgentMuxClientEvent } from '../../../packages/core/src/types.js'
import { headlessFixture, until } from '../../../packages/core/test/helpers/headless-runtime-fixture.js'
import { waitForDesktopHostConnection } from '../src/main/desktop-host.js'

const cleanup: Array<() => void | Promise<void>> = []
function fact(value: object) {
  if (process.env.LAUNCH_SMOKE_FACTS) appendFileSync(process.env.LAUNCH_SMOKE_FACTS, JSON.stringify(value) + '\n')
}
afterEach(async context => {
  const errors: unknown[] = []
  for (const close of cleanup.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  vi.restoreAllMocks()
  fact({ case: context.task.name, cleanup: errors.length ? 'unknown' : 'confirmed',
    ...(errors.length ? { errors: errors.map(error => error instanceof Error ? { name: error.name, message: error.message, code: (error as { code?: string }).code } : { value: String(error) }) } : {}) })
  if (errors.length) throw new AggregateError(errors, 'Private launch smoke connection cleanup failed')
})
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const settled = <T>(pending: Promise<T>) => pending.then(value => ({ state: 'fulfilled' as const, value }), error => ({ state: 'rejected' as const, error }))
const turn = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
function connection(state: 'restored' | 'unrecoverable', boundary: 'consumer-core' | 'core-ctxmux' = 'consumer-core'): AgentMuxClientEvent {
  return { type: 'connection-state', state, observationOrigin: { kind: 'runtime-connection', boundary },
    diagnostic: { code: 'ORIGINAL_CONNECTION_TERMINAL', message: 'Original connection diagnostic' }, evidence: { source: 'agentmux', observedAt: 1 } }
}
function port(connect: () => Promise<void>) {
  const listeners = new Set<(event: AgentMuxClientEvent) => unknown>(), abort = new AbortController()
  const client = { connect: vi.fn(connect), disconnect: vi.fn(), onEvent: vi.fn((listener: (event: AgentMuxClientEvent) => unknown) => {
    listeners.add(listener); return () => listeners.delete(listener)
  }) }
  cleanup.push(() => { abort.abort(); expect(listeners.size).toBe(0); expect(client.disconnect).not.toHaveBeenCalled() })
  return { client, abort, listeners, emit: (event: AgentMuxClientEvent) => { for (const listener of [...listeners]) listener(event) } }
}

it('launch smoke waits for the original Hosted background reconnect without replacing metadata or Native', async () => {
  const scope = await headlessFixture({ ownerNodeArgs: ['--import', resolve(import.meta.dirname, 'launch-smoke-connection-node-loader.mjs')] }); cleanup.push(() => scope.cleanup())
  const original = await scope.client()
  const created = await original.createAgent({ providerId: 'codex', executorId: 'fixture', workspacePath: scope.root,
    injectAgentMuxGuide: false, commandOverride: resolve(import.meta.dirname, '../../../packages/core/test/fixtures/fake-codex-cli.mjs'), env: { AGENTMUX_FAKE_NATIVE_RECORD: '1' } })
  cleanup.push(() => original.stopAgent(created.agentSessionId, created.run).then(() => undefined))
  await until(() => original.agentSession(created.agentSessionId), value => Boolean(value.nativeHandle), 'private original native metadata')
  const before = await original.statusAgent(created.agentSessionId), owner = scope.owner, daemon = scope.nativeProcessId
  expect(before.run.state).toBe('running')
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: scope.socketPath } }); cleanup.push(() => rpc.dispose())
  const releaseFirst = deferred(), rejectedFirst = deferred(), calls: Array<{ method: string; consumerId?: string }> = []
  let ownerReads = 0
  const wrapped: AgentMuxHostedRpcPort = {
    call: async (method, params, options) => {
      calls.push({ method, ...('consumerId' in params ? { consumerId: params.consumerId as string } : {}) })
      if (method === 'runtime.owner.identity' && ++ownerReads === 1) {
        await releaseFirst.promise; rejectedFirst.resolve()
        throw new AgentMuxError('Original platform registration observation is unconfirmed', 'HOST_SERVICE_UNCONFIRMED')
      }
      return await rpc.call(method, params, options)
    },
    subscribe: async (method, params, handlers) => {
      calls.push({ method, ...('consumerId' in params ? { consumerId: params.consumerId as string } : {}) })
      return await rpc.subscribe(method, params, handlers)
    }
  }
  const client = await connectHostedAgentMux({ rpc: wrapped, waitForReady: false, expectedRuntimeId: owner.runtimeId, expectedStorePath: scope.env.AGENTMUX_AGENT_SESSION_STORE })
  cleanup.push(() => client.dispose())
  const connect = vi.spyOn(client, 'connect'), disconnect = vi.spyOn(client, 'disconnect'), events: AgentMuxClientEvent[] = []
  const release = client.onEvent(event => { events.push(event) }); cleanup.push(release)
  const abort = new AbortController(); cleanup.push(() => abort.abort())
  const pending = settled(waitForDesktopHostConnection(client, abort.signal))
  releaseFirst.resolve(); await rejectedFirst.promise
  await expect(pending).resolves.toMatchObject({ state: 'fulfilled' })
  const after = await client.statusAgent(created.agentSessionId)
  expect(after.session).toMatchObject({ agentSessionId: created.agentSessionId, executorId: before.session.executorId, workspacePath: scope.root, run: before.session.run, nativeHandle: before.session.nativeHandle })
  expect(after.run).toMatchObject({ runId: before.run.runId, pid: before.run.pid, state: 'running' })
  expect(client.runtimeOwnerIdentity()).toEqual(owner)
  expect(scope.ownerProcess.pid).toBe(owner.processId); expect(scope.ownerProcess.exitCode).toBeNull()
  expect(scope.nativeProcessId).toBe(daemon); expect(() => process.kill(daemon!, 0)).not.toThrow()
  expect(ownerReads).toBeGreaterThanOrEqual(2)
  const consumerIds = [...new Set(calls.flatMap(value => value.consumerId ? [value.consumerId] : []))]
  expect(consumerIds).toHaveLength(1)
  expect(calls.filter(value => value.method === 'runtime.events')).toHaveLength(1)
  expect(events.some(value => value.type === 'connection-state' && value.state === 'lost' && value.observationOrigin.boundary === 'consumer-core')).toBe(true)
  expect(events.some(value => value.type === 'connection-state' && value.state === 'restored' && value.observationOrigin.boundary === 'consumer-core')).toBe(true)
  expect(disconnect).not.toHaveBeenCalled()
  fact({ phase: 'actual-hosted-reconnect', owner, nativeProcessId: daemon, sessionId: created.agentSessionId, runId: before.run.runId, runProcessId: before.run.pid,
    ownerReads, consumerIds, calls, publicConnectCalls: connect.mock.calls.length, scope: 'SDK background retry invokes its internal connect closure; public connect calls count only smoke confirmation.', metadataRetained: true, sameRun: true, sameNativeProcess: true })
})

it('launch smoke confirms an already connected client without waiting for a future event', async () => {
  const f = port(async () => {})
  await expect(waitForDesktopHostConnection(f.client, f.abort.signal)).resolves.toBeUndefined()
  expect(f.client.connect).toHaveBeenCalledOnce(); expect(f.listeners.size).toBe(0)
})

it('launch smoke requires complete bootstrap after restored and owner-only observations', async () => {
  const bootstrap = deferred(), f = port(() => bootstrap.promise)
  let result: unknown
  const pending = settled(waitForDesktopHostConnection(f.client, f.abort.signal)); void pending.then(value => { result = value })
  // A confirmed owner and a restored event are not a completed connect/bootstrap.
  Object.assign(f.client, { runtimeOwnerIdentity: () => ({ runtimeId: 'original-runtime', availability: 'connected' }) })
  await turn(); expect(result).toBeUndefined()
  f.emit(connection('restored')); await turn()
  expect(f.client.connect).toHaveBeenCalledTimes(2); expect(result).toBeUndefined()
  bootstrap.resolve(); await expect(pending).resolves.toMatchObject({ state: 'fulfilled' })
  expect(f.listeners.size).toBe(0)
})

it('launch smoke retains its consumer when only Native is unrecoverable', async () => {
  const bootstrap = deferred(), f = port(() => bootstrap.promise)
  let result: unknown
  const pending = settled(waitForDesktopHostConnection(f.client, f.abort.signal)); void pending.then(value => { result = value })
  f.emit(connection('unrecoverable', 'core-ctxmux')); await turn(); expect(result).toBeUndefined()
  bootstrap.resolve(); await expect(pending).resolves.toMatchObject({ state: 'fulfilled' }); expect(f.listeners.size).toBe(0)
})

it('launch smoke preserves the exact consumer terminal diagnostic', async () => {
  const f = port(() => new Promise(() => {})), pending = settled(waitForDesktopHostConnection(f.client, f.abort.signal))
  f.emit(connection('unrecoverable'))
  await expect(pending).resolves.toMatchObject({ state: 'rejected', error: { code: 'ORIGINAL_CONNECTION_TERMINAL', message: 'Original connection diagnostic' } })
  expect(f.listeners.size).toBe(0)
})

it('launch smoke abort releases only its listeners and preserves the original cancellation', async () => {
  const f = port(() => new Promise(() => {})), add = vi.spyOn(f.abort.signal, 'addEventListener'), remove = vi.spyOn(f.abort.signal, 'removeEventListener')
  const pending = settled(waitForDesktopHostConnection(f.client, f.abort.signal)), reason = new Error('Original smoke observer cancelled')
  f.abort.abort(reason)
  await expect(pending).resolves.toMatchObject({ state: 'rejected', error: reason })
  expect(f.listeners.size).toBe(0)
  expect(remove.mock.calls[0]?.slice(0, 2)).toEqual(add.mock.calls[0]?.slice(0, 2))
  const prior = port(async () => {}); prior.abort.abort(reason)
  await expect(waitForDesktopHostConnection(prior.client, prior.abort.signal)).rejects.toBe(reason)
  expect(prior.client.connect).not.toHaveBeenCalled(); expect(prior.client.onEvent).not.toHaveBeenCalled()
})

it('launch smoke sibling failure closes every pending observer without disconnecting clients', async () => {
  const first = port(() => new Promise(() => {})), sibling = port(() => new Promise(() => {})), abort = new AbortController()
  cleanup.push(() => abort.abort())
  const pending = settled(Promise.all([first.client, sibling.client].map(client => waitForDesktopHostConnection(client, abort.signal))).finally(() => abort.abort()))
  first.emit(connection('unrecoverable'))
  await expect(pending).resolves.toMatchObject({ state: 'rejected', error: { code: 'ORIGINAL_CONNECTION_TERMINAL' } })
  expect(first.listeners.size).toBe(0); expect(sibling.listeners.size).toBe(0)
})
