import { copyFile, chmod, mkdir, mkdtemp, open, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { prepareCodexNativeInput } from '../src/providers/codex-native-input.js'
import { createNativeInputCorrelation } from '../src/native-input-correlation.js'
import type { NativeProcessFile } from '../src/agent-native-process.js'
import { runProcess } from '../src/process-runner.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'

const os = vi.hoisted(() => ({ original: undefined as any, binary: undefined as any, stores: [] as NativeProcessFile[],
  ownerStateAbsent: false, helperStateAbsent: false, stateReadOnly: false,
  helperStateAfterReadMarker: undefined as string | undefined,
  sourceChanged: false, multi: false, queueChanged: false, helperChanged: false, helperStateChanged: false, birthChanged: false }))
vi.mock(import('../src/providers/app-server.js'), async importOriginal => ({
  ...await importOriginal(),
  locateAppServerNativeSession: async (_context: unknown, _role: unknown, _scope: unknown, target?: { id: string; path?: string }) => {
  if (os.multi && (!target || target.id !== os.original.id || target.path !== undefined && target.path !== os.original.file.path)) throw new Error('Multiple roots require the exact frozen target')
  return os.sourceChanged ? { ...os.original, id: 'foreign-thread' } : os.original
} }))
vi.mock('../src/agent-native-process.js', () => ({
  nativeProcessExecutable: async () => os.binary,
  nativeProcessBirth: async (pid: number) => `kernel-generation-${pid}-${os.birthChanged ? 'changed' : 'original'}`,
  nativeProcessFiles: async (pid: number) => {
    const readCompleted = os.helperStateAfterReadMarker && await readFile(os.helperStateAfterReadMarker).then(() => true, () => false)
    return os.stores.filter(file => basename(file.path) !== 'state_5.sqlite' ||
    !(pid === 700002 ? os.ownerStateAbsent : os.helperStateAbsent)).map(file => ({ ...file, processId: pid,
    access: os.stateReadOnly && basename(file.path) === 'state_5.sqlite' ? 'r' : file.access,
    inode: file.inode + (os.queueChanged && pid === 700002 || pid !== 700002 &&
      (os.helperChanged && basename(file.path) === 'queue_1.sqlite' || (os.helperStateChanged || readCompleted) && basename(file.path) === 'state_5.sqlite') ? 1n : 0n) }))
  },
  nativeProcessTcpListeners: async () => { throw new Error('The durable QueueStore does not require a managed WS actor') }
}))
const closes: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.unstubAllEnvs() })
const source = { providerId: 'codex', nativeSessionId: 'original-thread' }
const correlation = createNativeInputCorrelation({ kind: 'prompt', agentSessionId: 'recipient', expectedRun: { runId: 'original-run' }, submissionId: 'original-notice' })

async function fixture() {
  os.multi = os.sourceChanged = os.queueChanged = os.helperChanged = os.helperStateChanged = os.birthChanged = false
  os.ownerStateAbsent = os.helperStateAbsent = os.stateReadOnly = false
  os.helperStateAfterReadMarker = undefined
  const root = await mkdtemp(join(tmpdir(), 'amux-queue-contract-'))
  closes.push(async () => await rm(root, { recursive: true }))
  const executable = join(root, 'native executable'), path = join(root, 'rollout-original.jsonl'), trace = join(root, 'rpc.jsonl'), control = join(root, 'control.json')
  await copyFile(fileURLToPath(new URL('./fixtures/codex-queue-rpc.mjs', import.meta.url)), executable); await chmod(executable, 0o700)
  await writeFile(path, JSON.stringify({ type: 'session_meta', payload: { id: source.nativeSessionId, source: 'cli' } }) + '\n')
  const file = async (path: string): Promise<NativeProcessFile> => { const value = await stat(path, { bigint: true })
    return { processId: 700002, processGroup: 700001, descriptor: '12', path, device: value.dev, inode: value.ino, access: 'u' } }
  for (const name of ['queue_1.sqlite', 'state_5.sqlite']) await writeFile(join(root, name), 'private protocol fixture')
  os.stores = await Promise.all(['queue_1.sqlite', 'state_5.sqlite'].map(name => file(join(root, name))))
  os.binary = await file(executable); os.original = { id: source.nativeSessionId, file: await file(path), childSessionIds: [] }
  const configuration: Record<string, unknown> = { thread: source.nativeSessionId, path, trace, version: 'codex-cli 0.167.0' }
  const update = async (change: Record<string, unknown>) => { Object.assign(configuration, change); await writeFile(control, JSON.stringify(configuration)) }
  await update({}); vi.stubEnv('AGENTMUX_QUEUE_FIXTURE', control)
  const context = { processId: 700001, workspacePath: root, signal: new AbortController().signal,
    nativeHandle: { kind: 'provider' as const, providerId: 'codex', sessionId: source.nativeSessionId, transcriptPath: path } }
  const prepare = async () => { const prepared = await prepareCodexNativeInput(context, { ...source, idleOnly: true }); closes.push(async () => { await prepared.dispose() }); return prepared }
  const readTrace = async () => (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  return { root, context, prepare, update, readTrace }
}

it('uses the exact OS native binary and shared storage for a wrapper-owned Run without a private actor', async () => {
  const f = await fixture(), prepared = await f.prepare(), plan = { ...prepared.plan, clientCorrelation: correlation }
  expect(prepared.plan).toMatchObject({ protocolId: 'codex-durable-queue-0.163', operation: 'queue-idle', threadId: source.nativeSessionId })
  await prepared.assertCurrent()
  await expect(prepared.send('Frozen inbox reference only', plan)).resolves.toEqual({ outcome: 'admitted', queuedSubmissionId: 'original-native-queue-item' })
  const trace = await f.readTrace(), calls = trace.filter(row => row.method)
  expect(trace[0].launch).toEqual(['-c', `sqlite_home=${JSON.stringify(f.root)}`, 'app-server', '--stdio'])
  expect(calls.filter(row => row.method === 'thread/queue/add')).toEqual([expect.objectContaining({ params: {
    threadId: source.nativeSessionId, input: [{ type: 'text', text: 'Frozen inbox reference only', text_elements: [] }], clientUserMessageId: correlation
  } })])
  expect(calls.some(row => row.method === 'thread/queue/list' && row.params.threadId === source.nativeSessionId && row.params.limit === 1)).toBe(true)
  expect(calls.every(row => ['initialize', 'initialized', 'thread/read', 'thread/queue/list', 'thread/queue/add'].includes(row.method))).toBe(true)
  expect(prepared.plan.actorId).not.toContain(f.root)
})

it.each(['0.163.0', '0.165.0', '0.166.0', '0.167.0', '0.169.0', 'future-version'])('qualifies the original native queue wire independently of the %s version label', async version => {
  const f = await fixture(); await f.update({ version: 'codex-cli ' + version })
  const result = await f.prepare().then(prepared => ({ prepared }), error => ({ error }))
  expect(result, 'The qualified original executable must retain its queue capability').toHaveProperty('prepared')
  if (!('prepared' in result)) throw new Error('The qualified original queue is missing')
  const prepared = result.prepared
  expect(prepared.plan).toMatchObject({ protocolId: 'codex-durable-queue-0.163', operation: 'queue-idle' })
  await expect(prepared.send('Same qualified wire', { ...prepared.plan, clientCorrelation: correlation })).resolves.toMatchObject({ outcome: 'admitted' })
  expect((await f.readTrace()).filter(row => row.method === 'thread/queue/add')).toHaveLength(1)
})

it.each([null, {}, { items: [] }, { data: 'wrong' }, { data: [], nextCursor: 1 },
  { data: [null] }, { data: [{ id: '', clientUserMessageId: 'original', input: [] }] },
  { data: [{ id: 'original', clientUserMessageId: false, input: [] }] },
  { data: [{ id: 'original', clientUserMessageId: 'original', input: {} }] }])('refuses a changed native queue read contract before admission: %j', async queueReadResult => {
  const f = await fixture(); await f.update({ queueReadResult })
  await expect(f.prepare()).rejects.toMatchObject({ code: 'AGENT_NATIVE_INPUT_UNAVAILABLE' })
  expect((await f.readTrace()).filter(row => row.method === 'thread/queue/add')).toHaveLength(0)
})

it('qualifies a nonempty queue without changing its existing native input', async () => {
  const f = await fixture()
  const queueReadResult = { data: [{ id: 'existing-native-item', clientUserMessageId: 'existing-correlation',
    input: [{ type: 'text', text: 'Existing native input' }] }], nextCursor: 'original-opaque-cursor' }
  await f.update({ queueReadResult })
  const prepared = await f.prepare()
  expect(prepared.plan.operation).toBe('queue-idle')
  expect((await f.readTrace()).filter(row => row.method === 'thread/queue/add')).toHaveLength(0)
})

it.each([null, undefined])('does not require platform correlation on an existing native queue entry: %j', async clientUserMessageId => {
  const f = await fixture()
  await f.update({ queueReadResult: { data: [{ id: 'existing-native-item', clientUserMessageId,
    input: [{ type: 'text', text: 'Ordinary native input' }] }], nextCursor: null } })
  const result = await f.prepare().then(prepared => ({ prepared }), error => ({ error }))
  expect(result, 'Existing native input need not carry a platform correlation').toHaveProperty('prepared')
  if (!('prepared' in result)) throw new Error('Original native queue preparation is missing')
  const prepared = result.prepared
  expect(prepared.plan.operation).toBe('queue-idle')
  await expect(prepared.send('Original frozen platform input', { ...prepared.plan, clientCorrelation: correlation })).resolves.toMatchObject({ outcome: 'admitted' })
  expect((await f.readTrace()).filter(row => row.method === 'thread/queue/add')).toEqual([
    expect.objectContaining({ params: expect.objectContaining({ clientUserMessageId: correlation,
      input: [{ type: 'text', text: 'Original frozen platform input', text_elements: [] }] }) })
  ])
})

it('cancels only its read-only preparation and never submits a native input', async () => {
  const f = await fixture(), controller = new AbortController(), marker = join(f.root, 'queue-read-started')
  await f.update({ queueReadWait: true, queueReadMarker: marker })
  const preparing = prepareCodexNativeInput({ ...f.context, signal: controller.signal }, { ...source, idleOnly: true }).then(
    prepared => ({ prepared }), error => ({ error }))
  try {
    await expect.poll(() => readFile(marker, 'utf8').catch(() => ''), { timeout: 10_000 }).toBe('original queue read requested')
    controller.abort(new Error('Original reader cancelled'))
    expect(await preparing).toHaveProperty('error')
    expect((await f.readTrace()).filter(row => row.method === 'thread/queue/add')).toHaveLength(0)
  } finally {
    controller.abort()
    const result = await preparing
    if ('prepared' in result) await result.prepared.dispose()
  }
})

it('keeps a cancelled unacknowledged native submission unconfirmed without sending it again', async () => {
  const f = await fixture(), controller = new AbortController(), marker = join(f.root, 'queue-add-started')
  f.context.signal = controller.signal
  const prepared = await f.prepare()
  await f.update({ failure: 'wait-ack', queueAddMarker: marker })
  const sending = prepared.send('Original immutable reference', { ...prepared.plan, clientCorrelation: correlation }).then(
    value => ({ value }), error => ({ error }))
  try {
    await expect.poll(() => readFile(marker, 'utf8').catch(() => ''), { timeout: 10_000 }).toBe('original queue input received')
    controller.abort(new Error('Original native observation cancelled'))
    expect(await sending).toHaveProperty('error')
    expect((await f.readTrace()).filter(row => row.method === 'thread/queue/add')).toHaveLength(1)
  } finally { controller.abort(); await sending }
})

it.each(['lost-ack', 'partial-ack', 'wire', 'correlation', 'reject', 'unsupported'] as const)(
  'Core future input and public inspection preserve the original %s queue result and healthy terminal without replay', async failure => {
    const h = await rpcOwnerFixture(['recipient']); closes.push(h.close)
    const f = await fixture(); await f.update({ failure })
    const original = (await h.store.readMetadata('recipient'))!
    await h.store.compareAndSwapMetadata(original, { ...original, workspacePath: f.root, nativeHandle: f.context.nativeHandle,
      semanticStatus: { state: 'done', source: 'native-hook', observedAt: Date.now() }, updatedAt: Date.now() })
    await h.inner.registry.load('local')
    h.inner.kernel.status = vi.fn(async (id: string) => ({ ...h.run(id), pid: 700001, workspacePath: f.root }))
    const rpc = new AgentMuxRpcService({ coreClients: h.coreClients }), principal = { principal: { kind: 'user' as const, id: 'private-test-user' } }
    const prompt = 'Original future input 原文', operationId = 'original-queue-' + failure
    await h.client.saveAgentFuturePromptIntent({ agentSessionId: 'recipient', intentId: 'original-future', operationId: 'save-future', prompt, active: true })
    const packet = { operationId, agentSessionId: 'recipient', prompt, expectedRun: original.run, afterSubmissionId: null,
      expectedFutureIntent: { intentId: 'original-future', occurrenceAt: 1000 }, expectedInputByte: 0 }
    const failureReceipt = await h.client.submitAgentPrompt(packet).then(() => undefined, error => error)
    const key = { kind: 'prompt' as const, agentSessionId: 'recipient', expectedRun: original.run, submissionId: operationId }
    const status = failure === 'reject' ? 'not-applied' : 'unknown'
    if (failure === 'unsupported') {
      expect(failureReceipt).toMatchObject({ code: 'AGENT_NATIVE_INPUT_UNAVAILABLE', controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } })
      expect(await h.client.inspectAgentPromptSubmission(key)).toBeNull()
      expect(await h.client.readAgentFuturePromptIntent('recipient', 'original-future')).not.toHaveProperty('lastOccurrenceAt')
      expect((await f.readTrace()).filter(row => row.method === 'thread/queue/add')).toHaveLength(0)
    } else {
      await expect.poll(async () => (await h.client.inspectAgentPromptSubmission(key))?.admission?.native?.outcome).toBe(status)
      const saved = await h.client.inspectAgentPromptSubmission(key)
      expect(saved?.admission).toMatchObject({ transport: 'native', acknowledged: false,
        native: { outcome: status, plan: { protocolId: 'codex-durable-queue-0.163', operation: 'queue-idle', clientCorrelation: expect.any(String) } } })
      expect(await new AgentMuxFileAgentSessionStore(h.store.path).readPromptAdmission('recipient', original.run, operationId)).toEqual(saved)
      await h.client.submitAgentPrompt(packet).catch(() => {})
      expect(await h.client.inspectAgentPromptSubmission(key)).toEqual(saved)
      expect((await f.readTrace()).filter(row => row.method === 'thread/queue/add')).toHaveLength(1)
    }
    const inspected: any = await rpc.call('agent.input.inspect', { key }, principal)
    if (failure === 'unsupported') expect(inspected.record).toBeNull()
    else expect(inspected.record).toEqual(await h.client.inspectAgentPromptSubmission(key))
    expect(h.inner.kernel.input).not.toHaveBeenCalled()
    expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    await h.client.writeTerminalBytes(original.run, 'x')
    expect(h.rawInput).toHaveBeenCalledWith(original.run.runId, 'x')
    expect((await h.client.statusAgent('recipient')).run).toMatchObject({ state: 'running', pid: 700001 })
  })

it('keeps the selected target for preparation and admission while unrelated main candidates remain open', async () => {
  const f = await fixture(); os.multi = true
  const result = await f.prepare().then(prepared => ({ prepared }), error => ({ error }))
  expect(result, 'A qualified selected main remains usable while another main is open').not.toHaveProperty('error')
  if (!('prepared' in result)) throw new Error('Missing selected native input preparation')
  const prepared = result.prepared
  await prepared.assertCurrent()
  await expect(prepared.send('Selected original reference', { ...prepared.plan, clientCorrelation: correlation })).resolves.toMatchObject({ outcome: 'admitted' })
  const calls = (await f.readTrace()).filter(row => row.method === 'thread/read' || row.method === 'thread/queue/add')
  expect(calls.length).toBeGreaterThan(1)
  expect(calls.every(row => row.params.threadId === source.nativeSessionId)).toBe(true)
})

it('uses the OS-bound original writer for an id-only saved native handle', async () => {
  const f = await fixture()
  const nativeHandle = { kind: 'provider' as const, providerId: 'codex', sessionId: source.nativeSessionId }
  const prepared = await prepareCodexNativeInput({ ...f.context, nativeHandle }, { ...source, idleOnly: true })
  closes.push(async () => { await prepared.dispose() })
  await expect(prepared.send('Original reference', { ...prepared.plan, clientCorrelation: correlation })).resolves.toEqual({ outcome: 'admitted', queuedSubmissionId: 'original-native-queue-item' })
})

it.each(['ownerStateAbsent', 'helperStateAbsent', 'stateReadOnly'] as const)('keeps the same frozen queue identity when %s changes', async field => {
  const f = await fixture(), original = await f.prepare(), frozen = { ...original.plan, clientCorrelation: correlation }
  os[field] = true
  const result = await f.prepare().then(prepared => ({ prepared }), error => ({ error }))
  expect(result, 'Metadata descriptor residency must not revoke the original queue').toHaveProperty('prepared')
  if (!('prepared' in result)) throw new Error('Missing original queue preparation')
  expect(result.prepared.plan).toEqual(original.plan)
  await expect(original.send('Original queued reference', frozen)).resolves.toEqual({ outcome: 'admitted', queuedSubmissionId: 'original-native-queue-item' })
  expect((await f.readTrace()).filter(row => row.method === 'thread/queue/add')).toHaveLength(1)
})

it.each(['replace', 'missing', 'symlink', 'directory'] as const)('refuses %s metadata even without resident descriptors', async change => {
  const f = await fixture(), prepared = await f.prepare(), path = join(f.root, 'state_5.sqlite')
  os.ownerStateAbsent = os.helperStateAbsent = true
  await rename(path, path + '.original')
  if (change === 'replace') await writeFile(path, 'foreign metadata object')
  if (change === 'symlink') await symlink(path + '.original', path)
  if (change === 'directory') await mkdir(path)
  await expect(prepared.send('Original reference', { ...prepared.plan, clientCorrelation: correlation })).rejects.toBeDefined()
  if (change !== 'replace') await expect(f.prepare()).rejects.toBeDefined()
  expect((await f.readTrace()).filter(row => row.method === 'thread/queue/add')).toHaveLength(0)
})

it('rejects a contradictory read-only metadata descriptor before admission', async () => {
  const f = await fixture(), prepared = await f.prepare()
  os.stateReadOnly = os.helperStateChanged = true
  await expect(prepared.send('Original reference', { ...prepared.plan, clientCorrelation: correlation })).rejects.toMatchObject({ code: 'AGENT_NATIVE_INPUT_UNAVAILABLE' })
  expect((await f.readTrace()).filter(row => row.method === 'thread/queue/add')).toHaveLength(0)
})

it('ignores an unrelated read-only metadata file outside the selected queue root', async () => {
  const f = await fixture(), prepared = await f.prepare(), state = os.stores.find(file => basename(file.path) === 'state_5.sqlite')!
  os.stores.push({ ...state, path: join(f.root, 'unrelated', 'state_5.sqlite'), access: 'r' })
  await expect(prepared.send('Original reference', { ...prepared.plan, clientCorrelation: correlation })).resolves.toMatchObject({ outcome: 'admitted' })
  expect((await f.readTrace()).filter(row => row.method === 'thread/queue/add')).toHaveLength(1)
})

it('rejects metadata replaced during the native thread read before sending', async () => {
  const f = await fixture(), prepared = await f.prepare()
  os.ownerStateAbsent = os.helperStateAbsent = true
  await f.update({ replaceState: join(f.root, 'state_5.sqlite') })
  await expect(prepared.send('Original reference', { ...prepared.plan, clientCorrelation: correlation })).rejects.toMatchObject({ code: 'AGENT_NATIVE_INPUT_UNAVAILABLE' })
  expect((await f.readTrace()).filter(row => row.method === 'thread/queue/add')).toHaveLength(0)
})

it('rejects a helper metadata connection changed during native read even when the path still matches', async () => {
  const f = await fixture(), prepared = await f.prepare()
  os.helperStateAfterReadMarker = join(f.root, 'metadata-read-complete')
  await f.update({ metadataReadMarker: os.helperStateAfterReadMarker })
  await expect(prepared.send('Original reference', { ...prepared.plan, clientCorrelation: correlation })).rejects.toMatchObject({ code: 'AGENT_NATIVE_INPUT_UNAVAILABLE' })
  expect((await f.readTrace()).filter(row => row.method === 'thread/queue/add')).toHaveLength(0)
})

it.each(['sourceChanged', 'queueChanged', 'helperChanged', 'helperStateChanged', 'birthChanged'] as const)('refuses changed %s before admission without changing the message or touching the original terminal', async field => {
  const f = await fixture(), prepared = await f.prepare(); os[field] = true
  await expect(prepared.assertCurrent()).rejects.toMatchObject({ code: 'AGENT_NATIVE_INPUT_UNAVAILABLE' })
  await expect(prepared.send('Frozen reference', { ...prepared.plan, clientCorrelation: correlation })).rejects.toMatchObject({ code: 'AGENT_NATIVE_INPUT_UNAVAILABLE' })
  expect((await f.readTrace()).filter(row => row.method === 'thread/queue/add')).toHaveLength(0)
})

it('rejects a FIFO replacing an original regular path promptly without blocking the healthy input lane', async () => {
  const f = await fixture(), prepared = await f.prepare(), path = os.binary.path
  await rename(path, path + '.original')
  expect((await runProcess('mkfifo', [path], { timeoutMs: 2000 })).exitCode).toBe(0)
  const timedOut = Symbol('blocked-original-path')
  let timer: NodeJS.Timeout | undefined
  const pending = prepared.send('Original reference', { ...prepared.plan, clientCorrelation: correlation }).catch(error => error)
  try {
    const result = await Promise.race([pending, new Promise<symbol>(resolve => { timer = setTimeout(() => resolve(timedOut), 1000) })])
    expect(result).toMatchObject({ code: 'AGENT_NATIVE_INPUT_UNAVAILABLE' })
    expect((await f.readTrace()).filter(row => row.method === 'thread/queue/add')).toHaveLength(0)
  } finally {
    clearTimeout(timer)
    // The negative mutation can leave its read waiting on this exact private FIFO.
    // Release only that path, then join it; no blocked libuv reader leaks past the test.
    const writer = await open(path, constants.O_WRONLY | constants.O_NONBLOCK).catch(error => {
      if (error.code !== 'ENXIO') throw error
      return undefined
    })
    await writer?.close(); await pending
  }
})

it.each([{ sourcePath: 'foreign-source' }, { source: 'unknown' }, { denied: true }])('rejects a mismatched native saved source without loading it: %j', async change => {
  const f = await fixture(); await f.update(change)
  await expect(f.prepare()).rejects.toMatchObject({ code: 'AGENT_NATIVE_INPUT_UNAVAILABLE' })
  expect((await f.readTrace()).filter(row => row.method === 'thread/queue/add')).toHaveLength(0)
})

it.each(['lost-ack', 'wire', 'correlation', 'uncorrelated-null', 'uncorrelated-missing'])('keeps %s admission unknown and never retries an original queue request', async failure => {
  const f = await fixture(), prepared = await f.prepare(); await f.update({ failure })
  await expect(prepared.send('Original immutable reference', { ...prepared.plan, clientCorrelation: correlation })).rejects.toBeDefined()
  expect((await f.readTrace()).filter(row => row.method === 'thread/queue/add')).toHaveLength(1)
})

it('reports explicit native rejection as not-applied and rejects an altered frozen wire target before any request', async () => {
  const f = await fixture(), prepared = await f.prepare(); await f.update({ failure: 'reject' })
  await expect(prepared.send('Original reference', { ...prepared.plan, clientCorrelation: correlation })).resolves.toEqual({ outcome: 'not-applied', errorCode: -32600 })
  await expect(prepared.send('Original reference', { ...prepared.plan, clientCorrelation: correlation, threadId: 'foreign-thread' })).rejects.toMatchObject({ code: 'AGENT_NATIVE_INPUT_UNAVAILABLE' })
  expect((await f.readTrace()).filter(row => row.method === 'thread/queue/add')).toHaveLength(1)
})

it.each([{ ...source }, { ...source, idleOnly: true as const, expectedTurnId: 'active-turn' }])('never turns durable idle delivery into direct input or steer: %j', async target => {
  const f = await fixture()
  await expect(prepareCodexNativeInput(f.context, target)).rejects.toMatchObject({ code: 'AGENT_NATIVE_INPUT_UNAVAILABLE' })
  await expect(f.readTrace()).rejects.toMatchObject({ code: 'ENOENT' })
})
