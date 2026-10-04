import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { rename, writeFile } from 'node:fs/promises'
import { nativeHistoryFixture, jsonl } from './fixtures/native-history-session.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { readSessionHistoryTextResource } from '../src/session-history-content.js'
import { readNativeContentResource } from '../src/native-history-content.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { join } from 'node:path'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const fixtures: Awaited<ReturnType<typeof nativeHistoryFixture>>[] = []
const closes: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close()
  for (const f of fixtures.splice(0)) await f.close()
  vi.restoreAllMocks()
})
const body = ('Original 中文🙂 "quoted" \\ slash\n').repeat(150_000)
async function readInFreshProcess(f: Awaited<ReturnType<typeof fixture>>, request: object) {
  const input = join(f.root, 'content-worker-input.json')
  await writeFile(input, JSON.stringify({ storePath: f.storePath, agentSessionId: f.session.agentSessionId, request }))
  const result = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('./fixtures/native-history-content-worker.mjs', import.meta.url)), input],
    { maxBuffer: 1024 * 1024, timeout: 20_000 })
  const receipt = JSON.parse(result.stdout)
  expect(receipt.pid).not.toBe(process.pid)
  return receipt.result
}
async function fixture(provider: 'claude' | 'pi', sidechain = false, nested = false) {
  const f = await nativeHistoryFixture(provider, root => provider === 'claude' ? jsonl([
    { sessionId: 'native-main', uuid: 'old-small', type: 'user', message: { role: 'user', content: 'Original short prompt' } },
    { sessionId: 'native-main', uuid: 'large-result', type: 'user', ...(sidechain ? { isSidechain: true } : {}),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', is_error: true, content: body }] } },
    { sessionId: 'native-main', uuid: 'latest-small', type: 'assistant', message: { role: 'assistant', content: 'Newest short answer' } }
  ]) : jsonl([
    { type: 'session', version: 3, id: 'native-main', cwd: root },
    { type: 'message', id: 'old-small', parentId: null, message: { role: 'user', content: [{ type: 'text', text: 'Original short prompt' }] } },
    { type: 'message', id: 'large-result', parentId: 'old-small', message: nested
      ? { role: 'assistant', content: [{ type: 'toolCall', id: 'tool-1', name: 'inspect', arguments: { payload: body } }] }
      : { role: 'toolResult', toolCallId: 'tool-1', toolName: 'inspect', isError: true, content: [{ type: 'text', text: body }] } },
    { type: 'message', id: 'latest-small', parentId: 'large-result', message: { role: 'assistant', content: [{ type: 'text', text: 'Newest short answer' }] } }
  ]))
  fixtures.push(f)
  expect(f.before.native.length).toBeGreaterThan(4 * 1024 * 1024)
  return f
}
async function largePage(f: Awaited<ReturnType<typeof fixture>>) {
  const newest = await f.client.sessionHistoryPage('private-agent', { limit: 1 })
  expect(newest.items.map(item => item.id)).toEqual(['latest-small'])
  const page = await f.client.sessionHistoryPage('private-agent', { limit: 1, cursor: newest.nextCursor! })
  expect(page.items.map(item => item.id)).toEqual(['large-result'])
  expect(page.items[0]!.kind).toBe('activity')
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(64 * 1024)
  const part = page.items[0]!.contentParts[0]!
  if (part.kind !== 'resource' || part.resourceType !== 'text' || !part.content) throw new Error('Large content must be an exact typed resource')
  const request = { source: page.source, recordId: page.items[0]!.id, partIndex: 0, expectedReference: part.reference }
  return { page, part, request }
}
it.each(['claude', 'pi'] as const)('reads complete large %s tool content through the public owner and continues older history', async provider => {
  const f = await fixture(provider), { page, part, request } = await largePage(f), chunks: Buffer[] = []
  let offsetBytes = 0
  for (let count = 0; count < 200; count++) {
    const result = await f.client.sessionHistoryResource('private-agent', { ...request, offsetBytes, maxBytes: 128 * 1024 })
    expect(result.reference).toBe(part.reference)
    if (result.result.status !== 'fragment') throw new Error('Exact text fragments are required')
    const fragment = result.result
    expect(fragment.offsetBytes).toBe(offsetBytes); expect(fragment.byteLength).toBeLessThanOrEqual(128 * 1024)
    expect(fragment.sha256).toBe(part.content!.sha256)
    chunks.push(Buffer.from(fragment.dataBase64, 'base64'))
    if (fragment.nextOffsetBytes === null) break
    expect(fragment.nextOffsetBytes).toBeGreaterThan(offsetBytes); offsetBytes = fragment.nextOffsetBytes
  }
  const bytes = Buffer.concat(chunks)
  expect(bytes.length).toBe(part.content!.byteLength)
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(part.content!.sha256)
  expect(JSON.parse(bytes.toString('utf8'))).toMatchObject({ kind: 'tool-result', output: body, callId: 'tool-1', failed: true })
  const older = await f.client.sessionHistoryPage('private-agent', { limit: 1, cursor: page.nextCursor! })
  expect(older.items.map(item => item.id)).toEqual(['old-small'])
  const after = await f.bytes(); expect(after.native.equals(f.before.native)).toBe(true); expect(after.store.equals(f.before.store)).toBe(true)
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
}, 30_000)
it('filters a >4MiB Claude sidechain before materialization while earlier main speech remains reachable', async () => {
  const f = await fixture('claude', true)
  const newest = await f.client.sessionHistoryPage('private-agent', { limit: 1 })
  const older = await f.client.sessionHistoryPage('private-agent', { limit: 1, cursor: newest.nextCursor! })
  expect(older.items.map(item => item.id)).toEqual(['old-small'])
  expect(older.nextCursor).toBeNull()
  const after = await f.bytes(); expect(after.native.equals(f.before.native)).toBe(true); expect(after.store.equals(f.before.store)).toBe(true)
}, 30_000)
it('public browser-compatible helper reconstructs exact semantics and rejects changed fragment bytes or Core identity', async () => {
  const f = await fixture('claude'), { part, request } = await largePage(f)
  const reader = (input: typeof request) => f.client.sessionHistoryResource('private-agent', input)
  const complete = await readSessionHistoryTextResource(part, 0, request, reader)
  expect(complete).toMatchObject({ kind: 'tool-result', callId: 'tool-1', failed: true, output: body })
  const broken = async (input: typeof request) => {
    const result = await reader(input)
    if (result.result.status === 'fragment') {
      const bytes = Buffer.from(result.result.dataBase64, 'base64'); bytes[0] = bytes[0]! ^ 1
      return { ...result, result: { ...result.result, dataBase64: bytes.toString('base64') } }
    }
    return result
  }
  await expect(readSessionHistoryTextResource(part, 0, request, broken)).rejects.toThrow('changed')
  // The Store already forbids two live Sessions sharing one native handle. The issued capability
  // additionally binds its original Core Session before consulting any caller-supplied extent.
  await expect(readNativeContentResource({ agentSessionId: 'other-core-session', source: request.source,
    contentSigningSecret: f.session.hookToken, transcriptPath: f.path, command: 'unused', args: [], env: {}, workspacePath: f.root, signal: new AbortController().signal }, request))
    .rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_RESOURCE_MISMATCH' })
}, 30_000)
it('preserves nested JSON tool input escapes and tool identity when reading a large native field', async () => {
  const f = await fixture('pi', false, true), { part, request } = await largePage(f), chunks: Buffer[] = []
  let offsetBytes = 0
  do {
    const { result } = await f.client.sessionHistoryResource('private-agent', { ...request, offsetBytes, maxBytes: 128 * 1024 })
    if (result.status !== 'fragment') throw new Error('Expected complete tool-input fragments')
    chunks.push(Buffer.from(result.dataBase64, 'base64'))
    if (result.nextOffsetBytes === null) break
    offsetBytes = result.nextOffsetBytes
  } while (chunks.length < 200)
  const bytes = Buffer.concat(chunks)
  expect(bytes.length).toBe(part.content!.byteLength)
  const full = JSON.parse(bytes.toString('utf8'))
  expect(full).toMatchObject({ kind: 'tool-call', name: 'inspect', callId: 'tool-1' })
  expect(JSON.parse(full.input)).toEqual({ payload: body })
}, 30_000)
it('another real Node owner reads the original issued reference after restart, retirement and previous-source selection', async () => {
  const f = await fixture('claude'), { part, request } = await largePage(f)
  expect((await readInFreshProcess(f, request)).result).toMatchObject({ status: 'fragment', sha256: part.content!.sha256, offsetBytes: 0 })
  const newPath = join(f.root, 'new-native.jsonl')
  await writeFile(newPath, jsonl([{ sessionId: 'new-native', uuid: 'new-short', type: 'user', message: { role: 'user', content: 'Current independent source' } }]))
  const nextHandle = { kind: 'provider' as const, providerId: 'claude', sessionId: 'new-native', transcriptPath: newPath }
  if (f.session.nativeHandle?.kind !== 'provider') throw new Error('Original Provider source required')
  const switched = { ...f.session, updatedAt: 2, nativeHandle: nextHandle,
    nativeConfirmation: { operationId: 'explicit-source-change', run: f.session.run, previousNativeHandle: f.session.nativeHandle,
      nativeHandle: nextHandle, observedAt: 2, candidateObservedAt: 1 } }
  await f.store.compareAndSwap(f.session, switched)
  const previous = await f.client.sessionHistoryPage(f.session.agentSessionId, { nativeSource: 'previous', limit: 10 })
  expect(previous.items.some(item => item.id === 'large-result')).toBe(true)
  expect((await readInFreshProcess(f, request)).result).toMatchObject({ status: 'fragment', sha256: part.content!.sha256 })
  const reservation = { kind: 'stop' as const, reservationId: 'content-stop', ownerId: 'content-owner', ownerPid: process.pid,
    agentSessionId: f.session.agentSessionId, expectedRun: switched.run, operationId: 'content-stop-operation', expiresAt: Date.now() + 60_000,
    stopOperation: { daemonInstance: 'private-unconnected', operationKey: 'private-stop', runId: switched.run.runId } }
  await f.store.reserveLifecycle(reservation); await f.store.commitLifecycle(reservation, null)
  expect((await readInFreshProcess(f, request)).result).toMatchObject({ status: 'fragment', sha256: part.content!.sha256 })
  const result = await f.client.sessionHistoryResource(f.session.agentSessionId, { ...request, offsetBytes: part.content!.byteLength - 128 })
  expect(result.result).toMatchObject({ status: 'fragment', nextOffsetBytes: null, sha256: part.content!.sha256 })
  const [encoded, mac] = request.expectedReference.slice('amux-native-content:'.length).split('.')
  const foreign = JSON.parse(Buffer.from(encoded!, 'base64url').toString('utf8'))
  for (const segment of foreign.segments) if ('path' in segment) segment.path = join(f.root, 'never-authorized.txt')
  await writeFile(join(f.root, 'never-authorized.txt'), 'Unrelated private file must not become resource authority')
  const forged = 'amux-native-content:' + Buffer.from(JSON.stringify(foreign)).toString('base64url') + '.' + mac
  await expect(f.client.sessionHistoryResource(f.session.agentSessionId, { ...request, expectedReference: forged }))
    .rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
}, 30_000)
it('rejects changed sources, forged references, wrong record/part and over-budget reads without touching a Run', async () => {
  const f = await fixture('claude'), { request } = await largePage(f)
  for (const changes of [{ recordId: 'old-small' }, { partIndex: 1 }, { source: { providerId: 'pi', nativeSessionId: 'native-main' } },
    { expectedReference: request.expectedReference.slice(0, -1) + (request.expectedReference.endsWith('a') ? 'b' : 'a') },
    { offsetBytes: -1 }, { maxBytes: 128 * 1024 + 1 }]) {
    await expect(f.client.sessionHistoryResource('private-agent', { ...request, ...changes })).rejects.toBeInstanceOf(Error)
  }
  await rename(f.path, `${f.path}.original`); await writeFile(f.path, f.before.native)
  await expect(f.client.sessionHistoryResource('private-agent', request)).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
})
it('compiled CLI and RPC consume typed content fragments from the same offline source', async () => {
  const f = await fixture('claude'), { request, part } = await largePage(f)
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: () => [{ hostId: 'local', client: f.client }] })
  await server.start(); closes.push(() => server.stop())
  const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client: f.client }] }); closes.push(() => service.dispose())
  const params = { hostId: 'local', agentSessionId: 'private-agent', ...request, maxBytes: 128 * 1024 }
  const first = await service.call('agent.history.resource', params)
  expect(first.result.status).toBe('fragment')
  if (first.result.status !== 'fragment') throw new Error('Expected a source fragment')
  const input = join(f.root, 'resource-input.json')
  await writeFile(input, JSON.stringify({ ...params, offsetBytes: first.result.nextOffsetBytes }))
  const result = await runCompiledObjectCli(['agent', 'history', 'resource', '--input', input], objectCliEnvironment(f.root))
  expect(result.code, result.stderr).toBe(0)
  const receipt = JSON.parse(result.stdout)
  expect(receipt).toMatchObject({ ok: true, operation: 'agent.history.resource', result: { hostId: 'local', agentSessionId: 'private-agent',
    source: request.source, recordId: request.recordId, partIndex: request.partIndex, reference: part.reference,
    result: { status: 'fragment', offsetBytes: first.result.nextOffsetBytes, sha256: part.content!.sha256 } } })
  expect(Buffer.from(receipt.result.result.dataBase64, 'base64').length).toBeLessThanOrEqual(128 * 1024)
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
}, 30_000)
