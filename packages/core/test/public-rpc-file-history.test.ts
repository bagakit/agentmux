import { fixturePath as _historyFixturePath } from "./helpers/fixture-values.js"
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseFileHistoryParams, parseFileHistoryResult, type FileHistoryParams, type FileHistoryResult } from '../src/public-rpc-file-history.js'
import { noteHistoryRevision, noteHistorySnapshot, type NoteHistoryRecord } from '../src/note-history.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { AgentMuxRpcDispatcher } from '../src/public-rpc-wire.js'
import { AGENTMUX_RPC_MAX_MESSAGE_BYTES, rpcEncode } from '../src/public-rpc-frame.js'
import { parseRpcNativeResult } from '../src/rpc-native-codec.js'
import { parseAgentMuxCliInvocation } from '../src/agentmux-cli-commands.js'
import { runCompiledObjectCli, objectCliEnvironment } from './helpers/object-cli-rpc.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import type { AgentMuxRpcFilesOwner } from '../src/public-rpc-files.js'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


const resource = { hostId: 'local', workspaceId: 'workspace', workspacePath: _historyFixturePath("fixture"), zoneId: 'zone', zonePath: _historyFixturePath("fixture/notes"), path: 'notes/page.note.md' }
const original = { hostId: resource.hostId, workspaceId: resource.workspaceId, workspacePath: resource.workspacePath, path: resource.path }
const params: FileHistoryParams = { zoneId: 'zone', path: 'page.note.md', expectedResource: resource, noteId: 'original-note', limit: 2 }
const records: NoteHistoryRecord[] = [2, 1].map(sequence => ({ eventId: `event-${sequence}`, sequence, batchId: 'batch-agent', parentEventId: sequence === 2 ? 'prior-committed-event' : null, noteId: params.noteId,
  resource: original, originalResource: { ...original, workspacePath: _historyFixturePath("before-move") }, status: sequence === 2 ? 'committed' : 'unconfirmed', at: _historyFixtureEpoch(0, 1, 0) + sequence,
  actor: { kind: 'agent', id: 'author-agent' }, operation: 'edit', requestFingerprint: 'private-fingerprint', baseRevision: noteHistoryRevision('before'),
  revision: noteHistoryRevision(`after ${sequence}`), beforeContent: 'before', content: `after ${sequence}` }))
const snapshot = (input = params): FileHistoryResult => ({ resource, result: noteHistorySnapshot({ ...input, resource: original },
  records.filter(record => input.eventId === undefined || record.eventId === input.eventId).map(({ requestFingerprint: _private, ...entry }) => entry), input.eventId === undefined) })
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
function files(history?: AgentMuxRpcFilesOwner['history']): AgentMuxRpcFilesOwner {
  return { read: async () => ({ resource, result: { status: 'directory' } }), list: async () => ({ resource, result: { status: 'listed', files: [], complete: true, omitted: 'none', partialReason: null } }),
    write: vi.fn(), create: vi.fn(), ...(history ? { history } : {}) }
}
async function endpoint(owner: AgentMuxRpcFilesOwner) {
  const root = await mkdtemp(join(tmpdir(), 'amx-history-')), path = join(root, 'control.sock')
  const server = new AgentMuxControlServer({ socketPath: path, coreClients: () => [], files: owner })
  await server.start(); cleanup.push(async () => { await server.stop(); await rm(root, { recursive: true, force: true }) })
  return { root, path }
}

describe('exact original Note history public contract', () => {
  it('admits full mapped resources and bounded event/sequence queries without accepting an actor', () => {
    expect(parseFileHistoryParams({ ...params, before: 4, eventId: 'event-2', includeContent: true })).toMatchObject(params)
    for (const invalid of [
      { ...params, actor: { kind: 'agent', id: 'spoofed' } }, { ...params, expectedResource: original },
      { ...params, expectedResource: { ...resource, path: 'notes/another.note.md' } }, { ...params, noteId: '' },
      { ...params, path: '../escape.md' }, { ...params, limit: 0 }, { ...params, limit: 201 }, { ...params, before: 0 },
      { ...params, before: 1.5 }, { ...params, eventId: 'wrong\nevent' }, { ...params, includeContent: 'true' }, { ...params, includeContent: true }
    ]) expect(() => parseFileHistoryParams(invalid)).toThrowError(expect.objectContaining({ code: 'INVALID_CONTROL_REQUEST' }))
  })
  it('preserves event and attribution state, historical resource facts, pagination and content opt-in', () => {
    const value = snapshot()
    expect(parseFileHistoryResult(value, params)).toBe(value)
    expect(value.result).toMatchObject({ status: 'read', hasMore: true, entries: [{ status: 'committed' }, { status: 'unconfirmed' }] })
    expect(value.result).not.toHaveProperty('entries.0.content')
    const contentQuery = { ...params, eventId: 'event-2', includeContent: true }, withContent = snapshot(contentQuery)
    expect(parseRpcNativeResult('file.history', withContent, contentQuery)).toEqual(withContent)
    expect(withContent.result).toHaveProperty('entries.0.originalResource.workspacePath', _historyFixturePath("before-move"))
    if (withContent.result.status === 'unknown') throw Error('Fixture must contain history')
    const provenance = { noteId: params.noteId, resource: original, revision: records[0]!.revision,
      blocks: { block: { created: { actor: { kind: 'agent' as const, id: 'author-agent' }, at: _historyFixtureEpoch(0, 1, 2) }, lastEdited: null } } }
    withContent.result.entries[0]!.provenance = provenance
    expect(parseFileHistoryResult(withContent, contentQuery)).toEqual(withContent)
    ;(provenance.blocks.block.created.actor as unknown as Record<string, unknown>).kind = ['agent']
    expect(() => parseFileHistoryResult(withContent, contentQuery)).toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
    const exactQuery = { ...params, eventId: 'event-2' }
    const exact = { resource, result: noteHistorySnapshot({ ...exactQuery, resource: original }, records.slice(0, 1), false) }
    expect(parseFileHistoryResult(exact, exactQuery)).toEqual(exact)
    expect(parseFileHistoryResult(value, { ...params, before: 3 })).toBe(value)
    const unknown = { resource: null, result: { status: 'unknown', code: 'HISTORY_UNAVAILABLE', message: 'Original history retained.' } }
    expect(parseFileHistoryResult(unknown, params)).toBe(unknown)
    const unconfirmed = structuredClone(value)
    Object.assign(unconfirmed.result, { status: 'unconfirmed', reason: 'Original write outcome is unknown.' })
    expect(parseFileHistoryResult(unconfirmed, params)).toBe(unconfirmed)
  })
  it('rejects another Note, mapping, event, status, sequence, batch membership or revision', () => {
    const mutations: Array<(value: any) => void> = [
      v => { v.resource.zonePath = _historyFixturePath("fixture/rebound"); v.resource.path = 'rebound/page.note.md' },
      v => { v.result.noteId = 'another-note' }, v => { v.result.resource.path = 'notes/another.note.md' },
      v => { v.result.entries[0].noteId = 'another-note' }, v => { v.result.entries[0].resource.hostId = 'another-host' },
      v => { delete v.result.entries[0].originalResource }, v => { v.result.entries[0].status = 'saved' },
      v => { delete v.result.entries[0].parentEventId }, v => { v.result.entries[0].parentEventId = 'event-2' },
      v => { v.result.status = ['read'] }, v => { v.result.entries[0].status = ['committed'] },
      v => { v.result.entries[0].operation = 'unknown' }, v => { v.result.entries[0].actor = { kind: 'provider', id: 'forged' } },
      v => { v.result.entries[0].operation = ['edit'] }, v => { v.result.entries[0].actor.kind = ['agent'] },
      v => { v.result.entries[1].sequence = 2 }, v => { v.result.entries[1].eventId = 'event-2' },
      v => { v.result.entries[0].sequence = -1 }, v => { v.result.hasMore = 'true' },
      v => { v.result.batches[0].eventIds.pop() }, v => { v.result.batches[0].eventIds.push('event-2') },
      v => { v.result.batches[0].actor.id = 'another-author' }, v => { v.result.batches[0].from = 0 },
      v => { v.result.entries[0].content = 'unrequested source' }, v => { v.result.entries[0].requestFingerprint = 'private' }
    ]
    expect(mutations.length).toBeGreaterThan(0)
    for (const mutate of mutations) { const value = structuredClone(snapshot()); mutate(value); expect(() => parseFileHistoryResult(value, params)).toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' })) }
    const contentParams = { ...params, eventId: 'event-2', includeContent: true }, value = snapshot(contentParams)
    if (value.result.status === 'unknown') throw Error('Fixture must contain history')
    value.result.entries[0]!.content = 'replacement source'
    expect(() => parseFileHistoryResult(value, contentParams)).toThrow('does not match')
    expect(() => parseFileHistoryResult(snapshot(), { ...params, before: 2 })).toThrow('ordering')
    expect(() => parseFileHistoryResult(snapshot(), { ...params, eventId: 'event-2' })).toThrow()
    expect(() => parseFileHistoryResult({ resource: null, result: { ...snapshot().result } }, params)).toThrow('confirmed original resource')
  })
  it('uses the trusted service context and owner port, retaining existing file reads when history is absent', async () => {
    const h = await rpcOwnerFixture(); cleanup.push(h.close)
    const history = vi.fn(async () => snapshot()), owner = files(history), service = new AgentMuxRpcService({ coreClients: h.coreClients, files: owner })
    cleanup.push(() => service.dispose())
    expect(await service.call('file.history', params, { caller: h.credentials })).toEqual(snapshot())
    expect(history).toHaveBeenCalledExactlyOnceWith(params)
    await expect(service.call('file.history', params, { caller: { ...h.credentials, capability: 'wrong' } })).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
    expect(history).toHaveBeenCalledTimes(1)
    const absent = new AgentMuxRpcService({ coreClients: h.coreClients, files: files() }); cleanup.push(() => absent.dispose())
    await expect(absent.call('file.history', params, { caller: h.credentials })).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
    expect(await absent.call('file.read', { zoneId: params.zoneId, path: params.path, expectedResource: { hostId: original.hostId, workspaceId: original.workspaceId, workspacePath: original.workspacePath } }, { caller: h.credentials })).toMatchObject({ result: { status: 'directory' } })
    expect(h.inner.kernel.stop).not.toHaveBeenCalled(); expect(owner.write).not.toHaveBeenCalled(); expect(owner.create).not.toHaveBeenCalled()
  })
  it('forwards the exact history query and original authorization when the selected file owner lacks this optional port', async () => {
    const context = { principal: { kind: 'device' as const, id: 'original-device' } }, forward = vi.fn(async () => snapshot())
    const service = new AgentMuxRpcService({ coreClients: () => [], files: files(), forwardControl: forward as any }); cleanup.push(() => service.dispose())
    expect(await service.call('file.history', params, context)).toEqual(snapshot())
    expect(forward).toHaveBeenCalledExactlyOnceWith('file.history', params, context)
    forward.mockResolvedValue({ ...snapshot(), result: { status: 'unknown', code: 'OWNER_UNKNOWN', message: 'Keep the original query.' } })
    expect(await service.call('file.history', params, context)).toMatchObject({ result: { status: 'unknown', code: 'OWNER_UNKNOWN' } })
  })
  it('uses the real frame encoder for one oversized before/after body and retains the same event metadata', async () => {
    // 16 MiB of tabs on each side becomes over 64 MiB after JSON escaping.
    // The single body is shared; no user file or synthetic frame budget is used.
    const content = '\t'.repeat(16 * 1024 * 1024), revision = noteHistoryRevision(content)
    const event = { ...records[0]!, content, beforeContent: content, baseRevision: revision, revision }
    const owner = files(async input => ({ resource, result: noteHistorySnapshot({ ...input, resource: original }, [event], false) }))
    const service = new AgentMuxRpcService({ coreClients: () => [], files: owner }); cleanup.push(() => service.dispose())
    const selected = { ...params, eventId: event.eventId }
    expect(await service.call('file.history', { ...selected, includeContent: true })).toEqual({ resource,
      result: { status: 'unknown', code: 'FILE_HISTORY_CONTENT_UNAVAILABLE', message: expect.stringContaining('metadata remain available') } })
    const metadata = await service.call('file.history', selected)
    expect(metadata).toMatchObject({ resource, result: { status: 'read', hasMore: false, entries: [{ eventId: event.eventId, parentEventId: event.parentEventId, revision }] } })
    expect(metadata.result).not.toHaveProperty('entries.0.content')
    expect(await service.call('file.read', { zoneId: params.zoneId, path: params.path,
      expectedResource: { hostId: original.hostId, workspaceId: original.workspaceId, workspacePath: original.workspacePath } })).toMatchObject({ result: { status: 'directory' } })
    expect(owner.write).not.toHaveBeenCalled(); expect(owner.create).not.toHaveBeenCalled()
  }, 30_000)
  it('includes the trusted original response ID in selected-history content capacity without restricting that ID', async () => {
    const content = '\t'.repeat(12 * 1024 * 1024), revision = noteHistoryRevision(content), responseId = 'h'.repeat(20 * 1024 * 1024)
    const event = { ...records[0]!, content, beforeContent: content, baseRevision: revision, revision }
    const input = { ...params, eventId: event.eventId, includeContent: true }, withContent = { resource, result: noteHistorySnapshot({ ...input, resource: original }, [event], false) }
    const request = { jsonrpc: '2.0', id: responseId, method: 'file.history', params: input }
    expect(Buffer.byteLength(rpcEncode(request))).toBeLessThan(AGENTMUX_RPC_MAX_MESSAGE_BYTES)
    expect(Buffer.byteLength(rpcEncode({ jsonrpc: '2.0', id: null, result: withContent }))).toBeLessThan(AGENTMUX_RPC_MAX_MESSAGE_BYTES)
    expect(() => rpcEncode({ jsonrpc: '2.0', id: responseId, result: withContent })).toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
    const owner = files(async () => withContent), service = new AgentMuxRpcService({ coreClients: () => [], files: owner }); cleanup.push(() => service.dispose())
    const response = await new AgentMuxRpcDispatcher(service).receive(request, { signal: new AbortController().signal, stream: false,
      send: vi.fn(), activate: vi.fn(), cancel: vi.fn(), afterResponse: [] })
    if (!response || Array.isArray(response)) throw Error('Expected one original response')
    expect(response.id === responseId).toBe(true)
    expect(response.error).toBeUndefined()
    expect(response.result).toMatchObject({ resource, result: { status: 'unknown', code: 'FILE_HISTORY_CONTENT_UNAVAILABLE' } })
    expect(Buffer.byteLength(rpcEncode(response))).toBeLessThan(AGENTMUX_RPC_MAX_MESSAGE_BYTES)
    expect(owner.write).not.toHaveBeenCalled(); expect(owner.create).not.toHaveBeenCalled()
  }, 30_000)
  it('connects typed RPC and the compiled CLI through the real public server, including unconfirmed receipts', async () => {
    const contentParams = { ...params, eventId: 'event-2', includeContent: true }
    let result = snapshot(contentParams)
    const history = vi.fn(async () => result), h = await endpoint(files(history)), client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: h.path } })
    cleanup.push(() => client.dispose())
    expect(await client.call('file.history', contentParams)).toEqual(result)
    const args = ['--endpoint', `unix:${h.path}`, 'file', 'history', '--zone', params.zoneId, '--path', params.path, '--resource', JSON.stringify(resource), '--note', params.noteId, '--limit', '2', '--event-id', 'event-2', '--content']
    expect((await parseAgentMuxCliInvocation(args)).params).toEqual(contentParams)
    const run = () => runCompiledObjectCli(args, objectCliEnvironment(h.root))
    const success = await run()
    expect(success.code, success.stderr).toBe(0)
    expect(JSON.parse(success.stdout)).toMatchObject({ ok: true, operation: 'file.history', result })
    result = { resource, result: { status: 'unknown', code: 'ORIGINAL_UNKNOWN', message: 'Original history could not be observed.' } }
    const unknown = await run()
    expect(unknown.code).toBe(1)
    expect(JSON.parse(unknown.stdout)).toMatchObject({ result: { result: { status: 'unknown', code: 'ORIGINAL_UNKNOWN' } } })
    result = snapshot(contentParams)
    Object.assign(result.result, { status: 'unconfirmed', reason: 'The original write is still unknown.' })
    const partial = await run()
    expect(partial.code).toBe(1)
    expect(JSON.parse(partial.stdout)).toMatchObject({ result: { result: { status: 'unconfirmed' } } })
    expect(history.mock.calls.length).toBe(4)
  })
  it('parses explicit history selection and refuses malformed or duplicate CLI options', async () => {
    const args = ['file', 'history', '--zone', params.zoneId, '--path', params.path, '--resource', JSON.stringify(resource), '--note', params.noteId]
    expect((await parseAgentMuxCliInvocation([...args, '--space', 'original-space', '--before', '3', '--event-id', 'event-2', '--limit', '1', '--content'])).params)
      .toEqual({ ...params, limit: 1, spaceId: 'original-space', before: 3, eventId: 'event-2', includeContent: true })
    for (const tail of [['--actor', 'forged'], ['--before', '1.5'], ['--limit', '201'], ['--content'], ['--content=true'], ['--note', 'replacement']]) {
      await expect(parseAgentMuxCliInvocation([...args, ...tail])).rejects.toThrow()
    }
    await expect(parseAgentMuxCliInvocation(args.map(value => value === JSON.stringify(resource) ? '{invalid' : value))).rejects.toMatchObject({ code: 'INVALID_CLI_ARGUMENT' })
  })
})
