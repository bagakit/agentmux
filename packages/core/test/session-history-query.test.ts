import { fixtureEpoch as _tailRefreshFixtureEpoch } from "./helpers/fixture-values.js"
import { appendFile, readFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { parseAgentSessionHistoryReadPage } from '../src/session-history-reader.js'
import type { AgentSessionHistoryContentPart, AgentSessionHistoryQuestionAnswer } from '../src/types.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import { createHistoryQueryFixture, createHostedHistoryFixture } from './helpers/session-history-query.js'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const fixture = (provider: 'claude' | 'pi' = 'claude', records = 5) => createHistoryQueryFixture(cleanups, provider, records)

/** Optional raw receipts contain only this suite's owned fixtures, never user Sessions. */
async function recordOwnedFixture(name: string, f: Pick<Awaited<ReturnType<typeof fixture>>, 'transcript' | 'store' | 'session'>, value: unknown): Promise<void> {
  const output = process.env.AGENTMUX_HISTORY_QUERY_RECEIPTS
  if (!output) return
  await mkdir(output, { recursive: true })
  const transcript = await readFile(f.transcript)
  await writeFile(join(output, name + '.json'), JSON.stringify({
    metadata: await f.store.readMetadata(f.session.agentSessionId), captured: await f.store.loadTimeline(f.session.agentSessionId),
    native: { byteLength: transcript.length, sha256: createHash('sha256').update(transcript).digest('hex'), text: transcript.toString('utf8') }, value
  }, null, 2) + '\n')
}

it('keeps one captured snapshot append-safe and preserves exact sources and equal bodies without repeated full loads', async () => {
  const f = await fixture(), readTimeline = f.client.sessionTimeline.bind(f.client)
  const load = vi.spyOn(f.client, 'sessionTimeline').mockImplementation(async id => {
    const snapshot = await readTimeline(id)
    // A Reader may expose an immutable snapshot; query ordering never mutates it.
    Object.freeze(snapshot.items)
    return snapshot
  })
  const input = { ...f.reference, source: 'captured' as const, kind: 'user-message' as const, limit: 1, scanLimit: 1 }
  const first = await f.client.readAgentSessionHistory(input)
  expect(first).toMatchObject({ kind: 'user-message', items: [], scan: { examined: 1, complete: false }, userMessages: [{ rawId: 'captured-3', content: 'same input', author: { kind: 'human' }, source: { kind: 'captured', channel: 'message-tool', device: { deviceId: 'sender-device' } } }] })
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.session.agentSessionId, item: f.captured(4, 'newly appended') })
  const second = await f.client.readAgentSessionHistory({ ...input, cursor: first.nextCursor! })
  expect(second.userMessages!.map(message => [message.rawId, message.content])).toEqual([['captured-2', 'same input']])
  expect(second.revision).toBe(first.revision); expect(load).toHaveBeenCalledOnce()
  const fresh = await f.client.readAgentSessionHistory(input)
  expect(fresh.userMessages![0]!.content).toBe('newly appended'); expect(load).toHaveBeenCalledTimes(2)
  await recordOwnedFixture('captured-append-cut', f, { input, first, second, fresh })
  await f.noControls()
})

it.each(['claude', 'pi'] as const)('queries the original %s Provider beyond the 200/290 presentation ceiling and keeps native origin unknown', async provider => {
  const f = await fixture(provider, 352)
  const input = { ...f.reference, source: 'native' as const, query: 'needle', limit: 2, scanLimit: 50 }
  let page = await f.client.readAgentSessionHistory(input)
  expect(page.userMessages).toEqual([]); expect(page.scan).toEqual({ examined: 50, complete: false }); expect(page.nextCursor).toBeTypeOf('string')
  let examined = page.scan!.examined, pages = 1
  const messages = [...page.userMessages!]
  while (page.nextCursor) {
    page = await f.client.readAgentSessionHistory({ ...input, cursor: page.nextCursor })
    examined += page.scan!.examined; messages.push(...page.userMessages!); pages++
    expect(pages).toBeLessThan(12)
  }
  expect(examined).toBe(352); expect(page.scan!.complete).toBe(true)
  expect(messages).toMatchObject([{ rawId: 'record-0', content: 'needle older than three hundred records', author: { kind: 'unknown' }, source: { kind: 'native', providerId: provider, nativeSessionId: 'original-native', recordId: 'record-0' } }])
  expect(messages[0]!.source).not.toHaveProperty('channel'); expect(messages[0]).not.toHaveProperty('deliveryStatus')
  await recordOwnedFixture('native-' + provider, f, { input, examined, pages, messages, finalPage: page })
  await f.noControls()
})

it('binds continuations to exact Host/Agent/source/query, protects original Native source and never scans another Agent', async () => {
  const f = await fixture()
  await f.store.compareAndSwap(null, { ...f.session, agentSessionId: 'other-known-agent', run: { runId: 'other-known-run' },
    nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'other-known-native', transcriptPath: join(f.root, 'other-native.jsonl') } })
  const input = { ...f.reference, source: 'native' as const, query: 'input', limit: 1, scanLimit: 1 }
  const first = await f.client.readAgentSessionHistory(input)
  for (const changed of [{ query: 'other' }, { hostId: 'other-host' }, { agentSessionId: 'other-agent' }, { agentSessionId: 'other-known-agent' }, { source: 'captured' as const }]) {
    const observation = await f.client.readAgentSessionHistory({ ...input, ...changed, cursor: first.nextCursor! }).then(value => ({ value }), error => ({ error }))
    expect(observation).toMatchObject({ error: { code: 'agentSessionId' in changed && changed.agentSessionId === 'other-agent' ? 'UNKNOWN_AGENT_SESSION' : 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' } })
  }
  const current = (await f.store.readMetadata(f.session.agentSessionId))!
  await f.store.compareAndSwap(current, { ...current, nativeHandle: { ...current.nativeHandle!, sessionId: 'another-native' } })
  const changedSource = await f.client.readAgentSessionHistory({ ...input, cursor: first.nextCursor! }).then(value => ({ value }), error => ({ error }))
  expect(changedSource).toMatchObject({ error: { code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' } })
  await f.noControls()
})

it('measures the retained captured first-load cost and avoids full Timeline or unrelated catalogue work on continuations', async () => {
  const f = await fixture()
  for (let index = 4; index < 200; index++) await f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.session.agentSessionId,
    item: f.captured(index, `retained ${index} ` + 'x'.repeat(5120)) })
  const snapshot = await f.store.loadTimeline(f.session.agentSessionId)
  expect(snapshot.items).toHaveLength(200)
  const fullLoad = vi.spyOn(f.client, 'sessionTimeline')
  const catalogue = vi.spyOn(f.client, 'sessionHistorySources').mockRejectedValue(new Error('Unrelated catalogue must not gate an exact receiver read'))
  const input = { ...f.reference, source: 'captured' as const, query: 'no such literal', scanLimit: 50 }
  const started = performance.now(), first = await f.client.readAgentSessionHistory(input), firstReadMs = performance.now() - started
  const continued = performance.now(), second = await f.client.readAgentSessionHistory({ ...input, cursor: first.nextCursor! }), continuationReadMs = performance.now() - continued
  expect(first.scan).toEqual({ examined: 50, complete: false }); expect(second.scan).toEqual({ examined: 50, complete: false })
  expect(fullLoad).toHaveBeenCalledOnce(); expect(catalogue).not.toHaveBeenCalled()
  if (process.env.AGENTMUX_HISTORY_COST_RECEIPT) await appendFile(process.env.AGENTMUX_HISTORY_COST_RECEIPT, JSON.stringify({
    records: snapshot.items.length, snapshotJsonBytes: Buffer.byteLength(JSON.stringify(snapshot)), firstReadMs, continuationReadMs,
    fullTimelineLoads: fullLoad.mock.calls.length, unrelatedCatalogReads: catalogue.mock.calls.length,
    meaning: 'First captured read still loads/clones/hashes the original retained Timeline once; continuation reads the same snapshot. Timing is observation, not a performance gate.'
  }) + '\n')
  await f.noControls()
})

it('reports an exact expandable result budget and retains its query position for the original large record', async () => {
  const f = await fixture(), body = 'large 中🙂 body '.repeat(1800)
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.session.agentSessionId, item: f.captured(5, body) })
  const input = { ...f.reference, source: 'captured' as const, kind: 'user-message' as const, limit: 1, maxBytes: 4096 }
  const error = await f.client.readAgentSessionHistory(input).then(() => null, error => error)
  expect(error).toMatchObject({ code: 'AGENT_SESSION_HISTORY_BUDGET' })
  const detail = JSON.parse(error.detail)
  expect(detail).toMatchObject({ phase: 'query-result', maxBytes: 16 * 1024 * 1024 }); expect(detail.requiredBytes).toBeGreaterThan(4096)
  const expanded = await f.client.readAgentSessionHistory({ ...input, cursor: detail.cursor, maxBytes: detail.requiredBytes })
  expect(expanded.userMessages![0]!.content).toBe(body)
  await f.noControls()
})

it('queries complete native text resources past preview boundaries and preserves the original copyable resource', async () => {
  const f = await fixture(), long = 'ordinary user text '.repeat(120000) + ' needle after the long resource 中🙂'
  await appendFile(f.transcript, JSON.stringify({ type: 'user', sessionId: 'original-native', uuid: 'large-original', message: { role: 'user', content: long } }) + '\n')
  const page = await f.client.readAgentSessionHistory({ ...f.reference, source: 'native', query: 'needle after the long resource 中🙂', limit: 1 })
  expect(page.userMessages).toHaveLength(1)
  expect(page.userMessages![0]!.rawId).toBe('large-original')
  expect(page.userMessages![0]!.contentParts).toContainEqual(expect.objectContaining({ kind: 'resource', resourceType: 'text', content: expect.objectContaining({ kind: 'text' }) }))
  // The original content is a resource; no truncated preview is promoted to full authored text.
  expect(page.userMessages![0]!.content).not.toContain('needle after the long resource')
})

it('exposes the same typed query through the actual Unix RPC and compiled public CLI', async () => {
  const f = await fixture()
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: () => [{ hostId: 'local', client: f.client }] })
  await server.start(); cleanups.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(f.root, 'control.sock') } }); cleanups.push(() => rpc.dispose())
  const input = { ...f.reference, source: 'native' as const, query: 'needle', kind: 'user-message' as const, scanLimit: 50 }
  const publicPage = await rpc.call('agent.history', input)
  expect(publicPage.userMessages![0]!.rawId).toBe('record-0')
  const cli = await runCompiledObjectCli(['agent', 'history', '--host', 'local', '--session', f.session.agentSessionId, '--source', 'native',
    '--query', 'needle', '--kind', 'user-message', '--scan-limit', '50'], objectCliEnvironment(f.root))
  expect(cli.code, cli.stderr).toBe(0)
  expect(JSON.parse(cli.stdout).result.userMessages).toEqual(publicPage.userMessages)
  expect(JSON.parse(cli.stdout).result.scan).toEqual(publicPage.scan)
  await recordOwnedFixture('unix-rpc-compiled-cli', f, { request: input, rpc: publicPage, compiledCli: cli })
  await f.noControls()
})

it('delegates the typed query and cancellation through the actual Hosted SDK without adding Runtime calls after its existing cold-opening projection', async () => {
  const f = await createHostedHistoryFixture(); cleanups.push(() => f.dispose())
  const sdk = f.client
  const observation = await sdk.readAgentSessionHistory({ ...f.reference, source: 'captured', query: 'same', limit: 2 }).then(value => ({ value }), error => ({ error }))
  expect(observation).not.toHaveProperty('error')
  const result = 'value' in observation ? observation.value : undefined
  expect(result!.userMessages!.map(message => message.rawId)).toEqual(['captured-3', 'captured-2'])
  await recordOwnedFixture('unix-hosted-sdk', f, { result, coldOpeningRuntimeAttempts: f.coldOpeningRuntimeAttempts, queryRuntimeCalls: f.forbidden.map(spy => spy.mock.calls.length) })
  const abort = new AbortController(); abort.abort()
  const cancelled = await sdk.readAgentSessionHistory({ ...f.reference, source: 'native', query: 'needle' }, { signal: abort.signal }).then(value => ({ value }), error => ({ error }))
  expect(cancelled).toHaveProperty('error')
  await f.noControls()
})

it('rejects forged typed results that claim another Agent, Native channel, false completion or malformed source', async () => {
  const f = await fixture(), input = { ...f.reference, source: 'native' as const, kind: 'user-message' as const, limit: 1 }
  const page = await f.client.readAgentSessionHistory(input)
  expect(parseAgentSessionHistoryReadPage(page, input)).toEqual(page)
  for (const change of [
    (value: typeof page) => { value.userMessages![0]!.agentSessionId = 'other-agent' },
    (value: typeof page) => { Object.assign(value.userMessages![0]!.source, { channel: 'terminal' }) },
    (value: typeof page) => { value.scan!.complete = true },
    (value: typeof page) => { Object.assign(value.userMessages![0]!.source, { providerId: 'foreign' }) }
  ]) {
    const forged = structuredClone(page); change(forged)
    expect(() => parseAgentSessionHistoryReadPage(forged, input)).toThrow()
  }
  await f.noControls()
})

it('keeps route-local SDK/RPC queries on the exact receiver even when retained execution Host differs', async () => {
  const f = await fixture(), stored = (await f.store.readMetadata(f.session.agentSessionId))!
  await f.store.compareAndSwap(stored, { ...stored, hostId: 'original-execution-host' })
  const input = { ...f.reference, source: 'native' as const, kind: 'user-message' as const, query: 'needle' }
  const direct = await f.client.readAgentSessionHistory(input)
  expect(direct.hostId).toBe('local'); expect(direct.userMessages![0]!.rawId).toBe('record-0')
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'route.sock'), coreClients: () => [{ hostId: 'local', client: f.client }] })
  await server.start(); cleanups.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(f.root, 'route.sock') } }); cleanups.push(() => rpc.dispose())
  const page = await rpc.call('agent.history', input)
  expect(page.hostId).toBe('local'); expect(page.userMessages).toEqual(direct.userMessages)
  await f.noControls()
})

it('continues the original Native cut when new terminal messages append during a query', async () => {
  const f = await fixture('pi', 125), input = { ...f.reference, source: 'native' as const, kind: 'user-message' as const, limit: 1, scanLimit: 1 }
  const first = await f.client.readAgentSessionHistory(input)
  expect(first.userMessages![0]!.rawId).toBe('record-124')
  const appended = JSON.stringify({ type: 'message', id: 'record-new', parentId: 'record-124', timestamp: new Date(_tailRefreshFixtureEpoch(0, 2)).toISOString(), message: { role: 'user', content: 'new terminal input' } }) + '\n'
  const before = await readFile(f.transcript)
  await appendFile(f.transcript, appended)
  const second = await f.client.readAgentSessionHistory({ ...input, cursor: first.nextCursor! })
  expect(second.userMessages![0]!.rawId).toBe('record-123')
  const fresh = await f.client.readAgentSessionHistory(input)
  expect(fresh.userMessages![0]!.rawId).toBe('record-new')
  expect(f.forbidden.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0, 0])
  expect(await readFile(f.transcript)).toEqual(Buffer.concat([before, Buffer.from(appended)]))
})

it('cancels an in-flight exact resource query through Unix Hosted transport without stopping the original Agent', async () => {
  const f = await createHostedHistoryFixture(); cleanups.push(() => f.dispose())
  const content = 'long user body '.repeat(160000) + ' end needle'
  await appendFile(f.transcript, JSON.stringify({ type: 'user', sessionId: 'original-native', uuid: 'held-resource', message: { role: 'user', content } }) + '\n')
  let observation: AbortSignal | undefined
  const resource = vi.spyOn(f.ownerClient, 'sessionHistoryResource').mockImplementation(async (_id, input) => {
    observation = input.signal
    return await new Promise((_resolve, reject) => {
      if (!input.signal) { reject(new Error('Original query cancellation did not reach its resource reader')); return }
      const abort = () => reject(input.signal!.reason ?? new Error('Private resource read cancelled'))
      input.signal.addEventListener('abort', abort, { once: true })
      if (input.signal.aborted) abort()
    })
  })
  const abort = new AbortController()
  const pending = f.client.readAgentSessionHistory({ ...f.reference, source: 'native', query: 'end needle' }, { signal: abort.signal })
    .then(value => ({ value }), error => ({ error }))
  await vi.waitFor(() => expect(observation).toBeDefined())
  expect(resource).toHaveBeenCalledOnce(); expect(observation!.aborted).toBe(false)
  abort.abort(new Error('Private consumer closed its query'))
  await vi.waitFor(() => expect(observation!.aborted).toBe(true))
  const result = await pending
  expect(result).toHaveProperty('error')
  expect(f.forbidden.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0, 0])
})

it('matches exactly the full semantic text domain: no title fallback, reading spans, question replacement and cross-resource part boundaries', async () => {
  const f = await fixture(), source = { providerId: 'claude', nativeSessionId: 'original-native' }
  let parts: AgentSessionHistoryContentPart[] = [], answers: AgentSessionHistoryQuestionAnswer[] | undefined
  const resources = new Map<number, { bytes: Buffer; reference: string; sha256: string }>()
  const encoded = (part: AgentSessionHistoryContentPart, index: number): AgentSessionHistoryContentPart => {
    const bytes = Buffer.from(JSON.stringify(part)), sha256 = createHash('sha256').update(bytes).digest('hex'), reference = `private-original-part-${index}`
    resources.set(index, { bytes, reference, sha256 })
    return { kind: 'resource', resourceType: 'text', reference, content: { kind: 'text', encoding: 'json-utf8', byteLength: bytes.length, sha256 } }
  }
  vi.spyOn(f.client, 'sessionHistoryPage').mockImplementation(async () => ({ agentSessionId: f.session.agentSessionId, source, nextCursor: null,
    items: [{ id: 'semantic-record', kind: 'user-message', title: 'misleading title needle', contentParts: parts, ...(answers ? { questionAnswers: answers } : {}) }] }))
  const read = vi.spyOn(f.client, 'sessionHistoryResource').mockImplementation(async (_id, input) => {
    const original = resources.get(input.partIndex)!, offsetBytes = input.offsetBytes ?? 0
    expect(input.expectedReference).toBe(original.reference)
    const data = original.bytes.subarray(offsetBytes, offsetBytes + 17), nextOffset = offsetBytes + data.length
    return { agentSessionId: f.session.agentSessionId, source, recordId: 'semantic-record', partIndex: input.partIndex, reference: original.reference,
      result: { status: 'fragment', encoding: 'json-utf8', dataBase64: data.toString('base64'), byteLength: data.length,
        offsetBytes, totalBytes: original.bytes.length, sha256: original.sha256, nextOffsetBytes: nextOffset === original.bytes.length ? null : nextOffset } }
  })
  const found = async (query: string) => (await f.client.readAgentSessionHistory({ ...f.reference, source: 'native', query })).userMessages!.length
  parts = [{ kind: 'resource', resourceType: 'image', reference: 'private-image' }]
  expect(await found('misleading title needle')).toBe(0)
  parts = [{ kind: 'text', text: 'hidden visible secret', readingRange: { start: 7, end: 14 } }]
  expect(await found('hidden')).toBe(0); expect(await found('visible')).toBe(1)
  parts = [encoded({ kind: 'text', text: 'hidden 中🙂visible secret', readingRange: { start: 7, end: 17 } }, 0)]
  expect(await found('hidden')).toBe(0); expect(await found('中🙂visible')).toBe(1); expect(await found('secret')).toBe(0)
  parts = [{ kind: 'text', text: 'prefix' }, encoded({ kind: 'text', text: '中🙂middle' }, 1), { kind: 'text', text: 'suffix' }]
  expect(await found('prefix\n中🙂middle\nsuffix')).toBe(1)
  parts = [encoded({ kind: 'text', text: 'original-question-wrapper' }, 0), { kind: 'text', text: 'tail' }]
  answers = [{ questionId: 'original-question', answer: 'actual answer' }]
  read.mockClear()
  expect(await found('actual answer\ntail')).toBe(1); expect(await found('original-question-wrapper')).toBe(0)
  expect(read).not.toHaveBeenCalled()
  await f.noControls()
})
