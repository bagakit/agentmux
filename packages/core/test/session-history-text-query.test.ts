import { appendFile, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { parseAgentSessionHistoryReadPage, validateSessionHistoryReadInput } from '../src/session-history-reader.js'
import type { AgentSessionHistoryContentPart, AgentTimelineItem } from '../src/types.js'
import { createHistoryQueryFixture, createHostedHistoryFixture } from './helpers/session-history-query.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const fixture = () => createHistoryQueryFixture(cleanups)
function capturedRecord(original: AgentTimelineItem, kind: AgentTimelineItem['kind']): AgentTimelineItem {
  const { authorHuman: _human, ...item } = original
  return { ...item, kind }
}

it('queries original captured assistant, system and tool text without replacing the user-input view or matching titles', async () => {
  const f = await fixture()
  const assistant = capturedRecord(f.captured(10, 'assistant-only 中🙂 needle'), 'assistant_message')
  const system = capturedRecord(f.captured(11, 'system-only needle'), 'system_message')
  const tool: AgentTimelineItem = { ...capturedRecord(f.captured(12, ''), 'tool_call'), title: 'misleading-title-only',
    toolInput: 'input needle', toolOutput: 'output needle' }
  for (const item of [assistant, system, tool]) await f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.session.agentSessionId, item })
  const original = await f.store.loadTimeline(f.session.agentSessionId)
  const input = { ...f.reference, source: 'captured' as const, kind: 'text' as const, query: 'needle', limit: 2, scanLimit: 2 }
  const page = await f.client.readAgentSessionHistory(input)
  expect(page).toMatchObject({ kind: 'text', scan: { examined: 2, complete: false }, items: [
    { kind: 'item', item: { id: tool.id, kind: 'tool_call', toolInput: tool.toolInput, toolOutput: tool.toolOutput } },
    { kind: 'item', item: { id: system.id, kind: 'system_message', content: system.content } }
  ] })
  expect(page).not.toHaveProperty('userMessages')
  const next = await f.client.readAgentSessionHistory({ ...input, cursor: page.nextCursor! })
  expect(next.items).toMatchObject([{ item: { id: assistant.id, kind: 'assistant_message', content: assistant.content } }])
  expect(parseAgentSessionHistoryReadPage(page, input)).toEqual(page)
  const userOnly = await f.client.readAgentSessionHistory({ ...f.reference, source: 'captured', query: 'assistant-only' })
  expect(userOnly.kind).toBe('user-message'); expect(userOnly.userMessages).toEqual([])
  expect((await f.client.readAgentSessionHistory({ ...input, query: 'misleading-title-only' })).items).toEqual([])
  expect(await f.store.loadTimeline(f.session.agentSessionId)).toEqual(original)
  await f.noControls()
})

it.each(['claude', 'pi'] as const)('finds real %s assistant text beyond presentation limits and preserves original records', async provider => {
  const f = await createHistoryQueryFixture(cleanups, provider, 320)
  const native = provider === 'claude'
    ? { type: 'assistant', sessionId: 'original-native', uuid: 'assistant-only', message: { role: 'assistant', content: 'assistant-only needle 中🙂' } }
    : { type: 'message', id: 'assistant-only', parentId: 'record-319', message: { role: 'assistant', content: [{ type: 'text', text: 'assistant-only needle 中🙂' }] } }
  await appendFile(f.transcript, JSON.stringify(native) + '\n')
  const before = await readFile(f.transcript), metadata = await f.store.readMetadata(f.session.agentSessionId)
  const input = { ...f.reference, source: 'native' as const, kind: 'text' as const, query: 'assistant-only needle 中🙂', scanLimit: 30 }
  const page = await f.client.readAgentSessionHistory(input)
  expect(page.items).toMatchObject([{ kind: 'item', item: { id: 'assistant-only', kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'assistant-only needle 中🙂' }] } }])
  expect(page.nativeSource).toEqual({ providerId: provider, nativeSessionId: 'original-native' })
  expect(page.scan).toEqual({ examined: 30, complete: false })
  expect(parseAgentSessionHistoryReadPage(page, input)).toEqual(page)
  const userOnly = await f.client.readAgentSessionHistory({ ...f.reference, source: 'native', query: input.query })
  expect(userOnly.userMessages).toEqual([])
  const older = { ...input, query: 'needle older than three hundred records', scanLimit: 100 }
  let read = await f.client.readAgentSessionHistory(older), examined = read.scan!.examined
  expect(read.items).toEqual([]); expect(read.nextCursor).toBeTypeOf('string')
  for (let batch = 0; read.nextCursor && batch < 5; batch++) {
    read = await f.client.readAgentSessionHistory({ ...older, cursor: read.nextCursor }); examined += read.scan!.examined
  }
  expect(read.items).toMatchObject([{ item: { id: 'record-0', kind: 'user-message' } }])
  expect(read.scan!.complete).toBe(true); expect(examined).toBe(321)
  expect(await readFile(f.transcript)).toEqual(before); expect(await f.store.readMetadata(f.session.agentSessionId)).toEqual(metadata)
  expect(f.forbidden.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0, 0])
})

it('searches complete native reasoning and tool resources, spans and part boundaries rather than previews', async () => {
  const f = await fixture(), source = { providerId: 'claude', nativeSessionId: 'original-native' }
  let parts: AgentSessionHistoryContentPart[] = []
  const resources = new Map<number, { bytes: Buffer; reference: string; sha256: string }>()
  function resource(part: AgentSessionHistoryContentPart, index: number): AgentSessionHistoryContentPart {
    const bytes = Buffer.from(JSON.stringify(part)), sha256 = createHash('sha256').update(bytes).digest('hex'), reference = `original-part-${index}`
    resources.set(index, { bytes, reference, sha256 })
    return { kind: 'resource', resourceType: 'text', reference, label: 'misleading preview', content: { kind: part.kind, encoding: 'json-utf8', byteLength: bytes.length, sha256 } }
  }
  vi.spyOn(f.client, 'sessionHistoryPage').mockImplementation(async () => ({ agentSessionId: f.session.agentSessionId, source, nextCursor: null,
    items: [{ id: 'original-activity', kind: 'activity', contentParts: parts }] }))
  const read = vi.spyOn(f.client, 'sessionHistoryResource').mockImplementation(async (_id, input) => {
    const original = resources.get(input.partIndex)!, offsetBytes = input.offsetBytes ?? 0, data = original.bytes.subarray(offsetBytes, offsetBytes + 128 * 1024)
    expect(input.expectedReference).toBe(original.reference)
    return { agentSessionId: f.session.agentSessionId, source, recordId: 'original-activity', partIndex: input.partIndex, reference: original.reference,
      result: { status: 'fragment', encoding: 'json-utf8', dataBase64: data.toString('base64'), byteLength: data.length,
        offsetBytes, totalBytes: original.bytes.length, sha256: original.sha256, nextOffsetBytes: offsetBytes + data.length === original.bytes.length ? null : offsetBytes + data.length } }
  })
  const found = async (query: string) => (await f.client.readAgentSessionHistory({ ...f.reference, source: 'native', kind: 'text', query })).items
  for (const part of [
    { kind: 'reasoning' as const, text: 'long '.repeat(50000) + 'tail needle' },
    { kind: 'tool-call' as const, name: 'original-tool', input: 'long '.repeat(50000) + 'tail needle' },
    { kind: 'tool-result' as const, output: 'long '.repeat(50000) + 'tail needle' }
  ]) {
    parts = [resource(part, 0)]; read.mockClear()
    expect(await found('tail needle')).toMatchObject([{ item: { id: 'original-activity', kind: 'activity', contentParts: parts } }])
    expect(read.mock.calls.length).toBeGreaterThan(1)
    expect(await found('misleading preview')).toEqual([])
  }
  parts = [resource({ kind: 'text', text: 'hidden visible secret', readingRange: { start: 7, end: 14 } }, 0),
    { kind: 'reasoning', text: 'reasoning' }, { kind: 'tool-call', name: 'tool', input: 'input' }, { kind: 'tool-result', output: 'output' }]
  expect(await found('visible\nreasoning\ninput\noutput')).toHaveLength(1)
  expect(await found('hidden')).toEqual([]); expect(await found('secret')).toEqual([])
  parts = [resource({ kind: 'resource', resourceType: 'image', reference: 'original-image' }, 0)]
  await expect(found('needle')).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_RESOURCE_UNAVAILABLE' })
  for (const part of [{ kind: 'reasoning' as const, text: 'unavailable reasoning', redacted: true }]) {
    parts = [part]
    await expect(found('needle')).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_RESOURCE_UNAVAILABLE' })
    parts = [resource(part, 0)]
    await expect(found('needle')).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_RESOURCE_UNAVAILABLE' })
  }
  await f.noControls()
})

it('binds text cursors to kind, source and original Host/Session while retaining one captured cut', async () => {
  const f = await fixture(), load = vi.spyOn(f.client, 'sessionTimeline')
  const input = { ...f.reference, source: 'captured' as const, kind: 'text' as const, query: 'same', limit: 1, scanLimit: 1 }
  const first = await f.client.readAgentSessionHistory(input)
  expect(first.items).toMatchObject([{ item: { id: 'captured-3' } }]); expect(first.scan!.complete).toBe(false)
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.session.agentSessionId, item: f.captured(8, 'same new append') })
  const second = await f.client.readAgentSessionHistory({ ...input, cursor: first.nextCursor! })
  expect(second.items).toMatchObject([{ item: { id: 'captured-2' } }]); expect(load).toHaveBeenCalledOnce()
  for (const change of [{ kind: 'user-message' as const }, { query: 'changed' }, { source: 'native' as const }, { hostId: 'foreign-host' }])
    await expect(f.client.readAgentSessionHistory({ ...input, ...change, cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  const { kind: _kind, ...defaultInput } = input
  await expect(f.client.readAgentSessionHistory({ ...defaultInput, cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  const user = await f.client.readAgentSessionHistory({ ...input, kind: 'user-message' })
  await expect(f.client.readAgentSessionHistory({ ...input, cursor: user.nextCursor! })).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  await f.noControls()
})

it('keeps oversized text results at the same record and refuses forged wire provenance or completion', async () => {
  const f = await fixture(), body = 'assistant-only 中🙂 '.repeat(1200)
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.session.agentSessionId,
    item: capturedRecord(f.captured(9, body), 'assistant_message') })
  const input = { ...f.reference, source: 'captured' as const, kind: 'text' as const, query: 'assistant-only', maxBytes: 4096 }
  const failure = await f.client.readAgentSessionHistory(input).then(() => null, error => error)
  expect(failure).toMatchObject({ code: 'AGENT_SESSION_HISTORY_BUDGET' })
  const detail = JSON.parse(failure.detail), expandedInput = { ...input, maxBytes: detail.requiredBytes, cursor: detail.cursor }
  expect(detail.requiredBytes).toBeGreaterThan(4096)
  const page = await f.client.readAgentSessionHistory(expandedInput)
  expect(page.items).toMatchObject([{ item: { content: body } }]); expect(parseAgentSessionHistoryReadPage(page, expandedInput)).toEqual(page)
  for (const change of [
    (p: typeof page) => { p.agentSessionId = 'other' },
    (p: typeof page) => { p.scan!.complete = !p.scan!.complete },
    (p: typeof page) => { Object.assign(p.items[0]!.kind === 'item' ? p.items[0]!.item : {}, { agentSessionId: 'other' }) },
    (p: typeof page) => { Object.assign(p.items[0]!.kind === 'item' ? p.items[0]!.item : {}, { sourceChannel: 'guessed-channel' }) },
    (p: typeof page) => { Object.assign(p, { userMessages: [] }) }
  ]) { const forged = structuredClone(page); change(forged); expect(() => parseAgentSessionHistoryReadPage(forged, expandedInput)).toThrow() }
  const nativeInput = { ...f.reference, source: 'native' as const, kind: 'text' as const }, native = await f.client.readAgentSessionHistory(nativeInput)
  expect(native.items.length).toBeGreaterThan(0)
  for (const change of [
    (p: typeof native) => { Object.assign(p.items[0]!.kind === 'item' ? p.items[0]!.item : {}, { author: { kind: 'human' } }) },
    (p: typeof native) => { p.items.push(p.items[0]!) },
    (p: typeof native) => { p.nativeSource!.nativeSessionId = '' }
  ]) { const forged = structuredClone(native); change(forged); expect(() => parseAgentSessionHistoryReadPage(forged, nativeInput)).toThrow() }
  expect(() => validateSessionHistoryReadInput({ ...input, kind: 'text', scanLimit: 0 })).toThrow()
  await f.noControls()
})

it('serves text queries through the real public RPC and compiled CLI with exact source failures and continuations', async () => {
  const f = await fixture()
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.session.agentSessionId,
    item: capturedRecord(f.captured(10, 'assistant-only needle'), 'assistant_message') })
  const catalogue = vi.spyOn(f.client, 'sessionHistorySources').mockRejectedValue(new Error('An unrelated catalogue must not gate an exact original receiver'))
  const stored = (await f.store.readMetadata(f.session.agentSessionId))!
  await f.store.compareAndSwap(stored, { ...stored, hostId: 'original-execution-host' })
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: () => [{ hostId: 'local', client: f.client }] })
  await server.start(); cleanups.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(f.root, 'control.sock') } }); cleanups.push(() => rpc.dispose())
  const input = { ...f.reference, source: 'captured' as const, kind: 'text' as const, query: 'assistant-only', limit: 1, scanLimit: 1 }
  const page = await rpc.call('agent.history', input)
  expect(page.items).toMatchObject([{ item: { content: 'assistant-only needle', kind: 'assistant_message' } }]); expect(catalogue).not.toHaveBeenCalled()
  const run = (extra: string[] = [], query = 'assistant-only', source = 'captured', session = f.session.agentSessionId) => runCompiledObjectCli(['agent', 'history', '--host', 'local', '--session', session,
    '--source', source, '--kind', 'text', '--query', query, '--limit', '1', '--scan-limit', '1', ...extra], objectCliEnvironment(f.root))
  const cli = await run(); expect(cli.code, cli.stderr).toBe(0)
  expect(JSON.parse(cli.stdout).result.items).toEqual(page.items)
  const next = await run(['--cursor', JSON.parse(cli.stdout).result.nextCursor]); expect(next.code, next.stderr).toBe(0)
  expect(JSON.parse(next.stdout).result).toMatchObject({ items: [], scan: { examined: 1, complete: false } })
  const wrong = await run(['--cursor', page.nextCursor!], 'other'); expect(wrong.code).toBe(1)
  expect(JSON.parse(wrong.stderr).error.code).toBe('AGENT_SESSION_HISTORY_SOURCE_CHANGED')
  const otherSource = await run(['--cursor', page.nextCursor!], 'assistant-only', 'native'); expect(otherSource.code).toBe(1)
  expect(JSON.parse(otherSource.stderr).error.code).toBe('AGENT_SESSION_HISTORY_SOURCE_CHANGED')
  const unavailable = await run([], 'assistant-only', 'native', 'absent-original'); expect(unavailable.code).toBe(1)
  expect(JSON.parse(unavailable.stderr).error.code).toBe('UNKNOWN_AGENT_SESSION')
  const { nativeHandle: _native, ...capturedOnly } = stored
  await f.store.compareAndSwap(null, { ...capturedOnly, agentSessionId: 'captured-only', run: { runId: 'captured-only-run' } })
  const noNative = await run([], 'needle', 'native', 'captured-only'); expect(noNative.code).toBe(1)
  expect(JSON.parse(noNative.stderr).error.code).toBe('AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE')
  await f.noControls()
})

it('cancels the original text resource read through Hosted SDK without touching a healthy Run', async () => {
  const f = await createHostedHistoryFixture(); cleanups.push(() => f.dispose())
  await appendFile(f.transcript, JSON.stringify({ type: 'assistant', sessionId: 'original-native', uuid: 'held-original',
    message: { role: 'assistant', content: 'long '.repeat(600000) + 'tail needle' } }) + '\n')
  const before = await readFile(f.transcript)
  let observed: AbortSignal | undefined
  vi.spyOn(f.ownerClient, 'sessionHistoryResource').mockImplementation(async (_id, input) => {
    observed = input.signal
    return await new Promise((_resolve, reject) => {
      if (!input.signal) { reject(new Error('Original text cancellation did not reach its resource owner')); return }
      const abort = () => reject(input.signal!.reason)
      input.signal.addEventListener('abort', abort, { once: true }); if (input.signal.aborted) abort()
    })
  })
  const controller = new AbortController(), pending = f.client.readAgentSessionHistory({ ...f.reference, source: 'native', kind: 'text', query: 'tail needle' }, { signal: controller.signal })
    .then(value => ({ value }), error => ({ error }))
  await vi.waitFor(() => expect(observed).toBeDefined()); controller.abort(new Error('Original reader closed'))
  expect(await pending).toHaveProperty('error'); await vi.waitFor(() => expect(observed!.aborted).toBe(true))
  expect(f.forbidden.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0, 0]); expect(await readFile(f.transcript)).toEqual(before)
})
