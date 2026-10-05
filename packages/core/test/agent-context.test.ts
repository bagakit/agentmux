import { fixtureClock, fixtureDay, fixturePath } from './helpers/fixture-values.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { parseRpcNativeResult } from '../src/rpc-native-codec.js'
import { nativeHistoryFixture, jsonl } from './fixtures/native-history-session.js'
import { objectCliEnvironment } from './helpers/object-cli-rpc.js'

const close: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of close.splice(0).reverse()) await cleanup(); vi.restoreAllMocks() })
const fullText = 'Original complete context 中\n'.repeat(4000) + 'END-OF-LONG-ENTRY'
async function endpoint(provider: 'claude' | 'pi' = 'claude') {
  const f = await nativeHistoryFixture(provider, root => jsonl(provider === 'claude'
    ? [0, 1, 2].map(i => ({ sessionId: 'native-main', uuid: `native-${i}`, type: 'user', timestamp: `${fixtureDay(1)}T00:0${i}:00Z`, message: { role: 'user', content: i === 2 ? fullText : `Native ${i}` } }))
    : [{ type: 'session', version: 3, id: 'native-main', cwd: root, timestamp: fixtureDay(1) + "T" + fixtureClock(0, 0, 0) + "Z" },
      ...[0, 1, 2].map(i => ({ type: 'message', id: `native-${i}`, parentId: i === 0 ? null : `native-${i - 1}`, timestamp: `${fixtureDay(1)}T00:0${i}:00Z`, message: { role: 'user', content: i === 2 ? fullText : `Native ${i}` } }))]))
  close.push(f.close)
  for (let i = 0; i < 3; i++) await f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.session.agentSessionId, item: {
    id: `captured-${i}`, agentSessionId: f.session.agentSessionId, kind: 'user_message', status: 'complete', source: 'user',
    createdAt: i, updatedAt: i, title: 'Saved original input', content: i === 2 ? fullText : `Captured ${i}`, authorHuman: true } })
  const connect = vi.spyOn(f.client, 'connect')
  const socketPath = join(f.root, 'public.sock'), server = new AgentMuxControlServer({ socketPath, coreClients: () => [{ hostId: 'local', client: f.client }] })
  close.push(() => server.stop()); await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } }); close.push(() => rpc.dispose())
  return { ...f, socketPath, rpc, connect, input: { hostId: 'local', agentSessionId: f.session.agentSessionId, limit: 1 } }
}
it.each(['claude', 'pi'] as const)('unites every available %s source through the real durable owner and public client without truncating entries', async provider => {
  const f = await endpoint(provider), before = await readFile(f.storePath)
  const first = await f.rpc.call('agent.context', f.input)
  expect(first).toMatchObject({ hostId: 'local', agentSessionId: f.session.agentSessionId,
    descriptor: { state: 'active', history: { nativeHandle: f.session.nativeHandle } }, session: { run: f.session.run } })
  expect(first.captured).not.toBeNull(); expect(first.native).not.toBeNull()
  expect(first.captured!.items[0]!.content).toBe(fullText)
  expect(first.native!.items[0]!.contentParts).toEqual([{ kind: 'text', text: fullText }])
  expect(first.unavailable.map(issue => issue.source)).toEqual(expect.arrayContaining(['status', 'runtime']))
  const captured = first.captured!.items.map(item => item.id), native = first.native!.items.map(item => item.id)
  let cursor = first.nextCursor
  for (let pages = 0; cursor !== null; pages++) {
    expect(pages).toBeLessThan(5)
    const page = await f.rpc.call('agent.context', { ...f.input, cursor })
    captured.push(...page.captured!.items.map(item => item.id)); native.push(...(page.native?.items ?? []).map(item => item.id)); cursor = page.nextCursor
  }
  expect(captured.sort()).toEqual(['captured-0', 'captured-1', 'captured-2'])
  expect(native.sort()).toEqual(['native-0', 'native-1', 'native-2'])
  expect(await readFile(f.storePath)).toEqual(before)
  expect(f.connect).not.toHaveBeenCalled(); for (const control of f.controls) expect(control).not.toHaveBeenCalled()
})
it('preserves captured work and full unavailable diagnostics when the native owner fails', async () => {
  const f = await endpoint(), before = await readFile(f.storePath), diagnostic = 'Original native file unavailable '.repeat(2000)
  vi.spyOn(f.client, 'sessionHistoryPage').mockRejectedValue(Object.assign(new Error(diagnostic), { code: 'PRIVATE_NATIVE_UNAVAILABLE' }))
  const page = await f.rpc.call('agent.context', { ...f.input, limit: 30 })
  expect(page.captured!.items.map(item => item.id)).toEqual(['captured-0', 'captured-1', 'captured-2'])
  expect(page.native).toBeNull(); expect(page.unavailable.find(issue => issue.source === 'native')!.message).toBe(diagnostic)
  expect(await readFile(f.storePath)).toEqual(before); for (const control of f.controls) expect(control).not.toHaveBeenCalled()
})
it('retains the original context source while exposing a different observed native identity', async () => {
  const f = await endpoint(), observedNativeHandle = { kind: 'provider' as const, providerId: 'claude', sessionId: 'observed-other' }
  // Context retains diagnostics supplied by its original owner. This borrowed
  // metadata tests that read contract without introducing a new Store binding.
  const originalSources = await f.client.sessionHistorySources()
  const sources = originalSources.map(source => ({ ...source, history: { ...source.history!, observedNativeHandle } }))
  const borrowed = new Proxy(f.client, { get(target, property) {
    if (property === 'sessionHistorySources') return async () => sources
    const value = Reflect.get(target, property, target)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client: borrowed }] })
  const outcome = await service.call('agent.context', f.input).then(page => ({ page }), error => ({ error }))
  expect(outcome).not.toHaveProperty('error')
  if ('error' in outcome) throw outcome.error
  const page = outcome.page
  expect(page.descriptor.history).toMatchObject({ nativeHandle: f.session.nativeHandle, observedNativeHandle })
  expect(page.session?.nativeHandle).toEqual(f.session.nativeHandle)
  expect(page.native?.source.nativeSessionId).toBe(f.session.nativeHandle!.sessionId)
  expect(() => parseRpcNativeResult('agent.context', page, f.input)).not.toThrow()
  expect(() => parseRpcNativeResult('agent.context', { ...page, descriptor: { ...page.descriptor,
    history: { ...page.descriptor.history, observedNativeHandle: { ...observedNativeHandle, providerId: 'another-provider' } } } }, f.input))
    .toThrow(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
  expect(f.connect).not.toHaveBeenCalled()
})
it('keeps already admitted readable sources when their final metadata observation is unavailable', async () => {
  const f = await endpoint(), sources = await f.client.sessionHistorySources(), metadata = vi.fn().mockResolvedValueOnce(sources).mockRejectedValueOnce(new Error('Final durable metadata read unavailable'))
  const borrowed = new Proxy(f.client, { get(target, property) {
    if (property === 'sessionHistorySources') return metadata
    const value = Reflect.get(target, property, target)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client: borrowed }] })
  const page = await service.call('agent.context', f.input)
  expect(page.captured!.items[0]!.content).toBe(fullText); expect(page.native!.items[0]!.contentParts).toEqual([{ kind: 'text', text: fullText }])
  expect(page.unavailable).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'session', message: 'Final durable metadata read unavailable' })]))
  expect(() => parseRpcNativeResult('agent.context', page, f.input)).not.toThrow()
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
})
it('reads retained original sources through fresh durable instances after retirement', async () => {
  const f = await endpoint()
  const reservation = { kind: 'stop' as const, reservationId: 'context-retire', ownerId: 'context-owner', ownerPid: process.pid,
    agentSessionId: f.session.agentSessionId, expectedRun: f.session.run, operationId: 'context-retire-operation', expiresAt: Date.now() + 60_000,
    stopOperation: { daemonInstance: 'private-unconnected', operationKey: 'context-stop', runId: f.session.run.runId } }
  await f.store.reserveLifecycle(reservation); await f.store.commitLifecycle(reservation, null)
  const client = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(f.storePath) }); close.push(() => client.dispose())
  const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client }] })
  const page = await service.call('agent.context', { ...f.input, limit: 30 })
  expect(page.descriptor.state).toBe('retired'); expect(page.session).toBeNull(); expect(page.status).toBeNull()
  expect(page.captured!.items).toHaveLength(3); expect(page.native!.items).toHaveLength(3)
  expect(() => parseRpcNativeResult('agent.context', page, { ...f.input, limit: 30 })).not.toThrow()
})
it('binds cursor to exact Host, Session and native locator, and validates strict source payloads', async () => {
  const f = await endpoint(), page = await f.rpc.call('agent.context', f.input), cursor = page.nextCursor!
  await expect(f.rpc.call('agent.context', { ...f.input, hostId: 'another-host', cursor })).rejects.toMatchObject({ code: 'UNKNOWN_HOST' })
  await expect(f.rpc.call('agent.context', { ...f.input, agentSessionId: 'private', cursor })).rejects.toMatchObject({ code: 'UNKNOWN_AGENT_SESSION' })
  const decode = (change: Record<string, unknown>) => Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(cursor, 'base64url').toString()), ...change })).toString('base64url')
  const wrongCursor = await f.rpc.call('agent.context', { ...f.input, cursor: decode({ agentSessionId: 'wrong-original' }) }).then(() => null, error => error)
  expect(wrongCursor).toMatchObject({ code: 'AGENT_CONTEXT_SOURCE_CHANGED' })
  await expect(f.rpc.call('agent.context', { ...f.input, source: 'native' } as any)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  await expect(f.rpc.call('agent.context', { ...f.input, limit: 0 })).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  for (const bad of [{ ...page, hostId: 'wrong-host' }, { ...page, descriptor: { ...page.descriptor, agentSessionId: 'wrong-original' } },
    { ...page, session: { ...page.session, nativeHandle: { ...page.session!.nativeHandle, sessionId: 'another-fork' } } },
    { ...page, session: { ...page.session, workspacePath: fixturePath("different-original-source") } },
    { ...page, sourceHostId: 'another-owner' },
    { ...page, native: { ...page.native, source: { providerId: 'claude', nativeSessionId: 'fork' } } },
    { ...page, native: { ...page.native, items: [{ ...page.native!.items[0], untrustedExtra: true }] } },
    { ...page, unavailable: [{ source: 'native', code: 'UNKNOWN', message: 'unavailable', recovery: 'retry', healthy: false }] }]) {
    expect(() => parseRpcNativeResult('agent.context', bad, f.input)).toThrow(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  }
  const fresh = await f.rpc.call('agent.context', f.input)
  await f.store.compareAndSwap(f.session, { ...f.session, nativeHandle: { ...f.session.nativeHandle!, sessionId: 'different-native' }, updatedAt: 2 })
  await expect(f.rpc.call('agent.context', { ...f.input, cursor: fresh.nextCursor! })).rejects.toMatchObject({ code: 'AGENT_CONTEXT_SOURCE_CHANGED' })
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
})
it('keeps the original captured window readable while the healthy owner appends and updates work', async () => {
  const f = await endpoint(), first = await f.rpc.call('agent.context', f.input)
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.session.agentSessionId, item: {
    id: 'new-after-context', agentSessionId: f.session.agentSessionId, kind: 'user_message', status: 'complete', source: 'user', createdAt: 10, updatedAt: 10, title: 'New work', content: 'New original work continues' } })
  await f.store.applyTimelineMutation({ type: 'update', agentSessionId: f.session.agentSessionId, itemId: 'captured-1', updatedAt: 11, content: 'Original work completed during read', status: 'complete' })
  const second = await f.rpc.call('agent.context', { ...f.input, cursor: first.nextCursor! })
  expect(second.captured!.items.map(item => [item.id, item.content])).toEqual([['captured-1', 'Original work completed during read']])
  expect(second.captured!.revision).toBeGreaterThan(first.captured!.revision)
  const third = await f.rpc.call('agent.context', { ...f.input, cursor: second.nextCursor! })
  expect(third.captured!.items.map(item => item.id)).toEqual(['captured-0']); expect(third.nextCursor).toBeNull()
  expect((await f.rpc.call('agent.context', { ...f.input, limit: 30 })).captured!.items.map(item => item.id)).toEqual(['captured-0', 'captured-1', 'captured-2', 'new-after-context'])
  for (const control of f.controls) expect(control).not.toHaveBeenCalled(); expect(f.connect).not.toHaveBeenCalled()
})
it.each(['anchor-removed', 'reordered'] as const)('refuses a %s captured source window through the actual durable store', async change => {
  const f = await endpoint(), first = await f.rpc.call('agent.context', f.input), timeline = await f.client.sessionTimeline(f.session.agentSessionId)
  const files = await readdir(join(f.root, 'agent-timelines')); expect(files.filter(path => path.endsWith('.jsonl'))).toHaveLength(1)
  const items = change === 'anchor-removed' ? timeline.items.slice(0, -1) : [timeline.items[1]!, timeline.items[0]!, timeline.items[2]!]
  await writeFile(join(f.root, 'agent-timelines', files[0]!), JSON.stringify({ version: 3, agentSessionId: timeline.agentSessionId, revision: timeline.revision + 1, items }) + '\n')
  const unavailable = await f.rpc.call('agent.context', { ...f.input, cursor: first.nextCursor! }).then(() => null, error => error)
  expect(unavailable).toMatchObject({ code: 'AGENT_CONTEXT_SOURCE_CHANGED' })
  expect((await f.rpc.call('agent.context', { ...f.input, limit: 30 })).captured!.items.map(item => item.id)).toEqual(items.map(item => item.id))
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
})
it('routes an exact configured remote Host through its original forwardRpc namespace', async () => {
  const f = await endpoint(), remote = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client: f.client }] })
  const forward = vi.fn((method: any, params: any, context: any) => remote.call(method, params, context))
  const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'configured-remote', client: Object.assign(Object.create(f.client), { forwardRpc: forward }) }] })
  const input = { ...f.input, hostId: 'configured-remote' }, page = await service.call('agent.context', input)
  expect(forward.mock.calls[0]![1]).toMatchObject({ hostId: 'local', agentSessionId: f.session.agentSessionId })
  expect(page.hostId).toBe('configured-remote'); expect(page.sourceHostId).toBe('local'); expect(page.descriptor.hostId).toBe('local'); expect(page.session!.hostId).toBe('local')
  expect(() => parseRpcNativeResult('agent.context', page, input)).not.toThrow()
  const next = await service.call('agent.context', { ...input, cursor: page.nextCursor! })
  expect(next.captured!.items[0]!.id).toBe('captured-1'); expect(next.native!.items[0]!.id).toBe('native-1')
  const aliases = new AgentMuxRpcService({ coreClients: () => ['configured-remote', 'different-route'].map(hostId => ({ hostId, client: Object.assign(Object.create(f.client), { forwardRpc: forward }) })) })
  const wrongRoute = await aliases.call('agent.context', { ...input, hostId: 'different-route', cursor: page.nextCursor! }).then(() => null, error => error)
  expect(wrongRoute).toMatchObject({ code: 'AGENT_CONTEXT_SOURCE_CHANGED' })
})
it('actual compiled CLI consumes the same full public owner and meaningful failures', async () => {
  const f = await endpoint(), cli = process.env.AGENTMUX_TEST_OBJECT_CLI ?? resolve('packages/core/bin/amux')
  const invoke = async (args: string[]) => promisify(execFile)(process.execPath, [cli, '--endpoint', `unix:${f.socketPath}`, 'agent', 'context', ...args], {
    env: objectCliEnvironment(f.root), timeout: 15_000, maxBuffer: 4 * 1024 * 1024 })
  const args = ['--host', 'local', '--session', f.session.agentSessionId, '--limit', '1']
  const initial = JSON.parse((await invoke(args)).stdout)
  expect(initial).toMatchObject({ ok: true, operation: 'agent.context', result: { hostId: 'local', agentSessionId: f.session.agentSessionId } })
  expect(initial.result.captured.items[0].content).toBe(fullText)
  expect(initial.result.native.items[0].contentParts[0].text).toBe(fullText)
  const second = JSON.parse((await invoke([...args, '--cursor', initial.result.nextCursor])).stdout)
  expect(second.result.captured.items[0].id).toBe('captured-1'); expect(second.result.native.items[0].id).toBe('native-1')
  await rm(f.path)
  const partial = JSON.parse((await invoke(args)).stdout)
  expect(partial.result.captured.items[0].content).toBe(fullText)
  expect(partial.result.unavailable).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'native' })]))
  const failure = await invoke(['--host', 'wrong', '--session', f.session.agentSessionId]).then(() => null, error => error)
  expect(failure.code).toBe(1); expect(JSON.parse(failure.stderr).error.code).toBe('UNKNOWN_HOST')
  const sourceChoice = await invoke([...args, '--source', 'native']).then(() => null, error => error)
  expect(sourceChoice.code).toBe(1); expect(JSON.parse(sourceChoice.stderr).error.code).toBe('INVALID_CLI_ARGUMENT')
  for (const control of f.controls) expect(control).not.toHaveBeenCalled(); expect(f.connect).not.toHaveBeenCalled()
})
it('preserves original sourceDevice and sourceChannel through durable context, public Unix and actual CLI', async () => {
  const f = await endpoint(), sourceDevice = { hostId: 'original-writing-host', deviceId: 'original-device-id', name: 'Original device' }, sourceChannel = 'cli' as const
  const original = { id: 'captured-attributed', agentSessionId: f.session.agentSessionId, kind: 'user_message' as const, status: 'complete' as const,
    source: 'user' as const, createdAt: 10, updatedAt: 10, title: 'Original attributed input', content: 'Full attributed original work', authorHuman: true,
    sourceDevice, sourceChannel }
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.session.agentSessionId, item: original })
  const durable = new AgentMuxFileAgentSessionStore(f.storePath)
  expect((await durable.loadTimeline(f.session.agentSessionId)).items.at(-1)).toEqual(original)
  const observed = await f.rpc.call('agent.context', { ...f.input, limit: 30 }).then(page => ({ page }), error => ({ error }))
  expect(observed).not.toHaveProperty('error')
  if ('error' in observed) throw observed.error
  const page = observed.page
  expect(page.captured!.items.find(item => item.id === original.id)).toEqual(original)
  const cli = process.env.AGENTMUX_TEST_OBJECT_CLI ?? resolve('packages/core/bin/amux')
  const output = await promisify(execFile)(process.execPath, [cli, '--endpoint', `unix:${f.socketPath}`, 'agent', 'context', '--host', 'local', '--session', f.session.agentSessionId], {
    env: objectCliEnvironment(f.root), timeout: 15_000, maxBuffer: 4 * 1024 * 1024 })
  expect(JSON.parse(output.stdout).result.captured.items.find((item: { id: string }) => item.id === original.id)).toEqual(original)
  for (const attribution of [
    { sourceDevice: { ...sourceDevice, deviceId: 42 }, sourceChannel },
    { sourceDevice: { ...sourceDevice, privateToken: 'not-public-metadata' }, sourceChannel },
    { sourceDevice, sourceChannel: 42 },
    { sourceDevice, sourceChannel: 'unknown-channel' }
  ]) {
    const bad = { ...page, captured: { ...page.captured!, items: [{ ...original, ...attribution }] } }
    expect(() => parseRpcNativeResult('agent.context', bad, { ...f.input, limit: 30 })).toThrow(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  }
  for (const control of f.controls) expect(control).not.toHaveBeenCalled(); expect(f.connect).not.toHaveBeenCalled()
})
