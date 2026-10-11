import { afterEach, expect, it, vi } from 'vitest'
import { ingressFixture } from './fixtures/ingress.js'
import { context } from './fixtures/room-binding.js'
import { DurableIngressHost } from '../src/durable-ingress.js'
import { parseRoomBindingParams, parseRoomBindingResult } from '../../core/src/room-binding-codec.js'
import type { AgentProvider } from '../../core/src/agent-provider.js'
import type { AgentExternalInputIntent } from '../../core/src/external-author.js'
import { parseConnectionIngressRecord } from '../../core/src/ingress-codec.js'
import { join } from 'node:path'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
async function fixture() { const f = await ingressFixture(true); cleanup.push(f.close); return f }
const inputTarget = { kind: 'native-conversation' as const, source: { providerId: 'claude', nativeSessionId: 'ingress-native' } }
async function selectNative(f: Awaited<ReturnType<typeof fixture>>) {
  const linked = await f.bindings.relink({ ...f.input, operationId: 'select-native-source', expectedRevision: 1, inputTarget }, context)
  expect(linked).toMatchObject({ state: 'applied', binding: { revision: 2, inputTarget } })
  await f.bindings.grant({ ...f.grant, operationId: 'grant-native-source', expectedBindingRevision: 2, expectedRevision: 1 }, context)
  return await prepareNativeActor(f)
}
async function prepareNativeActor(f: Awaited<ReturnType<typeof fixture>>) {
  const original = (await f.store.readMetadata(f.input.agentSessionId))!
  await f.store.compareAndSwap(original, { ...original, nativeActor: { protocolId: 'fixture-native-protocol', actorId: 'original-native-actor', lifecycleOperationId: 'original-launch', token: 'a'.repeat(64), launch: { command: 'fixture-cli', args: [] } } })
  await f.inner.registry.load('local')
  f.inner.kernel.status = vi.fn(async (runId: string) => ({ ...f.run(runId), pid: 1234 }))
  const sends = vi.fn(async () => ({ outcome: 'admitted' as const, turnId: 'original-native-turn' }))
  const provider = (f.client as unknown as { providers: { get(id: string): AgentProvider } }).providers.get('claude')
  provider.prepareNativeInput = vi.fn<NonNullable<AgentProvider['prepareNativeInput']>>(async (ctx, target) => {
    expect(target).toEqual(inputTarget.source)
    return { plan: { kind: 'native-rpc', protocolId: ctx.nativeActor.protocolId, actorId: ctx.nativeActor.actorId, sourceId: JSON.stringify(['claude', 'ingress-native']), threadId: target.nativeSessionId, operation: 'start-or-steer' }, send: sends, dispose: vi.fn() }
  })
  return { sends }
}

it('freezes a newly confirmed Binding native target into the original ingress claim and shares the existing Core input journal', async () => {
  const f = await fixture(), { sends } = await selectNative(f)
  const received = await f.receive(), dispatched = await f.ingress.dispatch(received.ingress.ingressId)
  const ref = dispatched.ingress?.input
  expect(ref).toMatchObject({ agentSessionId: f.input.agentSessionId, expectedRun: f.session.run, admissionIntent: { ...inputTarget, expectedRun: f.session.run } })
  if (!ref || !('messageId' in ref)) throw new Error('Original message claim is missing')
  await expect.poll(async () => (await f.ingress.inspect({ ingressId: received.ingress.ingressId })).inputReceipt?.status).toBe('admitted')
  const page = await f.client.readAgentInputMailbox({ agentSessionId: f.input.agentSessionId })
  expect(page.items).toHaveLength(1); expect(page.items[0]).toMatchObject({ kind: 'item', item: { intent: { key: { kind: 'message', messageId: ref.messageId }, admissionIntent: ref.admissionIntent }, message: { sender: ref.author } } })
  const reopened = new DurableIngressHost(f.options)
  expect((await reopened.inspect({ ingressId: received.ingress.ingressId })).ingress).toEqual(dispatched.ingress)
  await reopened.dispatch(received.ingress.ingressId); expect(sends).toHaveBeenCalledTimes(1)
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('does not let a copied external author/body borrow another target or upgrade an old claim with no frozen intent', async () => {
  const f = await fixture(), { sends } = await selectNative(f), received = await f.receive(), dispatched = await f.ingress.dispatch(received.ingress.ingressId)
  const record = dispatched.ingress
  if (!record || record.kind === 'action' || !record.input) throw new Error('The original message input was not claimed')
  await expect.poll(async () => sends.mock.calls.length).toBe(1)
  const host = f.ingress as unknown as { context(originalRecord: typeof record): { externalAuthor: { assertCurrent(intent: AgentExternalInputIntent): void } } }
  const actual = { agentSessionId: record.input.agentSessionId, expectedRun: record.input.expectedRun, operationId: record.input.operationId, messageId: record.input.messageId, body: record.body,
    admissionIntent: { ...inputTarget, expectedRun: record.input.expectedRun } }
  expect(() => host.context(record).externalAuthor.assertCurrent(actual)).not.toThrow()
  for (const changed of [
    { ...actual, admissionIntent: { ...actual.admissionIntent, source: { ...inputTarget.source, nativeSessionId: 'other-source' } } },
    { ...actual, admissionIntent: { kind: 'manual-actor' as const, expectedRun: actual.expectedRun } },
    { ...actual, expectedRun: { runId: 'another-run' } }
  ]) expect(() => host.context(record).externalAuthor.assertCurrent(changed)).toThrow()
  const historical = structuredClone(record); delete historical.input!.admissionIntent
  expect(parseConnectionIngressRecord(historical)).toEqual(historical)
  expect(() => host.context(historical).externalAuthor.assertCurrent(actual)).toThrow()
  expect(sends).toHaveBeenCalledTimes(1)
})

it('requires an explicit new bind/relink source choice, rejects per-turn binding targets and returns the exact safe target in public results', async () => {
  const f = await fixture()
  expect(f.bindings.readCurrent(f.input.bindingId)).not.toHaveProperty('inputTarget')
  const request = { ...f.input, operationId: 'explicit-native-relink', expectedRevision: 1, inputTarget }
  expect(parseRoomBindingParams('connection.binding.relink', request)).toEqual(request)
  const applied = await f.bindings.relink(request, context)
  expect(parseRoomBindingResult('connection.binding.relink', applied, request)).toEqual(applied)
  for (const malformed of [{ ...inputTarget, expectedTurnId: 'stale-turn' }, { ...inputTarget, expectedRun: f.session.run }, { kind: 'manual-actor' }]) {
    expect(() => parseRoomBindingParams('connection.binding.relink', { ...request, inputTarget: malformed })).toThrow()
  }
  const defaultAgain = await f.bindings.relink({ ...f.input, operationId: 'explicit-default-relink', expectedRevision: 2 }, context)
  expect(defaultAgain).toMatchObject({ state: 'applied', binding: { revision: 3 } })
  if (defaultAgain.state !== 'applied') throw new Error('The new explicit original TTY target did not apply')
  expect(defaultAgain.binding).not.toHaveProperty('inputTarget')
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
})

it.runIf(process.env.AGENTMUX_NATIVE_INPUT_COMPILED === '1')('compiled CLI and real RPC retain the selected Binding source and deliver explicit local and external intents through the same original Core journal', async () => {
  const f = await fixture(), core = await import('../../core/dist/index.js')
  const path = join(f.root, 'native-input.sock'), server = new core.AgentMuxControlServer({ socketPath: path, coreClients: f.coreClients, connections: f.connections })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path } }); cleanup.push(() => rpc.dispose())
  const env = objectCliEnvironment(f.root), endpoint = ['--endpoint', 'unix://' + path]
  const request = { ...f.input, operationId: 'cli-explicit-native-relink', expectedRevision: 1, inputTarget }
  const linked = await runCompiledObjectCli([...endpoint, 'connection', 'binding', 'relink', '--input', '-'], env, JSON.stringify(request))
  expect(linked.code, linked.stderr).toBe(0)
  expect(JSON.parse(linked.stdout).result).toMatchObject({ state: 'applied', binding: { revision: 2, inputTarget } })
  expect(await rpc.call('connection.binding.inspect', { bindingId: f.input.bindingId })).toMatchObject({ binding: { revision: 2, inputTarget } })
  await f.bindings.grant({ ...f.grant, operationId: 'grant-cli-native-source', expectedBindingRevision: 2, expectedRevision: 1 }, context)
  const { sends } = await prepareNativeActor(f)
  const received = await f.receive(), external = await f.ingress.dispatch(received.ingress.ingressId)
  await expect.poll(async () => (await f.ingress.inspect({ ingressId: received.ingress.ingressId })).inputReceipt?.status).toBe('admitted')
  const packet = { operationId: 'cli-addressed-native', target: { kind: 'agent-session', agentSessionId: f.input.agentSessionId }, execution: 'immediate', text: 'Original explicit CLI input',
    admissionIntent: { ...inputTarget, expectedRun: f.session.run } }
  const local = await runCompiledObjectCli([...endpoint, 'agent', 'send', '--input', '-'], env, JSON.stringify(packet))
  expect(local.code, local.stderr).toBe(0)
  const originalKey = JSON.parse(local.stdout).result.inputReceipt.key
  await expect.poll(async () => (await f.client.inspectAgentInput({ key: originalKey }))?.status).toBe('admitted')
  const sdk = await f.client.readAgentInputMailbox({ agentSessionId: f.input.agentSessionId })
  const page = await rpc.call('agent.input.ls', { hostId: 'local', agentSessionId: f.input.agentSessionId })
  expect(sdk.items).toHaveLength(2); expect(page.items).toEqual(sdk.items); expect(page.cut).toEqual(sdk.cut)
  for (const key of [external.inputReceipt!.key, originalKey]) {
    expect(sdk.items.some(entry => entry.kind === 'item' && entry.item.kind === 'controlled' && entry.item.intent.key.kind === 'message' && entry.item.intent.key.messageId === key.messageId)).toBe(true)
  }
  expect(sends).toHaveBeenCalledTimes(2)
  expect((await runCompiledObjectCli([...endpoint, 'agent', 'send', '--input', '-'], env, JSON.stringify(packet))).code).toBe(0)
  expect(sends).toHaveBeenCalledTimes(2)
  const rejected = await runCompiledObjectCli([...endpoint, 'agent', 'send', '--input', '-'], env, JSON.stringify({ ...packet, admissionIntent: { ...packet.admissionIntent, source: { ...inputTarget.source, nativeSessionId: 'other-source' } } }))
  expect(rejected.code).not.toBe(0); expect(rejected.stdout + rejected.stderr).toContain('AGENT_PROMPT_OPERATION_CONFLICT')
  const discovery = await runCompiledObjectCli(['agent', '--skill'], env)
  expect(discovery.code, discovery.stderr).toBe(0); expect(discovery.stdout).toContain('agent send'); expect(discovery.stdout).toContain('--input')
  const help = await runCompiledObjectCli(['--help', 'agent', 'send'], env)
  expect(help.code, help.stderr).toBe(0); expect(help.stdout).toContain('native-conversation'); expect(help.stdout).toContain('expectedTurnId')
  const bindingHelp = await runCompiledObjectCli(['--help', 'connection', 'binding', 'relink'], env)
  expect(bindingHelp.code, bindingHelp.stderr).toBe(0); expect(bindingHelp.stdout).toContain('inputTarget'); expect(bindingHelp.stdout).toContain('never carries a turn ID')
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})
