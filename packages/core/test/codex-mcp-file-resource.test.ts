import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { createHash } from 'node:crypto'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore, loadAgentSessions } from '../src/agent-session-store.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import type { AgentMuxRpcMethod, AgentMuxRpcParams } from '../src/public-rpc.js'
import type { AgentSessionHistoryResourceReadResult } from '../src/types.js'
import { jsonl } from './fixtures/native-history-session.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

const source = { providerId: 'codex', nativeSessionId: '00000000-0000-4000-8000-000000000001' }
const sessionId = 'codex-mcp-file-session', turnId = 'original-turn', callId = 'original-mcp-call'
const bytes = Buffer.from([0, 255, 17, 29, ...Buffer.from('Original recorded MCP document')])
const mimeType = 'application/octet-stream', reference = `data:${mimeType};base64,${bytes.toString('base64')}`
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')

function completed(options: { name?: string; thread?: string; turn?: string; itemId?: string; content?: unknown[] } = {}) {
  return { type: 'event_msg', payload: { type: 'item_completed', thread_id: options.thread ?? source.nativeSessionId,
    turn_id: options.turn ?? turnId, item: { type: 'McpToolCall', id: options.itemId ?? callId, server: 'recorded-server', tool: 'read_document',
      arguments: { resource: 'original' }, status: 'completed', result: { content: options.content ?? [
        { type: 'resource', resource: { uri: 'opaque:original/report.bin', mimeType, blob: bytes.toString('base64'), ...(options.name === undefined ? {} : { name: options.name }) } },
        { type: 'text', text: 'Original tool note' }
      ] } } } }
}
function modelOutput() {
  // The model representation is a string, even when it contains a JSON-shaped resource.
  const output = JSON.stringify(completed().payload.item.result)
  return { type: 'response_item', payload: { type: 'function_call_output', call_id: callId, turn_id: turnId, output } }
}

async function fixture(rows: unknown[] = [modelOutput(), completed()]) {
  const root = await mkdtemp(join(tmpdir(), 'amx-codex-file-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'native.jsonl'), store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
  const records: unknown[] = [{ type: 'session_meta', payload: { id: source.nativeSessionId, cwd: root, history_mode: 'paginated', cli_version: '0.163.0' } }, ...rows]
  await writeFile(path, jsonl(records))
  await store.compareAndSwap(null, { kind: 'agent', agentSessionId: sessionId, providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: root,
    run: { runId: 'retained-original-run' }, retiredRuns: [], hookBindingId: 'original-binding', hookToken: 'original-content-authority', createdAt: _tailFixtureEpoch(0, 0, 1), updatedAt: _tailFixtureEpoch(0, 0, 1),
    nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: source.nativeSessionId, transcriptPath: path } })
  const previousQueue = process.env.AGENTMUX_MESSAGE_QUEUE_PATH
  let client: AgentMuxClient
  try { process.env.AGENTMUX_MESSAGE_QUEUE_PATH = join(root, 'messages.ndjson'); client = new AgentMuxClient({ store }) }
  finally { if (previousQueue === undefined) delete process.env.AGENTMUX_MESSAGE_QUEUE_PATH; else process.env.AGENTMUX_MESSAGE_QUEUE_PATH = previousQueue }
  cleanups.push(() => client.dispose())
  const connect = vi.spyOn(client, 'connect').mockRejectedValue(new Error('Reading an original MCP file cannot connect a Run'))
  const runtime = new AgentMuxHostedRuntimeService(client, null, () => ({ runtimeId: 'mcp-file-runtime', ownerInstanceId: 'mcp-file-owner', protocolVersion: 2,
    processId: process.pid, availability: 'unverified', ctxmux: { hostId: 'local', buildIdentity: 'mcp-file-fixture', protocolVersion: 1,
      processId: null, instanceId: 'original-runtime-context', ownership: 'unverified' } }))
  cleanups.push(() => runtime.dispose())
  const server = new AgentMuxControlServer({ coreClients: () => [{ hostId: 'local', client }], hostedRuntime: () => runtime }, join(root, 'control.sock'))
  await server.start(); cleanups.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanups.push(() => rpc.dispose())
  const recordId = (index: number) => `codex-record:${Buffer.byteLength(jsonl(records.slice(0, index)))}`
  const input = (index = records.length - 1) => ({ hostId: 'local', agentSessionId: sessionId, source, turnId, recordId: recordId(index), partIndex: 0, expectedReference: reference, representation: 'file' as const })
  const cli = (request: unknown) => runCompiledObjectCli(['--endpoint', 'unix:' + server.path, 'agent', 'history', 'resource', '--input', '-'], objectCliEnvironment(root), JSON.stringify(request))
  return { root, path, store, client, connect, rpc, records, recordId, input, cli,
    append: async (...next: unknown[]) => { await appendFile(path, jsonl(next)); records.push(...next) } }
}

function expectFile(result: AgentSessionHistoryResourceReadResult['result'], label?: string) {
  expect(result.status).toBe('file')
  if (result.status !== 'file') throw new Error('The original typed MCP file was not returned')
  expect(result).toMatchObject({ mimeType, byteLength: bytes.length, dataBase64: bytes.toString('base64') })
  expect(result.label).toBe(label)
  expect(digest(Buffer.from(result.dataBase64, 'base64'))).toBe(digest(bytes))
}

it('reads one canonical MCP file through compiled CLI, SDK and Hosted without converting its model text into a second file', async () => {
  const h = await fixture(), input = h.input()
  // Keep the first oracle downstream of the real Provider and Unix public service.
  const output = await h.cli(input)
  expect(output.code, output.stdout + output.stderr).toBe(0)
  const receipt = JSON.parse(output.stdout).result
  expect(receipt).toMatchObject({ source, recordId: input.recordId, turnId, partIndex: 0, reference })
  expectFile(receipt.result)
  const { hostId: _host, agentSessionId: _session, ...request } = input
  expectFile((await h.client.sessionHistoryResource(sessionId, request)).result)
  const page = await h.client.sessionHistoryPage(sessionId)
  expect(page.items.flatMap(item => item.contentParts.filter(part => part.kind === 'resource' && part.resourceType === 'file'))).toHaveLength(1)
  const canonical = page.items.find(item => item.id === input.recordId)!, mirror = page.items.find(item => item.id === h.recordId(1))!
  expect(canonical).toMatchObject({ kind: 'activity', turnId })
  expect(canonical.contentParts[0]).toMatchObject({ kind: 'resource', resourceType: 'file', reference, contentEligibility: 'public' })
  const metadata = canonical.contentParts.filter(part => part.kind === 'tool-result')
  expect(metadata).toHaveLength(1)
  expect(metadata[0]).toMatchObject({ callId, contentEligibility: 'unconfirmed' })
  expect(JSON.stringify(metadata)).not.toContain(bytes.toString('base64'))
  expect(JSON.stringify(metadata)).toContain('Original tool note')
  expect(mirror).toMatchObject({ kind: 'activity', turnId, contentParts: [{ kind: 'tool-result', callId, output: modelOutput().payload.output }] })
  expect(canonical.conversation?.sameEvent).toBeUndefined(); expect(mirror.conversation?.sameEvent).toBeUndefined()
  expect(canonical.conversation?.nativeInvocationScope?.source).toEqual(source)
  expect(mirror.conversation?.nativeInvocationScope?.source).toEqual(source)
  expect(page.items.some(item => item.kind === 'user-message' || item.kind === 'assistant-message')).toBe(false)

  let finishProjection!: () => void
  const projection = new Promise<void>(resolveProjection => { finishProjection = resolveProjection })
  const port = { call: async <M extends AgentMuxRpcMethod>(method: M, params: AgentMuxRpcParams<M>, options?: { signal?: AbortSignal }) => {
    const response = h.rpc.call(method, params, options)
    if (method === 'runtime.invoke' && (params as AgentMuxRpcParams<'runtime.invoke'>).invocation.method === 'runtimeProjection')
      void response.then(() => finishProjection(), () => finishProjection())
    return await response
  }, subscribe: h.rpc.subscribe.bind(h.rpc) }
  const hosted = await connectHostedAgentMux({ rpc: port, consumerId: 'mcp-file-reader' }); cleanups.push(() => hosted.dispose())
  await projection; expect(h.connect).toHaveBeenCalledTimes(1); h.connect.mockClear()
  expectFile((await hosted.sessionHistoryResource(sessionId, request)).result)
  expect(h.connect).not.toHaveBeenCalled()
  expect((await loadAgentSessions(h.store))[0]!.run).toEqual({ runId: 'retained-original-run' })
})

it('uses the original cut and same canonical record and part after append and after the newest page moves', async () => {
  const h = await fixture([]), cut = await h.client.sessionHistoryCheckpoint(sessionId)
  const commonCut = await h.rpc.call('agent.conversation.checkpoint', { hostId: 'local', agentSessionId: sessionId })
  await h.append(modelOutput(), completed({ name: 'Original report.bin' }))
  const input = h.input(), changes = await h.client.readSessionHistoryChanges(sessionId, { checkpoint: cut })
  const canonical = changes.items.find(item => item.id === input.recordId)!
  expect(canonical.turnId).toBe(turnId)
  expect(canonical.contentParts[0]).toMatchObject({ kind: 'resource', resourceType: 'file', reference, label: 'Original report.bin' })
  const common = await h.rpc.call('agent.conversation.changes', { hostId: 'local', agentSessionId: sessionId, checkpoint: commonCut.checkpoint })
  const records = common.items.flatMap(entry => entry.kind === 'item' ? entry.item.records : [])
  expect(records.filter(record => record.original.kind === 'native' && record.original.item.id === input.recordId)).toHaveLength(1)
  const retained = records.find(record => record.original.kind === 'native' && record.original.item.id === input.recordId)!
  expect(retained.original).toMatchObject({ kind: 'native', item: { contentParts: canonical.contentParts, turnId } })
  expect(common.items.flatMap(entry => entry.kind === 'item' ? entry.item.event.relations.filter(relation => relation.kind === 'same-event') : [])).toEqual([])
  await h.append(...Array.from({ length: 35 }, (_, i) => ({ type: 'event_msg', payload: { type: 'agent_message', message: `Independent later record ${i}` } })))
  expect((await h.client.sessionHistoryPage(sessionId, { limit: 30 })).items.map(item => item.id)).not.toContain(input.recordId)
  const output = await h.cli(input)
  expect(output.code, output.stdout + output.stderr).toBe(0)
  expectFile(JSON.parse(output.stdout).result.result, 'Original report.bin')
  expect(h.connect).not.toHaveBeenCalled()
})

it('refuses a canonical-looking file from a different original thread through compiled CLI', async () => {
  const h = await fixture([completed({ thread: '00000000-0000-4000-8000-000000000002' })])
  const output = await h.cli(h.input())
  expect(output.code, output.stdout + output.stderr).toBe(1)
  const page = await h.client.sessionHistoryPage(sessionId)
  expect(page.items.flatMap(item => item.contentParts.filter(part => part.kind === 'resource' && part.resourceType === 'file'))).toEqual([])
  expect(h.connect).not.toHaveBeenCalled()
})

it('preserves previews and unknown resource shapes without guessing a file or changing the original input', async () => {
  const resource = { uri: 'opaque:do-not-fetch', mimeType, blob: bytes.toString('base64') }
  for (const record of [completed({ turn: '' }), completed({ itemId: '' }), completed({ content: [{ type: 'text', text: JSON.stringify(resource) }] }),
    completed({ content: [{ type: 'resource_link', uri: resource.uri, mimeType }] }), completed({ content: [{ type: 'resource', resource: { uri: resource.uri, blob: resource.blob } }] }),
    ...['image/png', 'audio/wav'].map(mimeType => completed({ content: [{ type: 'resource', resource: { ...resource, mimeType } }] }))]) {
    const h = await fixture([record]), page = await h.client.sessionHistoryPage(sessionId)
    expect(page.items.flatMap(item => item.contentParts.filter(part => part.kind === 'resource' && part.resourceType === 'file'))).toEqual([])
    expect(await readFile(h.path, 'utf8')).toContain(JSON.stringify(record))
    expect(h.connect).not.toHaveBeenCalled()
  }
  const malformed = await fixture([completed({ content: [{ type: 'resource', resource: { ...resource, blob: 'Zg=' } }] })])
  const input = { ...malformed.input(), expectedReference: `data:${mimeType};base64,Zg=` }
  expect((await malformed.rpc.call('agent.history.resource', input)).result).toMatchObject({ status: 'unavailable', code: 'AGENT_SESSION_HISTORY_RESOURCE_FORMAT_UNSUPPORTED' })
  const h = await fixture(), original = h.input()
  for (const patch of [{ turnId: 'other-turn' }, { partIndex: 20 }, { expectedReference: reference + 'AA' }])
    await expect(h.rpc.call('agent.history.resource', { ...original, ...patch })).rejects.toHaveProperty('code')
  expect(h.connect).not.toHaveBeenCalled()
})
