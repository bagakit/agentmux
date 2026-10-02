import { fixturePath } from './helpers/fixture-values.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import type { AgentMuxRuntimeOwnerIdentity } from '../src/hosted-client-contract.js'
import type { AgentMuxClientEvent } from '../src/types.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { gapFacts } from './helpers/output-gap.js'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
async function fixture() {
  const f = await rpcOwnerFixture(['gap-agent']); cleanups.push(() => f.close())
  f.inner.kernel.identity = () => ({ buildIdentity: 'private-gap-sdk', protocolVersion: 22, daemonInstanceId: 'private-gap-owner' })
  const inputs: Array<{ runId: string; data: Uint8Array }> = []
  f.inner.kernel.input = vi.fn(async (runId: string, input: { data: string | Uint8Array; expectedByte: number }) => {
    const data = typeof input.data === 'string' ? new TextEncoder().encode(input.data) : input.data
    inputs.push({ runId, data })
    return { run: { ...f.run(runId), acceptedInputBytes: input.expectedByte + data.byteLength },
      appliedByteRange: { startByte: input.expectedByte, endByte: input.expectedByte + data.byteLength } }
  })
  const owner: AgentMuxRuntimeOwnerIdentity = { runtimeId: 'private-gap-host', ownerInstanceId: 'private-gap-host-epoch',
    protocolVersion: 1, processId: process.pid, ctxmux: f.client.runtimeIdentity(), availability: 'connected' }
  const hosted = new AgentMuxHostedRuntimeService(f.client, join(f.root, 'sessions.json'), () => owner)
  cleanups.push(() => hosted.dispose())
  const directory = await mkdtemp(fixturePath("tmp/amx-gap-wire-")), socketPath = join(directory, 'rpc.sock')
  const server = new AgentMuxControlServer({ socketPath, coreClients: f.coreClients, hostedRuntime: () => hosted })
  await server.start(); cleanups.push(async () => { await server.stop(); await rm(directory, { recursive: true, force: true }) })
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } }); cleanups.push(() => rpc.dispose())
  return { ...f, rpc, inputs, publish(event: AgentMuxClientEvent) {
    (f.client as unknown as { publisher: { publish(event: AgentMuxClientEvent): void } }).publisher.publish(event)
  } }
}
function diagnostic(origin: 'daemon' | 'client' | 'mixed' = 'daemon'): Extract<AgentMuxClientEvent, { type: 'agent-error' }> {
  return { type: 'agent-error', agentSessionId: 'gap-agent', code: 'OUTPUT_GAP', message: 'Private SDK observation.',
    evidence: { source: 'terminal-output', observedAt: 120, run: { runId: 'run-gap-agent' }, outputGap: {
      kind: 'live-stream', latestOutputBytes: 27, publishedThroughByte: 4, representation: 'raw', ...gapFacts('run-gap-agent', origin) } } }
}

it.each(['daemon', 'client', 'mixed'] as const)('preserves complete %s Gap through the actual hosted RPC reader', async origin => {
  const f = await fixture(), seen: AgentMuxClientEvent[] = []
  const reader = await connectHostedAgentMux({ rpc: f.rpc }); cleanups.push(() => reader.dispose())
  reader.onEvent(event => seen.push(event))
  const gap = diagnostic(origin); f.publish(gap)
  await expect.poll(() => seen.find(event => event.type === 'agent-error' && event.code === 'OUTPUT_GAP')).toBeDefined()
  expect(seen.find(event => event.type === 'agent-error' && event.code === 'OUTPUT_GAP')).toEqual(gap)
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  expect(f.client.agentSession('gap-agent').run).toEqual({ runId: 'run-gap-agent' })
})

it('keeps explicit unknown and zero SDK facts through the hosted RPC edge', async () => {
  const f = await fixture(), seen: AgentMuxClientEvent[] = []
  const reader = await connectHostedAgentMux({ rpc: f.rpc }); cleanups.push(() => reader.dispose())
  reader.onEvent(event => seen.push(event))
  const gap = diagnostic('client'), facts = gap.evidence.outputGap!
  if (facts.kind !== 'live-stream') throw new Error('Expected synthetic live observation')
  Object.assign(facts.observation, { runtime: null, receivedOutputHeadByte: null, deliveredThroughByte: 0,
    requestedAfterByte: 0, recoveryAfterByte: 0, missingOutputBytes: null })
  Object.assign(facts.observation.localPressure!, { droppedOutputBytes: null, countersSaturated: true })
  f.publish(gap)
  await expect.poll(() => seen.find(event => event.type === 'agent-error' && event.code === 'OUTPUT_GAP')).toBeDefined()
  expect(seen.find(event => event.type === 'agent-error' && event.code === 'OUTPUT_GAP')).toEqual(gap)
})

it('preserves the independent public Core output reader evidence through agent.output', async () => {
  const f = await fixture(), seen: unknown[] = []
  const subscription = await f.rpc.subscribe('agent.output', { agentSessionId: 'gap-agent', afterByte: 0, follow: true }, {
    onInitial() {}, onEvent(event) { seen.push(event) }, onEnd() {}
  }); cleanups.push(() => subscription.dispose())
  expect(f.observers.size).toBe(1)
  for (const listener of f.observers) listener({ type: 'gap', runId: 'run-gap-agent', latestOutputBytes: 27,
    ...gapFacts('run-gap-agent', 'mixed') })
  await expect.poll(() => seen.find((event: any) => event.type === 'error')).toBeDefined()
  expect(seen.find((event: any) => event.type === 'error')).toMatchObject({ type: 'error', error: {
    code: 'OUTPUT_GAP', evidence: { source: 'terminal-output', run: { runId: 'run-gap-agent' }, outputGap: {
      kind: 'live-stream', latestOutputBytes: 27, representation: 'raw', publishedThroughByte: 2,
      ...gapFacts('run-gap-agent', 'mixed') } } } })
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('preserves the independent reader Gap through the public hosted Core API', async () => {
  const f = await fixture(), seen: AgentMuxClientEvent[] = []
  // Complete the synthetic Native transport's advertised three-byte replay fence.
  const observe = f.inner.kernel.observeOutput as (...args: unknown[]) => Promise<any>
  f.inner.kernel.observeOutput = async (...args: unknown[]) => {
    const value = await observe(...args)
    value.replay.push({ type: 'data', runId: 'run-gap-agent', startByte: 2, endByte: 3, data: '', dataBytes: Uint8Array.of(0xad) })
    return value
  }
  const reader = await connectHostedAgentMux({ rpc: f.rpc }); cleanups.push(() => reader.dispose())
  const observation = await reader.observeAgentOutput('gap-agent', 0, event => seen.push(event))
  cleanups.push(() => observation.close())
  expect(f.observers.size).toBe(1)
  for (const listener of f.observers) listener({ type: 'gap', runId: 'run-gap-agent', latestOutputBytes: 27,
    ...gapFacts('run-gap-agent', 'client') })
  await expect.poll(() => seen.find(event => event.type === 'agent-error')).toBeDefined()
  expect(seen.find(event => event.type === 'agent-error')).toMatchObject({ code: 'OUTPUT_GAP', evidence: {
    run: { runId: 'run-gap-agent' }, outputGap: { ...gapFacts('run-gap-agent', 'client'), publishedThroughByte: 3 } } })
  expect(seen.filter(event => event.type === 'process-state')).toEqual([])
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it.each(['missing-cause', 'empty-cause', 'foreign-run', 'daemon-exact-loss', 'extra-field'] as const)(
  'rejects %s Gap locally while retaining the actual Hosted input lease', async fault => {
    const f = await fixture(), seen: AgentMuxClientEvent[] = []
    const reader = await connectHostedAgentMux({ rpc: f.rpc }); cleanups.push(() => reader.dispose())
    reader.onEvent(event => seen.push(event))
    const originalIdentity = reader.runtimeIdentity()
    const gap = diagnostic(), facts = gap.evidence.outputGap!
    if (facts.kind !== 'live-stream') throw new Error('Expected live transport fixture')
    const corrupt = facts as any
    if (fault === 'missing-cause') delete corrupt.causes.unknown
    else if (fault === 'empty-cause') for (const key of Object.keys(corrupt.causes)) corrupt.causes[key] = false
    else if (fault === 'foreign-run') corrupt.observation.runId = 'another-run'
    else if (fault === 'daemon-exact-loss') corrupt.observation.missingOutputBytes = 19
    else corrupt.observation.queue.fabricatedBudget = 5
    f.publish(gap)
    await expect.poll(() => seen.find(event => event.type === 'agent-error')).toBeDefined()
    const rejected = seen.find(event => event.type === 'agent-error')
    expect(rejected).toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR', evidence: { source: 'agentmux' } })
    expect(rejected).not.toHaveProperty('agentSessionId')
    expect(rejected).not.toHaveProperty('evidence.run')
    expect(seen.filter(event => event.type === 'agent-error' && event.code === 'OUTPUT_GAP')).toEqual([])
    expect(seen.filter(event => event.type === 'connection-state')).toEqual([])
    const nextGap = diagnostic('client'); f.publish(nextGap)
    await expect.poll(() => seen.find(event => event.type === 'agent-error' && event.code === 'OUTPUT_GAP')).toEqual(nextGap)
    const input = await reader.writeTerminal({ runId: 'run-gap-agent' }, {
      ownerInstanceId: originalIdentity.instanceId, operationId: 'after-invalid-' + fault, expectedByte: 0, data: 'still available\n' })
    expect(input.appliedByteRange).toEqual({ startByte: 0, endByte: 16 })
    expect(f.inputs).toEqual([{ runId: 'run-gap-agent', data: new TextEncoder().encode('still available\n') }])
    expect(reader.runtimeIdentity()).toEqual(originalIdentity)
    expect(f.inner.kernel.stop).not.toHaveBeenCalled()
    expect(f.client.agentSession('gap-agent').run).toEqual({ runId: 'run-gap-agent' })
  })
