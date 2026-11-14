import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, AgentMuxControlServer, connectAgentMuxRpc,
  type AgentMuxInteractionRequest, type AgentMuxInteractionResponse } from '@agentmux/core'
import { AgentMuxError } from '../src/errors.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { runStorageSourceCli } from './helpers/storage-recovery-source-cli.js'

const sid = 'original-recipient', other = 'unrelated-recipient', runId = 'run-' + sid
const operationId = 'original-frozen-answer'
const cleanups: Array<() => Promise<void>> = [], roots: string[] = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const close of cleanups.splice(0).reverse()) { try { await close() } catch (error) { failures.push(error) } }
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    expect(existsSync(root), 'the original private frozen-answer fixture must be removed').toBe(false)
    if (process.env.AMX_A08_CLEANUP) appendFileSync(process.env.AMX_A08_CLEANUP, JSON.stringify({ root, removed: true }) + '\n')
  }
  if (failures.length) throw new AggregateError(failures, 'Private frozen-answer cleanup failed')
})
async function fixture() {
  const h = await rpcOwnerFixture([sid, other], { AgentMuxClient, AgentMuxFileAgentSessionStore })
  cleanups.push(h.close); roots.push(h.root)
  const request: AgentMuxInteractionRequest = { kind: 'permission', id: 'original-request', agentSessionId: sid,
    nativeToolCallId: 'original-native-call', title: 'Original approval', options: [{ id: 'allow-once', label: 'Original option', kind: 'allow-once' }],
    evidence: { source: 'native-hook', observedAt: 1, run: { runId }, hookReceiptId: 'original-request' } }
  const response: AgentMuxInteractionResponse = { kind: 'permission', requestId: request.id, decision: { outcome: 'selected', optionId: 'allow-once' } }
  const byteRange = { startByte: 10, endByte: 11 }, nativeHandle = { kind: 'provider' as const, providerId: 'codex', sessionId: 'original-native' }
  const previous = (await h.store.readMetadata(sid))!
  await h.store.compareAndSwapMetadata(previous, { ...previous, nativeHandle, pendingInteraction: { request, response: {
    value: response, responseDigest: createHash('sha256').update(JSON.stringify(response)).digest('base64url'), operationId,
    inputByteRange: byteRange, acknowledged: false } }, interactionOperations: { [operationId]: {
    operationId, agentSessionId: sid, run: { runId }, nativeHandle, expectedRequest: request, response,
    delivery: 'unknown', nativeAdoption: 'unknown', inputByteRange: byteRange } } })
  await h.inner.registry.load('local')
  const acceptedInputBytes = 14
  const status = vi.fn(async (id: string) => ({ ...h.run(id), acceptedInputBytes }))
  h.inner.kernel.status = status
  // This deterministic Runtime port already owns the exact old claim. It has no
  // implementation for applying new input; an unknown operation is refused.
  h.inner.kernel.input = vi.fn(async (id: string, input: { ownerInstanceId: string; operationId: string; expectedByte: number; data: string }) => {
    if (id !== runId || input.ownerInstanceId !== 'fixture-runtime' || input.operationId !== operationId || input.expectedByte !== 10 || input.data !== '1') {
      throw new AgentMuxError('No such original Runtime input claim.', 'CTXMUX_input_unknown', 'unknown')
    }
    return { run: { ...h.run(runId), acceptedInputBytes }, appliedByteRange: byteRange }
  })
  const input = { agentSessionId: sid, expectedRun: { runId }, operationId, expectedRequest: request, response }
  return { ...h, request, response, input, acceptedInputBytes, byteRange, status }
}

it.each(['rpc', 'source-cli'] as const)('the original frozen answer via %s ignores unrelated bulk metadata observation and queries only its old claim', async transport => {
  const h = await fixture()
  const bulkRead = h.store.loadMetadata.bind(h.store)
  const bulkObservation = vi.spyOn(h.store, 'loadMetadata').mockImplementation(async (...args) => {
    const records = await bulkRead(...args)
    if (records.some(session => session.agentSessionId === other)) throw new Error('Unrelated Session B metadata observation unavailable')
    return records
  })
  Reflect.set(h.client, 'connectionNeedsObservation', true)
  const observeAll = vi.spyOn(h.client, 'connect')
  const runtimeOnly = vi.spyOn(h.client, 'connectRuntime')
  const socketPath = join(h.root, 'control.sock')
  const server = new AgentMuxControlServer({ socketPath, coreClients: h.coreClients })
  cleanups.push(async () => { await server.stop() }); await server.start()
  const rpc = await connectAgentMuxRpc({ transport: 'unix', path: socketPath })
  cleanups.push(async () => { rpc.dispose() })
  const file = join(h.root, 'original-answer.json')
  await writeFile(file, JSON.stringify(h.input), { mode: 0o600 })
  const result = await Promise.allSettled([transport === 'rpc'
    ? rpc.call('agent.interaction.respond', h.input)
    : runStorageSourceCli(h.root, socketPath, ['agent', 'interaction', 'respond', '--input', file]).then(output => {
      expect(output.code, output.stderr + output.stdout).toBe(0); return JSON.parse(output.stdout).result
    })])
  expect(result[0]!.status, 'frozen ACK lookup must finish without unrelated Session observation: ' + JSON.stringify(result[0]) + (result[0]?.status === 'rejected' ? String(result[0].reason) : '')).toBe('fulfilled')
  if (result[0]!.status !== 'fulfilled') throw result[0]!.reason
  const receipt = result[0]!.value
  expect(receipt).toMatchObject({ operationId, expectedRequest: h.request, delivery: 'bytes-accepted', nativeAdoption: 'unknown', inputByteRange: h.byteRange })
  expect(observeAll).not.toHaveBeenCalled(); expect(bulkObservation).not.toHaveBeenCalled()
  expect(runtimeOnly).toHaveBeenCalledOnce()
  expect(h.inner.kernel.input).toHaveBeenCalledExactlyOnceWith(runId, { ownerInstanceId: 'fixture-runtime', operationId, expectedByte: 10, data: '1' })
  expect(h.rawInput).not.toHaveBeenCalled()
  expect((await h.status(runId)).acceptedInputBytes).toBe(h.acceptedInputBytes)
  expect(await rpc.call('agent.interaction.inspect', { agentSessionId: sid, operationId })).toEqual({ receipt })
  const inspected = await runStorageSourceCli(h.root, socketPath, ['agent', 'interaction', 'inspect', '--session', sid, '--operation-id', operationId])
  expect(inspected.code, inspected.stderr + inspected.stdout).toBe(0)
  expect(JSON.parse(inspected.stdout).result.receipt).toEqual(receipt)
  expect(await h.client.respondAgentInteraction(h.input)).toEqual(receipt)
  expect(h.inner.kernel.input).toHaveBeenCalledOnce()
  for (const changed of [
    { ...h.input, expectedRun: { runId: 'foreign-run' } },
    { ...h.input, operationId: 'foreign-operation' },
    { ...h.input, expectedRequest: { ...h.request, nativeToolCallId: 'foreign-call' } }
  ]) await expect(h.client.respondAgentInteraction(changed)).rejects.toMatchObject({ code: 'AGENT_INTERACTION_RESPONSE_CONFLICT' })
  expect(h.inner.kernel.input).toHaveBeenCalledOnce()
  expect(h.client.agentSession(sid).run).toEqual({ runId })
  expect((await h.store.readMetadata(other))?.run).toEqual({ runId: 'run-' + other })
})

it('a native target changed during Runtime admission cannot adopt the frozen answer', async () => {
  const h = await fixture()
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve }), held = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(h.client, 'connectRuntime').mockImplementation(async () => { entered(); await held })
  const answer = h.client.respondAgentInteraction(h.input)
  const outcome = answer.then(value => ({ value }), error => ({ error }))
  try {
    await started
    const original = (await h.store.readMetadata(sid))!
    await h.store.compareAndSwapMetadata(original, { ...original, nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'foreign-native' } })
    await h.inner.registry.refresh(sid)
  } finally { release() }
  expect(await outcome).toMatchObject({ error: { code: 'STALE_AGENT_SESSION' } })
  expect(h.inner.kernel.input).not.toHaveBeenCalled()
  expect(await h.client.inspectAgentInteractionOperation(h.input)).toMatchObject({ delivery: 'unknown', nativeAdoption: 'unknown' })
})
