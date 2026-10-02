import { fixturePath } from './helpers/fixture-values.js'
import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { historyReaderFixture, core } from './fixtures/session-history-reader.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

const fixtures: Awaited<ReturnType<typeof historyReaderFixture>>[] = []
const servers: InstanceType<typeof core.AgentMuxControlServer>[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.stop()))
  await Promise.all(fixtures.splice(0).map(f => f.close())); vi.restoreAllMocks()
})
async function fixture(native = false, retired = false, body?: string) {
  const f = await historyReaderFixture(native, retired, body); fixtures.push(f)
  const server = new core.AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'),
    coreClients: () => [{ hostId: 'local', client: f.client }] })
  await server.start(); servers.push(server)
  const run = (source: string, extra: string[] = []) => runCompiledObjectCli(['agent', 'history', '--host', 'local',
    '--session', f.session.agentSessionId, '--source', source, '--limit', '1', ...extra], objectCliEnvironment(f.root))
  return { ...f, run }
}
it.each([false, true])('compiled CLI reads captured history without a token after old Run loss (retired=%s)', async retired => {
  const f = await fixture(false, retired)
  const first = await f.run('captured')
  expect(first.code, first.stderr).toBe(0)
  expect(first.stderr).toBe('')
  const page = JSON.parse(first.stdout)
  expect(page).toMatchObject({ ok: true, operation: 'agent.history', result: { ...f.reference, source: 'captured',
    availability: 'available', items: [{ kind: 'item', item: { id: 'captured-1', content: 'Original task 中' } }] } })
  const next = await f.run('captured', ['--cursor', page.result.nextCursor])
  expect(next.code, next.stderr).toBe(0)
  expect(JSON.parse(next.stdout).result).toMatchObject({ items: [{ kind: 'item', item: { id: 'captured-0' } }], nextCursor: null })
  const unavailable = await f.run('native')
  expect(unavailable.code).toBe(1)
  expect(JSON.parse(unavailable.stderr)).toMatchObject({ operation: 'agent.history', error: { code: 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE' } })
  await f.unchanged()
})
it('compiled CLI reads real Provider JSONL with source and opaque continuation after retirement', async () => {
  const f = await fixture(true, true)
  const first = await f.run('native', ['--max-bytes', '4096'])
  expect(first.code, first.stderr).toBe(0)
  expect(Buffer.byteLength(first.stdout)).toBeLessThanOrEqual(4096)
  const page = JSON.parse(first.stdout).result
  expect(page).toMatchObject({ ...f.reference, source: 'native', order: 'chronological-page',
    nativeSource: { providerId: 'claude', nativeSessionId: 'original-native' },
    items: [{ kind: 'item', item: { id: 'newer-native', contentParts: [{ kind: 'text', text: 'Original task 中' }] } }] })
  const next = await f.run('native', ['--cursor', page.nextCursor, '--max-bytes', '4096'])
  expect(next.code, next.stderr).toBe(0)
  expect(JSON.parse(next.stdout).result).toMatchObject({ items: [{ kind: 'item', item: { id: 'older-native' } }], nextCursor: null })
  await f.unchanged()
})
it('cold compiled CLI processes reconstruct an oversized captured item without skipping the older work', async () => {
  const body = 'Original 中🙂'.repeat(600), f = await fixture(false, true, body)
  const fragments: Buffer[] = []
  let cursor: string | undefined, sha = '', total = 0, done = false
  for (let index = 0; index < 100; index++) {
    const result = await f.run('captured', ['--max-bytes', '4096', ...(cursor ? ['--cursor', cursor] : [])])
    expect(result.code, result.stderr).toBe(0)
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(4096)
    const page = JSON.parse(result.stdout).result, fragment = page.items[0]
    expect(fragment.kind).toBe('fragment'); expect(fragment.offsetBytes).toBe(total)
    if (!sha) sha = fragment.sha256
    expect(fragment.sha256).toBe(sha)
    const bytes = Buffer.from(fragment.dataBase64, 'base64'); fragments.push(bytes); total += bytes.length
    expect(bytes.length).toBeGreaterThan(0); cursor = page.nextCursor
    if (total === fragment.totalBytes) { done = true; break }
  }
  expect(done).toBe(true)
  const bytes = Buffer.concat(fragments)
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(sha)
  expect(JSON.parse(bytes.toString('utf8')).content).toBe(body)
  const older = await f.run('captured', ['--max-bytes', '4096', '--cursor', cursor!])
  expect(older.code, older.stderr).toBe(0)
  expect(JSON.parse(older.stdout).result).toMatchObject({ items: [{ kind: 'item', item: { id: 'captured-0' } }], nextCursor: null })
  await f.unchanged()
})
it('public service selects only the explicit Host and rejects forged scope and native paths', async () => {
  const f = await fixture()
  const unrelated = new core.AgentMuxClient({ store: new core.AgentMuxMemoryAgentSessionStore() })
  const scan = vi.spyOn(unrelated, 'sessionHistorySources').mockRejectedValue(new Error('Unrelated Host must not be read'))
  const service = new core.AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client: f.client }, { hostId: 'other', client: unrelated }] })
  try {
    const input = { ...f.reference, source: 'captured' as const }
    expect((await service.call('agent.history', input)).items.length).toBeGreaterThan(0)
    expect(scan).not.toHaveBeenCalled()
    await expect(service.call('agent.history', { ...input, hostId: 'absent' })).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
    await expect(service.call('agent.history', { ...input, agentSessionId: 'original' })).rejects.toMatchObject({ code: 'UNKNOWN_AGENT_SESSION' })
    await expect(service.call('agent.history', { ...input, transcriptPath: fixturePath("untrusted") } as typeof input))
      .rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
    await expect(service.call('agent.history', { ...input, maxBytes: 100 })).rejects.toMatchObject({ code: 'INVALID_AGENT_SESSION_HISTORY_OPTIONS' })
    await f.unchanged()
  } finally { await unrelated.dispose(); await service.dispose() }
})
it('pages on the remote semantic Host without transferring an SDK snapshot through the outer RPC', async () => {
  const f = await fixture()
  const inner = new core.AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client: f.client }] })
  const forward = vi.fn(async (_method: 'agent.history', input: Parameters<typeof core.readAgentSessionHistory>[1]) => inner.call('agent.history', input))
  const remote = Object.assign(Object.create(f.client), { forwardRpc: forward })
  const snapshot = vi.spyOn(f.client, 'sessionTimeline')
  const outer = new core.AgentMuxRpcService({ coreClients: () => [{ hostId: 'remote-original', client: remote }] })
  const result = await outer.call('agent.history', { hostId: 'remote-original', agentSessionId: f.session.agentSessionId, source: 'captured', limit: 1 })
  expect(forward).toHaveBeenCalledOnce()
  expect(forward.mock.calls[0]!.slice(0, 2)).toEqual(['agent.history', { hostId: 'local', agentSessionId: f.session.agentSessionId, source: 'captured', limit: 1 }])
  expect(snapshot).toHaveBeenCalledOnce()
  expect(result).toMatchObject({ hostId: 'remote-original', agentSessionId: f.session.agentSessionId, source: 'captured', items: [{ kind: 'item' }] })
  await f.unchanged()
})
it('authenticates the local Mote caller before borrowing the exact remote read authority without exporting its capability', async () => {
  const local = await historyReaderFixture(false, false, 'Local work', true)
  const original = await historyReaderFixture(false, true)
  fixtures.push(local, original)
  const inner = new core.AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client: original.client }] })
  const forward = vi.fn(async (_method: 'agent.history', input: Parameters<typeof core.readAgentSessionHistory>[1], context = {}) =>
    inner.call('agent.history', input, context))
  const remote = Object.assign(Object.create(original.client), { forwardRpc: forward })
  const outer = new core.AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client: local.client }, { hostId: 'remote-original', client: remote }] })
  const input = { hostId: 'remote-original', agentSessionId: original.session.agentSessionId, source: 'captured' as const }
  const context = { caller: local.caller!, principal: { kind: 'user' as const, id: 'fixture-owner' }, transport: 'unix' as const }
  expect((await outer.call('agent.history', input, context)).items.length).toBeGreaterThan(0)
  expect(forward.mock.calls[0]![2]).not.toHaveProperty('caller')
  expect(forward.mock.calls[0]![2]).toMatchObject({ principal: context.principal })
  forward.mockClear()
  await expect(outer.call('agent.history', input, { ...context, caller: { ...local.caller!, capability: 'invalid' } }))
    .rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
  expect(forward).not.toHaveBeenCalled()
  await local.unchanged(); await original.unchanged()
})
