import { afterEach, expect, it, vi } from 'vitest'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { createNativeInputCorrelation, nativeInputSourceId } from '../src/native-input-correlation.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import type { AgentProviderSessionStatusObservationContext } from '../src/agent-provider.js'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parsePromptSubmissionRecord } from '../src/prompt-submission-record.js'
import { ObjectCliProbe, objectCliEnvironment } from './helpers/object-cli-rpc.js'
import { runSourceObjectCli } from './helpers/source-object-cli.js'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { appendFile } from 'node:fs/promises'
import { SESSION_HISTORY_MAX_PAGE_BYTES } from '../src/session-history.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'

const closes: (() => Promise<unknown>)[] = []
const evidence = async (record: Record<string, unknown>) => { if (process.env.PROMPT_NATIVE_RESULT_CASES) await appendFile(process.env.PROMPT_NATIVE_RESULT_CASES, JSON.stringify(record) + '\n') }
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
async function fixture(carrier: 'native' | 'pty' | 'queue' = 'native') {
  const transport = carrier === 'queue' ? 'native' : carrier
  const h = await rpcOwnerFixture(['recipient', 'caller'], undefined, () => ({ providerId: transport === 'native' ? 'codex' : 'grok', executorId: transport === 'native' ? 'codex' : 'grok' }))
  closes.push(h.close)
  const before = (await h.store.readMetadata('recipient'))!, source = { providerId: before.providerId, nativeSessionId: 'original-native' }
  const key = { kind: 'prompt' as const, agentSessionId: 'recipient', expectedRun: before.run, submissionId: 'original-input' }
  const plan = { kind: 'native-rpc' as const, protocolId: 'original-native-protocol', actorId: 'original-actor', sourceId: nativeInputSourceId(source), threadId: source.nativeSessionId,
    operation: carrier === 'queue' ? 'queue-idle' as const : 'start-or-steer' as const, clientCorrelation: createNativeInputCorrelation(key) }
  const admission: any = { submissionId: key.submissionId, operationId: key.submissionId, inputKey: key, acknowledged: true,
    ...(carrier === 'queue' ? { futureIntent: { intentId: 'original-future', occurrenceAt: 1000 } } : {}),
    intent: { run: before.run, ownerInstanceId: 'original-runtime', prompt: 'Original private input', message: { userContent: 'Original private input' }, plan: transport === 'native' ? plan : { kind: 'single-phase', data: 'Original private input\r' },
      ...(carrier === 'queue' ? { execution: 'default', admissionIntent: { kind: 'exact-condition', condition: { expectedRun: before.run, afterSubmissionId: null } } } : {}) },
    ...(transport === 'native' ? { transport, native: { plan, outcome: 'admitted', ...(carrier === 'queue' ? { queuedSubmissionId: 'original-queue-item' } : { turnId: 'original-turn' }) } } : { transport, startByte: 0, endByte: 23 }) }
  const transcriptPath = join(h.root, 'native.jsonl'), meta = { type: 'session_meta', payload: { id: source.nativeSessionId, cwd: h.root, history_mode: 'paginated' } }
  await writeFile(transcriptPath, JSON.stringify(meta) + '\n')
  const next = { ...before, nativeHandle: { kind: 'provider' as const, ...source, sessionId: source.nativeSessionId, transcriptPath }, promptCompletionAdmission: admission }
  delete (next.nativeHandle as any).nativeSessionId
  await h.store.compareAndSwap(before, next)
  let observer: AgentProviderSessionStatusObservationContext | undefined
  vi.spyOn(h.client.providers.get(before.providerId), 'observeSessionStatus').mockImplementation(async context => { observer = context; return { dispose() {} } })
  await h.inner.registry.load('local')
  const rpc = new AgentMuxRpcService({ coreClients: h.coreClients }); closes.push(() => rpc.dispose())
  await h.client.statusAgent('recipient')
  await vi.waitFor(() => expect(observer).toBeDefined())
  return { ...h, key, source, rpc, plan, transcriptPath, writeNative: async (rows: unknown[]) => writeFile(transcriptPath, [meta, ...rows].map(row => JSON.stringify(row)).join('\n') + '\n'), emit: async (endReason: 'completed' | 'failed' | 'interrupted' | undefined, turnId = 'original-turn') => {
    expect(observer).toBeDefined()
    observer!.onStatus({ recordId: 'native-end-record', sequence: 12, nativeTurnId: turnId, state: endReason === 'failed' ? 'error' : endReason === 'interrupted' ? 'unknown' : 'done',
      ...(endReason ? { endReason } : {}), nativeObservedAt: 12345 })
    await vi.waitFor(async () => expect((await h.store.readMetadata('recipient'))?.nativeTurnEnds?.turns[turnId]).toBeDefined())
    await Reflect.get(h.client, 'nativeStatusWatches').get('recipient')?.pending
  } }
}
it('a direct native ACK can settle only its same native turn typed outcome in the canonical original record', async () => {
  const h = await fixture(); await h.emit('completed')
  const read = await h.rpc.call('agent.input.inspect', { key: h.key })
  expect(read.record?.nativeResult).toMatchObject({ state: 'completed', nativeTurnId: 'original-turn', nativeObservedAt: 12345 })
})
const nativeUser = (h: Awaited<ReturnType<typeof fixture>>, id = 'canonical-native-user', text = 'Original private input') => ({ timestamp: '2026-11-15T00:00:00Z', type: 'event_msg', payload: {
  type: 'item_completed', thread_id: h.source.nativeSessionId, turn_id: 'consumed-native-turn',
  item: { type: 'UserMessage', id, client_id: h.plan.clientCorrelation, content: [{ type: 'text', text }] } } })
const nativeEnd = (h: Awaited<ReturnType<typeof fixture>>, status = 'completed') => ({ timestamp: '2026-11-15T00:00:01Z', type: 'event_msg', payload: {
  type: status === 'interrupted' ? 'turn_aborted' : 'task_complete', thread_id: h.source.nativeSessionId, turn_id: 'consumed-native-turn',
  ...(status === 'interrupted' ? { reason: 'interrupted' } : status === 'failed' ? { error: { code: 'provider-error', message: 'Native failure' } } : {}) } })
it.each(['completed', 'failed', 'interrupted'])('a complete original native cut qualifies the queue adoption and its exact %s result', async state => {
  const h = await fixture('queue'); await h.writeNative([nativeUser(h), nativeEnd(h, state)])
  const page = await h.client.sessionHistoryPage('recipient')
  expect(page.nextCursor).toBeNull(); expect(page.changesCursor).toBeTruthy()
  expect(page.items.some(item => item.conversation?.adoptedInput?.key.submissionId === h.key.submissionId)).toBe(true)
  expect((await h.rpc.call('agent.input.inspect', { key: h.key })).record?.nativeResult).toMatchObject({ state, nativeTurnId: 'consumed-native-turn',
    correlation: { kind: 'native-adoption', queuedSubmissionId: 'original-queue-item' } })
})
it.each(['partial', 'duplicate', 'edited'] as const)('a %s queue cut never permanently claims the input result', async shape => {
  const h = await fixture('queue'); await h.writeNative([...(shape === 'partial' ? [{ type: 'event_msg', payload: { type: 'user_message', message: 'Earlier independent record' } }] : []), nativeUser(h, 'canonical-native-user', shape === 'edited' ? 'Edited native queue body' : undefined),
    ...(shape === 'duplicate' ? [nativeUser(h, 'second-semantic-item')] : []), nativeEnd(h)])
  const page = await h.client.sessionHistoryPage('recipient', { limit: shape === 'partial' ? 2 : 100 })
  if (shape === 'edited') expect(page.items.some(item => item.conversation?.adoptedInput)).toBe(false)
  expect((await h.rpc.call('agent.input.inspect', { key: h.key })).record?.nativeResult?.state).toBe('unknown')
})
it.each(['foreign-thread', 'foreign-token', 'wrong-end-turn', 'missing-end'] as const)('a %s native queue source remains unknown', async shape => {
  const h = await fixture('queue'), user = nativeUser(h), end = nativeEnd(h)
  if (shape === 'foreign-thread') user.payload.thread_id = 'foreign-native-source'
  if (shape === 'foreign-token') user.payload.item.client_id = createNativeInputCorrelation({ ...h.key, submissionId: 'another-input' })
  if (shape === 'wrong-end-turn') end.payload.turn_id = 'another-native-turn'
  await h.writeNative([user, ...(shape === 'missing-end' ? [] : [end])])
  await h.client.sessionHistoryPage('recipient')
  expect((await h.client.inspectAgentPromptSubmission(h.key))?.nativeResult?.state).toBe('unknown')
})
it('a native ACK cannot borrow a different turn on the same Run', async () => {
  const h = await fixture(); await h.emit('completed', 'later-human-native-turn')
  expect((await h.client.inspectAgentPromptSubmission(h.key))?.nativeResult?.state).toBe('unknown')
})
it('a complete cut whose normalization drops native provenance cannot settle a queue result', async () => {
  const h = await fixture('queue')
  const user = (id: string, turnId: string) => ({ id, kind: 'user-message' as const, turnId, contentParts: [{ kind: 'text' as const, text: 'Original private input' }],
    conversation: { nativeInput: { source: h.source, semanticItemId: id, clientCorrelation: h.plan.clientCorrelation, turnId } } })
  const a = user('native-A', 'turn-A'), b = user('native-B', 'turn-B')
  const page = { source: h.source, items: [{ id: 'large-original', kind: 'system-message' as const, contentParts: [{ kind: 'text' as const, text: '' }] },
    a, { id: 'end-A', kind: 'activity' as const, turnId: 'turn-A', contentParts: [], turnOutcome: { status: 'completed' as const } }, b], nextCursor: null, changesCursor: 'whole-original-native-cut' }
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
  const body = { ...page, items: page.items.map(({ conversation: _, ...item }: any) => item) }
  const { conversation: _, ...without } = a
  page.items[0]!.contentParts[0]!.text = 'x'.repeat(SESSION_HISTORY_MAX_PAGE_BYTES - bytes(body) - (bytes(a) - bytes(without)) - 32)
  vi.spyOn(h.client.providers.get('codex'), 'readSessionHistoryPage').mockResolvedValue(page)
  const read = await h.client.sessionHistoryPage('recipient')
  expect(read.items).toHaveLength(4)
  expect((await h.client.inspectAgentPromptSubmission(h.key))?.nativeResult?.state).toBe('unknown')
})
it.each(['failed', 'interrupted'] as const)('a direct ACK retains its original %s typed outcome', async state => {
  const h = await fixture(); await h.emit(state)
  expect((await h.client.inspectAgentPromptSubmission(h.key))?.nativeResult?.state).toBe(state)
})
it.each(['run', 'source'] as const)('the original direct ACK cannot borrow another %s generation end', async shape => {
  const h = await fixture(); await h.emit('completed')
  const original = (await h.store.readMetadata('recipient'))!, run = shape === 'run' ? { runId: 'later-run' } : original.run
  const handle = { ...original.nativeHandle!, ...(shape === 'source' ? { transcriptPath: join(h.root, 'replacement.jsonl') } : {}) }
  await h.store.compareAndSwapMetadata(original, { ...original, run, nativeHandle: handle,
    ...(shape === 'run' ? { promptCompletionAdmission: undefined } : {}),
    nativeTurnEnds: { ...original.nativeTurnEnds!, run, nativeHandle: handle } })
  expect((await h.client.inspectAgentPromptSubmission(h.key))?.nativeResult?.state).toBe('unknown')
})
it('a later input cannot overwrite or refresh a qualified original native result', async () => {
  const h = await fixture(); await h.emit('completed')
  const before = (await h.client.inspectAgentPromptSubmission(h.key))!.nativeResult
  const original = (await h.store.readMetadata('recipient'))!
  await h.store.compareAndSwapMetadata(original, { ...original, promptCompletionAdmission: undefined, nativeTurnEnds: undefined })
  expect((await h.client.inspectAgentPromptSubmission(h.key))!.nativeResult).toEqual(before)
})
it('an archive settlement failure keeps the original result unknown and input readable', async () => {
  const h = await fixture(); await h.emit('completed')
  vi.spyOn(h.store, 'settlePromptAdmission').mockRejectedValue(new Error('Private result writer unavailable'))
  expect((await h.client.inspectAgentPromptSubmission(h.key))?.nativeResult?.state).toBe('unknown')
  expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})
it('an optional native observation failure cannot hide an already readable original input', async () => {
  const h = await fixture(); await h.emit('completed')
  vi.spyOn(h.store, 'readMetadata').mockRejectedValue(new Error('Only native observation metadata unavailable'))
  await expect(h.client.inspectAgentPromptSubmission(h.key)).resolves.toMatchObject({ agentSessionId: 'recipient', nativeResult: { state: 'unknown' } })
})
it('unsupported PTY input inspection needs no current native observation read', async () => {
  const h = await fixture('pty')
  const metadata = vi.spyOn(h.store, 'readMetadata').mockRejectedValue(new Error('A PTY receipt has no native outcome to qualify'))
  await expect(h.client.inspectAgentPromptSubmission(h.key)).resolves.toMatchObject({ nativeResult: { state: 'unsupported' } })
  expect(metadata).not.toHaveBeenCalled()
})
it('the source CLI and strict public codec consume the same original native result', async () => {
  const h = await fixture(); await h.emit('completed')
  const probe = new ObjectCliProbe(request => h.rpc.call(request.method as any, request.params as any, { caller: h.credentials }))
  await probe.start(); closes.push(() => probe.stop())
  const cli = await runSourceObjectCli(['--endpoint', 'unix:' + probe.socketPath, 'agent', 'input', 'inspect', '--input', '-'], probe.environment(), JSON.stringify({ key: h.key }))
  expect(cli.code, cli.stderr).toBe(0)
  expect(JSON.parse(cli.stdout).result.record.nativeResult).toEqual((await h.client.inspectAgentPromptSubmission(h.key))!.nativeResult)
  await evidence({ scenario: 'public-source-cli', root: h.root, methods: probe.requests.map(row => row.method), key: h.key, noModel: true })
})
it('two independent OS Core owners read the same qualified archived key and outcome without input or a dist asset', async () => {
  const h = await fixture('queue'); await h.writeNative([nativeUser(h), nativeEnd(h)])
  await h.client.sessionHistoryPage('recipient')
  const before = (await h.client.inspectAgentPromptSubmission(h.key))!
  expect(before.nativeResult?.state).toBe('completed')
  await h.client.dispose()
  const owner = fileURLToPath(new URL('./fixtures/prompt-native-result-owner.mjs', import.meta.url)), loader = new URL('./helpers/prompt-native-result-loader.mjs', import.meta.url)
  const registration = `import { register } from 'node:module'; register(${JSON.stringify(loader.href)}, ${JSON.stringify(import.meta.url)});`
  const pids: number[] = [], records: unknown[] = []
  for (let round = 0; round < 2; round++) {
    const child = spawn(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(registration), owner, h.root], { env: objectCliEnvironment(h.root), stdio: ['pipe', 'pipe', 'pipe'] })
    let output = '', errors = ''; child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { errors += data })
    const ended = new Promise<number | null>(resolve => child.once('close', resolve))
    closes.push(async () => { if (child.exitCode === null) child.stdin.end(); await ended })
    await vi.waitFor(() => expect(output, errors).toContain('"socket"'), { timeout: 15000 })
    const opened = JSON.parse(output.split('\n')[0]!)
    pids.push(opened.pid)
    const cli = await runSourceObjectCli(['--endpoint', 'unix:' + opened.socket, 'agent', 'input', 'inspect', '--input', '-'], objectCliEnvironment(h.root), JSON.stringify({ key: h.key }), 15000, loader)
    expect(cli.code, cli.stderr).toBe(0); records.push(JSON.parse(cli.stdout).result.record)
    child.stdin.end(); expect(await ended, errors).toBe(0); expect(output).toContain('"closed":true')
  }
  expect(pids[0]).not.toBe(pids[1]); expect(records).toEqual([before, before])
  await evidence({ scenario: 'two-os-original-outcome', root: h.root, pids, key: h.key, nativeResult: before.nativeResult, noInputOrModel: true })
}, 60000)
it('the public participant guard still denies a foreign Agent and the result codec rejects a foreign result source', async () => {
  const h = await fixture(); await h.emit('completed')
  await expect(h.rpc.call('agent.input.inspect', { key: h.key }, { caller: { agentSessionId: 'caller', capability: h.capability } })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  const original = (await h.client.inspectAgentPromptSubmission(h.key))!
  expect(parsePromptSubmissionRecord(original).nativeResult?.state).toBe('completed')
  expect(() => parsePromptSubmissionRecord({ ...original, nativeResult: { ...original.nativeResult, sourceId: 'foreign-source' } })).toThrow()
})
it('a PTY ACK and later native end cannot claim the original Grok input was consumed', async () => {
  const h = await fixture('pty'); await h.emit('completed', 'human-native-turn-B')
  expect((await h.store.readMetadata('recipient'))?.semanticStatus?.nativeTurnId).toBe('human-native-turn-B')
  expect((await h.rpc.call('agent.input.inspect', { key: h.key })).record?.nativeResult).toMatchObject({ state: 'unsupported' })
})
it('a legacy native end without endReason remains unknown even after its original input ACK', async () => {
  const h = await fixture(); await h.emit(undefined)
  expect((await h.rpc.call('agent.input.inspect', { key: h.key })).record?.nativeResult).toMatchObject({ state: 'unknown' })
})
it('a legacy latest slot without an archived source never backfills native authority on read or a routine save', async () => {
  const h = await fixture(); await h.emit('completed')
  // Own private fixture only: reproduce an old source with its original latest
  // admission but no archive row. The reader must not reinterpret today as intake.
  await Reflect.get(h.store, 'enqueue').call(h.store, () => {
    Reflect.get(h.store, 'db').prepare('DELETE FROM prompt_admissions WHERE session_id=?').run('recipient')
    Reflect.set(h.store, 'dirty', true)
  })
  expect((await h.client.inspectAgentPromptSubmission(h.key))?.nativeResult?.state).toBe('unknown')
  const previous = (await h.store.readMetadata('recipient'))!
  await h.store.compareAndSwapMetadata(previous, { ...previous, updatedAt: previous.updatedAt + 1 })
  const original = await h.client.inspectAgentPromptSubmission(h.key)
  expect(original?.nativeSource).toBeUndefined()
  expect(original?.nativeResult?.state).toBe('unknown')
})
it('physical legacy JSON import cannot become a new native input claim', async () => {
  const h = await fixture(); await h.emit('completed')
  const session = (await h.store.readMetadata('recipient'))!, path = join(h.root, 'physical-original.json')
  await writeFile(path, JSON.stringify({ version: 5, sessions: [session], reservations: [], retiredRuns: [], retiredAgentSessions: [] }))
  const imported = new AgentMuxFileAgentSessionStore(path), before = (await imported.readMetadata('recipient'))!
  await imported.compareAndSwapMetadata(before, { ...before, updatedAt: before.updatedAt + 1 })
  const record = await imported.readPromptAdmission('recipient', h.key.expectedRun, h.key.submissionId)
  expect(record?.nativeSource).toBeUndefined()
  expect(record?.nativeResult?.state).toBe('unknown')
})
