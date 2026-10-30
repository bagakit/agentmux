import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { withAgentInputClaimLease, type AgentInputClaimLease } from '../src/agent-input-claim-lease.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { DurableAgentMuxMessageQueue } from '../src/agent-global-message-queue.js'
import type { AgentInputSubmissionReceipt } from '../src/agent-input-wait.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { const errors: unknown[] = []; for (const close of cleanup.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }; vi.restoreAllMocks(); vi.unstubAllEnvs(); if (errors.length) throw new AggregateError(errors) })
async function settled(client: unknown) {
  const core = client as { inputWaitingRecipients: Map<string, { pending: Promise<void> }> }
  for (;;) { const entries = [...core.inputWaitingRecipients.values()]; if (!entries.length) return; await Promise.all(entries.map(value => value.pending)) }
}
async function fixture(render = false) {
  const f = await rpcOwnerFixture(['recipient', 'independent']); cleanup.push(f.close)
  const queue = Reflect.get(f.client, 'messageQueue') as DurableAgentMuxMessageQueue
  const provider = Reflect.get(f.client, 'providers').get('codex')
  const plan = render ? { kind: 'render-then-submit' as const, payload: 'Original carrier\n原文', renderedText: 'Original carrier\n原文', submit: '\r' }
    : { kind: 'single-phase' as const, data: 'Original carrier\n原文\r' }
  const planner = vi.spyOn(provider, 'planPromptInput').mockReturnValue(plan)
  const input = { agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, operationId: 'original-handoff', prompt: 'Original carrier\n原文',
    authorHuman: true, execution: 'immediate' as const, admissionIntent: { kind: 'manual-actor' as const } }
  const key = { kind: 'prompt' as const, agentSessionId: input.agentSessionId, expectedRun: input.expectedRun, submissionId: input.operationId }
  const owner = { runtimeId: 'handoff-runtime', ownerInstanceId: 'handoff-owner', protocolVersion: 2 as const, processId: process.pid,
    ctxmux: f.client.runtimeIdentity(), availability: 'connected' as const }
  const service = new AgentMuxHostedRuntimeService(f.client, f.store.path, () => owner); cleanup.push(() => service.dispose())
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'handoff.sock'), coreClients: f.coreClients, hostedRuntime: () => service })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
  const hosted = await connectHostedAgentMux({ rpc }); cleanup.push(() => hosted.dispose())
  return { ...f, queue, plan, planner, input, key, rpc, hosted, server }
}

it.each(['sdk', 'hosted', 'cli'] as const)('continues an original frozen PTY gate once through %s without selecting another Provider carrier', async route => {
  const f = await fixture(route === 'hosted')
  const gate = f.queue.authorizeInputDispatch.bind(f.queue)
  vi.spyOn(f.queue, 'authorizeInputDispatch').mockImplementationOnce(async (...args) => { await gate(...args); throw Error('Original gate durable; claim callback never entered') })
  await f.client.submitAgentPrompt(f.input); await settled(f.client)
  const before = (await f.client.inspectAgentInput({ key: f.key }))!
  expect(before).toMatchObject({ status: 'unknown', admission: null, control: { state: 'dispatch-authorized', handoff: { version: 1, carrier: { kind: 'pty', plan: f.plan } } } })
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
  f.planner.mockImplementation(() => { throw Error('A newer Provider must not reselect this original carrier') })
  if (route === 'sdk') await f.client.rejoinAgentInputWaiting({ ref: before.ref })
  else if (route === 'hosted') await f.hosted.rejoinAgentInputWaiting({ ref: before.ref })
  else {
    const cli = await runCompiledObjectCli(['--endpoint', 'unix:' + f.server.path, 'agent', 'input', 'rejoin', '--input', '-'], objectCliEnvironment(f.root), JSON.stringify({ ref: before.ref }))
    expect(cli.code, cli.stdout + cli.stderr).toBe(0)
  }
  await settled(f.client)
  const after = (await f.client.inspectAgentInput({ key: f.key }))!
  expect(after).toMatchObject({ key: before.key, ref: before.ref, status: 'terminal-confirmed', control: before.control })
  expect((await f.rpc.call('agent.input.inspect', { key: f.key })).input).toEqual(after)
  const calls = (f.inner.kernel.input as ReturnType<typeof vi.fn>).mock.calls
  expect(calls.map(call => call[1].data)).toEqual(f.plan.kind === 'single-phase' ? [f.plan.data] : [f.plan.payload, f.plan.submit])
  await f.client.rejoinAgentInputWaiting({ ref: before.ref }); await settled(f.client)
  expect(f.inner.kernel.input).toHaveBeenCalledTimes(calls.length)
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 25_000)

it('only a live exact private claim lease may mint a resumable gate; legacy or forged origins stay unknown', async () => {
  const owner = await rpcOwnerFixture(['recipient']); cleanup.push(owner.close)
  const input = { agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, operationId: 'private-lease-input', prompt: 'Retained private input', authorHuman: true, execution: 'immediate' as const, admissionIntent: { kind: 'manual-actor' as const } }
  const f = { ...owner, queue: Reflect.get(owner.client, 'messageQueue') as DurableAgentMuxMessageQueue, input,
    key: { kind: 'prompt' as const, agentSessionId: input.agentSessionId, expectedRun: input.expectedRun, submissionId: input.operationId },
    plan: { kind: 'single-phase' as const, data: input.prompt + '\r' } }
  Reflect.set(f.client, 'connected', false)
  const saved = await f.client.submitAgentPrompt(f.input) as AgentInputSubmissionReceipt
  await settled(f.client)
  const carrier = { kind: 'pty' as const, plan: f.plan }
  const snapshot = await f.queue.inspectInput({ key: f.key })
  for (const lease of [{}, JSON.parse('{}')]) await expect(f.queue.authorizeInputDispatch(saved.ref, undefined, undefined, { lease: lease as AgentInputClaimLease, carrier })).rejects.toMatchObject({ code: 'AGENT_INPUT_CLAIM_LEASE_INVALID' })
  await withAgentInputClaimLease(new AgentMuxMemoryAgentSessionStore(), f.queue.queueId, f.key, async lease => {
    await expect(f.queue.authorizeInputDispatch(saved.ref, undefined, undefined, { lease, carrier })).rejects.toMatchObject({ code: 'AGENT_INPUT_CLAIM_LEASE_INVALID' })
  })
  let expired!: AgentInputClaimLease
  await withAgentInputClaimLease(f.store, f.queue.queueId, f.key, async lease => {
    expired = lease
    const wrong = new DurableAgentMuxMessageQueue(join(f.root, 'other.ndjson'))
    await expect(wrong.authorizeInputDispatch(saved.ref, undefined, undefined, { lease, carrier })).rejects.toMatchObject({ code: 'AGENT_INPUT_CLAIM_LEASE_INVALID' })
    await expect(f.queue.authorizeInputDispatch({ ...saved.ref, key: { ...f.key, submissionId: 'other-input' } }, undefined, undefined, { lease, carrier })).rejects.toMatchObject({ code: 'AGENT_INPUT_CLAIM_LEASE_INVALID' })
  })
  await expect(f.queue.authorizeInputDispatch(saved.ref, undefined, undefined, { lease: expired, carrier })).rejects.toMatchObject({ code: 'AGENT_INPUT_CLAIM_LEASE_INVALID' })
  expect(await f.queue.inspectInput({ key: f.key })).toEqual(snapshot)
  await f.queue.authorizeInputDispatch(saved.ref)
  Reflect.set(f.client, 'connected', true)
  const legacy = await f.client.rejoinAgentInputWaiting({ ref: saved.ref })
  expect(legacy, JSON.stringify(legacy)).toMatchObject({ status: 'unknown', admission: null })
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
})

it('an original writer holding the shared Session lock cannot be stolen by a concurrent gate rejoin', async () => {
  const f = await fixture()
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve }), held = new Promise<void>(resolve => { release = resolve })
  const gate = f.queue.authorizeInputDispatch.bind(f.queue)
  vi.spyOn(f.queue, 'authorizeInputDispatch').mockImplementationOnce(async (...args) => { const link = await gate(...args); enter(); await held; return link })
  await f.client.submitAgentPrompt(f.input)
  await entered
  const before = (await f.client.inspectAgentInput({ key: f.key }))!
  const second = new (f.client.constructor as typeof import('../src/client.js').AgentMuxClient)({ store: f.store })
  cleanup.push(() => second.dispose())
  const inner = second as any
  await inner.registry.load('local'); inner.connected = true
  inner.kernel.isConnected = () => true; inner.kernel.identity = f.inner.kernel.identity; inner.kernel.status = f.inner.kernel.status; inner.kernel.input = f.inner.kernel.input
  vi.spyOn(inner.providers.get('codex'), 'planPromptInput').mockImplementation(() => { throw Error('Original carrier is frozen') })
  try {
    await second.rejoinAgentInputWaiting({ ref: before.ref }); await settled(second)
    expect(await second.inspectAgentInput({ key: f.key })).toMatchObject({ status: 'unknown', admission: null, control: before.control })
    expect(f.inner.kernel.input, 'a live original claim writer has not released its dispatch owner').not.toHaveBeenCalled()
  } finally { release() }
  await settled(f.client)
  expect(await f.client.inspectAgentInput({ key: f.key })).toMatchObject({ status: 'terminal-confirmed' })
  expect(f.inner.kernel.input).toHaveBeenCalledOnce()
})
