import { afterEach, expect, test, vi } from 'vitest'
import { join } from 'node:path'
import { AgentMuxCreationAuthority } from '../src/agent-creation-authority.js'
import { HostRouteGateway, delegatedHostRouteActor } from '../src/host-route-gateway.js'
import { hostRouteTransport, routedAgentMuxRpc } from '../src/host-route-rpc.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { decodeHostedValue } from '../src/hosted-value.js'
import type { AdoptedHostRoute, HostRouteGrant } from '../src/host-route.js'
import type { AgentInputSubmissionReceipt } from '../src/agent-input-wait.js'
import type { AgentMuxRpcCallContext } from '../src/public-rpc-service.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'

const fault = vi.hoisted(() => ({ afterWritePath: undefined as string | undefined }))
vi.mock('../src/durable-write.js', async originalModule => {
  const original = await originalModule<typeof import('../src/durable-write.js')>()
  return { ...original, durableWriteFile: async (...args: Parameters<typeof original.durableWriteFile>) => {
    const result = await original.durableWriteFile(...args)
    if (String(args[0]) === fault.afterWritePath) {
      fault.afterWritePath = undefined
      throw Object.assign(new Error('Private post-write durability confirmation failed'), { code: 'EIO' })
    }
    return result
  } }
})
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { fault.afterWritePath = undefined; for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
function barrier() { let resolve!: () => void; const pending = new Promise<void>(done => { resolve = done }); return { pending, resolve } }

/** Original Gateway/Unix/Hosted/Core journal and dispatch. Only Native state/bytes are controlled. */
async function fixture(beforeD?: (context: AgentMuxRpcCallContext) => Promise<void>) {
  const h = await rpcOwnerFixture(['recipient']); cleanups.push(h.close)
  const service = new AgentMuxHostedRuntimeService(h.client, null, () => ({ runtimeId: 'runtime-D', ownerInstanceId: 'owner-D', protocolVersion: 2,
    processId: process.pid, availability: 'connected', ctxmux: h.client.runtimeIdentity() }))
  cleanups.push(() => service.dispose())
  const authorityB = new AgentMuxCreationAuthority({ stateDirectory: join(h.root, 'B'), runtimeId: 'runtime-B' })
  const authorityD = new AgentMuxCreationAuthority({ stateDirectory: join(h.root, 'D'), runtimeId: 'runtime-D' })
  const b = await authorityB.identity(), d = await authorityD.identity(), actor = { source: b, kind: 'user' as const, id: `local-user:${process.getuid?.() ?? 'current'}` }
  let serverB: AgentMuxControlServer, serverD: AgentMuxControlServer, rpcD: Awaited<ReturnType<typeof connectAgentMuxRpc>>
  const arrivals: AgentMuxRpcCallContext[] = []
  const gatewayB = new HostRouteGateway({ stateDirectory: join(h.root, 'B'), authority: authorityB,
    edge: () => hostRouteTransport(rpcD), call: (method, params, context) => serverB.callRpc(method, params, context),
    subscribe: (method, params, emit, context) => serverB.subscribeRpc(method, params, emit, context) })
  const gatewayD = new HostRouteGateway({ stateDirectory: join(h.root, 'D'), authority: authorityD,
    edge: () => { throw Error('D is the original execution owner, not a relay') },
    call: async (method, params, context) => { arrivals.push(context); await beforeD?.(context); return await serverD.callRpc(method, params, context) },
    subscribe: (method, params, emit, context) => serverD.subscribeRpc(method, params, emit, context) })
  serverB = new AgentMuxControlServer({ hostRoutes: gatewayB }, join(h.root, 'B.sock'))
  serverD = new AgentMuxControlServer({ hostRoutes: gatewayD, hostedRuntime: () => service }, join(h.root, 'D.sock'))
  await serverD.start(); await serverB.start()
  rpcD = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(h.root, 'D.sock') } })
  const rpcB = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(h.root, 'B.sock') } })
  cleanups.push(async () => { gatewayB.dispose(); gatewayD.dispose(); await rpcB.dispose(); await rpcD.dispose(); await serverB.stop(); await serverD.stop() })
  const route: AdoptedHostRoute = { source: b, hops: [{ edgeId: 'D', target: d }] }
  const grant: HostRouteGrant = { id: 'original-B-user', delegator: b, actor, destination: d, scopes: ['runtime.invoke/submitAgentPrompt'] }
  const configureD = async (grants: HostRouteGrant[]) => {
    const original = await rpcD.call('route.inspect', {})
    await rpcD.call('route.configure', { expectedRevision: original.revision, operationId: 'D-' + Math.random(), configuration: { routes: [], grants } })
  }
  const originalB = await rpcB.call('route.inspect', {})
  await rpcB.call('route.configure', { expectedRevision: originalB.revision, operationId: 'original-route', configuration: { routes: [{ id: 'D', route }], grants: [] } })
  await configureD([grant])
  const entered = barrier(), hold = barrier(), status = h.inner.kernel.status as (runId: string) => Promise<ReturnType<typeof h.run>>
  let first = true
  h.inner.kernel.status = async (id: string) => { if (first) { first = false; entered.resolve(); await hold.pending } return await status(id) }
  cleanups.push(async () => { hold.resolve() })
  const key = { kind: 'prompt' as const, agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, submissionId: 'original-GUI-operation' }
  const call = (signal?: AbortSignal) => routedAgentMuxRpc(rpcB, 'D', route).call('runtime.invoke', { consumerId: 'original-viewer', fence: { runtimeId: 'runtime-D', ownerInstanceId: 'owner-D' },
    invocation: { method: 'submitAgentPrompt', args: [{ agentSessionId: key.agentSessionId, expectedRun: key.expectedRun, operationId: key.submissionId,
      prompt: 'Original explicit GUI input', admissionIntent: { kind: 'manual-actor' }, execution: 'immediate' }] } }, signal ? { signal } : {})
  return { ...h, actor, arrivals, key, call, entered, hold, configureD, grant, gatewayD, policyPath: join(h.root, 'D', 'host-route-settings.json') }
}

test('a real routed first-save reply does not retire the accepted Core input authority before deferred Native dispatch', async () => {
  const f = await fixture()
  const observer = new AbortController()
  const result = await f.call(observer.signal), first = decodeHostedValue(result.value) as AgentInputSubmissionReceipt
  expect(first).toMatchObject({ key: f.key, persistence: 'confirmed', status: 'waiting' })
  await f.entered.pending
  expect(delegatedHostRouteActor(f.arrivals[0]!)).toEqual(f.actor)
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
  expect(Reflect.get(f.gatewayD, 'active').size, 'The finished RPC reader is not retained by the accepted input').toBe(0)
  observer.abort(new Error('The completed original reader is no longer visible'))
  f.hold.resolve()
  try { await expect.poll(async () => (await f.client.inspectAgentInput({ key: f.key }))?.status).toBe('terminal-confirmed') }
  catch {
    const observed = await f.client.inspectAgentInput({ key: f.key })
    expect(observed?.status, 'The original input must dispatch after unary close: ' + JSON.stringify(observed?.control)).toBe('terminal-confirmed')
  }
  expect(f.inner.kernel.input).toHaveBeenCalled()
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

test('the accepted input still checks D receiver revocation before deferred Native bytes without stopping its Session', async () => {
  const f = await fixture()
  const result = await f.call(), first = decodeHostedValue(result.value) as AgentInputSubmissionReceipt
  expect(first).toMatchObject({ key: f.key, persistence: 'confirmed', status: 'waiting' })
  await f.entered.pending
  await f.configureD([])
  f.hold.resolve()
  await expect.poll(async () => {
    const receipt = await f.client.inspectAgentInput({ key: f.key })
    return receipt?.status === 'terminal-confirmed' ||
      receipt?.control.state === 'enabled' && receipt.control.waiting?.failure?.code !== undefined
  }).toBe(true)
  const observed = await f.client.inspectAgentInput({ key: f.key })
  expect(observed?.control.state === 'enabled' ? observed.control.waiting?.failure?.code : undefined,
    'The current D receiver restriction must still reject the original accepted input').toBe('HOST_ROUTE_NOT_DELEGATED')
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
  expect(f.client.agentSession(f.key.agentSessionId).run).toEqual(f.key.expectedRun)
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

test('only the actual routed Session, Run and operation can receive the accepted-input restriction', async () => {
  const denied: string[] = []
  const f = await fixture(async context => {
    expect(context.retainAcceptedInputAuthority).toBeTypeOf('function')
    const original = { kind: 'prompt' as const, agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, submissionId: 'original-GUI-operation' }
    for (const key of [{ ...original, agentSessionId: 'another-SID' }, { ...original, expectedRun: { runId: 'another-Run' } }, { ...original, submissionId: 'another-operation' }]) {
      try { const handle = await context.retainAcceptedInputAuthority!(key); handle.release(); denied.push('incorrectly-retained') }
      catch (error) { denied.push((error as { code: string }).code) }
    }
  })
  await f.call(); await f.entered.pending
  expect(denied).toEqual(['HOST_ROUTE_TARGET_MISMATCH', 'HOST_ROUTE_TARGET_MISMATCH', 'HOST_ROUTE_TARGET_MISMATCH'])
  expect(delegatedHostRouteActor(f.arrivals[0]!)).toEqual(f.actor)
  f.hold.resolve()
  await expect.poll(async () => (await f.client.inspectAgentInput({ key: f.key }))?.status).toBe('terminal-confirmed')
})

test('an unconfirmed D policy write cannot leave an accepted input using the previous receiver grant', async () => {
  const f = await fixture()
  await f.call(); await f.entered.pending
  fault.afterWritePath = f.policyPath
  await expect(f.configureD([])).rejects.toMatchObject({ code: 'HOST_ROUTE_POLICY_SAVE_UNCONFIRMED' })
  f.hold.resolve()
  await expect.poll(async () => {
    const receipt = await f.client.inspectAgentInput({ key: f.key })
    return receipt?.status === 'terminal-confirmed' ||
      receipt?.control.state === 'enabled' && receipt.control.waiting?.failure?.code !== undefined
  }).toBe(true)
  const observed = await f.client.inspectAgentInput({ key: f.key })
  expect(observed?.control.state === 'enabled' ? observed.control.waiting?.failure?.code : undefined,
    'The original D owner must reload its invalidated policy before accepted input dispatch').toBe('HOST_ROUTE_NOT_DELEGATED')
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

test('a stop that wins during authority handoff retains its original input and releases that unused restriction', async () => {
  const acquired = barrier(), release = barrier(), disposed = vi.fn()
  const f = await fixture(async context => {
    const original = context.retainAcceptedInputAuthority!
    context.retainAcceptedInputAuthority = async key => {
      const handle = await original(key)
      acquired.resolve(); await release.pending
      return { assertCurrent: handle.assertCurrent, release: () => { disposed(); handle.release() } }
    }
  })
  const pending = f.call()
  try {
    await acquired.pending
    const saved = await f.client.inspectAgentInput({ key: f.key })
    expect(saved).toMatchObject({ persistence: 'confirmed', status: 'waiting' })
    await f.client.stopAgentInputWaiting({ ref: saved!.ref, cancelOperationId: 'original-stop-during-handoff' })
    release.resolve()
    const reply = decodeHostedValue((await pending).value) as AgentInputSubmissionReceipt
    expect(reply).toMatchObject({ key: f.key, status: 'stopped' })
    expect(disposed).toHaveBeenCalledTimes(1)
    expect(Reflect.get(f.client, 'inputWaitingContexts').size).toBe(0)
    expect(f.inner.kernel.input).not.toHaveBeenCalled()
    expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  } finally { release.resolve(); await pending }
})
