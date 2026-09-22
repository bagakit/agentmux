import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { chmod, copyFile, lstat, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { isDeepStrictEqual } from 'node:util'
import {
  AgentMuxClient, AgentMuxFileAgentSessionStore,
  defaultAgentMuxHookPort, defaultAgentMuxRuntimeDirectory, defaultCtxmuxStateDirectory,
  type AgentMuxStoredAgentSession, type AgentMuxRunRef
} from '../../dist/index.js'

const delay = async (ms: number): Promise<void> => await new Promise(done => setTimeout(done, ms))
type Client = Pick<AgentMuxClient, 'connect' | 'dispose' | 'agentSessions' | 'statusAgent' | 'stopAgent' | 'listRuns'>

/** Observes successful real persistence; does not alter the Store or publish another event. */
export class ObservedPromptStore extends AgentMuxFileAgentSessionStore {
  readonly committed: Array<AgentMuxStoredAgentSession | null> = []
  override async compareAndSwap(expected: AgentMuxStoredAgentSession | null, next: AgentMuxStoredAgentSession | null, signal?: AbortSignal): Promise<void> {
    const snapshot = structuredClone(next)
    await super.compareAndSwap(expected, next, signal)
    this.committed.push(freeze(snapshot))
  }

  confirmedSubmission(id: string, run: AgentMuxRunRef, submissionId: string) {
    const candidates = this.committed.flatMap(session => {
      const state = session?.terminalPromptSubmission
      return session?.agentSessionId === id && session.run.runId === run.runId && state?.submissionId === submissionId &&
        state.payload.acknowledged && state.submit.acknowledged
        ? [{ run: state.run, submissionId: state.submissionId, readinessEvidence: state.readinessEvidence, payload: state.payload, submit: state.submit }]
        : []
    })
    assert(candidates.length > 0, 'No successfully persisted two-phase receipt.')
    const witness = candidates[0]!
    assert(candidates.every(value => isDeepStrictEqual(value, witness)), 'Conflicting successfully persisted receipts.')
    assert.equal(witness.run.runId, run.runId)
    assert(witness.payload.operationId.length > 0 && witness.submit.operationId.length > 0)
    assert.notEqual(witness.payload.operationId, witness.submit.operationId)
    return witness
  }
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

export async function hookVacant(): Promise<void> {
  await new Promise<void>((done, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(defaultAgentMuxHookPort(), '127.0.0.1', () => server.close(error => error ? reject(error) : done()))
  })
}

/** One test owns one child handle and pins its defaults until every in-flight operation settles. */
export class RealCodexScope {
  readonly clients = new Set<Client>()
  readonly inflight = new Set<Promise<unknown>>()
  closed = false
  child: ChildProcess | undefined
  private childClosed: Promise<unknown> | undefined
  private runsSettled = true // A fresh, not-yet-connected scope has never launched a Run.
  constructor(readonly root: string, private readonly originalEnv: NodeJS.ProcessEnv) {}

  assertOpen(): void { assert(!this.closed, 'Private lifecycle scope is closed.') }

  async perform<T>(operation: () => Promise<T>): Promise<T> {
    this.assertOpen()
    const pending = Promise.resolve().then(() => { this.assertOpen(); return operation() })
    this.inflight.add(pending)
    void pending.then(() => this.inflight.delete(pending), () => this.inflight.delete(pending))
    return await pending
  }

  async connect<T extends Client>(client: T): Promise<T> {
    this.assertOpen()
    this.clients.add(client)
    this.runsSettled = false
    await this.perform(async () => {
      await client.connect()
      if (this.closed) throw new Error('Private connect completed after scope closure.')
    })
    return client
  }

  async dispose(client: Client): Promise<void> {
    await this.perform(async () => {
      this.runsSettled = !(await client.listRuns()).some(run => run.state === 'running')
      await client.dispose(); this.clients.delete(client)
    })
  }

  async startNative(executable: string): Promise<void> {
    await this.perform(async () => {
      await hookVacant()
      const socket = join(defaultAgentMuxRuntimeDirectory(), 'ctxmux.sock')
      const absent = await lstat(socket).then(() => false, error => { if (error.code === 'ENOENT') return true; throw error })
      assert(absent, 'Private Runtime socket already exists.')
      this.assertOpen()
      const child = spawn(executable, ['--socket', socket, '--state-dir', defaultCtxmuxStateDirectory(), '--readiness-fd', '3'],
        { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] })
      this.ownChild(child)
      let timer: NodeJS.Timeout | undefined
      try {
        await Promise.race([once(child.stdio[3]!, 'data'), this.childClosed!.then(() => { throw new Error('Private Native exited before readiness.') }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Private Native readiness timed out.')), 5_000) })])
      } finally { clearTimeout(timer) }
    })
  }

  ownChild(child: ChildProcess): void {
    assert(!this.child, 'Private scope already owns a Native child.')
    this.child = child
    this.childClosed = once(child, 'close')
    // Keep rejection handled even when spawn fails before the readiness wait starts.
    void this.childClosed.catch(() => {})
  }

  async cleanup(timeoutMs = 25_000): Promise<void> {
    this.closed = true
    const deadline = Date.now() + timeoutMs
    const bounded = async <T>(operation: Promise<T>): Promise<T> => {
      this.inflight.add(operation)
      void operation.then(() => this.inflight.delete(operation), () => this.inflight.delete(operation))
      let timer: NodeJS.Timeout | undefined
      try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Private cleanup did not settle; preserved ${this.root}`)), Math.max(1, deadline - Date.now())) })]) }
      finally { clearTimeout(timer) }
    }
    // If this rejects, leave env, Native, auth and evidence pinned: callbacks still own them.
    await bounded(Promise.allSettled([...this.inflight]))
    const errors: unknown[] = []
    for (const client of this.clients) {
      try {
        for (const session of client.agentSessions()) {
          assert.equal(session.workspacePath, join(this.root, 'workspace'))
          const status = await bounded(client.statusAgent(session.agentSessionId))
          assert.equal(status.run.runId, session.run.runId)
          await bounded(client.stopAgent(session.agentSessionId, session.run))
        }
        const remaining = await bounded(client.listRuns())
        assert(!remaining.some(run => run.state === 'running'), 'Private Runtime still has a running Run.')
        this.runsSettled = true
      } catch (error) { errors.push(error) }
      try { await bounded(client.dispose()); this.clients.delete(client) } catch (error) { errors.push(error) }
    }
    // Credentials are no longer read only after all client work has actually completed.
    if (errors.length) throw new AggregateError(errors, `Private cleanup failed; preserved ${this.root}`)
    assert(this.runsSettled, `No connected client confirmed private Run cleanup; preserved ${this.root}`)
    if (this.clients.size === 0) await rm(join(this.root, 'codex-home', 'auth.json')).catch(error => { if (error.code !== 'ENOENT') throw error })
    await hookVacant()
    if (this.child) {
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGINT')
      await bounded(this.childClosed!)
    }
    await rm(this.root, { recursive: true })
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, this.originalEnv)
  }
}

export async function prepareRealCodexScope(register?: (scope: RealCodexScope) => void): Promise<RealCodexScope> {
  const originalEnv = { ...process.env }
  const seed = process.env.CODEX_HOME?.trim()
  assert(seed && resolve(seed) !== resolve(homedir(), '.codex'), 'Real lifecycle requires an explicit isolated CODEX_HOME seed before any Native or Agent launch.')
  for (const file of ['auth.json', 'config.toml']) assert((await lstat(join(seed, file))).isFile(), `Private seed requires ${file}.`)
  const root = await mkdtemp(join(tmpdir(), 'amx-real-codex-'))
  const scope = new RealCodexScope(root, originalEnv)
  const retained = ['PATH', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_CTYPE', 'LC_ALL', 'TERM']
  for (const key of Object.keys(process.env)) if (!retained.includes(key)) delete process.env[key]
  Object.assign(process.env, { HOME: join(root, 'home'), CODEX_HOME: join(root, 'codex-home'), TMPDIR: join(root, 'tmp'),
    AGENTMUX_RUNTIME_DIRECTORY: join(root, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(root, 'durable'),
    AGENTMUX_AGENT_SESSION_STORE: join(root, 'agent-sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(root, 'global-messages.ndjson') })
  try {
    register?.(scope)
    await scope.perform(async () => {
      await chmod(root, 0o700)
      for (const name of ['home', 'codex-home', 'runtime', 'durable', 'workspace', 'tmp']) await mkdir(join(root, name), { mode: 0o700 })
      for (const file of ['auth.json', 'config.toml']) { await copyFile(join(seed, file), join(root, 'codex-home', file)); await chmod(join(root, 'codex-home', file), 0o600) }
    })
    assert.equal(defaultCtxmuxStateDirectory(), join(root, 'durable', 'ctxmux'))
    return scope
  } catch (error) {
    if (!register) await scope.cleanup()
    throw error
  }
}

export const privateCodexConfigArgs = ['--config', 'cli_auth_credentials_store="file"', '--config', 'notify=[]',
  '--config', 'features.plugins=false', '--config', 'features.plugin_hooks=false', '--config', 'features.memories=false', '--config', 'features.chronicle=false']

export async function assertExitedAdmission(scope: RealCodexScope, store: ObservedPromptStore, id: string, run: AgentMuxRunRef, submissionId: string, plan: unknown, startByte: number) {
  const witness = store.confirmedSubmission(id, run, submissionId)
  assert.deepEqual(witness.payload.inputByteRange, { startByte, endByte: startByte + 5 })
  assert.deepEqual(witness.submit.inputByteRange, { startByte: startByte + 5, endByte: startByte + 6 })
  const deadline = Date.now() + 10_000
  for (;;) {
    scope.assertOpen()
    const values = await scope.perform(async () => await store.load())
    assert(values.length > 0, 'Exited Session Store is empty.')
    const matches = values.filter(value => (value as AgentMuxStoredAgentSession).agentSessionId === id) as AgentMuxStoredAgentSession[]
    assert.equal(matches.length, 1, 'Exited Session is not unique.')
    const session = matches[0]!
    assert.deepEqual(session.run, run)
    if (!session.terminalPromptReadiness && !session.terminalPromptSubmission) {
      const admission = session.promptCompletionAdmission
      assert(admission?.acknowledged && admission.notApplied === false)
      assert(admission.intent, 'Exited admission has no frozen intent.')
      assert.equal(admission.submissionId, submissionId)
      assert.equal(admission.operationId, witness.payload.operationId)
      assert.deepEqual(admission.intent.run, run)
      assert.deepEqual(admission.intent.plan, plan)
      assert.equal(admission.startByte, startByte)
      assert.equal(admission.endByte, startByte + 6)
      return witness
    }
    assert(Date.now() < deadline, 'Exited readiness/submission was not cleared.')
    await delay(20)
  }
}
