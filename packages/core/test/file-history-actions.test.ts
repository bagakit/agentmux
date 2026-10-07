import { fixturePath as _historyFixturePath } from "./helpers/fixture-values.js"
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fileUploadRevision, parseFileCreateResult, parseFileWriteResult, parseFileRestoreParams, parseFileRestoreResult, parseFileUndoParams, parseFileUndoResult, type AgentMuxRpcFilesOwner, type FileRestoreParams, type FileUndoParams, type FileWriteResult } from '../src/public-rpc-files.js'
import { noteHistorySnapshot, parseNoteHistoryRecord, parseNoteHistorySource, type NoteHistoryRecord } from '../src/note-history.js'
import { parseFileHistoryResult } from '../src/public-rpc-file-history.js'
import { parseAgentMuxCliInvocation } from '../src/agentmux-cli-commands.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { AgentMuxRpcDispatcher } from '../src/public-rpc-wire.js'
import { AGENTMUX_RPC_MAX_MESSAGE_BYTES, rpcEncode } from '../src/public-rpc-frame.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


const hash = (content: string) => fileUploadRevision(new TextEncoder().encode(content))
const resource = { hostId: 'local', workspaceId: 'workspace', workspacePath: _historyFixturePath("fixture"), zoneId: 'zone', zonePath: _historyFixturePath("fixture"), path: 'page.note.md' }
const original = { hostId: resource.hostId, workspaceId: resource.workspaceId, workspacePath: resource.workspacePath, path: resource.path }
const body = (text: string, noteId = 'original-note') => `---\nschema: agentmux.note.md.v1\nnote-id: ${noteId}\n---\n${text}\n`
const common = { zoneId: resource.zoneId, path: resource.path, expectedResource: resource, noteId: 'original-note', expectedRevision: hash(body('current')), operationId: 'new-history-action' }
const restore: FileRestoreParams = { ...common, eventId: 'selected-event' }
const undo: FileUndoParams = { ...common, batchId: 'selected-batch', batchLastEventId: 'selected-tail' }
const saved = (content = body('canonical')): FileWriteResult => ({ resource, result: { status: 'written', content, revision: hash(content), noteHistory: { status: 'committed', eventId: common.operationId, batchId: 'new-batch' } } })
const overlap = (): FileWriteResult => ({ resource, result: { status: 'conflict', observedRevision: hash(body('current')), noteConflict: {
  reason: 'overlap', baseContent: body('batch result'), currentContent: body('current'), proposedContent: body('before batch') },
  noteHistory: { status: 'not-applied', eventId: common.operationId, batchId: 'new-batch' } } })
const cleanup: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
async function directory() { const root = await mkdtemp(join(tmpdir(), 'note-history-action-')); cleanup.push(() => rm(root, { recursive: true, force: true })); return root }
function files(): AgentMuxRpcFilesOwner {
  return { read: async () => ({ resource, result: { status: 'directory' } }), list: vi.fn(), create: vi.fn(), write: async () => saved() }
}
const args = (action: 'restore' | 'undo') => ['file', action, '--zone', common.zoneId, '--path', common.path, '--resource', JSON.stringify(resource), '--note', common.noteId,
  '--expected-revision', common.expectedRevision, '--operation-id', common.operationId,
  ...(action === 'restore' ? ['--event-id', restore.eventId] : ['--batch', undo.batchId, '--batch-last-event', undo.batchLastEventId])]

describe('explicit original Note restore and selective undo public actions', () => {
  it('requires exact current targets, explicit operations and original selections without accepting a body or actor', () => {
    expect(parseFileRestoreParams(restore)).toEqual(restore); expect(parseFileUndoParams(undo)).toEqual(undo)
    for (const [parse, input] of [[parseFileRestoreParams, restore], [parseFileUndoParams, undo]] as const) {
      for (const invalid of [
        { ...input, content: body('replacement') }, { ...input, baseContent: body('base') }, { ...input, actor: { kind: 'agent', id: 'forged' } },
        { ...input, eventIds: ['page-window'] }, { ...input, operationId: '' }, { ...input, operationId: ['array'] }, { ...input, expectedRevision: null },
        { ...input, expectedResource: { ...resource, path: 'other.note.md' } }, { ...input, noteId: '' }, { ...input, responseId: 'forged' }
      ]) expect(() => parse(invalid)).toThrowError(expect.objectContaining({ code: 'INVALID_CONTROL_REQUEST' }))
    }
    const { eventId: _event, ...missingEvent } = restore, { batchLastEventId: _tail, ...missingTail } = undo
    expect(() => parseFileRestoreParams(missingEvent)).toThrowError(expect.objectContaining({ code: 'INVALID_CONTROL_REQUEST' }))
    expect(() => parseFileUndoParams(missingTail)).toThrowError(expect.objectContaining({ code: 'INVALID_CONTROL_REQUEST' }))
    expect(() => parseFileRestoreParams({ ...restore, eventId: common.operationId })).toThrow()
    expect(() => parseFileUndoParams({ ...undo, batchLastEventId: common.operationId })).toThrow()
    expect(() => parseFileRestoreParams({ ...restore, batchId: undo.batchId })).toThrow()
    expect(() => parseFileUndoParams({ ...undo, eventId: restore.eventId })).toThrow()
  })
  it('retains immutable, operation-specific history sources through metadata and body queries', () => {
    const content = body('saved'), beforeContent = body('before'), event: NoteHistoryRecord = { eventId: 'new-event', sequence: 2, batchId: 'new-batch', noteId: common.noteId,
      resource: original, originalResource: original, status: 'committed', actor: { kind: 'agent', id: 'trusted-writer' }, at: _historyFixtureEpoch(0, 1, 0), parentEventId: 'previous-event',
      operation: 'restore', source: { eventId: restore.eventId }, requestFingerprint: 'private', baseRevision: hash(beforeContent), revision: hash(content), beforeContent, content }
    for (const selected of [{ operation: 'restore' as const, source: { eventId: restore.eventId } }, { operation: 'undo' as const, source: { batchId: undo.batchId, lastEventId: undo.batchLastEventId } }]) {
      const value = { ...event, ...selected }
      expect(parseNoteHistoryRecord(value)).toEqual(value)
      for (const includeContent of [false, true]) {
        const query = { zoneId: common.zoneId, path: common.path, expectedResource: resource, noteId: common.noteId, eventId: event.eventId, ...(includeContent ? { includeContent: true } : {}) }
        const snapshot = { resource, result: noteHistorySnapshot({ ...query, resource: original }, [value], false) }
        expect(parseFileHistoryResult(snapshot, query)).toMatchObject({ result: { entries: [{ source: selected.source }] } })
      }
    }
    for (const [operation, source] of [
      ['edit', { eventId: restore.eventId }], ['restore', undefined], ['restore', { batchId: 'batch', lastEventId: 'tail' }],
      ['undo', { eventId: 'event' }], ['undo', { batchId: 'batch', lastEventId: 'tail', actor: 'forged' }], ['undo', { batchId: 'batch', lastEventId: ['array'] }]
    ] as const) expect(() => parseNoteHistorySource(operation, source)).toThrowError(expect.objectContaining({ code: 'NOTE_HISTORY_INVALID' }))
    expect(() => parseNoteHistoryRecord({ ...event, source: { eventId: event.eventId } })).toThrow()
    const query = { zoneId: common.zoneId, path: common.path, expectedResource: resource, noteId: common.noteId, eventId: event.eventId }
    const malformed = { resource, result: noteHistorySnapshot({ ...query, resource: original }, [{ ...event, source: { eventId: 'old', actor: 'forged' } } as NoteHistoryRecord], false) }
    expect(() => parseFileHistoryResult(malformed, query)).toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  })
  it('requires canonical bytes, Note identity and original operation receipts while retaining known conflicts and unknowns', () => {
    for (const [parse, input] of [[parseFileRestoreResult, restore], [parseFileUndoResult, undo]] as const) {
      expect(parse(saved(), input as FileRestoreParams & FileUndoParams)).toEqual(saved())
      const projected = saved()
      if (projected.result.status !== 'written') throw Error('Written fixture required')
      projected.result.noteTitleProjection = { status: 'projected', noteId: common.noteId, resource: original,
        revision: hash(body('later observed body')), title: 'Later observed title', catalogRevision: 7 }
      expect(parse(projected, input as FileRestoreParams & FileUndoParams)).toEqual(projected)
      projected.result.noteTitleProjection.noteId = 'another-note'
      expect(() => parse(projected, input as FileRestoreParams & FileUndoParams)).toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
      const replay = saved(); replay.result.noteHistory = { status: 'committed', eventId: common.operationId, batchId: 'original', replayed: true }
      expect(parse(replay, input as FileRestoreParams & FileUndoParams)).toEqual(replay)
      const writtenUnavailable = { resource, result: { status: 'written', revision: hash(body('canonical')), contentUnavailable: 'The body was saved; read canonical content separately.', noteHistory: replay.result.noteHistory } }
      expect(parse(writtenUnavailable, input as FileRestoreParams & FileUndoParams)).toEqual(writtenUnavailable)
      for (const changes of [
        { content: body('canonical') }, { contentUnavailable: '' }, { contentUnavailable: ['unavailable'] }, { noteHistory: undefined },
        { noteAttribution: { status: 'recorded' } }, { noteProvenance: {} }, { noteTitleProjection: {} }
      ]) expect(() => parse({ resource, result: { ...writtenUnavailable.result, ...changes } }, input as FileRestoreParams & FileUndoParams)).toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
      expect(() => parse({ resource, result: { status: 'error', code: 'NOT_WRITTEN', message: 'No write', contentUnavailable: 'Not an error field' } }, input as FileRestoreParams & FileUndoParams)).toThrow()
      for (const mutate of [
        (value: any) => { delete value.result.content }, (value: any) => { delete value.result.noteHistory },
        (value: any) => { value.result.noteHistory.eventId = 'another-operation' }, (value: any) => { value.result.content = body('another body') },
        (value: any) => { value.result.noteHistory.status = 'prepared'; value.result.noteHistory.replayed = true },
        (value: any) => { value.resource.workspaceId = 'another-workspace' }
      ]) { const value = structuredClone(saved()); mutate(value); expect(() => parse(value, input as FileRestoreParams & FileUndoParams)).toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' })) }
      expect(() => parse(saved(body('canonical', 'another-note')), input as FileRestoreParams & FileUndoParams)).toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
      expect(parse(overlap(), input as FileRestoreParams & FileUndoParams)).toEqual(overlap())
      const invalid = overlap(); if (invalid.result.status !== 'conflict' || !invalid.result.noteConflict) throw Error('Conflict fixture required')
      invalid.result.noteConflict.currentContent = 'wrong observed bytes'
      expect(() => parse(invalid, input as FileRestoreParams & FileUndoParams)).toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
      const unavailable = { resource, result: { status: 'conflict', observedRevision: null, noteConflictUnavailable: 'Read the original file and event for available bodies.' } }
      expect(parse(unavailable, input as FileRestoreParams & FileUndoParams)).toEqual(unavailable)
      expect(() => parse({ ...unavailable, result: { ...unavailable.result, noteConflict: (overlap().result as any).noteConflict } }, input as FileRestoreParams & FileUndoParams)).toThrow()
      expect(parse({ resource: null, result: { status: 'unknown', code: 'ORIGINAL_UNKNOWN', message: 'Keep the original operation', noteHistory: { status: 'unconfirmed', eventId: common.operationId, reason: 'Original event unknown\nnot replayed' } } }, input as FileRestoreParams & FileUndoParams)).toMatchObject({ result: { status: 'unknown' } })
    }
    const ordinary = { zoneId: common.zoneId, path: common.path, expectedResource: resource, expectedRevision: common.expectedRevision, content: body('proposal') }
    const withoutInventedEvent = { resource, result: { status: 'written', revision: hash(body('canonical')), contentUnavailable: 'Original Note save succeeded; read its body separately.' } }
    expect(parseFileWriteResult(withoutInventedEvent, ordinary)).toEqual(withoutInventedEvent)
    expect(parseFileCreateResult(withoutInventedEvent, { ...ordinary, expectedRevision: null })).toEqual(withoutInventedEvent)
    expect(() => parseFileWriteResult(withoutInventedEvent, { ...ordinary, content: 'No Note header' })).toThrow()
    const nonNoteResource = { ...resource, path: 'plain.txt' }
    expect(() => parseFileWriteResult({ ...withoutInventedEvent, resource: nonNoteResource }, { ...ordinary, path: nonNoteResource.path, expectedResource: nonNoteResource })).toThrow()
    const enhanced = { ...ordinary, baseContent: body('current'), operationId: common.operationId }
    expect(() => parseFileWriteResult(withoutInventedEvent, enhanced)).toThrow()
    expect(parseFileWriteResult({ resource, result: { ...withoutInventedEvent.result, noteHistory: { status: 'committed', eventId: common.operationId, batchId: 'original' } } }, enhanced)).toMatchObject({ result: { status: 'written' } })
  })
  it('uses original authenticated actors and exact selections without granting identity from request fields', async () => {
    const h = await rpcOwnerFixture(); cleanup.push(h.close)
    const owner = { ...files(), restore: vi.fn(async () => saved()), undo: vi.fn(async () => saved()) }, service = new AgentMuxRpcService({ coreClients: h.coreClients, files: owner }); cleanup.push(() => service.dispose())
    expect(await service.call('file.restore', restore, { caller: h.credentials })).toEqual(saved())
    expect(await service.call('file.undo', undo, { caller: h.credentials })).toEqual(saved())
    const context = { actor: { kind: 'agent', id: h.credentials.agentSessionId } }
    expect(owner.restore).toHaveBeenCalledExactlyOnceWith(restore, context); expect(owner.undo).toHaveBeenCalledExactlyOnceWith(undo, context)
    await expect(service.call('file.restore', restore, { caller: { ...h.credentials, capability: 'wrong' } })).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
    await expect(service.call('file.undo', { ...undo, actor: { kind: 'user', id: 'forged' } } as never, { caller: h.credentials })).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
    expect(owner.restore).toHaveBeenCalledTimes(1); expect(owner.undo).toHaveBeenCalledTimes(1); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
  })
  it('rejects only unavailable history mutations and preserves original forwarding, ordinary reads and saves', async () => {
    const owner = files(), service = new AgentMuxRpcService({ coreClients: () => [], files: owner }); cleanup.push(() => service.dispose())
    await expect(service.call('file.restore', restore)).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
    await expect(service.call('file.undo', undo)).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
    expect(await service.call('file.read', { zoneId: common.zoneId, path: common.path, expectedResource: { hostId: resource.hostId, workspaceId: resource.workspaceId, workspacePath: resource.workspacePath } })).toMatchObject({ result: { status: 'directory' } })
    expect(await service.call('file.write', { zoneId: common.zoneId, path: common.path, expectedResource: resource, expectedRevision: common.expectedRevision, content: body('ordinary') })).toEqual(saved())
    const forward = vi.fn(async () => saved()), forwarded = new AgentMuxRpcService({ coreClients: () => [], files: owner, forwardControl: forward as never }); cleanup.push(() => forwarded.dispose())
    const context = { principal: { kind: 'device' as const, id: 'trusted-device' } }
    expect(await forwarded.call('file.restore', restore, context)).toEqual(saved())
    expect(forward).toHaveBeenCalledWith('file.restore', restore, context)
    expect(await forwarded.call('file.undo', undo, context)).toEqual(saved())
    expect(forward).toHaveBeenCalledWith('file.undo', undo, context)
  })
  it('parses explicit CLI selections and never mints a missing operation or accepts caller body/actor flags', async () => {
    expect((await parseAgentMuxCliInvocation(args('restore'))).params).toEqual(restore)
    expect((await parseAgentMuxCliInvocation(args('undo'))).params).toEqual(undo)
    for (const action of ['restore', 'undo'] as const) {
      const input = args(action), operation = input.indexOf('--operation-id'), missing = [...input.slice(0, operation), ...input.slice(operation + 2)]
      await expect(parseAgentMuxCliInvocation(missing)).rejects.toMatchObject({ code: 'INVALID_CLI_ARGUMENT' })
      for (const extra of [['--input', '-'], ['--actor', 'forged'], ['--event-ids', 'page-window']]) await expect(parseAgentMuxCliInvocation([...input, ...extra])).rejects.toMatchObject({ code: 'INVALID_CLI_ARGUMENT' })
    }
    const input = args('undo'), tail = input.indexOf('--batch-last-event')
    await expect(parseAgentMuxCliInvocation([...input.slice(0, tail), ...input.slice(tail + 2)])).rejects.toMatchObject({ code: 'INVALID_CLI_ARGUMENT' })
  })
  it('consumes restore and undo through the actual server, typed client and compiled CLI with truthful exit states', async () => {
    const root = await directory(), socketPath = join(root, 'control.sock'); let reply = saved()
    const owner = { ...files(), restore: vi.fn(async () => reply), undo: vi.fn(async () => reply) }, server = new AgentMuxControlServer({ socketPath, coreClients: () => [], files: owner })
    await server.start(); cleanup.push(() => server.stop())
    const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } }); cleanup.push(() => client.dispose())
    for (const action of ['restore', 'undo'] as const) {
      reply = saved()
      const input = action === 'restore' ? restore : undo, success = await runCompiledObjectCli(['--endpoint', `unix:${socketPath}`, ...args(action)], objectCliEnvironment(root))
      expect(success.code, success.stderr).toBe(0); expect(JSON.parse(success.stdout)).toMatchObject({ operationId: common.operationId, result: reply })
      expect(owner[action]).toHaveBeenCalledWith(input, { actor: { kind: 'user', id: expect.stringContaining('local-user:') } })
      reply = { resource, result: { status: 'written', revision: hash(body('canonical')), contentUnavailable: 'The original body was saved; read canonical content separately.',
        noteHistory: { status: 'committed', eventId: common.operationId, batchId: 'original' } } }
      const unavailable = await runCompiledObjectCli(['--endpoint', `unix:${socketPath}`, ...args(action)], objectCliEnvironment(root))
      expect(unavailable.code, unavailable.stderr).toBe(0); expect(JSON.parse(unavailable.stdout)).toMatchObject({ operationId: common.operationId, result: reply })
      reply = overlap()
      const conflict = await runCompiledObjectCli(['--endpoint', `unix:${socketPath}`, ...args(action)], objectCliEnvironment(root))
      expect(conflict.code, conflict.stderr).toBe(1); expect(JSON.parse(conflict.stdout)).toMatchObject({ operationId: common.operationId, result: reply })
      reply = { resource, result: { status: 'unknown', code: 'ORIGINAL_PENDING', message: 'Original action is not replayed', noteHistory: { status: 'prepared', eventId: common.operationId, batchId: 'original' } } }
      const unknown = await runCompiledObjectCli(['--endpoint', `unix:${socketPath}`, ...args(action)], objectCliEnvironment(root))
      expect(unknown.code).toBe(1); expect(JSON.parse(unknown.stdout)).toMatchObject({ operationId: common.operationId, result: reply })
      reply = saved(); reply.result.noteHistory = { status: 'committed', eventId: common.operationId, batchId: 'original', replayed: true }
      expect(await client.call(`file.${action}`, input as FileRestoreParams & FileUndoParams)).toEqual(reply)
    }
  }, 30_000)
  it('keeps both history actions confirmed when the real reply budget includes a large original wire ID', async () => {
    const tabs = '\t'.repeat(9 * 1024 * 1024), current = body('current' + tabs), conflict: FileWriteResult = { resource, result: { status: 'conflict', observedRevision: hash(current),
      noteConflict: { reason: 'overlap', baseContent: body('base' + tabs), currentContent: current, proposedContent: body('inverse' + tabs) }, noteHistory: { status: 'not-applied', eventId: common.operationId, batchId: 'new-batch' } } }
    const owner = { ...files(), restore: vi.fn(async () => conflict), undo: vi.fn(async () => conflict) }, service = new AgentMuxRpcService({ coreClients: () => [], files: owner }); cleanup.push(() => service.dispose())
    const dispatcher = new AgentMuxRpcDispatcher(service), responseId = 'i'.repeat(20 * 1024 * 1024)
    expect(Buffer.byteLength(rpcEncode({ jsonrpc: '2.0', id: null, result: conflict }))).toBeLessThan(AGENTMUX_RPC_MAX_MESSAGE_BYTES)
    expect(() => rpcEncode({ jsonrpc: '2.0', id: responseId, result: conflict })).toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
    for (const action of ['restore', 'undo'] as const) {
      const request = { jsonrpc: '2.0', id: responseId, method: `file.${action}`, params: action === 'restore' ? restore : undo }
      expect(Buffer.byteLength(rpcEncode(request))).toBeLessThan(AGENTMUX_RPC_MAX_MESSAGE_BYTES)
      const response = await dispatcher.receive(request, { signal: new AbortController().signal, stream: false, send: vi.fn(), activate: vi.fn(), cancel: vi.fn(), afterResponse: [] })
      if (!response || Array.isArray(response)) throw Error('Expected one original response')
      expect(response.id === responseId).toBe(true); expect(response.error).toBeUndefined()
      expect(response.result).toMatchObject({ resource, result: { status: 'conflict', noteConflictUnavailable: expect.any(String), noteHistory: { status: 'not-applied', eventId: common.operationId } } })
      expect(response.result).not.toHaveProperty('result.noteConflict'); expect(Buffer.byteLength(rpcEncode(response))).toBeLessThan(AGENTMUX_RPC_MAX_MESSAGE_BYTES)
    }
    expect(conflict.result).toHaveProperty('noteConflict.currentContent', current)
  }, 30_000)
  it('keeps known written results when a single canonical body and its metadata cannot fit the actual original response ID', async () => {
    const content = body('\t'.repeat(15 * 1024 * 1024)), revision = hash(content), written = saved(content)
    if (written.result.status !== 'written') throw Error('Written fixture required')
    written.result.noteAttribution = { status: 'recorded' }
    written.result.noteProvenance = { status: 'recorded', noteId: common.noteId, resource: original, revision, blocks: {} }
    written.result.noteTitleProjection = { status: 'not-registered', noteId: common.noteId, resource: original }
    written.result.noteHistory = { status: 'committed', eventId: common.operationId, batchId: 'original', replayed: true }
    let reply = written
    const owner = { ...files(), write: vi.fn(async () => reply), create: vi.fn(async () => reply), restore: vi.fn(async () => reply), undo: vi.fn(async () => reply) }, service = new AgentMuxRpcService({ coreClients: () => [], files: owner }); cleanup.push(() => service.dispose())
    const dispatcher = new AgentMuxRpcDispatcher(service), responseId = 'i'.repeat(40 * 1024 * 1024)
    const enhanced = { zoneId: common.zoneId, path: common.path, expectedResource: resource, expectedRevision: common.expectedRevision, operationId: common.operationId, baseContent: body('current'), content: body('proposal') }
    expect(Buffer.byteLength(rpcEncode({ jsonrpc: '2.0', id: null, result: written }))).toBeLessThan(AGENTMUX_RPC_MAX_MESSAGE_BYTES)
    expect(() => rpcEncode({ jsonrpc: '2.0', id: responseId, result: written })).toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
    for (const [method, input] of [['file.restore', restore], ['file.undo', undo], ['file.write', enhanced]] as const) {
      const request = { jsonrpc: '2.0', id: responseId, method, params: input }
      expect(Buffer.byteLength(rpcEncode(request))).toBeLessThan(AGENTMUX_RPC_MAX_MESSAGE_BYTES)
      const response = await dispatcher.receive(request, { signal: new AbortController().signal, stream: false, send: vi.fn(), activate: vi.fn(), cancel: vi.fn(), afterResponse: [] })
      if (!response || Array.isArray(response)) throw Error('Expected one original response')
      expect(response.id === responseId).toBe(true); expect(response.error).toBeUndefined()
      expect(response.result).toEqual({ resource, result: { status: 'written', revision, contentUnavailable: expect.stringContaining('body was saved'), noteHistory: written.result.noteHistory } })
      expect(Buffer.byteLength(rpcEncode(response))).toBeLessThan(AGENTMUX_RPC_MAX_MESSAGE_BYTES)
    }
    const { noteHistory: _history, ...ordinaryReceipt } = written.result
    reply = { resource, result: ordinaryReceipt }
    const { baseContent: _base, operationId: _operation, ...ordinary } = enhanced
    for (const [method, input] of [['file.write', ordinary], ['file.create', { ...ordinary, expectedRevision: null }]] as const) {
      const request = { jsonrpc: '2.0', id: responseId, method, params: input }
      expect(Buffer.byteLength(rpcEncode(request))).toBeLessThan(AGENTMUX_RPC_MAX_MESSAGE_BYTES)
      const response = await dispatcher.receive(request, { signal: new AbortController().signal, stream: false, send: vi.fn(), activate: vi.fn(), cancel: vi.fn(), afterResponse: [] })
      if (!response || Array.isArray(response)) throw Error('Expected one original response')
      expect(response.id === responseId).toBe(true); expect(response.error).toBeUndefined()
      expect(response.result).toEqual({ resource, result: { status: 'written', revision, contentUnavailable: expect.stringContaining('body was saved') } })
      expect(response.result).not.toHaveProperty('result.noteHistory')
      expect(Buffer.byteLength(rpcEncode(response))).toBeLessThan(AGENTMUX_RPC_MAX_MESSAGE_BYTES)
    }
    expect(written.result.content).toBe(content); expect(written.result.noteProvenance).toBeDefined(); expect(written.result.noteAttribution).toBeDefined(); expect(written.result.noteTitleProjection).toBeDefined()
  }, 30_000)
})
