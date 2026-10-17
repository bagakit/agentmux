import { copyFile, chmod, mkdtemp, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { prepareCodexNativeInput } from '../src/providers/codex-native-input.js'
import { createNativeInputCorrelation } from '../src/native-input-correlation.js'
import type { NativeProcessFile } from '../src/agent-native-process.js'
import { runProcess } from '../src/process-runner.js'

const os = vi.hoisted(() => ({ original: undefined as any, binary: undefined as any, stores: [] as NativeProcessFile[],
  sourceChanged: false, queueChanged: false, helperChanged: false, helperStateChanged: false, birthChanged: false }))
vi.mock('../src/providers/app-server-native-session.js', () => ({ locateAppServerNativeSession: async () =>
  os.sourceChanged ? { ...os.original, id: 'foreign-thread' } : os.original }))
vi.mock('../src/agent-native-process.js', () => ({
  nativeProcessExecutable: async () => os.binary,
  nativeProcessBirth: async (pid: number) => `kernel-generation-${pid}-${os.birthChanged ? 'changed' : 'original'}`,
  nativeProcessFiles: async (pid: number) => os.stores.map(file => ({ ...file, processId: pid,
    inode: file.inode + (os.queueChanged && pid === 700002 || pid !== 700002 &&
      (os.helperChanged && basename(file.path) === 'queue_1.sqlite' || os.helperStateChanged && basename(file.path) === 'state_5.sqlite') ? 1n : 0n) })),
  nativeProcessTcpListeners: async () => { throw new Error('The durable QueueStore does not require a managed WS actor') }
}))
const closes: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.unstubAllEnvs() })
const source = { providerId: 'codex', nativeSessionId: 'original-thread' }
const correlation = createNativeInputCorrelation({ kind: 'prompt', agentSessionId: 'recipient', expectedRun: { runId: 'original-run' }, submissionId: 'original-notice' })

async function fixture() {
  os.sourceChanged = os.queueChanged = os.helperChanged = os.helperStateChanged = os.birthChanged = false
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
  const configuration: Record<string, unknown> = { thread: source.nativeSessionId, path, trace }
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
  expect(calls.every(row => ['initialize', 'initialized', 'thread/read', 'thread/queue/add'].includes(row.method))).toBe(true)
  expect(prepared.plan.actorId).not.toContain(f.root)
})

it('uses the OS-bound original writer for an id-only saved native handle', async () => {
  const f = await fixture()
  const nativeHandle = { kind: 'provider' as const, providerId: 'codex', sessionId: source.nativeSessionId }
  const prepared = await prepareCodexNativeInput({ ...f.context, nativeHandle }, { ...source, idleOnly: true })
  closes.push(async () => { await prepared.dispose() })
  await expect(prepared.send('Original reference', { ...prepared.plan, clientCorrelation: correlation })).resolves.toEqual({ outcome: 'admitted', queuedSubmissionId: 'original-native-queue-item' })
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

it.each(['lost-ack', 'wire', 'correlation'])('keeps %s admission unknown and never retries an original queue request', async failure => {
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
