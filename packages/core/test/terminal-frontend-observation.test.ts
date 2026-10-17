import { fixtureEpoch as _batchFixtureEpoch } from "../../../test/fixture-values.mjs"
import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import type { AgentProvider } from '../src/agent-provider.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'

type Observation = Parameters<NonNullable<AgentProvider['observeTerminalFrontend']>>[0]
const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { vi.useRealTimers(); for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

async function fixture(ids = ['recipient']) {
  const h = await rpcOwnerFixture(ids), inner = h.client as any, provider = h.client.providers.get('codex')
  cleanups.push(h.close)
  const actor = { protocolId: 'fixture-frontend-protocol', actorId: 'original-actor', lifecycleOperationId: 'original-create', token: 'a'.repeat(64),
    frontendControl: true as const, launch: { command: 'codex', args: [] } }
  for (const id of ids) await inner.registry.update(id, { runId: 'run-' + id }, (session: AgentMuxStoredAgentSession) => ({ ...session, nativeActor: actor }))
  const status = inner.kernel.status
  inner.kernel.status = vi.fn(async (id: string) => ({ ...await status(id), pid: 123 }))
  const contexts: Observation[] = [], disposed: ReturnType<typeof vi.fn>[] = []
  const observe = vi.spyOn(provider as AgentProvider & { observeTerminalFrontend: NonNullable<AgentProvider['observeTerminalFrontend']> }, 'observeTerminalFrontend').mockImplementation(async (context: Observation) => {
    contexts.push(context)
    const dispose = vi.fn(); disposed.push(dispose)
    context.onFrontend({ frontendId: 'first-generation', state: 'attached', backendState: 'running', source: 'managed-process', observedAt: _batchFixtureEpoch(0, 0, 100) })
    return { dispose }
  })
  const ensure = (id = ids[0]!) => inner.ensureTerminalFrontendObservation(inner.registry.get(id)) as Promise<boolean>
  return { ...h, inner, provider, observe, contexts, disposed, ensure, actor }
}

it('recovers a first missing control endpoint without any client refresh or session action', async () => {
  const f = await fixture()
  f.observe.mockRejectedValueOnce(Object.assign(new Error('Private control ENOENT'), { code: 'ENOENT' }))
  expect(await f.ensure()).toBe(false)
  expect(f.client.agentSession('recipient').terminalFrontend).toMatchObject({ state: 'unknown', message: 'Private control ENOENT' })
  await vi.waitFor(() => expect(f.client.agentSession('recipient').terminalFrontend?.state).toBe('attached'))
  expect(f.observe).toHaveBeenCalledTimes(2)
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  await new Promise(resolve => setTimeout(resolve, 300)); expect(f.observe).toHaveBeenCalledTimes(2)
})

it('reestablishes a failed subscription and accepts older Provider facts after local unknown', async () => {
  const f = await fixture(); await f.ensure()
  f.contexts[0]!.onUnavailable('Private observer lost its connection')
  expect(f.client.agentSession('recipient').terminalFrontend?.state).toBe('unknown')
  await vi.waitFor(() => expect(f.observe).toHaveBeenCalledTimes(2))
  expect(f.client.agentSession('recipient').terminalFrontend).toMatchObject({ state: 'attached', observedAt: _batchFixtureEpoch(0, 0, 100) })
  expect(f.disposed[0]).toHaveBeenCalledOnce()
  f.contexts[0]!.onFrontend({ frontendId: 'obsolete', state: 'detached', backendState: 'running', source: 'managed-process', observedAt: Date.now(), exitCode: 23 })
  expect(f.client.agentSession('recipient').terminalFrontend?.frontendId).toBe('first-generation')
})

it('deduplicates retry requests and does no work for unrelated Session events', async () => {
  const f = await fixture()
  f.observe.mockRejectedValueOnce(new Error('Private first observation unavailable'))
  await f.ensure()
  await Promise.all(Array.from({ length: 100 }, () => f.ensure()))
  expect(f.observe).toHaveBeenCalledOnce()
  await vi.waitFor(() => expect(f.observe).toHaveBeenCalledTimes(2))
  const calls = f.inner.kernel.status.mock.calls.length
  for (let i = 0; i < 100; i++) f.inner.continuitySupervisor.wake('unrelated')
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(f.inner.kernel.status).toHaveBeenCalledTimes(calls)
})

it('cancels only the replaced actor reader and retries independent sessions separately', async () => {
  const f = await fixture(['first', 'second'])
  f.observe.mockRejectedValueOnce(new Error('first endpoint unavailable'))
  await f.ensure('first'); await f.ensure('second')
  const second = f.contexts[0]!
  await f.inner.registry.update('first', { runId: 'run-first' }, (session: AgentMuxStoredAgentSession) => ({ ...session,
    nativeActor: { ...f.actor, actorId: 'replacement-actor' } }))
  await f.ensure('first')
  expect(second.signal.aborted).toBe(false)
  await new Promise(resolve => setTimeout(resolve, 300))
  expect(f.observe).toHaveBeenCalledTimes(3)
  expect(f.client.agentSession('second').terminalFrontend?.state).toBe('attached')
})

it('disconnect cancels an in-flight Provider read and disposes its late subscription', async () => {
  const f = await fixture(), result = Promise.withResolvers<{ dispose(): void }>(), entered = Promise.withResolvers<void>(), dispose = vi.fn()
  f.observe.mockImplementationOnce(async () => { entered.resolve(); return await result.promise })
  const observation = f.ensure(); await entered.promise
  f.client.disconnect()
  expect(await observation).toBe(false)
  result.resolve({ dispose }); await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce())
  expect(f.inner.terminalFrontendWatches.size).toBe(0)
})

it('dispose removes failed-reader timers while ordinary healthy input remains usable before disposal', async () => {
  const f = await fixture()
  f.observe.mockRejectedValue(new Error('Private optional control unavailable'))
  await f.ensure()
  await f.client.writeAgent({ agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, source: 'user', data: 'ordinary input' })
  expect(f.inner.kernel.input).toHaveBeenCalledOnce(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  await f.client.dispose()
  await new Promise(resolve => setTimeout(resolve, 300))
  expect(f.observe).toHaveBeenCalledOnce(); expect(f.inner.terminalFrontendWatches.size).toBe(0)
})

it('a new handshake waits for recovered current generation, while a historical ACK remains unchanged', async () => {
  const f = await fixture()
  f.observe.mockRejectedValueOnce(new Error('Private control not yet listening'))
  await f.inner.observeInitialTerminalFrontend(f.inner.registry.get('recipient'))
  expect(f.client.agentSession('recipient').terminalFrontend?.frontendId).toBe('first-generation')
  const ack = { run: { runId: 'run-recipient' }, operationId: 'old-ack', inputByteRange: { startByte: 0, endByte: 5 }, acknowledged: true }
  await f.inner.registry.update('recipient', ack.run, (session: AgentMuxStoredAgentSession) => ({ ...session, terminalHandshake: ack }))
  await f.ensure()
  expect((await f.store.readMetadata('recipient'))!.terminalHandshake).toEqual(ack)
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
})

it('changing the canonical Run cancels its old retry without touching the new Run', async () => {
  const f = await fixture()
  f.observe.mockRejectedValueOnce(new Error('Original control still missing'))
  await f.ensure()
  const first = f.inner.terminalFrontendWatches.get('recipient')
  const replacement = await f.inner.registry.update('recipient', { runId: 'run-recipient' }, (session: AgentMuxStoredAgentSession) => ({ ...session, run: { runId: 'replacement-run' } }))
  f.inner.publishSession(replacement)
  expect(first.controller.signal.aborted).toBe(true)
  await new Promise(resolve => setTimeout(resolve, 300))
  expect(f.observe).toHaveBeenCalledOnce(); expect(f.inner.kernel.input).not.toHaveBeenCalled()
})

it('bounds initial generation waiting even when the Provider opening never replies', async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>()
  f.observe.mockImplementationOnce(async () => { entered.resolve(); return await new Promise(() => {}) })
  vi.useFakeTimers()
  const waiting = f.inner.observeInitialTerminalFrontend(f.inner.registry.get('recipient'))
  const outcome = expect(waiting).rejects.toMatchObject({ code: 'AGENT_TERMINAL_HANDSHAKE_TIMEOUT' })
  await entered.promise; await vi.advanceTimersByTimeAsync(10_000); await outcome
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('binds the unconsumed initial composer to its first observed generation alongside the real query ACK', async () => {
  const f = await fixture(), hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('base64url')
  const handshake = f.provider.terminalHandshake!, run = { runId: 'run-recipient' }
  const unscoped = hash(['agentmux-terminal-handshake-v1', 'codex', run.runId, handshake.query, handshake.response])
  const provisional = { source: 'initial-composer' as const, id: hash(['agentmux-terminal-prompt-readiness-v1', 'initial-composer', 'codex', run.runId, unscoped]), run, outputCursorBytes: 0 }
  await f.inner.registry.update('recipient', run, (session: AgentMuxStoredAgentSession) => ({ ...session, terminalPromptReadiness: provisional }))
  f.inner.kernel.observeOutput = vi.fn(async () => ({ run: { ...f.run(run.runId), pid: 123 }, replay: [{ data: handshake.query }], close: vi.fn(async () => {}) }))
  const opening = f.inner.ensureTerminalHandshake(f.inner.registry.get('recipient'))
  await expect(opening).resolves.toMatchObject({ terminalHandshake: { frontendId: 'first-generation', acknowledged: true } })
  const next = await opening
  expect(next.terminalHandshake).toMatchObject({ run, frontendId: 'first-generation', acknowledged: true, inputByteRange: { startByte: 0, endByte: Buffer.byteLength(handshake.response) } })
  expect(next.terminalPromptReadiness.id).not.toBe(provisional.id)
  expect(next.terminalPromptReadiness.consumedBySubmissionId).toBeUndefined()
  expect(f.inner.kernel.input).toHaveBeenCalledOnce()
  expect(f.inner.kernel.input.mock.calls[0][1].data).toBe(handshake.response)
})
