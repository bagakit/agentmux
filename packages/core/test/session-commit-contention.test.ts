import { appendFileSync, realpathSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { objectCliEnvironment } from './helpers/object-cli-rpc.js'
import { runSourceObjectCli } from './helpers/source-object-cli.js'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

function facts(name: string, value: Record<string, unknown>): void {
  const path = process.env.AGENTMUX_TEST_COMMIT_CONTENTION_FACTS
  if (path) appendFileSync(path, JSON.stringify({ name, ...value }) + '\n')
}

function session(): AgentMuxStoredAgentSession {
  return { kind: 'agent', agentSessionId: 'original', providerId: 'fixture', executorId: 'fixture', hostId: 'local',
    workspacePath: tmpdir(), run: { runId: 'original-run' }, retiredRuns: [], hookBindingId: 'original-hook',
    hookToken: 'original-token', createdAt: 1, updatedAt: 1 }
}

/** Hold a real SHARED lock only when the exact writer reaches COMMIT. */
function commitReader(path: string, target: (database: DatabaseSync) => boolean = () => true,
  options: { release?: false; onBusy?(database: DatabaseSync): void } = {}) {
  const execute = DatabaseSync.prototype.exec
  const originalPath = realpathSync(path)
  let reader: DatabaseSync | undefined, writer: DatabaseSync | undefined
  let release: ReturnType<typeof setImmediate> | undefined
  let originalError: unknown
  const observed = { commits: 0, busy: 0, mutationVisibleOnlyToWriter: false, activeAtBusy: false }
  const spy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
    if (sql === 'COMMIT' && !writer && this.prepare('PRAGMA database_list').all().some(row => row.file === originalPath) && target(this)) {
      writer = this
      reader = new DatabaseSync(path, { readOnly: true })
      execute.call(reader, 'BEGIN')
      reader.prepare('SELECT json FROM sessions').all()
      observed.mutationVisibleOnlyToWriter = JSON.stringify(reader.prepare('SELECT json FROM sessions').all()) !==
        JSON.stringify(this.prepare('SELECT json FROM sessions').all())
    }
    if (this === writer && sql === 'COMMIT') observed.commits += 1
    try { return execute.call(this, sql) }
    catch (error) {
      if (this === writer && sql === 'COMMIT' && (error as { errcode?: unknown }).errcode === 5) {
        observed.busy += 1
        observed.activeAtBusy = this.isTransaction
        originalError ??= error
        release ??= setImmediate(() => {
          options.onBusy?.(writer!)
          if (reader && options.release !== false) { execute.call(reader, 'COMMIT'); reader.close(); reader = undefined }
        })
      }
      throw error
    }
  })
  return { observed, get originalError() { return originalError }, close() {
    if (release) clearImmediate(release)
    if (reader) { execute.call(reader, 'ROLLBACK'); reader.close(); reader = undefined }
    spy.mockRestore()
  } }
}

it('commits one Store mutation after an independent same-process reader releases the original transaction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amx-commit-reader-'))
  const store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json')), original = session()
  await store.compareAndSwap(null, original)
  const mutation = vi.spyOn(store as unknown as { swapSession(...args: unknown[]): Promise<void> }, 'swapSession')
  const reader = commitReader(store.path)
  try {
    await expect(store.compareAndSwap(original, { ...original, updatedAt: 2 })).resolves.toBeUndefined()
    expect(reader.observed.busy).toBeGreaterThan(0)
    expect(reader.observed.commits).toBe(reader.observed.busy + 1)
    expect(reader.observed.activeAtBusy).toBe(true)
    expect(reader.observed.mutationVisibleOnlyToWriter).toBe(true)
    expect(mutation).toHaveBeenCalledTimes(1)
    expect(await new AgentMuxFileAgentSessionStore(store.path).readMetadata(original.agentSessionId)).toMatchObject({ updatedAt: 2 })
  } finally { reader.close(); await rm(root, { recursive: true, force: true }) }
  facts('same-process-store', { ...reader.observed, mutationCalls: mutation.mock.calls.length, cleanup: 'confirmed' })
})

it('SDK keeps one exact input gate and payload while a reader delays its admission COMMIT', async () => {
  const h = await rpcOwnerFixture(), operationId = 'original-input'
  const reader = commitReader(h.store.path, database => {
    const row = database.prepare('SELECT json FROM sessions WHERE id=?').get('recipient')
    return row !== undefined && JSON.parse(String(row.json)).promptCompletionAdmission?.submissionId === operationId
  })
  try {
    const first = await h.client.submitAgentPrompt({ agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' },
      operationId, prompt: 'Original input 原文', admissionIntent: { kind: 'manual-actor' }, execution: 'immediate', authorHuman: true })
    await Reflect.get(h.client, 'inputWaitingRecipients').get('recipient')?.pending
    const receipt = await h.client.inspectAgentInput({ key: { kind: 'prompt', agentSessionId: 'recipient',
      expectedRun: { runId: 'run-recipient' }, submissionId: operationId } })
    expect(receipt).toMatchObject({ status: 'terminal-confirmed', persistence: 'confirmed', ref: first && first.ref,
      control: { state: 'dispatch-authorized' } })
    expect(receipt?.admission?.admission?.inputDispatch).toEqual({ ref: receipt!.ref, gateId: receipt!.control.gateId })
    const input = h.inner.kernel.input as ReturnType<typeof vi.fn>
    expect(input).toHaveBeenCalledTimes(2)
    expect(input.mock.calls[0]![1].data.split('Original input 原文')).toHaveLength(2)
    expect(input.mock.calls[1]![1].data).toBe('\r')
    expect(reader.observed.busy).toBeGreaterThan(0)
    expect(reader.observed.mutationVisibleOnlyToWriter).toBe(true)
    expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    const reopened = await new AgentMuxFileAgentSessionStore(h.store.path).readPromptAdmission('recipient', receipt!.key.expectedRun, operationId)
    expect(reopened).toEqual(receipt!.admission)
    facts('sdk-original-input-receipt', { ...reader.observed, key: receipt!.key, ref: receipt!.ref, gateId: receipt!.control.gateId,
      inputCalls: input.mock.calls.length, inputBytes: input.mock.calls.map(call => Buffer.byteLength(call[1].data)) })
  } finally { reader.close(); await h.close() }
  facts('sdk-original-input', { cleanup: 'confirmed' })
})

it('commits the same mutation after a different process releases its exact read transaction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amx-commit-process-'))
  const store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json')), original = session()
  await store.compareAndSwap(null, original)
  const child: ChildProcess = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/session-commit-contention/reader.mjs', import.meta.url)), store.path],
    { stdio: ['pipe', 'pipe', 'pipe'] })
  let output = '', errors = '', ready: Record<string, unknown> | undefined
  child.stderr!.on('data', chunk => { errors += String(chunk) })
  const completed = once(child, 'exit')
  let writer: DatabaseSync | undefined, commits = 0, busy = 0
  const execute = DatabaseSync.prototype.exec
  const mutation = vi.spyOn(store as unknown as { swapSession(...args: unknown[]): Promise<void> }, 'swapSession')
  const spy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
    if (sql === 'COMMIT') { writer ??= this; commits += 1; expect(this).toBe(writer) }
    try { return execute.call(this, sql) } catch (error) {
      if (sql === 'COMMIT' && (error as { errcode?: unknown }).errcode === 5) {
        busy += 1
        if (busy === 1) setImmediate(() => child.stdin!.end('release\n'))
      }
      throw error
    }
  })
  try {
    ready = await new Promise<Record<string, unknown>>((resolve, reject) => {
      child.once('error', reject)
      child.stdout!.on('data', chunk => {
        output += String(chunk)
        if (output.includes('\n')) { try { resolve(JSON.parse(output.split('\n')[0]!)) } catch (error) { reject(error) } }
      })
      void completed.then(() => { if (!output.includes('\n')) reject(new Error('Read-lock owner exited before its barrier: ' + errors)) })
    })
    expect(ready).toMatchObject({ phase: 'read-transaction-owned', updatedAt: 1 })
    await expect(store.compareAndSwap(original, { ...original, updatedAt: 2 })).resolves.toBeUndefined()
    expect(busy).toBeGreaterThan(0); expect(commits).toBe(busy + 1)
    expect(mutation).toHaveBeenCalledTimes(1)
    expect(await completed).toEqual([0, null])
    spy.mockRestore()
    expect(await new AgentMuxFileAgentSessionStore(store.path).readMetadata(original.agentSessionId)).toMatchObject({ updatedAt: 2 })
  } finally {
    spy.mockRestore()
    if (child.exitCode === null && child.signalCode === null) { child.stdin!.end('release\n'); await completed }
    await rm(root, { recursive: true, force: true })
  }
  facts('cross-process-store', { commits, busy, mutationCalls: mutation.mock.calls.length, reader: ready, cleanup: 'confirmed' })
})

it('cancels the exact blocked transaction without another COMMIT and releases it for a healthy write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amx-commit-cancel-'))
  const store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json')), original = session()
  await store.compareAndSwap(null, original)
  const controller = new AbortController(), reason = new DOMException('Original write was cancelled.', 'AbortError')
  const reader = commitReader(store.path, undefined, { release: false, onBusy: () => controller.abort(reason) })
  try {
    await expect(store.compareAndSwap(original, { ...original, updatedAt: 2 }, controller.signal)).rejects.toBe(reason)
    expect(reader.observed.commits).toBe(1)
    reader.close()
    expect(await store.readMetadata(original.agentSessionId)).toEqual(original)
    await expect(store.compareAndSwap(original, { ...original, updatedAt: 3 })).resolves.toBeUndefined()
  } finally { reader.close(); await rm(root, { recursive: true, force: true }) }
  facts('cancelled-commit', { ...reader.observed, cleanup: 'confirmed' })
})

it('exhausts only the original COMMIT wait budget, preserves its SQLite cause and rolls back once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amx-commit-budget-'))
  const store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json')), original = session()
  await store.compareAndSwap(null, original)
  vi.spyOn(Math, 'random').mockReturnValue(0)
  const mutation = vi.spyOn(store as unknown as { swapSession(...args: unknown[]): Promise<void> }, 'swapSession')
  const reader = commitReader(store.path, undefined, { release: false })
  try {
    const error = await store.compareAndSwap(original, { ...original, updatedAt: 2 }).catch(error => error)
    expect(error).toMatchObject({ code: 'AGENT_SESSION_STORE_UNAVAILABLE', cause: { errcode: 5 } })
    expect(JSON.parse(error.detail)).toMatchObject({ stage: 'commit', cause: { errcode: 5 } })
    expect(reader.observed.commits).toBe(300)
    expect(mutation).toHaveBeenCalledTimes(1)
    reader.close()
    expect(await store.readMetadata(original.agentSessionId)).toEqual(original)
    await expect(store.compareAndSwap(original, { ...original, updatedAt: 3 })).resolves.toBeUndefined()
  } finally { reader.close(); await rm(root, { recursive: true, force: true }) }
  facts('exhausted-commit', { ...reader.observed, cleanup: 'confirmed' })
})

it.each([10, '5'])('does not retry a COMMIT with non-BUSY numeric identity %j', async errcode => {
  const root = await mkdtemp(join(tmpdir(), 'amx-commit-error-'))
  const store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json')), original = session()
  await store.compareAndSwap(null, original)
  const reason = Object.assign(new Error('Original machine failure.'), { code: 'ERR_SQLITE_ERROR', errcode })
  const execute = DatabaseSync.prototype.exec
  let commits = 0
  const spy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
    if (sql === 'COMMIT') { commits += 1; throw reason }
    return execute.call(this, sql)
  })
  try {
    const error = await store.compareAndSwap(original, { ...original, updatedAt: 2 }).catch(error => error)
    expect(error).toMatchObject({ code: 'AGENT_SESSION_STORE_UNAVAILABLE', cause: reason })
    expect(commits).toBe(1)
    spy.mockRestore()
    expect(await store.readMetadata(original.agentSessionId)).toEqual(original)
    await expect(store.compareAndSwap(original, { ...original, updatedAt: 3 })).resolves.toBeUndefined()
  } finally { spy.mockRestore(); await rm(root, { recursive: true, force: true }) }
  facts('non-busy-commit', { errcode, commits, cleanup: 'confirmed' })
})

it.each(['at-failure', 'during-yield'] as const)('never retries an inactive transaction %s and preserves the original unknown outcome', async phase => {
  const root = await mkdtemp(join(tmpdir(), 'amx-commit-inactive-'))
  const store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json')), original = session()
  await store.compareAndSwap(null, original)
  const execute = DatabaseSync.prototype.exec
  let commits = 0, originalError: unknown
  const reader = phase === 'during-yield' ? commitReader(store.path, undefined, {
    onBusy: database => execute.call(database, 'ROLLBACK')
  }) : undefined
  const spy = phase === 'at-failure' ? vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
    if (sql === 'COMMIT') {
      commits += 1; execute.call(this, 'ROLLBACK')
      originalError = Object.assign(new Error('Original inactive COMMIT failure.'), { code: 'ERR_SQLITE_ERROR', errcode: 5 })
      throw originalError
    }
    return execute.call(this, sql)
  }) : undefined
  try {
    const error = await store.compareAndSwap(original, { ...original, updatedAt: 2 }).catch(error => error)
    expect(error).toMatchObject({ code: 'AGENT_SESSION_STORE_DURABILITY_UNCONFIRMED', commitOutcome: 'unknown',
      cause: phase === 'during-yield' ? reader!.originalError : originalError })
    expect(phase === 'during-yield' ? reader!.observed.commits : commits).toBe(1)
    reader?.close(); spy?.mockRestore()
    expect(await store.readMetadata(original.agentSessionId)).toEqual(original)
    await expect(store.compareAndSwap(original, { ...original, updatedAt: 3 })).resolves.toBeUndefined()
  } finally { reader?.close(); spy?.mockRestore(); await rm(root, { recursive: true, force: true }) }
  facts('inactive-commit', { phase, commits: reader?.observed.commits ?? commits, cleanup: 'confirmed' })
})

it('public RPC and source CLI submit and inspect their original inputs through the same contended FileStore', async () => {
  const h = await rpcOwnerFixture(), path = join(h.root, 'input.sock')
  const server = new AgentMuxControlServer({ socketPath: path, coreClients: h.coreClients })
  await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } })
  const sourceLoader = new URL('./fixtures/session-commit-contention/node-loader.mjs', import.meta.url)
  const environment = objectCliEnvironment(h.root, {
    AGENTMUX_TEST_COMMIT_CONTENTION_LOADED: process.env.AGENTMUX_TEST_COMMIT_CONTENTION_LOADED,
    AGENTMUX_TEST_COMMIT_CONTENTION_MUTANT: process.env.AGENTMUX_TEST_COMMIT_CONTENTION_MUTANT
  })
  const results: Record<string, unknown>[] = []
  try {
    for (const producer of ['rpc', 'cli'] as const) {
      const input = { agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, operationId: 'original-' + producer,
        prompt: producer + ' original input 原文', admissionIntent: { kind: 'manual-actor' as const }, execution: 'immediate' as const }
      const reader = commitReader(h.store.path, database => {
        const row = database.prepare('SELECT json FROM sessions WHERE id=?').get('recipient')
        return row !== undefined && JSON.parse(String(row.json)).promptCompletionAdmission?.submissionId === input.operationId
      })
      try {
        const submitted = producer === 'rpc' ? await rpc.call('agent.input.submit', input) : await (async () => {
          const result = await runSourceObjectCli(['--endpoint', 'unix://' + path, 'agent', 'input', 'submit', '--session', input.agentSessionId,
            '--operation-id', input.operationId, '--input', '-'], environment, JSON.stringify(input), 15_000, sourceLoader)
          expect(result.code, result.stderr).toBe(0)
          return JSON.parse(result.stdout).result
        })()
        expect(submitted.key).toEqual({ kind: 'prompt', agentSessionId: input.agentSessionId, expectedRun: input.expectedRun, submissionId: input.operationId })
        await Reflect.get(h.client, 'inputWaitingRecipients').get('recipient')?.pending
        const inspected = await rpc.call('agent.input.inspect', { key: submitted.key })
        expect(inspected.input).toMatchObject({ key: submitted.key, status: 'terminal-confirmed', persistence: 'confirmed' })
        expect(reader.observed.busy).toBeGreaterThan(0)
        if (producer === 'cli') {
          const result = await runSourceObjectCli(['--endpoint', 'unix://' + path, 'agent', 'input', 'inspect', '--input', '-'],
            environment, JSON.stringify({ key: submitted.key }), 15_000, sourceLoader)
          expect(result.code, result.stderr).toBe(0)
          expect(JSON.parse(result.stdout).result.input).toEqual(inspected.input)
        }
        results.push({ producer, key: submitted.key, ref: inspected.input!.ref, gateId: inspected.input!.control.gateId, ...reader.observed })
      } finally { reader.close() }
    }
    const input = h.inner.kernel.input as ReturnType<typeof vi.fn>
    expect(input).toHaveBeenCalledTimes(4)
    expect(input.mock.calls.map(call => call[1].data).join('').split('rpc original input 原文')).toHaveLength(2)
    expect(input.mock.calls.map(call => call[1].data).join('').split('cli original input 原文')).toHaveLength(2)
    expect(h.inner.kernel.stop).not.toHaveBeenCalled()
  } finally { await rpc.dispose(); await server.stop(); await h.close() }
  facts('public-original-input', { results, inputCalls: 4, cleanup: 'confirmed' })
}, 30_000)
