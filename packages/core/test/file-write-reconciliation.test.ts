import { fixturePath as _historyFixturePath } from "./helpers/fixture-values.js"
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fileUploadRevision, parseFileWriteParams, parseFileWriteResult, parseFileCreateParams, type FileWriteParams, type FileWriteResult, type AgentMuxRpcFilesOwner } from '../src/public-rpc-files.js'
import { parseAgentMuxCliInvocation } from '../src/agentmux-cli-commands.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { AGENTMUX_RPC_MAX_MESSAGE_BYTES, rpcEncode } from '../src/public-rpc-frame.js'
import { AgentMuxRpcDispatcher } from '../src/public-rpc-wire.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


const hash = (content: string) => fileUploadRevision(new TextEncoder().encode(content))
const resource = { hostId: 'local', workspaceId: 'workspace', workspacePath: _historyFixturePath("fixture"), zoneId: 'zone', zonePath: _historyFixturePath("fixture"), path: 'page.note.md' }
const baseContent = '\uFEFFOriginal 中文\r\nSecond paragraph\n'
const params: FileWriteParams = { zoneId: resource.zoneId, path: resource.path, expectedResource: resource, baseContent,
  operationId: 'original-edit', expectedRevision: hash(baseContent), content: 'Proposed 中文\r\nSecond paragraph\n' }
const plain = () => { const { operationId: _operation, baseContent: _base, ...cas } = params; return cas }
const saved = (content = 'Canonical merged body'): FileWriteResult => ({ resource, result: { status: 'written', revision: hash(content), content,
  noteHistory: { eventId: params.operationId!, batchId: 'batch-original', status: 'committed' } } })
const conflict = (): FileWriteResult => ({ resource, result: { status: 'conflict', observedRevision: hash('Current saved body'),
  noteConflict: { reason: 'overlap', baseContent, currentContent: 'Current saved body', proposedContent: params.content } } })
const cleanup: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
async function root() { const path = await mkdtemp(join(tmpdir(), 'note-write-public-')); cleanup.push(() => rm(path, { recursive: true, force: true })); return path }
function files(write: AgentMuxRpcFilesOwner['write']): AgentMuxRpcFilesOwner {
  return { read: async () => ({ resource, result: { status: 'directory' } }), list: vi.fn(), create: vi.fn(), write }
}
describe('original Note edit public write contract', () => {
  it('keeps ordinary CAS and requires the complete original operation/base pair with its exact revision', () => {
    expect(parseFileWriteParams(plain())).toEqual(plain())
    expect(parseFileWriteParams(params)).toEqual(params)
    for (const invalid of [
      { ...plain(), baseContent }, { ...plain(), operationId: 'half-operation' }, { ...params, baseContent: baseContent.trim() },
      { ...params, baseContent: null }, { ...params, operationId: '' }, { ...params, operationId: ['original-edit'] },
      { ...params, operationId: 'other\noperation' }, { ...params, actor: { kind: 'agent', id: 'forged' } },
      { ...params, expectedRevision: null }, { ...params, expectedResource: { ...resource, path: 'other.note.md' } },
      { ...params, responseId: 'Not business authority' }
    ]) expect(() => parseFileWriteParams(invalid)).toThrowError(expect.objectContaining({ code: 'INVALID_CONTROL_REQUEST' }))
    const creation = { ...plain(), expectedRevision: null }
    expect(parseFileCreateParams(creation)).toEqual(creation)
    for (const fields of [{ baseContent }, { operationId: params.operationId }, { baseContent, operationId: params.operationId }]) {
      expect(() => parseFileCreateParams({ ...creation, ...fields })).toThrowError(expect.objectContaining({ code: 'INVALID_CONTROL_REQUEST' }))
    }
  })
  it('binds enhanced written and committed replay receipts to the original operation and canonical bytes', () => {
    expect(parseFileWriteResult(saved(), params)).toEqual(saved())
    const replay = saved()
    if (replay.result.status !== 'written') throw Error('Fixture must be written')
    replay.result.noteHistory = { status: 'committed', eventId: params.operationId!, batchId: 'original-batch', replayed: true }
    expect(parseFileWriteResult(replay, params)).toEqual(replay)
    const mutations: Array<(value: any) => void> = [
      value => { delete value.result.content }, value => { delete value.result.noteHistory },
      value => { value.result.content = 'Different bytes' }, value => { value.result.noteHistory.eventId = 'another-operation' },
      value => { value.result.noteHistory.replayed = false }, value => { value.result.noteHistory.replayed = ['true'] },
      value => { value.result.noteHistory.replayed = true; value.result.noteHistory.status = 'prepared' },
      value => { value.result.noteHistory.reason = 'Not a committed-history field' },
      value => { value.result.noteConflict = conflict().result }, value => { value.resource.workspaceId = 'another-workspace' }
    ]
    expect(mutations.length).toBeGreaterThan(0)
    for (const mutate of mutations) { const value = structuredClone(saved()); mutate(value); expect(() => parseFileWriteResult(value, params)).toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' })) }
    expect(() => parseFileWriteResult(replay, plain())).toThrow('committed original Note operation')
    expect(parseFileWriteResult({ resource, result: { status: 'written', revision: hash(plain().content) } }, plain())).toMatchObject({ result: { status: 'written' } })
    const note = saved('---\nschema: agentmux.note.md.v1\nnote-id: original-note\n---\nSaved body\n')
    if (note.result.status !== 'written') throw Error('Fixture must be written')
    const author = { actor: { kind: 'agent' as const, id: 'original-agent' }, at: _historyFixtureEpoch(0, 0, 1) }
    note.result.noteProvenance = { noteId: 'original-note', resource: { hostId: resource.hostId, workspaceId: resource.workspaceId, workspacePath: resource.workspacePath, path: resource.path },
      revision: note.result.revision, status: 'unconfirmed', reason: 'Original provenance error\n' + '详细诊断'.repeat(5000), blocks: { block: { created: author, lastEdited: author } } }
    expect(parseFileWriteResult(note, params)).toEqual(note)
    ;(author.actor as unknown as Record<string, unknown>).kind = ['agent']
    expect(() => parseFileWriteResult(note, params)).toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  })
  it('retains the exact base/current/proposal for enhanced conflicts without inventing a missing current body', () => {
    for (const reason of ['overlap', 'identity', 'invalid-structure'] as const) {
      const value = conflict()
      if (value.result.status !== 'conflict' || !value.result.noteConflict) throw Error('Fixture must conflict')
      value.result.noteConflict.reason = reason
      expect(parseFileWriteResult(value, params)).toEqual(value)
    }
    const mutations: Array<(value: any) => void> = [
      value => { value.result.noteConflict.baseContent = 'Another base' }, value => { value.result.noteConflict.proposedContent = 'Another proposal' },
      value => { value.result.noteConflict.currentContent = 'Another current body' }, value => { value.result.noteConflict.reason = ['overlap'] },
      value => { value.result.observedRevision = null }, value => { value.result.noteConflict.actor = 'forged' }
    ]
    for (const mutate of mutations) { const value = structuredClone(conflict()); mutate(value); expect(() => parseFileWriteResult(value, params)).toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' })) }
    expect(() => parseFileWriteResult(conflict(), plain())).toThrow('exact original base')
    expect(parseFileWriteResult({ resource, result: { status: 'conflict', observedRevision: null } }, params)).toMatchObject({ result: { status: 'conflict' } })
    const unavailable = { resource, result: { status: 'conflict', observedRevision: hash('Current saved body'),
      noteConflictUnavailable: 'The original conflict is confirmed.\nRead the original file and selected event for content.',
      noteHistory: { status: 'not-applied', eventId: params.operationId, batchId: 'original-batch' } } }
    expect(parseFileWriteResult(unavailable, params)).toEqual(unavailable)
    for (const value of [
      { ...unavailable, result: { ...unavailable.result, noteConflict: (conflict().result as { noteConflict: unknown }).noteConflict } },
      { ...unavailable, result: { ...unavailable.result, noteConflictUnavailable: '' } },
      { ...unavailable, result: { ...unavailable.result, noteConflictUnavailable: ['unavailable'] } },
      { ...saved(), result: { ...saved().result, noteConflictUnavailable: 'Not a written field' } }
    ]) expect(() => parseFileWriteResult(value, params)).toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
    expect(() => parseFileWriteResult(unavailable, plain())).toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  })
  it('keeps an original operation unknown, even without a confirmed resource or prepared event', () => {
    for (const original of [resource, null]) {
      const value = { resource: original, result: { status: 'unknown', code: 'OWNER_UNCONFIRMED', message: 'Original intent\nremains unconfirmed',
        noteHistory: { status: 'unconfirmed', eventId: params.operationId, batchId: 'batch-original', reason: 'Original prepare is unconfirmed' } } }
      expect(parseFileWriteResult(value, params)).toEqual(value)
    }
    expect(parseFileWriteResult({ resource, result: { status: 'error', code: 'HISTORY_UNAVAILABLE', message: 'No original event was prepared.' } }, params)).toMatchObject({ result: { status: 'error' } })
    expect(() => parseFileWriteResult({ resource, result: { status: 'unknown', code: 'UNKNOWN', message: 'Unknown',
      noteHistory: { status: 'committed', eventId: params.operationId, batchId: 'batch-original', replayed: true } } }, params)).toThrow('committed original Note operation')
    const written = saved(), reason = 'Original metadata error\n' + '中文😀'.repeat(5000)
    written.result.noteHistory = { status: 'unconfirmed', eventId: params.operationId!, batchId: 'original-batch', reason }
    expect(parseFileWriteResult(written, params)).toEqual(written)
    expect(parseFileWriteResult(written, params)).toMatchObject({ result: { status: 'written', noteHistory: { status: 'unconfirmed', reason } } })
  })
  it('reads a named exact UTF-8 base without changing BOM or line endings and rejects half-paired CLI input', async () => {
    const directory = await root(), path = join(directory, 'base.md')
    await writeFile(path, baseContent)
    const args = ['file', 'write', '--zone', resource.zoneId, '--path', resource.path, '--resource', JSON.stringify(resource), '--expected-revision', params.expectedRevision]
    const { content: _proposed, ...expected } = params
    expect((await parseAgentMuxCliInvocation([...args, '--base', path, '--operation-id', params.operationId!])).params)
      .toEqual(expected)
    const parsed = (await parseAgentMuxCliInvocation(args)).params
    expect(parsed).not.toHaveProperty('operationId'); expect(parsed).not.toHaveProperty('baseContent')
    for (const tail of [['--base', path], ['--operation-id', 'half'], ['--base', '-', '--operation-id', 'original'], ['--base', path, '--operation-id', '']]) {
      await expect(parseAgentMuxCliInvocation([...args, ...tail])).rejects.toMatchObject({ code: 'INVALID_CLI_ARGUMENT' })
    }
    await writeFile(path, Buffer.from([0xff, 0xfe]))
    await expect(parseAgentMuxCliInvocation([...args, '--base', path, '--operation-id', 'original'])).rejects.toMatchObject({ code: 'INVALID_CLI_ARGUMENT' })
  })
  it('passes the exact original fields and trusted actor through the original public service', async () => {
    const h = await rpcOwnerFixture(); cleanup.push(h.close)
    const write = vi.fn(async () => saved()), service = new AgentMuxRpcService({ coreClients: h.coreClients, files: files(write) }); cleanup.push(() => service.dispose())
    expect(await service.call('file.write', params, { caller: h.credentials })).toEqual(saved())
    expect(write).toHaveBeenCalledExactlyOnceWith(params, { actor: { kind: 'agent', id: h.credentials.agentSessionId } })
    await expect(service.call('file.write', { ...params, actor: { kind: 'user', id: 'forged' } } as never, { caller: h.credentials })).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
    expect(write).toHaveBeenCalledTimes(1); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
  })
  it('retains a confirmed original conflict through the real server when three valid bodies exceed one reply frame', async () => {
    // Each body is below the original Files 16 MiB read boundary. JSON escaping
    // keeps two bodies within the real 64 MiB request frame, but not three in a reply.
    const tabs = '\t'.repeat(11 * 1024 * 1024), base = 'base\n' + tabs, current = 'current\n' + tabs, proposed = 'proposed\n' + tabs
    const input = { ...params, baseContent: base, content: proposed, expectedRevision: hash(base) }
    const history = { status: 'not-applied' as const, eventId: input.operationId!, batchId: 'original-conflict-batch' }
    const original: FileWriteResult = { resource, result: { status: 'conflict', observedRevision: hash(current), noteHistory: history,
      noteConflict: { reason: 'overlap', baseContent: base, currentContent: current, proposedContent: proposed } } }
    expect(Buffer.byteLength(rpcEncode({ jsonrpc: '2.0', id: 'write-capacity', method: 'file.write', params: input }))).toBeLessThan(AGENTMUX_RPC_MAX_MESSAGE_BYTES)
    expect(() => rpcEncode({ jsonrpc: '2.0', id: 'write-capacity', result: original })).toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
    const directory = await root(), socketPath = join(directory, 'control.sock'), write = vi.fn(async () => original), owner = files(write)
    owner.read = vi.fn(async () => ({ resource, result: { status: 'read', document: { path: resource.path, content: current, revision: hash(current) } } }))
    const server = new AgentMuxControlServer({ socketPath, coreClients: () => [], files: owner })
    await server.start(); cleanup.push(() => server.stop())
    const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } }); cleanup.push(() => client.dispose())
    const reply = await client.call('file.write', input)
    expect(reply).toEqual({ resource, result: { status: 'conflict', observedRevision: hash(current), noteHistory: history,
      noteConflictUnavailable: expect.stringContaining('conflict is confirmed') } })
    expect(Buffer.byteLength(rpcEncode({ jsonrpc: '2.0', id: 'write-capacity', result: reply }))).toBeLessThan(4096)
    expect(write).toHaveBeenCalledTimes(1)
    expect(original.result).toHaveProperty('noteConflict.currentContent', current)
    expect(original.result).not.toHaveProperty('noteConflictUnavailable')
    const read = await client.call('file.read', { zoneId: resource.zoneId, path: resource.path,
      expectedResource: { hostId: resource.hostId, workspaceId: resource.workspaceId, workspacePath: resource.workspacePath } })
    expect(read).toEqual({ resource, result: { status: 'read', document: { path: resource.path, content: current, revision: hash(current) } } })
    expect(owner.read).toHaveBeenCalledTimes(1)
  }, 30_000)
  it('budgets the actual wire response ID without imposing an ID length limit on a confirmed conflict', async () => {
    const body = 'x'.repeat(15 * 1024 * 1024), base = 'base\n' + body, current = 'current\n' + body, proposed = 'proposed\n' + body
    const input = { ...params, baseContent: base, content: proposed, expectedRevision: hash(base) }, responseId = 'i'.repeat(20 * 1024 * 1024)
    const history = { status: 'not-applied' as const, eventId: input.operationId!, batchId: 'original-conflict-batch' }
    const original: FileWriteResult = { resource, result: { status: 'conflict', observedRevision: hash(current), noteHistory: history,
      noteConflict: { reason: 'overlap', baseContent: base, currentContent: current, proposedContent: proposed } } }
    const request = { jsonrpc: '2.0', id: responseId, method: 'file.write', params: input }
    expect(Buffer.byteLength(rpcEncode(request))).toBeLessThan(AGENTMUX_RPC_MAX_MESSAGE_BYTES)
    expect(Buffer.byteLength(rpcEncode({ jsonrpc: '2.0', id: null, result: original }))).toBeLessThan(AGENTMUX_RPC_MAX_MESSAGE_BYTES)
    expect(() => rpcEncode({ jsonrpc: '2.0', id: responseId, result: original })).toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
    const write = vi.fn(async () => original), service = new AgentMuxRpcService({ coreClients: () => [], files: files(write) }); cleanup.push(() => service.dispose())
    const response = await new AgentMuxRpcDispatcher(service).receive(request, { signal: new AbortController().signal, stream: false,
      send: vi.fn(), activate: vi.fn(), cancel: vi.fn(), afterResponse: [] })
    if (!response || Array.isArray(response)) throw Error('Expected one original response')
    expect(response.id === responseId).toBe(true)
    expect(response.error).toBeUndefined()
    expect(response.result).toEqual({ resource, result: { status: 'conflict', observedRevision: hash(current), noteHistory: history,
      noteConflictUnavailable: expect.stringContaining('when available') } })
    expect(Buffer.byteLength(JSON.stringify(response.result))).toBeLessThan(4096)
    expect(Buffer.byteLength(rpcEncode(response))).toBeLessThan(AGENTMUX_RPC_MAX_MESSAGE_BYTES)
    expect(write).toHaveBeenCalledTimes(1)
  }, 30_000)
  it('consumes the pair, canonical operation receipt, conflict and unknown through a real server and compiled CLI', async () => {
    const directory = await root(), socketPath = join(directory, 'control.sock'), basePath = join(directory, 'base.md')
    await writeFile(basePath, baseContent)
    let reply = saved()
    const write = vi.fn(async () => reply), server = new AgentMuxControlServer({ socketPath, coreClients: () => [], files: files(write) })
    await server.start(); cleanup.push(() => server.stop())
    const env = objectCliEnvironment(directory), args = ['--endpoint', `unix:${socketPath}`, 'file', 'write', '--zone', resource.zoneId, '--path', resource.path,
      '--resource', JSON.stringify(resource), '--expected-revision', params.expectedRevision, '--base', basePath, '--operation-id', params.operationId!]
    const run = () => runCompiledObjectCli(args, env, params.content)
    const success = await run()
    expect(success.code, success.stderr).toBe(0)
    expect(JSON.parse(success.stdout)).toMatchObject({ operationId: params.operationId, result: saved() })
    expect(write.mock.calls[0]).toEqual([params, { actor: { kind: 'user', id: expect.stringContaining('local-user:') } }])
    const reason = 'Original metadata persistence failed\n' + '中文😀'.repeat(5000)
    reply = saved()
    reply.result.noteHistory = { status: 'unconfirmed', eventId: params.operationId!, batchId: 'original-batch', reason }
    const metadataFailure = await run()
    expect(metadataFailure.code, metadataFailure.stderr).toBe(0)
    expect(JSON.parse(metadataFailure.stdout)).toMatchObject({ result: { result: { status: 'written', noteHistory: { status: 'unconfirmed', reason } } } })
    const replay = saved()
    if (replay.result.status !== 'written') throw Error('Fixture must be written')
    replay.result.noteHistory = { status: 'committed', eventId: params.operationId!, batchId: 'original-batch', replayed: true }
    const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } }); cleanup.push(() => client.dispose())
    reply = replay
    expect(await client.call('file.write', params)).toEqual(replay)
    reply = conflict()
    const overlap = await run()
    expect(overlap.code).toBe(1); expect(JSON.parse(overlap.stdout)).toMatchObject({ result: reply })
    reply = { resource, result: { status: 'conflict', observedRevision: hash('Current saved body'), noteConflictUnavailable: 'Read the original file and selected event for the retained conflict content.',
      noteHistory: { status: 'not-applied', eventId: params.operationId!, batchId: 'original-batch' } } }
    const unavailable = await run()
    expect(unavailable.code).toBe(1); expect(JSON.parse(unavailable.stdout)).toMatchObject({ operationId: params.operationId, result: reply })
    reply = { resource, result: { status: 'unknown', code: 'ORIGINAL_PENDING', message: 'Keep this original edit', noteHistory: { status: 'unconfirmed', eventId: params.operationId!, batchId: 'original-batch' } } }
    const unknown = await run()
    expect(unknown.code).toBe(1); expect(JSON.parse(unknown.stdout)).toMatchObject({ operationId: params.operationId, result: reply })
    const beforeInvalid = write.mock.calls.length
    await writeFile(basePath, 'Not the originally observed base')
    const invalid = await run()
    expect(invalid.code).toBe(1); expect(JSON.parse(invalid.stderr)).toMatchObject({ error: { code: 'INVALID_CONTROL_REQUEST' } })
    expect(write).toHaveBeenCalledTimes(beforeInvalid)
  }, 30_000)
})
