import { afterEach, expect, it, vi } from 'vitest'
import { DurableIngressHost } from '../src/durable-ingress.js'
import { createHostedIngressCorePort } from '../src/core-ingress-port.js'
import * as core from '../../core/dist/index.js'
import { connectHostedAgentMux } from '../../core/dist/hosted.js'
import { AgentMuxHostedRuntimeService } from '../../core/dist/hosted-runtime-service.js'
import { hostedTestOwner } from '../../core/test/helpers/hosted-runtime-port.js'
import { createRpcExternalInputAuthority } from './helpers/rpc-external-input-authority.js'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { ingressFixture } from './fixtures/ingress.js'
import { config, context } from './fixtures/room-binding.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
async function fixture(running = true) {
  const f = await ingressFixture(running); cleanup.push(() => f.close()); return f
}
async function hostedFixture(running: boolean) {
  const f = await fixture(running), businessPath = join(f.root, 'business.sock')
  const service = new AgentMuxHostedRuntimeService(f.client, f.store.path, () => hostedTestOwner(f.client), undefined,
    createRpcExternalInputAuthority({ socketPath: businessPath, executionHostId: 'local' }))
  cleanup.push(() => service.dispose())
  const business = new core.AgentMuxControlServer({ socketPath: businessPath, connections: f.connections, coreClients: f.coreClients })
  await business.start(); cleanup.push(() => business.stop())
  const semantic = new core.AgentMuxControlServer({ socketPath: join(f.root, 'semantic.sock'), hostedRuntime: () => service, coreClients: f.coreClients })
  await semantic.start(); cleanup.push(() => semantic.stop())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: semantic.path } }); cleanup.push(() => rpc.dispose())
  const hosted = await connectHostedAgentMux({ rpc }); cleanup.push(() => hosted.dispose()); await hosted.connect()
  const options = { ...f.options, core: createHostedIngressCorePort(() => [{ hostId: 'local', client: hosted }]) }
  const ingress = new DurableIngressHost(options); f.connections.ingress = ingress
  return { ...f, ingress, options }
}

it('revisits saved claimed input after receiver reconstruction and reuses its exact original wait', async () => {
  const f = await fixture(false), received = await f.receive()
  const first = await f.ingress.dispatch(received.ingress.ingressId)
  expect(first.inputReceipt?.status).toBe('waiting')
  const rejoin = vi.spyOn(f.client, 'rejoinAgentInputWaiting')
  const restarted = new DurableIngressHost(f.options)
  expect(restarted.received(config.connectionId).ingressIds).toContain(received.ingress.ingressId)
  const result = await restarted.dispatch(received.ingress.ingressId)
  expect(rejoin).toHaveBeenCalledOnce()
  expect(rejoin.mock.calls[0]![0]).toEqual({ ref: first.inputReceipt!.ref })
  expect(result.ingress?.input).toEqual(first.ingress?.input)
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
  await restarted.dispatch(received.ingress.ingressId)
  expect(rejoin).toHaveBeenCalledOnce() // retained pending input is backed off, not discarded
})

it('never resumes or rejoins a revoked original while retaining its waiting input', async () => {
  const f = await fixture(false), received = await f.receive(), first = await f.ingress.dispatch(received.ingress.ingressId)
  const rejoin = vi.spyOn(f.client, 'rejoinAgentInputWaiting'), resume = vi.spyOn(f.client, 'ensureAgentContinuity')
  await f.bindings.grant({ ...f.grant, operationId: 'revoke-pending', expectedRevision: 1, state: 'revoked' }, context)
  const restarted = new DurableIngressHost(f.options)
  await expect(restarted.dispatch(received.ingress.ingressId)).rejects.toMatchObject({ code: 'INGRESS_ACTOR_NOT_AUTHORIZED' })
  expect((await restarted.inspect({ ingressId: received.ingress.ingressId })).inputReceipt?.key).toEqual(first.inputReceipt?.key)
  expect(rejoin).not.toHaveBeenCalled(); expect(resume).not.toHaveBeenCalled()
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('uses the original continuity operation for an ended recipient and retains pending intake until recovery is ready', async () => {
  const f = await fixture(), received = await f.receive(), session = f.client.agentSession(f.input.agentSessionId)
  const status = await f.client.runtimeSubject({ kind: 'terminal-run', runId: session.run.runId })
  vi.spyOn(f.client, 'runtimeSubject').mockResolvedValue({ ...status, run: { ...status.run, state: 'exited', exitCode: 0 } })
  const resume = vi.spyOn(f.client, 'ensureAgentContinuity').mockResolvedValue({ kind: 'pending', agentSessionId: session.agentSessionId,
    previousRun: session.run, reason: 'runtime-unverified', evidence: { kind: 'run-missing', observedAt: 1 } } as never)
  await expect(f.ingress.dispatch(received.ingress.ingressId)).rejects.toMatchObject({ code: 'INGRESS_RECOVERY_PENDING' })
  const restarted = new DurableIngressHost(f.options)
  await expect(restarted.dispatch(received.ingress.ingressId)).rejects.toMatchObject({ code: 'INGRESS_RECOVERY_PENDING' })
  expect(resume).toHaveBeenCalledTimes(2)
  expect(resume.mock.calls[0]![0]).toEqual(resume.mock.calls[1]![0])
  expect(resume.mock.calls[0]![0]).toMatchObject({ agentSessionId: session.agentSessionId, expectedRun: session.run, trigger: 'input' })
  expect(resume.mock.calls[0]![0]).not.toHaveProperty('input')
  expect((await restarted.inspect({ ingressId: received.ingress.ingressId })).ingress?.state).toBe('received')
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
})

it('keeps healthy recipient input available without creating recovery operations', async () => {
  const f = await fixture(), resume = vi.spyOn(f.client, 'ensureAgentContinuity'), received = await f.receive()
  const first = await f.ingress.dispatch(received.ingress.ingressId)
  expect(first.ingress?.state).toBe('claimed')
  await vi.waitFor(async () => expect((await f.ingress.inspect({ ingressId: received.ingress.ingressId })).inputReceipt?.status).toBe('terminal-confirmed'))
  expect(resume).not.toHaveBeenCalled()
  expect(f.ingress.received(config.connectionId).ingressIds).not.toContain(received.ingress.ingressId)
  expect(f.inner.kernel.input).toHaveBeenCalledOnce()
})

it('a saved unknown operation stays observable without creating a fresh input attempt', async () => {
  const f = await fixture(), received = await f.receive()
  vi.mocked(f.inner.kernel.input).mockRejectedValue(new Error('Original write result unavailable'))
  await f.ingress.dispatch(received.ingress.ingressId)
  await vi.waitFor(async () => expect((await f.ingress.inspect({ ingressId: received.ingress.ingressId })).inputReceipt?.status).toBe('unknown'))
  const rejoin = vi.spyOn(f.client, 'rejoinAgentInputWaiting'), resume = vi.spyOn(f.client, 'ensureAgentContinuity')
  const restarted = new DurableIngressHost(f.options)
  await restarted.dispatch(received.ingress.ingressId)
  expect(rejoin).not.toHaveBeenCalled(); expect(resume).not.toHaveBeenCalled()
  expect(f.inner.kernel.input).toHaveBeenCalledOnce()
})

it('retains an authoritative confirmed receipt if the derived work index cannot be updated', async () => {
  const f = await fixture(), received = await f.receive()
  await f.ingress.dispatch(received.ingress.ingressId)
  await vi.waitFor(async () => expect((await f.ingress.inspect({ ingressId: received.ingress.ingressId })).inputReceipt?.status).toBe('terminal-confirmed'))
  const restarted = new DurableIngressHost(f.options), database = Reflect.get(restarted, 'database') as DatabaseSync
  const prepare = database.prepare.bind(database)
  vi.spyOn(database, 'prepare').mockImplementation(sql => {
    if (sql.startsWith('UPDATE connection_ingress_message SET input_settled')) throw new Error('Derived index write unavailable')
    return prepare(sql)
  })
  expect(await restarted.inspect({ ingressId: received.ingress.ingressId })).toMatchObject({ observation: 'observed', inputReceipt: { status: 'terminal-confirmed' } })
  expect(f.inner.kernel.input).toHaveBeenCalledOnce()
})

it.each(['mention', 'reply'] as const)('continues the original %s input through Hosted authority after receiver reconstruction', async selection => {
  const f = await hostedFixture(false)
  const received = await f.ingress.receive({ connectionId: config.connectionId, raw: JSON.stringify({ proof: 'adapter-private-witness', event: f.event({ selection }) }) }, vi.fn())
  const first = await f.ingress.dispatch(received.ingress.ingressId)
  expect(first.inputReceipt?.status).toBe('waiting')
  const rejoin = vi.spyOn(f.client, 'rejoinAgentInputWaiting'), restarted = new DurableIngressHost(f.options)
  f.connections.ingress = restarted
  const after = await restarted.dispatch(received.ingress.ingressId)
  expect(rejoin).toHaveBeenCalledOnce()
  expect(rejoin.mock.calls[0]![0]).toEqual({ ref: first.inputReceipt!.ref })
  expect(after.ingress?.input).toEqual(first.ingress?.input)
  expect(after.inputReceipt?.key).toEqual(first.inputReceipt?.key)
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
})

it('automatically retries two wholly unapplied originals through Hosted in their saved order', async () => {
  const f = await hostedFixture(true), write = f.inner.kernel.input.bind(f.inner.kernel)
  const refused = vi.spyOn(f.inner.kernel, 'input').mockRejectedValue(new core.AgentMuxError(
    'This complete input was not applied.', 'CTXMUX_input_cursor_mismatch', 'not_applied', { disposition: 'not_applied', confirmedInputBytes: 0 }))
  const originals: Array<Awaited<ReturnType<DurableIngressHost['inspect']>>> = []
  for (const [index, selection] of (['mention', 'reply'] as const).entries()) {
    const received = await f.ingress.receive({ connectionId: config.connectionId, raw: JSON.stringify({ proof: 'adapter-private-witness',
      event: f.event({ eventId: `retry-event-${index}`, messageId: `retry-message-${index}`, body: `Retained original ${index}`, selection }) }) }, vi.fn())
    await f.ingress.dispatch(received.ingress.ingressId)
    await vi.waitFor(async () => expect((await f.ingress.inspect({ ingressId: received.ingress.ingressId })).inputReceipt?.status).toBe('not-applied'))
    originals.push(await f.ingress.inspect({ ingressId: received.ingress.ingressId }))
  }
  refused.mockImplementation(write)
  const written: string[] = []
  refused.mockImplementation(async (...args) => { written.push(String(args[1].data)); return await write(...args) })
  const restarted = new DurableIngressHost(f.options); f.connections.ingress = restarted
  const candidates = restarted.received(config.connectionId).ingressIds
  expect(candidates).toEqual(originals.map(original => original.ingress!.ingressId))
  await Promise.all(candidates.map(id => restarted.dispatch(id)))
  for (const original of originals) {
    const id = original.ingress!.ingressId
    await vi.waitFor(async () => expect((await restarted.inspect({ ingressId: id })).inputReceipt?.status).toBe('terminal-confirmed'))
    const result = await restarted.inspect({ ingressId: id })
    expect(result.ingress?.input).toEqual(original.ingress?.input)
    expect(result.inputReceipt?.key).toEqual(original.inputReceipt?.key)
    expect(result.inputReceipt?.ref.waitGeneration).toBe(original.inputReceipt!.ref.waitGeneration + 1)
    expect((await f.client.inspectAgentPromptSubmission(original.inputReceipt!.key))?.admission?.notApplied).toBe(true)
  }
  expect(written).toHaveLength(2)
  expect(written[0]).toContain('Retained original 0'); expect(written[1]).toContain('Retained original 1')
  expect(restarted.received(config.connectionId).ingressIds).toEqual([])
  expect(f.client.agentSession(f.input.agentSessionId).run).toEqual(f.session.run)
}, 20_000)

it('keeps stopped originals visible without automatically resuming them', async () => {
  const f = await fixture(false), received = await f.receive(), first = await f.ingress.dispatch(received.ingress.ingressId)
  await f.client.stopAgentInputWaiting({ ref: first.inputReceipt!.ref, cancelOperationId: 'stop-original-wait' })
  const rejoin = vi.spyOn(f.client, 'rejoinAgentInputWaiting'), resume = vi.spyOn(f.client, 'ensureAgentContinuity')
  const restarted = new DurableIngressHost(f.options), result = await restarted.dispatch(received.ingress.ingressId)
  expect(result.inputReceipt?.control.state).toBe('stopped-before-dispatch')
  expect(result.inputReceipt?.key).toEqual(first.inputReceipt?.key)
  expect(rejoin).not.toHaveBeenCalled(); expect(resume).not.toHaveBeenCalled()
})

it('pages only unfinished original inputs in order after settled history grows', async () => {
  const f = await fixture()
  for (let n = 0; n < 30; n++) {
    const received = await f.receive({ eventId: `settled-event-${n}`, messageId: `settled-message-${n}` })
    await f.ingress.dispatch(received.ingress.ingressId)
    await vi.waitFor(async () => expect((await f.ingress.inspect({ ingressId: received.ingress.ingressId })).inputReceipt?.status).toBe('terminal-confirmed'))
  }
  f.inner.connected = false; f.inner.kernel.isConnected = () => false
  const pending: string[] = []
  for (let n = 0; n < 3; n++) {
    const received = await f.receive({ eventId: `pending-event-${n}`, messageId: `pending-message-${n}` })
    expect((await f.ingress.dispatch(received.ingress.ingressId)).inputReceipt?.status).toBe('waiting')
    pending.push(received.ingress.ingressId)
  }
  const restarted = new DurableIngressHost(f.options), page = restarted.received(config.connectionId, undefined, 2)
  expect(page).toEqual({ ingressIds: pending.slice(0, 2), nextAfterIngressId: pending[1] })
  expect(restarted.received(config.connectionId, page.nextAfterIngressId!, 2)).toEqual({ ingressIds: pending.slice(2), nextAfterIngressId: null })
  expect(f.inner.kernel.input).toHaveBeenCalledTimes(30)
}, 20_000)
