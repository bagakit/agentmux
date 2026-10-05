import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { appendFile, open, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { nativeHistoryFixture, jsonl } from './fixtures/native-history-session.js'
import { readSessionHistoryTextResource } from '../src/session-history-content.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import type { AgentSessionHistoryResourceRequest, AgentSessionHistoryResourceReadResult } from '../src/types.js'

const fixtures: Awaited<ReturnType<typeof nativeHistoryFixture>>[] = []
const closes: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close()
  for (const f of fixtures.splice(0)) await f.close()
  vi.restoreAllMocks()
})
const body = ('Original 中文🙂 "quoted" \\ slash\n').repeat(65_000)
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
async function fixture(mode: 'retired' | 'rotated' = 'retired') {
  const f = await nativeHistoryFixture('claude', jsonl([
    { sessionId: 'native-main', uuid: 'original', type: 'assistant', message: { role: 'assistant', content: body } },
    ...Array.from({ length: 250 }, (_, index) => ({ sessionId: 'native-main', uuid: 'newer-' + index,
      type: 'user', message: { role: 'user', content: 'Newer small prompt ' + index } }))
  ]))
  fixtures.push(f)
  let cursor: string | undefined
  let original
  for (;;) {
    const page = await f.client.sessionHistoryPage(f.session.agentSessionId, { limit: 100, ...(cursor ? { cursor } : {}) })
    const item = page.items.find(value => value.id === 'original')
    if (item) { original = { page, item }; break }
    if (!page.nextCursor) throw new Error('Original record must remain reachable')
    cursor = page.nextCursor
  }
  const part = original.item.contentParts[0]!
  if (part.kind !== 'resource' || part.resourceType !== 'text' || !part.content) throw new Error('Original large content required')
  if (mode === 'rotated') await f.store.compareAndSwap(f.session, { ...f.session, updatedAt: 2, hookToken: 'rotated-token' })
  else {
    const reservation = { kind: 'stop' as const, reservationId: 'content-stop', ownerId: 'content-owner', ownerPid: process.pid,
      agentSessionId: f.session.agentSessionId, expectedRun: f.session.run, operationId: 'content-stop-operation', expiresAt: Date.now() + 60_000,
      stopOperation: { daemonInstance: 'private-unconnected', operationKey: 'private-stop', runId: f.session.run.runId } }
    await f.store.reserveLifecycle(reservation); await f.store.commitLifecycle(reservation, null)
  }
  const proof = vi.spyOn(f.client.providers.get('claude'), 'readSessionHistoryPage')
  const request = { source: original.page.source, recordId: original.item.id, partIndex: 0, expectedReference: part.reference }
  return { ...f, part, request, proof }
}
function continuation(receipt: AgentSessionHistoryResourceReadResult): string {
  if (receipt.result.status !== 'fragment' || !receipt.result.continuationReference) throw new Error('Owner must publish renewed exact content authority')
  return receipt.result.continuationReference
}

it.each(['retired', 'rotated'] as const)('complete SDK read revalidates %s authority once across 250 newer records', async mode => {
  const f = await fixture(mode), requests: AgentSessionHistoryResourceRequest[] = [], receipts: AgentSessionHistoryResourceReadResult[] = []
  const before = await f.bytes()
  const complete = await readSessionHistoryTextResource(f.part, 0, f.request, async request => {
    requests.push(request)
    const receipt = await f.client.sessionHistoryResource(f.session.agentSessionId, request)
    receipts.push(receipt); return receipt
  })
  expect(complete.kind).toBe('text')
  if (complete.kind !== 'text') throw new Error('Original text required')
  expect(digest(complete.text)).toBe(digest(body))
  expect(requests.length).toBeGreaterThan(10)
  expect(f.proof).toHaveBeenCalledTimes(3)
  const renewed = continuation(receipts[0]!)
  expect(renewed).not.toBe(f.part.reference)
  expect(requests[0]!.expectedReference).toBe(f.part.reference)
  expect(requests.slice(1).every(request => request.expectedReference === renewed)).toBe(true)
  const after = await f.bytes()
  expect(after.native.equals(before.native)).toBe(true); expect(after.store.equals(before.store)).toBe(true)
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
}, 30_000)

it('renewed authority retains exact source, record, part and original reference facts', async () => {
  const f = await fixture(), first = await f.client.sessionHistoryResource(f.session.agentSessionId, f.request)
  const renewed = continuation(first)
  for (const changes of [{ recordId: 'newer-0' }, { partIndex: 1 }, { source: { providerId: 'pi', nativeSessionId: 'native-main' } },
    { source: { providerId: 'claude', nativeSessionId: 'another-native' } },
    { expectedReference: renewed.slice(0, -1) + (renewed.endsWith('a') ? 'b' : 'a') }]) {
    await expect(f.client.sessionHistoryResource(f.session.agentSessionId, { ...f.request, expectedReference: renewed, ...changes })).rejects.toBeInstanceOf(Error)
  }
  await expect(f.client.sessionHistoryResource('another-agent', { ...f.request, expectedReference: renewed })).rejects.toBeInstanceOf(Error)
  const [encoded, mac] = f.part.reference.slice('amux-native-content:'.length).split('.')
  const foreign = JSON.parse(Buffer.from(encoded!, 'base64url').toString('utf8'))
  foreign.segments.find((segment: { path?: string }) => segment.path).path = join(f.root, 'unrelated.txt')
  const forged = 'amux-native-content:' + Buffer.from(JSON.stringify(foreign)).toString('base64url') + '.' + mac
  await expect(f.client.sessionHistoryResource(f.session.agentSessionId, { ...f.request, expectedReference: forged }))
    .rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
}, 30_000)

it('renewed capability permits append but rejects same-inode middle rewrites at the contributing block', async () => {
  const f = await fixture(), first = await f.client.sessionHistoryResource(f.session.agentSessionId, f.request), renewed = continuation(first)
  await appendFile(f.path, jsonl([{ sessionId: 'native-main', uuid: 'appended', type: 'user', message: { role: 'user', content: 'Legitimate new prompt' } }]))
  const complete = await readSessionHistoryTextResource({ ...f.part, reference: renewed }, 0, f.request,
    request => f.client.sessionHistoryResource(f.session.agentSessionId, request))
  expect(complete.kind === 'text' && digest(complete.text)).toBe(digest(body))
  expect(f.proof).toHaveBeenCalledTimes(3)
  const [encoded] = renewed.slice('amux-native-content:'.length).split('.')
  const capability = JSON.parse(Buffer.from(encoded!, 'base64url').toString('utf8'))
  const index = Math.floor(capability.segments.length / 2), block = capability.segments[index]
  expect(block.path).toBe(f.path)
  const offsetBytes = capability.segments.slice(0, index).reduce((sum: number, segment: { literal?: string; byteLength: number }) => sum +
    (segment.literal === undefined ? segment.byteLength : Buffer.byteLength(segment.literal)), 0)
  const file = await open(f.path, 'r+')
  try {
    const byte = Buffer.alloc(1); await file.read(byte, 0, 1, block.start + 8)
    byte[0] = byte[0]! ^ 1; await file.write(byte, 0, 1, block.start + 8)
  } finally { await file.close() }
  await expect(f.client.sessionHistoryResource(f.session.agentSessionId, { ...f.request, expectedReference: renewed, offsetBytes }))
    .rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  expect(f.proof).toHaveBeenCalledTimes(3)
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
}, 30_000)

it('RPC exposes renewed authority and actual compiled CLI consumes its next exact fragment without reproof', async () => {
  const f = await fixture()
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: () => [{ hostId: 'local', client: f.client }] })
  await server.start(); closes.push(() => server.stop())
  const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client: f.client }] }); closes.push(() => service.dispose())
  const params = { hostId: 'local', agentSessionId: f.session.agentSessionId, ...f.request, maxBytes: 128 * 1024 }
  const first = await service.call('agent.history.resource', params), renewed = continuation(first)
  if (first.result.status !== 'fragment') throw new Error('Expected exact fragment')
  const input = join(f.root, 'continuation-input.json')
  await writeFile(input, JSON.stringify({ ...params, expectedReference: renewed, offsetBytes: first.result.nextOffsetBytes }))
  const result = await runCompiledObjectCli(['agent', 'history', 'resource', '--input', input], objectCliEnvironment(f.root))
  expect(result.code, result.stderr).toBe(0)
  const receipt = JSON.parse(result.stdout).result
  expect(receipt.reference).toBe(renewed)
  expect(receipt.result.offsetBytes).toBe(first.result.nextOffsetBytes)
  expect(receipt.result.sha256).toBe(f.part.content!.sha256)
  expect(f.proof).toHaveBeenCalledTimes(3)
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
}, 30_000)

it('SDK rejects invalid renewed grants and keeps the original semantic digest when a foreign grant is injected', async () => {
  const f = await fixture()
  const invalid = (request: AgentSessionHistoryResourceRequest) => f.client.sessionHistoryResource(f.session.agentSessionId, request).then(receipt => {
    if (receipt.result.status === 'fragment') return { ...receipt, result: { ...receipt.result, continuationReference: '' } }
    return receipt
  })
  await expect(readSessionHistoryTextResource(f.part, 0, f.request, invalid)).rejects.toThrow('authority')
  const foreign = (request: AgentSessionHistoryResourceRequest) => f.client.sessionHistoryResource(f.session.agentSessionId, request).then(receipt => {
    if (receipt.result.status === 'fragment') return { ...receipt, result: { ...receipt.result, continuationReference: 'amux-native-content:foreign.invalid' } }
    return receipt
  })
  await expect(readSessionHistoryTextResource(f.part, 0, f.request, foreign)).rejects.toBeInstanceOf(Error)
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
}, 30_000)
