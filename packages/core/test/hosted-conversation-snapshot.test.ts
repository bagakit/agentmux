import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { decodeHostedValue, encodeHostedValue } from '../src/hosted-value.js'
import type { AgentMuxHostedInvocation } from '../src/hosted-client-contract.js'
import { hostedTestClient } from './helpers/hosted-runtime-port.js'
import { jsonl, nativeHistoryFixture } from './fixtures/native-history-session.js'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks() })

async function fixture() {
  const native = await nativeHistoryFixture('claude', jsonl([
    { type: 'assistant', uuid: 'retained-reply', sessionId: 'native-main', message: { role: 'assistant', content: 'Original recorded answer' } }
  ]))
  cleanups.push(native.close)
  // Runtime preparation is a named collaborator. Custody, Hosted dispatch, codecs and FileStore
  // stay real; listing or releasing source evidence must not connect or control a Run.
  const connect = vi.spyOn(native.client, 'connect').mockResolvedValue()
  const connectRuntime = vi.spyOn(native.client, 'connectRuntime').mockResolvedValue()
  vi.spyOn(native.client, 'runtimeProjection').mockResolvedValue({ hostId: 'local', subjects: [] })
  const ref = { hostId: 'local', agentSessionId: native.session.agentSessionId }
  const source = { providerId: 'claude', nativeSessionId: 'native-main' }
  const cut = await native.client.conversationCheckpoint({ ...ref, nativeSnapshot: 'scope' })
  expect(cut.coverage.find(item => item.source.kind === 'native')?.gaps).toEqual([])
  const hosted = await hostedTestClient(native.client)
  cleanups.push(hosted.dispose)
  connect.mockClear(); connectRuntime.mockClear()
  const list = vi.spyOn(native.client, 'listConversationSnapshots')
  const release = vi.spyOn(native.client, 'releaseConversationSnapshot')
  return { ...native, ...hosted, ref, source, connect, connectRuntime, list, release }
}

it('the public Host reads and releases real Core snapshot custody through its Hosted consumer', async () => {
  const f = await fixture(), socketPath = join(f.root, 's')
  const host = new AgentMuxControlServer({ socketPath, coreClients: () => [{ hostId: 'original-host', client: f.sdk }] })
  await host.start(); cleanups.push(() => host.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } })
  cleanups.push(() => rpc.dispose())
  const request = { ...f.ref, hostId: 'original-host', source: f.source, limit: 1 }
  const listed = await rpc.call('agent.conversation.snapshot.ls', request)
    .then(value => ({ value, error: null }), error => ({ value: null, error }))
  expect(listed.error).toBeNull()
  const page = listed.value!
  expect(page).toMatchObject({ hostId: request.hostId, agentSessionId: request.agentSessionId, source: f.source, next: null })
  expect(page.snapshots).toEqual([expect.objectContaining({ reference: expect.any(String), purpose: 'scope', released: false })])
  expect(f.list).toHaveBeenCalledExactlyOnceWith({ ...request, hostId: 'local' })
  const reference = page.snapshots[0]!.reference
  await expect(rpc.call('agent.conversation.snapshot.release', { ...f.ref, hostId: request.hostId, source: f.source, reference })).resolves.toEqual({
    hostId: request.hostId, agentSessionId: request.agentSessionId, source: f.source, reference, released: true
  })
  expect(f.release).toHaveBeenCalledExactlyOnceWith({ ...f.ref, source: f.source, reference })
  const inspected = await f.sdk.listConversationSnapshots({ ...f.ref, source: f.source })
  expect(inspected.snapshots).toEqual([expect.objectContaining({ reference, released: true })])
  expect((await f.client.readAgentConversation(f.ref)).items.length).toBeGreaterThan(0)
  expect((await f.bytes()).native).toEqual(f.before.native)
  expect(f.connect).not.toHaveBeenCalled(); expect(f.connectRuntime).not.toHaveBeenCalled()
  expect(f.controls).toHaveLength(6)
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
})

function corruptReply(f: Awaited<ReturnType<typeof fixture>>, target: AgentMuxHostedInvocation['method'],
  change: (value: Record<string, unknown>) => Record<string, unknown>) {
  const call = f.port.call.bind(f.port)
  vi.spyOn(f.port, 'call').mockImplementation(async (method, params, options) => {
    const result = await call(method, params, options)
    if (method !== 'runtime.invoke' || (decodeHostedValue((params as { invocation: unknown }).invocation) as AgentMuxHostedInvocation).method !== target) return result
    const reply = result as { value: unknown }
    return { ...reply, value: encodeHostedValue(change(decodeHostedValue(reply.value) as Record<string, unknown>)) } as never
  })
}

it.each(['host', 'session', 'source', 'metadata'] as const)('the Hosted reader rejects a snapshot list with mismatched %s facts', async wrong => {
  const f = await fixture()
  corruptReply(f, 'listConversationSnapshots', value => wrong === 'host' ? { ...value, hostId: 'another-host' }
    : wrong === 'session' ? { ...value, agentSessionId: 'another-session' }
      : wrong === 'source' ? { ...value, source: { ...f.source, nativeSessionId: 'another-native-source' } }
        : { ...value, snapshots: [{ ...(value.snapshots as Record<string, unknown>[])[0], end: -1 }] })
  await expect(f.sdk.listConversationSnapshots({ ...f.ref, source: f.source })).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
  expect(f.list).toHaveBeenCalledTimes(1)
  expect(f.release).not.toHaveBeenCalled()
  expect((await f.bytes()).native).toEqual(f.before.native)
  expect(f.connect).not.toHaveBeenCalled(); expect(f.connectRuntime).not.toHaveBeenCalled()
})

it.each(['reference', 'confirmation'] as const)('an invalid Hosted release %s does not confirm or replay the applied original release', async wrong => {
  const f = await fixture(), page = await f.sdk.listConversationSnapshots({ ...f.ref, source: f.source })
  expect(page.snapshots).toHaveLength(1)
  const reference = page.snapshots[0]!.reference, input = { ...f.ref, source: f.source, reference }
  corruptReply(f, 'releaseConversationSnapshot', value => wrong === 'reference'
    ? { ...value, reference: 'another-snapshot' } : { ...value, released: false })
  await expect(f.sdk.releaseConversationSnapshot(input)).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
  expect(f.release).toHaveBeenCalledExactlyOnceWith(input)
  const retained = await f.sdk.listConversationSnapshots({ ...f.ref, source: f.source })
  expect(retained.snapshots).toEqual([expect.objectContaining({ reference, released: true })])
  expect(f.release).toHaveBeenCalledTimes(1)
  expect((await f.bytes()).native).toEqual(f.before.native)
})
