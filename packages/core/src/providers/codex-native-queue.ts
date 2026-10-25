import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { JSONRPCClient, JSONRPCErrorException } from 'json-rpc-2.0'
import type { AgentProvider } from '../agent-provider.js'
import { nativeProcessBirth, nativeProcessExecutable, nativeProcessFiles, type NativeProcessFile } from '../agent-native-process.js'
import { AgentMuxError } from '../errors.js'
import { nativeInputSourceId } from '../native-input-correlation.js'
import { runProcess } from '../process-runner.js'
import { locateAppServerNativeSession } from './app-server-native-session.js'
import { codexMainNativeRecord } from './codex-native-record-role.js'

// Stable original queue contract, qualified on 0.163 and 0.165. This identifier
// is retained by frozen claims and does not assert the running executable version.
const PROTOCOL = 'codex-durable-queue-0.163'
const unavailable = () => new AgentMuxError('The original native queue source is unconfirmed. The message, Agent and ordinary terminal input remain available.', 'AGENT_NATIVE_INPUT_UNAVAILABLE')
type FileObject = Pick<NativeProcessFile, 'path' | 'device' | 'inode'>
const identity = (file: FileObject) => [file.path, String(file.device), String(file.inode)]
const sameFile = (a: FileObject, b: FileObject) => a.device === b.device && a.inode === b.inode

async function closeFailedPreparation(dispose: () => Promise<void>, error: unknown): Promise<never> {
  try { await dispose() } catch (cleanup) {
    const original = error instanceof AgentMuxError ? error : unavailable()
    const failure = new AgentMuxError(original.message + ' Native queue helper cleanup is also unconfirmed.', original.code,
      original.detail, original.controlFailure, original.logId)
    Object.defineProperty(failure, 'cause', { value: error })
    Object.defineProperty(failure, 'cleanup', { value: [cleanup] })
    throw failure
  }
  throw error
}

async function assertFile(file: FileObject): Promise<void> {
  const input = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try { const stat = await input.stat({ bigint: true }); if (!stat.isFile() || stat.dev !== file.device || stat.ino !== file.inode) throw unavailable() }
  finally { await input.close() }
}

function stores(files: NativeProcessFile[]): { queue: NativeProcessFile; state: NativeProcessFile } {
  const exact = (name: string) => {
    const candidates = files.filter(file => basename(file.path) === name && (file.access === 'w' || file.access === 'u'))
    const unique = [...new Map(candidates.map(file => [JSON.stringify(identity(file)), file])).values()]
    if (unique.length !== 1) throw unavailable()
    return unique[0]!
  }
  // These names belong to the qualified native storage protocol, not to an Executor.
  const queue = exact('queue_1.sqlite'), state = exact('state_5.sqlite')
  if (dirname(queue.path) !== dirname(state.path)) throw unavailable()
  return { queue, state }
}

/** This private helper exposes only queue preparation and admission. It cannot load a
 * thread, start/steer a turn, edit trust or replace the original model writer. */
async function openQueueHelper(command: string, storage: string, workspacePath: string, signal: AbortSignal) {
  const home = await mkdtemp(join(tmpdir(), 'agentmux-native-queue-'))
  const child = spawn(command, ['-c', `sqlite_home=${JSON.stringify(storage)}`, 'app-server', '--stdio'], {
    cwd: workspacePath, env: { ...process.env, CODEX_HOME: home }, detached: true, stdio: ['pipe', 'pipe', 'pipe']
  })
  let failed: unknown, carry = '', bytes = 0, closed = false
  const client = new JSONRPCClient(message => new Promise<void>((resolve, reject) => {
    child.stdin.write(JSON.stringify(message) + '\n', error => error ? reject(error) : resolve())
  }))
  const fail = (error: unknown) => { failed ??= error; client.rejectAllPendingRequests('Original native queue transport unavailable.') }
  const ended = new Promise<void>(resolve => child.once('close', () => { closed = true; fail(unavailable()); resolve() }))
  child.on('error', fail); child.stdin.on('error', fail)
  const budget = (chunk: Buffer) => { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) fail(unavailable()); return failed === undefined }
  child.stderr.on('data', budget)
  const decoder = new TextDecoder('utf-8', { fatal: true })
  child.stdout.on('data', (chunk: Buffer) => {
    if (!budget(chunk)) return
    try {
      carry += decoder.decode(chunk, { stream: true })
      for (let newline; (newline = carry.indexOf('\n')) >= 0;) {
        const line = carry.slice(0, newline); carry = carry.slice(newline + 1)
        if (!line.trim()) continue
        const message = JSON.parse(line)
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw unavailable()
        if (Object.hasOwn(message, 'id')) {
          if (Object.hasOwn(message, 'method')) throw unavailable()
          client.receive(message)
        }
      }
    } catch (error) { fail(error) }
  })
  const abort = () => fail(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  const request = async (method: 'initialize' | 'thread/read' | 'thread/queue/add', params: Record<string, unknown>): Promise<any> => {
    signal.throwIfAborted()
    if (failed !== undefined || !['initialize', 'thread/read', 'thread/queue/add'].includes(method)) throw unavailable()
    return await client.timeout(10_000).request(method, params)
  }
  const dispose = async (): Promise<void> => {
    signal.removeEventListener('abort', abort); client.rejectAllPendingRequests('Original native queue helper disposed.')
    child.stdin.end()
    const wait = async (ms: number) => { if (closed) return; let timer: NodeJS.Timeout | undefined
      await Promise.race([ended, new Promise<void>(resolve => { timer = setTimeout(resolve, ms) })]); clearTimeout(timer) }
    const stop = (value: NodeJS.Signals) => { if (!child.pid) return
      try { process.kill(-child.pid, value) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error } }
    await wait(1_000)
    if (!closed) { stop('SIGTERM'); await wait(1_000) }
    if (!closed) { stop('SIGKILL'); await wait(1_000) }
    if (!closed) throw unavailable()
    stop('SIGKILL'); await rm(home, { recursive: true })
  }
  try {
    await request('initialize', { clientInfo: { name: 'agentmux_native_queue', version: '1' }, capabilities: { experimentalApi: true } })
    client.notify('initialized', {}, undefined)
    if (!child.pid) throw unavailable()
    return { processId: child.pid, request, dispose }
  } catch (error) { return await closeFailedPreparation(dispose, error) }
}

/** Codex's durable QueueStore is consumed by its original loaded thread, including
 * embedded TUIs. Its native external-change watcher dispatches only while idle.
 * No launcher syntax, private managed-actor credential or second message ledger. */
export const prepareCodexDurableQueueInput: NonNullable<AgentProvider['prepareNativeInput']> = async (context, target) => {
  if (target.providerId !== 'codex' || target.idleOnly !== true || target.expectedTurnId !== undefined) throw unavailable()
  const { signal, processId } = context
  const rootBirth = await nativeProcessBirth(processId, signal)
  const original = await locateAppServerNativeSession(context, codexMainNativeRecord, 'run-group', { id: target.nativeSessionId,
    ...(context.nativeHandle?.kind === 'provider' && context.nativeHandle.transcriptPath ? { path: context.nativeHandle.transcriptPath } : {}) })
  if (!original || original.id !== target.nativeSessionId || context.nativeHandle &&
      (context.nativeHandle.kind !== 'provider' || context.nativeHandle.providerId !== target.providerId ||
       context.nativeHandle.sessionId !== original.id || context.nativeHandle.transcriptPath !== undefined && context.nativeHandle.transcriptPath !== original.file.path)) throw unavailable()
  const owner = original.file.processId, ownerBirth = await nativeProcessBirth(owner, signal)
  const executable = await nativeProcessExecutable(owner, signal)
  await assertFile(executable)
  const version = await runProcess(executable.path, ['--version'], { signal, timeoutMs: 2_000, maxOutputBytes: 4096 })
  if (version.exitCode !== 0 || version.stderr || !['codex-cli 0.163.0', 'codex-cli 0.165.0'].includes(version.stdout.trim())) throw unavailable()
  const storage = stores(await nativeProcessFiles(owner, signal, 'process'))
  await assertFile(storage.queue); await assertFile(storage.state)
  const helper = await openQueueHelper(executable.path, dirname(storage.queue.path), context.workspacePath, signal)
  try {
    const helperBirth = await nativeProcessBirth(helper.processId, signal)
    const assertCurrent = async (): Promise<void> => {
      signal.throwIfAborted()
      if (await nativeProcessBirth(processId, signal) !== rootBirth || await nativeProcessBirth(owner, signal) !== ownerBirth ||
          await nativeProcessBirth(helper.processId, signal) !== helperBirth) throw unavailable()
      const current = await locateAppServerNativeSession(context, codexMainNativeRecord, 'run-group', { id: original.id, path: original.file.path })
      if (!current || current.id !== original.id || current.file.processId !== owner || !sameFile(current.file, original.file) || current.file.path !== original.file.path) throw unavailable()
      const sourceStores = stores(await nativeProcessFiles(owner, signal, 'process'))
      const helperStores = stores(await nativeProcessFiles(helper.processId, signal, 'process'))
      if (!sameFile(sourceStores.queue, storage.queue) || !sameFile(sourceStores.state, storage.state) ||
          !sameFile(helperStores.queue, storage.queue) || !sameFile(helperStores.state, storage.state)) throw unavailable()
      await assertFile(storage.queue); await assertFile(storage.state); await assertFile(executable)
      const read = await helper.request('thread/read', { threadId: original.id, includeTurns: false }), thread = read?.thread
      // A helper reads the saved object without loading it. Null live capabilities
      // stay unknown. In this native version queue/add uses the same ownership
      // policy as canAcceptDirectInput, so an explicit false is counterevidence.
      if (thread?.id !== original.id || thread.path !== original.file.path || thread.ephemeral !== false ||
          thread.canAcceptDirectInput === false || !codexMainNativeRecord({ source: thread.source,
            ...(thread.threadSource === null ? {} : { thread_source: thread.threadSource }) })) throw unavailable()
    }
    await assertCurrent()
    const plan = { kind: 'native-rpc' as const, protocolId: PROTOCOL, sourceId: nativeInputSourceId(target), threadId: original.id,
      actorId: createHash('sha256').update(JSON.stringify([rootBirth, ownerBirth, identity(storage.queue), identity(storage.state)])).digest('hex'),
      operation: 'queue-idle' as const }
    return { plan, assertCurrent, dispose: helper.dispose,
      async send(prompt, frozen) {
        if (!frozen.clientCorrelation || !isDeepStrictEqual({ ...frozen, clientCorrelation: undefined }, { ...plan, clientCorrelation: undefined })) throw unavailable()
        await assertCurrent()
        const input = [{ type: 'text', text: prompt, text_elements: [] }]
        try {
          const receipt = await helper.request('thread/queue/add', { threadId: plan.threadId, input, clientUserMessageId: frozen.clientCorrelation })
          const item = receipt?.queuedSubmission
          if (typeof item?.id !== 'string' || !item.id || item.clientUserMessageId !== frozen.clientCorrelation || !isDeepStrictEqual(item.input, input)) throw unavailable()
          return { outcome: 'admitted', queuedSubmissionId: item.id }
        } catch (error) {
          if (error instanceof JSONRPCErrorException && [-32600, -32602].includes(error.code)) return { outcome: 'not-applied', errorCode: error.code }
          throw error
        }
      } }
  } catch (error) { return await closeFailedPreparation(helper.dispose, error) }
}
