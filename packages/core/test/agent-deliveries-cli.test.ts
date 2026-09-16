import { spawn, type ChildProcess } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AgentMuxClient, AgentMuxFileAgentSessionStore, AgentMuxMemoryAgentSessionStore, DurableAgentMuxMessageQueue,
  defaultAgentMuxMessageQueuePath, hashAgentCapability, issueAgentCapability,
  loadAgentSessions, terminalEnvironment,
  type AgentMuxDeliveryBatch, type AgentMuxMessageAppendInput,
  type AgentMuxStoredAgentSession
} from '../dist/index.js'

const roots: string[] = []
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup() } catch (error) { failures.push(error) }
  }
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  if (failures.length > 0) throw new AggregateError(failures, 'Private delivery fixture cleanup failed.')
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })))
}, 20_000)

async function privateRoot(): Promise<string> {
  const root = await mkdtemp('/tmp/amux-delivery-')
  roots.push(root)
  return root
}

function envelope(id: string, recipient = 'reader-one'): AgentMuxMessageAppendInput {
  return {
    messageId: id, operationId: `operation-${id}`, createdAt: 100,
    sender: { kind: 'agent-session', agentSessionId: 'sender' },
    recipient: { kind: 'agent-session', agentSessionId: recipient },
    threadId: 'synthetic-thread', correlationId: 'synthetic-correlation', replyTo: null,
    workspaceId: '/synthetic-workspace', senderSessionId: 'sender', senderRunId: 'sender-run',
    recipientSessionId: recipient, recipientRunId: 'original-reader-run', body: `Synthetic ${id}`
  }
}

type ConsumerInternals = {
  connected: boolean
  kernel: { isConnected(): boolean }
  registry: { load(hostId: string): Promise<void> }
  messageQueue: DurableAgentMuxMessageQueue
}

async function consumerFixture(memoryStore = false) {
  const root = await privateRoot()
  const store = memoryStore ? new AgentMuxMemoryAgentSessionStore()
    : new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
  const capability = issueAgentCapability()
  const current: AgentMuxStoredAgentSession = {
    kind: 'agent', agentSessionId: 'reader-one', providerId: 'traex', executorId: 'traex',
    hostId: 'local', workspacePath: root, run: { runId: 'reader-run-one' }, retiredRuns: [],
    hookBindingId: 'synthetic-binding', hookToken: 'synthetic-hook-token',
    capabilityHash: hashAgentCapability(capability), outputCursorBytes: 0, createdAt: 100, updatedAt: 100
  }
  await store.compareAndSwap(null, current)
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'global-messages.ndjson'))
  const client = new AgentMuxClient({ store })
  const internals = client as unknown as ConsumerInternals
  internals.connected = true
  internals.kernel.isConnected = () => true
  await internals.registry.load('local')
  cleanups.push(async () => await client.dispose())
  const queue = new DurableAgentMuxMessageQueue(join(root, 'global-messages.ndjson'))
  return { root, store, current, capability, client, queue, internals,
    input: { capability, callerAgentSessionId: current.agentSessionId } }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('public durable delivery consumer', () => {
  it('treats a brand-new journal as empty and leaves message delivery facts unchanged', async () => {
    const { client, input, queue } = await consumerFixture()
    expect(await client.checkDeliveries({ ...input, limit: 3 })).toEqual({
      consumerId: 'reader-one', readerRun: { runId: 'reader-run-one' }, generation: 1, messages: []
    })
    await queue.append(envelope('one'))
    await queue.append(envelope('other', 'reader-two'))
    await queue.append(envelope('two'))
    await queue.recordDelivery('one', 'failed', 200, 'Synthetic refusal')
    const before = await queue.listAfter()
    const batch = await client.checkDeliveries({ ...input, limit: 1 })
    expect(batch.messages.map((item) => item.envelope.messageId)).toEqual(['one'])
    await queue.append(envelope('three'))
    expect((await client.checkDeliveries({ ...input, limit: 100 })).messages).toEqual(batch.messages)
    expect(await client.ackDeliveryBatch({ ...input, readerRun: batch.readerRun, generation: batch.generation }))
      .toEqual({ consumerId: 'reader-one', readerRun: batch.readerRun,
        acknowledgedMessageIds: ['one'], nextGeneration: 2 })
    expect((await client.checkDeliveries({ ...input, limit: 2 })).messages.map((item) => item.envelope.messageId))
      .toEqual(['two', 'three'])
    expect((await queue.listAfter()).slice(0, 3)).toEqual(before)
  })

  it('uses fresh persisted capability facts instead of a cached Session or caller label', async () => {
    const fixture = await consumerFixture()
    await fixture.queue.append(envelope('one'))
    await expect(fixture.client.checkDeliveries({ ...fixture.input, capability: issueAgentCapability(), limit: 1 }))
      .rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
    const replacementCapability = issueAgentCapability()
    const replacement = { ...fixture.current, run: { runId: 'reader-run-two' },
      capabilityHash: hashAgentCapability(replacementCapability), updatedAt: 200 }
    await fixture.store.compareAndSwap(fixture.current, replacement)
    await expect(fixture.client.checkDeliveries({ ...fixture.input, limit: 1 }))
      .rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
    const batch = await fixture.client.checkDeliveries({ ...fixture.input, capability: replacementCapability, limit: 1 })
    expect(batch.readerRun).toEqual(replacement.run)
    expect(batch.messages.map((item) => item.envelope.messageId)).toEqual(['one'])
  })

  it('rejects a previously authorized late check after the replacement Run takes the same batch', async () => {
    const fixture = await consumerFixture()
    await fixture.queue.append(envelope('one'))
    await fixture.queue.append(envelope('two'))
    const first = await fixture.client.checkDeliveries({ ...fixture.input, limit: 1 })
    const entered = deferred<void>()
    const release = deferred<void>()
    const original = fixture.internals.messageQueue.check.bind(fixture.internals.messageQueue)
    vi.spyOn(fixture.internals.messageQueue, 'check').mockImplementationOnce(async (input, authorize) => {
      entered.resolve()
      await release.promise
      return await original(input, authorize)
    })
    const delayed = fixture.client.checkDeliveries({ ...fixture.input, limit: 2 })
    const delayedOutcome = delayed.then((batch) => ({ batch }), (error: unknown) => ({ error }))
    await entered.promise
    // Keeping the same capability isolates the Run fence from the independent capability rotation.
    const replacement = { ...fixture.current, run: { runId: 'reader-run-two' }, updatedAt: 200 }
    await fixture.store.compareAndSwap(fixture.current, replacement)
    const second = await fixture.client.checkDeliveries({ ...fixture.input, limit: 2 })
    expect(second.readerRun).toEqual(replacement.run)
    expect(second.generation).toBe(first.generation + 1)
    expect(second.messages).toEqual(first.messages)
    release.resolve()
    expect(await delayedOutcome).toMatchObject({ error: { code: 'MESSAGE_ACK_GENERATION_STALE' } })
    expect(await fixture.client.checkDeliveries({ ...fixture.input, limit: 2 })).toEqual(second)
  })

  it('rejects a previously authorized late ACK after the replacement Run checks', async () => {
    const fixture = await consumerFixture()
    await fixture.queue.append(envelope('one'))
    const first = await fixture.client.checkDeliveries({ ...fixture.input, limit: 1 })
    const entered = deferred<void>()
    const release = deferred<void>()
    const original = fixture.internals.messageQueue.ack.bind(fixture.internals.messageQueue)
    vi.spyOn(fixture.internals.messageQueue, 'ack').mockImplementationOnce(async (input, authorize) => {
      entered.resolve()
      await release.promise
      return await original(input, authorize)
    })
    const delayed = fixture.client.ackDeliveryBatch({ ...fixture.input, readerRun: first.readerRun, generation: first.generation })
    const delayedOutcome = delayed.then((ack) => ({ ack }), (error: unknown) => ({ error }))
    await entered.promise
    const replacement = { ...fixture.current, run: { runId: 'reader-run-two' }, updatedAt: 200 }
    await fixture.store.compareAndSwap(fixture.current, replacement)
    const second = await fixture.client.checkDeliveries({ ...fixture.input, limit: 1 })
    release.resolve()
    expect(await delayedOutcome).toMatchObject({ error: { code: 'MESSAGE_ACK_GENERATION_STALE' } })
    expect(await fixture.client.checkDeliveries({ ...fixture.input, limit: 1 })).toEqual(second)
  })

  it('reauthorizes inside the actual held queue lock, after another reader binds the replacement', async () => {
    // Memory SessionStore makes the authorization schedule deterministic. The journal and its
    // cross-instance SQLite lock are real; independent FileStore/CLI authority is tested above/below.
    const fixture = await consumerFixture(true)
    await fixture.queue.append(envelope('one'))
    const first = await fixture.client.checkDeliveries({ ...fixture.input, limit: 1 })
    const replacement = { ...fixture.current, run: { runId: 'reader-run-two' }, updatedAt: 200 }
    const held = deferred<void>()
    const release = deferred<void>()
    const takeover = fixture.queue.check({ consumerId: 'reader-one', readerRun: replacement.run, limit: 1 }, async () => {
      held.resolve()
      await release.promise
      await fixture.store.compareAndSwap(fixture.current, replacement)
    })
    await held.promise
    const queued = deferred<void>()
    const original = fixture.internals.messageQueue.check.bind(fixture.internals.messageQueue)
    vi.spyOn(fixture.internals.messageQueue, 'check').mockImplementationOnce(async (input, authorize) => {
      queued.resolve()
      return await original(input, authorize)
    })
    const late = fixture.client.checkDeliveries({ ...fixture.input, limit: 1 })
    const outcome = late.then((batch) => ({ batch }), (error: unknown) => ({ error }))
    await queued.promise
    // Let a wrongly moved pre-lock read settle against A before B updates the actual Store.
    await new Promise<void>((done) => setImmediate(done))
    release.resolve()
    const second = await takeover
    expect(second.readerRun).toEqual(replacement.run)
    expect(second.generation).toBe(first.generation + 1)
    expect(second.messages).toEqual(first.messages)
    expect(await outcome).toMatchObject({ error: { code: 'MESSAGE_ACK_GENERATION_STALE' } })
    expect(await fixture.client.checkDeliveries({ ...fixture.input, limit: 1 })).toEqual(second)
  })

  it('requires the checked Run and generation even when the replacement has not checked yet', async () => {
    const fixture = await consumerFixture()
    await fixture.queue.append(envelope('one'))
    const first = await fixture.client.checkDeliveries({ ...fixture.input, limit: 1 })
    await expect(fixture.client.ackDeliveryBatch({ ...fixture.input, readerRun: first.readerRun, generation: 999 }))
      .rejects.toMatchObject({ code: 'AGENT_DELIVERY_GENERATION_STALE' })
    await fixture.store.compareAndSwap(fixture.current, { ...fixture.current, run: { runId: 'reader-run-two' }, updatedAt: 200 })
    await expect(fixture.client.ackDeliveryBatch({ ...fixture.input, readerRun: first.readerRun, generation: first.generation }))
      .rejects.toMatchObject({ code: 'MESSAGE_ACK_GENERATION_STALE' })
    await expect(fixture.client.ackDeliveryBatch({ ...fixture.input, readerRun: { runId: 'reader-run-two' }, generation: first.generation }))
      .rejects.toMatchObject({ code: 'MESSAGE_ACK_GENERATION_STALE' })
    const replacement = await fixture.client.checkDeliveries({ ...fixture.input, limit: 1 })
    expect(replacement.messages).toEqual(first.messages)
    expect(replacement.generation).toBe(first.generation + 1)
  })

  it('rejects invalid limits and unreadable or malformed journals instead of silently consuming empty', async () => {
    const fixture = await consumerFixture()
    for (const limit of [0, -1, 1.5, 101, Number.NaN]) {
      await expect(fixture.client.checkDeliveries({ ...fixture.input, limit }))
        .rejects.toMatchObject({ code: 'MESSAGE_BATCH_LIMIT_INVALID' })
    }
    await writeFile(fixture.queue.path, '{not-json}\n', { mode: 0o600 })
    await expect(fixture.client.checkDeliveries({ ...fixture.input, limit: 1 }))
      .rejects.toMatchObject({ code: 'MESSAGE_QUEUE_UNAVAILABLE' })
    await rm(fixture.queue.path)
    await mkdir(fixture.queue.path)
    await expect(fixture.client.checkDeliveries({ ...fixture.input, limit: 1 }))
      .rejects.toMatchObject({ code: 'MESSAGE_QUEUE_UNAVAILABLE' })
  })

  it('does not reset an old consumer record without an authenticated Run binding', async () => {
    const fixture = await consumerFixture()
    await fixture.queue.append(envelope('one'))
    await writeFile(fixture.queue.path, `${await readFile(fixture.queue.path, 'utf8')}${JSON.stringify({
      kind: 'consumer-check', sequence: 2, consumerId: 'reader-one', generation: 1, deliveryIds: ['one']
    })}\n`)
    const before = await readFile(fixture.queue.path)
    await expect(fixture.client.checkDeliveries({ ...fixture.input, limit: 1 })).rejects.toThrow()
    expect(await readFile(fixture.queue.path)).toEqual(before)
  })

  it('chooses one queue authority while keeping the implicit default outside temporary Runtime state', async () => {
    const root = await privateRoot()
    vi.stubEnv('AGENTMUX_AGENT_SESSION_STORE', '')
    vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', '')
    vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'runtime'))
    const implicit = new AgentMuxClient() as unknown as ConsumerInternals
    cleanups.push(async () => await (implicit as unknown as AgentMuxClient).dispose())
    expect(implicit.messageQueue.path).toBe(join(homedir(), '.agentmux', 'state', 'global-messages.ndjson'))
    const adopted = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(join(root, 'adopted', 'sessions.json')) })
    cleanups.push(async () => await adopted.dispose())
    expect((adopted as unknown as ConsumerInternals).messageQueue.path).toBe(join(root, 'adopted', 'global-messages.ndjson'))
    const authority = join(root, 'authority', 'global-messages.ndjson')
    vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', authority)
    expect(defaultAgentMuxMessageQueuePath(join(root, 'adopted', 'sessions.json'))).toBe(authority)
    expect(terminalEnvironment({ AGENTMUX_MESSAGE_QUEUE_PATH: authority }, join(root, 'other', 'sessions.json'))
      .AGENTMUX_MESSAGE_QUEUE_PATH).toBe(authority)
    expect(() => defaultAgentMuxMessageQueuePath(null, 'relative.ndjson')).toThrow()
  })
})

type CliReceipt = { ok: boolean; operation: string; result?: AgentMuxDeliveryBatch & {
  acknowledgedMessageIds?: string[]; nextGeneration?: number
}; error?: { code: string } }

function gone(child: ChildProcess): boolean { return child.exitCode !== null || child.signalCode !== null }

async function waitFor<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await new Promise((done) => setTimeout(done, 20))
  }
  throw new Error(`Private fixture timed out: ${label}`)
}

async function stopChild(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
  if (gone(child)) return
  if (!child.pid) throw new Error('Private child has no owned PID.')
  process.kill(-child.pid, signal)
  const deadline = Date.now() + 3_000
  while (!gone(child) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10))
  if (!gone(child)) {
    process.kill(-child.pid, 'SIGKILL')
    await waitFor(async () => gone(child) ? true : undefined, 'owned child exit')
  }
  expect(gone(child)).toBe(true)
}

function pidGone(pid: number): boolean {
  try { process.kill(pid, 0); return false } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
    throw error
  }
}

describe('actual built agentmux deliveries CLI', () => {
  it('replays exact recipient batches after consumer SIGKILL, independently ACKs and keeps healthy Agent input usable', async () => {
    const root = await privateRoot()
    const runtime = join(root, 'runtime')
    const home = join(root, 'codex-home')
    const captures = join(root, 'captures')
    await Promise.all([runtime, home, captures].map(async (path) => await mkdir(path, { recursive: true, mode: 0o700 })))
    const queuePath = join(root, 'global-messages.ndjson')
    const storePath = join(root, 'sessions.json')
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, CODEX_HOME: home, AGENTMUX_RUNTIME_DIRECTORY: runtime,
      AGENTMUX_AGENT_SESSION_STORE: storePath, AGENTMUX_MESSAGE_QUEUE_PATH: queuePath
    }
    for (const [key, value] of Object.entries(env)) if (value !== undefined) vi.stubEnv(key, value)
    const daemonPath = fileURLToPath(new URL('../vendor/ctxmux/darwin-arm64/bin/ctxmuxd', import.meta.url))
    const daemon = spawn(daemonPath, ['--socket', join(runtime, 'ctxmux.sock'), '--state-dir', join(runtime, 'state'), '--readiness-fd', '3'], {
      detached: true, stdio: ['ignore', 'ignore', 'pipe', 'pipe'], env
    })
    let readiness = ''
    daemon.stdio[3]!.on('data', (chunk: Buffer) => { readiness += chunk.toString() })
    // Cleanup order: client/Run owner first, exact private daemon last, files only after both settle.
    cleanups.push(async () => await stopChild(daemon))
    await waitFor(async () => {
      if (gone(daemon)) throw new Error('Private daemon exited before readiness.')
      return readiness.includes('\n') && (await stat(join(runtime, 'ctxmux.sock'))).isSocket() ? true : undefined
    }, 'private daemon readiness')
    const script = join(root, 'synthetic-codex.mjs')
    const syntheticExecutor = fileURLToPath(new URL('./fixtures/fake-codex-cli.mjs', import.meta.url))
    // The established synthetic executor implements Hook/native-handle/TTY resume without a model.
    // agentmux, Core, the daemon, hooks, Session persistence and process replacement are real.
    await writeFile(script, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nif (process.argv.includes('--version')) { process.stdout.write('synthetic codex fixture 1\\n'); process.exit(0); }\nwriteFileSync(join(process.env.AMUX_TEST_CAPTURE, process.env.AGENTMUX_AGENT_SESSION_ID + '.json'), JSON.stringify({ pid: process.pid, capability: process.env.AGENTMUX_AGENT_CAPABILITY, queuePath: process.env.AGENTMUX_MESSAGE_QUEUE_PATH, storePath: process.env.AGENTMUX_AGENT_SESSION_STORE }), { mode: 0o600 });\nawait import(${JSON.stringify(syntheticExecutor)});\n`)
    await chmod(script, 0o755)
    const hold = join(root, 'hold-cli.mjs')
    // The import only keeps the real CLI process alive after its real receipt so SIGKILL can interrupt it.
    await writeFile(hold, 'setInterval(() => {}, 1000)\n')
    const store = new AgentMuxFileAgentSessionStore(storePath)
    const client = new AgentMuxClient({ store })
    const sessions: Array<{ agentSessionId: string; run: { runId: string } }> = []
    const ownedAgentPids = new Set<number>()
    cleanups.push(async () => {
      const results = await Promise.allSettled(sessions.map(async (session) => {
        const current = client.agentSessions().find((item) => item.agentSessionId === session.agentSessionId)
        if (current) await client.stopAgent(current.agentSessionId, current.run)
      }))
      await client.dispose()
      for (const pid of ownedAgentPids) await waitFor(async () => pidGone(pid) ? true : undefined, 'owned Agent PID gone')
      const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
      if (failures.length > 0) throw new AggregateError(failures, 'Private Agent Run cleanup failed.')
    })
    await client.connect()
    for (const agentSessionId of ['reader-one', 'reader-two', 'reader-three']) {
      sessions.push(await client.createAgent({ agentSessionId, providerId: 'codex', executorId: 'codex',
        commandOverride: script, workspacePath: root,
        injectAgentMuxGuide: false, env: { ...env, AMUX_TEST_CAPTURE: captures } as Record<string, string> }))
    }
    const credentials = new Map<string, { pid: number; capability: string; queuePath: string; storePath: string }>()
    for (const session of sessions) {
      const value = await waitFor(async () => {
        try { return JSON.parse(await readFile(join(captures, `${session.agentSessionId}.json`), 'utf8')) } catch { return undefined }
      }, 'private issued capability')
      credentials.set(session.agentSessionId, value)
      ownedAgentPids.add(value.pid)
      expect(value.queuePath).toBe(queuePath)
      expect(value.storePath).toBe(storePath)
    }
    const queue = new DurableAgentMuxMessageQueue(queuePath)
    await queue.append(envelope('one'))
    await queue.append(envelope('other', 'reader-two'))
    await queue.append(envelope('other-third', 'reader-three'))
    await queue.append(envelope('two'))
    await queue.recordDelivery('one', 'failed', 200, 'Synthetic refusal')
    const deliveryBefore = await queue.listAfter()
    const statusBefore = await client.statusAgent('reader-one')
    const cli = fileURLToPath(new URL('../dist/agentmux.js', import.meta.url))
    const invoke = async (agentSessionId: string, args: string[], keepAlive = false, capability = credentials.get(agentSessionId)!.capability) => {
      const child = spawn(process.execPath, [...(keepAlive ? ['--import', hold] : []), cli, 'deliveries', ...args], {
        detached: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: root,
        env: { ...env, AGENTMUX_ENV: '1', AGENTMUX_AGENT_SESSION_ID: agentSessionId, AGENTMUX_AGENT_CAPABILITY: capability }
      })
      cleanups.push(async () => await stopChild(child))
      let stdout = ''
      let stderr = ''
      child.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
      const receipt = await waitFor(async () => {
        const line = `${stdout}\n${stderr}`.split('\n').find((value) => value.trim().startsWith('{'))
        if (line) return JSON.parse(line) as CliReceipt
        if (gone(child)) throw new Error('Actual CLI exited without a JSON receipt.')
        return undefined
      }, 'actual deliveries receipt')
      if (!keepAlive) await waitFor(async () => gone(child) ? true : undefined, 'actual CLI exit')
      expect(`${stdout}\n${stderr}`.includes(capability)).toBe(false)
      return { child, receipt }
    }
    const interrupted = await invoke('reader-one', ['check', '--limit', '1'], true)
    expect(interrupted.receipt.ok).toBe(true)
    expect(interrupted.receipt.operation).toBe('deliveries.check')
    const first = interrupted.receipt.result!
    expect(first.messages.map((item) => item.envelope.messageId)).toEqual(['one'])
    expect(first.consumerId).toBe('reader-one')
    expect(first.readerRun).toEqual(sessions[0]!.run)
    await stopChild(interrupted.child, 'SIGKILL')
    expect(interrupted.child.signalCode).toBe('SIGKILL')
    await queue.append(envelope('three'))
    const replay = await invoke('reader-one', ['check', '--limit', '100'])
    expect(replay.receipt.result).toEqual(first)
    const other = await invoke('reader-two', ['check', '--limit', '100'])
    expect(other.receipt.result!.messages.map((item) => item.envelope.messageId)).toEqual(['other'])
    const third = await invoke('reader-three', ['check', '--limit', '100'])
    expect(third.receipt.result!.messages.map((item) => item.envelope.messageId)).toEqual(['other-third'])
    const spoof = await invoke('reader-two', ['check', '--limit', '1'], false, credentials.get('reader-one')!.capability)
    expect(spoof.receipt).toMatchObject({ ok: false, error: { code: 'AGENT_CAPABILITY_INVALID' } })
    const stale = await invoke('reader-one', ['ack', '--generation', '999', '--reader-run', first.readerRun.runId])
    expect(stale.receipt).toMatchObject({ ok: false, error: { code: 'AGENT_DELIVERY_GENERATION_STALE' } })
    const ack = await invoke('reader-one', ['ack', '--generation', String(first.generation), '--reader-run', first.readerRun.runId])
    expect(ack.receipt).toMatchObject({ ok: true, operation: 'deliveries.ack', result: { acknowledgedMessageIds: ['one'], nextGeneration: 2 } })
    const next = await invoke('reader-one', ['check', '--limit', '100'])
    expect(next.receipt.result!.messages.map((item) => item.envelope.messageId)).toEqual(['two', 'three'])
    expect((await invoke('reader-two', ['check', '--limit', '1'])).receipt.result).toEqual(other.receipt.result)
    expect((await invoke('reader-three', ['check', '--limit', '1'])).receipt.result).toEqual(third.receipt.result)
    expect((await queue.listAfter()).slice(0, deliveryBefore.length)).toEqual(deliveryBefore)
    const after = await client.statusAgent('reader-one')
    expect(after.run.pid).toBe(statusBefore.run.pid)
    expect(after.run.acceptedInputBytes).toBe(statusBefore.run.acceptedInputBytes)
    expect(after.run.state).toBe('running')
    await client.submitAgentPrompt({ agentSessionId: 'reader-one', expectedRun: sessions[0]!.run,
      operationId: 'healthy-typed-input', prompt: 'Synthetic input remains usable' })
    expect((await client.statusAgent('reader-one')).run.acceptedInputBytes).toBeGreaterThan(after.run.acceptedInputBytes)
    const oldCapability = credentials.get('reader-one')!.capability
    const oldRun = sessions[0]!.run
    // Interrupt only the PID issued by our private daemon and captured by our own executor.
    // This simulates process loss; public stopAgent would intentionally retire the Session.
    expect(statusBefore.run.pid).toBe(credentials.get('reader-one')!.pid)
    process.kill(statusBefore.run.pid!, 'SIGTERM')
    await waitFor(async () => (await client.statusAgent('reader-one')).run.state === 'exited' ? true : undefined,
      'private original Run exit without Session retirement')
    sessions[0] = await client.resumeAgent({ agentSessionId: 'reader-one', operationId: 'synthetic-reader-resume',
      prompt: 'Synthetic resume without a model', commandOverride: script,
      env: { ...env, AMUX_TEST_CAPTURE: captures } as Record<string, string> })
    expect(sessions[0]!.run).not.toEqual(oldRun)
    const newCredential = await waitFor(async () => {
      const value = JSON.parse(await readFile(join(captures, 'reader-one.json'), 'utf8'))
      return value.capability !== oldCapability ? value : undefined
    }, 'replacement issued capability')
    credentials.set('reader-one', newCredential)
    ownedAgentPids.add(newCredential.pid)
    const takeover = await invoke('reader-one', ['check', '--limit', '1'])
    expect(takeover.receipt.result!.readerRun).toEqual(sessions[0]!.run)
    expect(takeover.receipt.result!.generation).toBe(next.receipt.result!.generation + 1)
    expect(takeover.receipt.result!.messages).toEqual(next.receipt.result!.messages)
    expect((await invoke('reader-one', ['check', '--limit', '1'], false, oldCapability)).receipt)
      .toMatchObject({ ok: false, error: { code: 'AGENT_CAPABILITY_INVALID' } })
    expect((await invoke('reader-one', ['ack', '--generation', String(next.receipt.result!.generation), '--reader-run', oldRun.runId])).receipt)
      .toMatchObject({ ok: false, error: { code: 'MESSAGE_ACK_GENERATION_STALE' } })
    const takeoverAck = await invoke('reader-one', ['ack', '--generation', String(takeover.receipt.result!.generation), '--reader-run', sessions[0]!.run.runId])
    expect(takeoverAck.receipt).toMatchObject({ ok: true, result: { acknowledgedMessageIds: ['two', 'three'] } })
    expect((await invoke('reader-one', ['check', '--limit', '1'])).receipt.result!.messages).toEqual([])
    expect((await loadAgentSessions(store)).map((session) => session.agentSessionId).sort()).toEqual(['reader-one', 'reader-three', 'reader-two'])
  }, 60_000)
})
