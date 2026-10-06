import { afterEach, expect, it } from 'vitest'
import { join } from 'node:path'
import { historyReaderFixture, core } from './fixtures/session-history-reader.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

const resources: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of resources.splice(0).reverse()) await close() })

it('reads the retained original conversation through the SDK, public service and compiled CLI', async () => {
  const f = await historyReaderFixture(true, true); resources.push(f.close)
  const server = new core.AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'),
    coreClients: () => [{ hostId: 'local', client: f.client }] })
  await server.start(); resources.push(() => server.stop())
  const input = { ...f.reference, source: 'native' as const, limit: 1 }
  const sdk = await f.client.readAgentConversation(input)
  expect(sdk).toMatchObject(f.reference)
  expect(sdk.items).toMatchObject([{ kind: 'item', item: { id: 'newer-native' } }])
  const output = await runCompiledObjectCli(['agent', 'conversation', 'inspect', '--host', 'local',
    '--session', f.reference.agentSessionId, '--source', 'native', '--limit', '1'], objectCliEnvironment(f.root))
  expect(output.code, output.stderr).toBe(0)
  const result = JSON.parse(output.stdout)
  expect(result.operation).toBe('agent.conversation.inspect')
  expect({ hostId: result.result.hostId, agentSessionId: result.result.agentSessionId }).toEqual(f.reference)
  expect(result.result.items).toEqual(sdk.items)
  expect(result.result.nextCursor).toBeTypeOf('string')
  await f.unchanged()
})

it('retains oversized original bytes and rejects forged route references without controlling the Agent', async () => {
  const f = await historyReaderFixture(false, false, 'Large original 中🙂'.repeat(800)); resources.push(f.close)
  const input = { ...f.reference, source: 'captured' as const, limit: 1, maxBytes: 4096 }
  const result = await f.client.readAgentConversation(input)
  expect(result.items).toMatchObject([{ kind: 'fragment', offsetBytes: 0 }])
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(4096)
  expect(core.parseConversationReadPage(result, input)).toEqual(result)
  expect(() => core.parseConversationReadPage({ ...result, agentSessionId: 'other' }, input))
    .toThrow(/another source/)
  await f.unchanged()
})

it('projects original source identity, all parts and independent repeated content without UI dependencies', () => {
  const parts = [{ kind: 'text' as const, text: 'Same content' }, { kind: 'reasoning' as const, text: 'Recorded trace' }]
  const page = { agentSessionId: 'session', source: { providerId: 'codex', nativeSessionId: 'native' },
    items: ['first', 'second'].map(id => ({ id, kind: 'assistant-message' as const, contentParts: parts })), nextCursor: null }
  const records = core.projectConversationRecords({ agentSessionId: 'session', executionHostId: 'owner', historyPage: page })
  expect(records.map(record => record.rawId)).toEqual(['first', 'second'])
  expect(new Set(records.map(record => record.id)).size).toBe(2)
  expect(records.map(record => record.author)).toEqual([{ kind: 'agent', agentSessionId: 'session' }, { kind: 'agent', agentSessionId: 'session' }])
  expect(records[0]!.contentParts).toBe(parts)
  expect(records[0]!.original).toEqual({ kind: 'native', item: page.items[0] })
  expect(core.projectConversationRecords({ agentSessionId: 'other', historyPage: page })).toEqual([])
})

it('the shared read envelope does not duplicate long legal scope identities outside the original byte budget', async () => {
  const f = await historyReaderFixture(false); resources.push(f.close)
  const input = { ...f.reference, source: 'captured' as const, limit: 1, maxBytes: 4096 }
  const page = await f.client.readAgentConversation(input)
  const hostId = 'route'.repeat(320)
  const wire = { ...page, hostId }
  expect(Buffer.byteLength(JSON.stringify(wire))).toBeLessThanOrEqual(4096 - 1024)
  expect(core.parseConversationReadPage(wire, { ...input, hostId })).toEqual(wire)
  expect(Object.keys(wire)).not.toContain('conversation')
})
