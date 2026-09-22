import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  defaultAgentMuxHookPort, defaultAgentMuxRuntimeDirectory, defaultCtxmuxStateDirectory,
  type AgentMuxStoredAgentSession, type AgentMuxClient
} from '../dist/index.js'
import { assertExitedAdmission, ObservedPromptStore, prepareRealCodexScope, RealCodexScope } from './helpers/real-codex-fixture.js'

const originalEnv = { ...process.env }
const roots: string[] = []
afterEach(async () => {
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  for (const root of roots.splice(0)) await rm(root, { recursive: true })
})
async function temporary(name: string) {
  const root = await mkdtemp(join(tmpdir(), name)); roots.push(root); return root
}
async function seed() {
  const root = await temporary('amx-fixture-seed-')
  await writeFile(join(root, 'auth.json'), '{"testOnly":"opaque"}', { mode: 0o600 })
  await writeFile(join(root, 'config.toml'), 'features.hooks=true\n')
  process.env.CODEX_HOME = root
  return root
}
async function scope() {
  await seed()
  const value = await prepareRealCodexScope(); roots.push(value.root); return value
}
function forget(root: string) { roots.splice(roots.indexOf(root), 1) }
function session(): AgentMuxStoredAgentSession {
  return {
    kind: 'agent', agentSessionId: 'fixture-session', providerId: 'codex', executorId: 'codex', hostId: 'local',
    workspacePath: '/tmp/fixture-workspace', run: { runId: 'fixture-run' }, retiredRuns: [],
    hookBindingId: 'fixture-binding', hookToken: 'fixture-token', createdAt: 1, updatedAt: 2,
    terminalPromptSubmission: {
      run: { runId: 'fixture-run' }, submissionId: 'fixture-submission', promptDigest: 'fixture-digest', outputCursorBytes: 12,
      readinessEvidence: { source: 'native-stop', id: 'stop-1', outputCursorBytes: 8, readyThroughByte: 12 },
      payload: { operationId: 'payload-1', inputByteRange: { startByte: 5, endByte: 10 }, acknowledged: true },
      submit: { operationId: 'submit-1', inputByteRange: { startByte: 10, endByte: 11 }, acknowledged: true }
    },
    promptCompletionAdmission: {
      submissionId: 'fixture-submission', operationId: 'payload-1', startByte: 5, endByte: 11, acknowledged: true, notApplied: false,
      intent: { run: { runId: 'fixture-run' }, ownerInstanceId: 'fixture-owner', prompt: '/exit',
        plan: { kind: 'render-then-submit', payload: '/exit', renderedText: '/exit', submit: '\r' } }
    }
  }
}
function child() {
  const value = new EventEmitter() as ChildProcess
  Object.assign(value, { exitCode: null, signalCode: null })
  value.kill = vi.fn(() => { Object.assign(value, { signalCode: 'SIGINT' }); value.emit('close', null, 'SIGINT'); return true })
  return value
}
function client(workspacePath: string) {
  let running = true
  const value = {
    connect: vi.fn(async () => {}), dispose: vi.fn(async () => {}),
    agentSessions: vi.fn(() => [{ agentSessionId: 'owned', workspacePath, run: { runId: 'owned-run' } }]),
    statusAgent: vi.fn(async () => ({ run: { runId: 'owned-run', state: running ? 'running' : 'exited' } })),
    stopAgent: vi.fn(async () => { running = false }),
    listRuns: vi.fn(async () => running ? [{ runId: 'owned-run', state: 'running' }] : [])
  }
  return value as unknown as Pick<AgentMuxClient, 'connect' | 'dispose' | 'agentSessions' | 'statusAgent' | 'stopAgent' | 'listRuns'> & typeof value
}

describe('real Codex fixture persistence observation', () => {
  it('records immutable witnesses only after successful real FileStore CAS; rejected and aborted CAS do not record', async () => {
    const root = await temporary('amx-fixture-store-'); const store = new ObservedPromptStore(join(root, 'sessions.json'))
    const next = session()
    await store.compareAndSwap(null, next)
    expect(await store.load()).toHaveLength(1)
    next.terminalPromptSubmission!.submit.operationId = 'mutated-caller-value'
    expect(store.confirmedSubmission(next.agentSessionId, next.run, 'fixture-submission').submit.operationId).toBe('submit-1')
    expect(Object.isFrozen(store.committed[0]?.terminalPromptSubmission?.payload)).toBe(true)
    await expect(store.compareAndSwap(null, session())).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
    const controller = new AbortController(); controller.abort(new Error('abort fixture CAS'))
    await expect(store.compareAndSwap(session(), null, controller.signal)).rejects.toThrow('abort fixture CAS')
    expect(store.committed).toHaveLength(1)
    expect(store.committed[0]?.terminalPromptSubmission?.submit.operationId).toBe('submit-1')
  })

  it('requires a nonempty semantic witness, accepts repeated equal successful CAS, and rejects contradictory phase facts', async () => {
    const root = await temporary('amx-fixture-repeated-'); const store = new ObservedPromptStore(join(root, 'sessions.json'))
    let current = session()
    expect(() => store.confirmedSubmission(current.agentSessionId, current.run, 'fixture-submission')).toThrow('No successfully persisted')
    await store.compareAndSwap(null, current)
    current = (await store.load())[0] as AgentMuxStoredAgentSession
    await store.compareAndSwap(current, { ...current, updatedAt: 3 })
    expect(store.committed).toHaveLength(2)
    expect(store.confirmedSubmission(current.agentSessionId, current.run, 'fixture-submission').payload.inputByteRange).toEqual({ startByte: 5, endByte: 10 })
    const changed = structuredClone(current); changed.terminalPromptSubmission!.submit.operationId = 'different-operation'
    await store.compareAndSwap((await store.load())[0] as AgentMuxStoredAgentSession, changed)
    expect(() => store.confirmedSubmission(current.agentSessionId, current.run, 'fixture-submission')).toThrow('Conflicting successfully persisted')
  })

  it('reads terminal admission from the real durable Store after transient readiness/submission clear', async () => {
    const root = await temporary('amx-fixture-ended-'); const store = new ObservedPromptStore(join(root, 'sessions.json'))
    let current = session(); await store.compareAndSwap(null, current)
    current = (await store.load())[0] as AgentMuxStoredAgentSession
    const ended = structuredClone(current); delete ended.terminalPromptSubmission
    await store.compareAndSwap(current, ended)
    const owner = new RealCodexScope(root, { ...process.env })
    const witness = await assertExitedAdmission(owner, store, current.agentSessionId, current.run, 'fixture-submission', current.promptCompletionAdmission!.intent!.plan, 5)
    expect(witness.readinessEvidence).toEqual({ source: 'native-stop', id: 'stop-1', outputCursorBytes: 8, readyThroughByte: 12 })
    const invalid = structuredClone(ended); invalid.promptCompletionAdmission!.notApplied = true
    await store.compareAndSwap((await store.load())[0] as AgentMuxStoredAgentSession, invalid)
    await expect(assertExitedAdmission(owner, store, current.agentSessionId, current.run, 'fixture-submission', current.promptCompletionAdmission!.intent!.plan, 5)).rejects.toThrow()
    await store.compareAndSwap((await store.load())[0] as AgentMuxStoredAgentSession, null)
    await expect(assertExitedAdmission(owner, store, current.agentSessionId, current.run, 'fixture-submission', current.promptCompletionAdmission!.intent!.plan, 5)).rejects.toThrow('Exited Session Store is empty')
  })
})

describe('real Codex fixture isolation and cleanup', () => {
  it('rejects missing or default user seed before creating any scope', async () => {
    const outside = await temporary('amx-fixture-default-home-')
    await mkdir(join(outside, '.codex'))
    await writeFile(join(outside, '.codex', 'auth.json'), '{"testOnly":"opaque"}')
    await writeFile(join(outside, '.codex', 'config.toml'), 'features.hooks=true\n')
    process.env.HOME = outside
    const registered: RealCodexScope[] = []
    const register = (owner: RealCodexScope) => { registered.push(owner); roots.push(owner.root) }
    delete process.env.CODEX_HOME
    await expect(prepareRealCodexScope(register)).rejects.toThrow('explicit isolated CODEX_HOME seed')
    process.env.CODEX_HOME = join(homedir(), '.codex')
    await expect(prepareRealCodexScope(register)).rejects.toThrow('explicit isolated CODEX_HOME seed')
    expect(registered).toEqual([])
    expect(process.env.AGENTMUX_RUNTIME_DIRECTORY).toBe(originalEnv.AGENTMUX_RUNTIME_DIRECTORY)
  })

  it('pins actual public defaults, private auth mode and an empty HOME; normal cleanup restores the original env', async () => {
    const source = await seed(); const prior = { ...process.env }
    const owner = await prepareRealCodexScope(); roots.push(owner.root)
    expect(homedir()).toBe(join(owner.root, 'home'))
    expect(defaultAgentMuxRuntimeDirectory()).toBe(join(owner.root, 'runtime'))
    expect(defaultCtxmuxStateDirectory()).toBe(join(owner.root, 'durable', 'ctxmux'))
    expect(defaultAgentMuxHookPort()).toBeGreaterThanOrEqual(40_000)
    expect(process.env.AGENTMUX_MESSAGE_QUEUE_PATH).toBe(join(owner.root, 'global-messages.ndjson'))
    expect((await stat(join(owner.root, 'codex-home', 'auth.json'))).mode & 0o777).toBe(0o600)
    expect(await readFile(join(owner.root, 'codex-home', 'auth.json'), 'utf8')).toBe(await readFile(join(source, 'auth.json'), 'utf8'))
    expect(await stat(join(owner.root, 'home', '.codex')).catch(error => error.code)).toBe('ENOENT')
    await owner.cleanup(); forget(owner.root)
    expect(process.env).toEqual(prior)
  })

  it('owns a client before rejected connect and preserves the scope if no public Run fact is readable', async () => {
    const owner = await scope(); const owned = client(join(owner.root, 'workspace'))
    owned.connect.mockRejectedValue(new Error('connect rejected'))
    owned.statusAgent.mockRejectedValue(new Error('not connected'))
    await expect(owner.connect(owned)).rejects.toThrow('connect rejected')
    expect([...owner.clients]).toEqual([owned])
    await expect(owner.cleanup()).rejects.toThrow('Private cleanup failed')
    expect(owned.dispose).toHaveBeenCalledTimes(1)
    expect(await stat(owner.root)).toBeDefined()
    expect(process.env.HOME).toBe(join(owner.root, 'home'))
  })

  it('keeps defaults pinned while late connect actually reads paths and writes privately; bounded failure does not stop Native', async () => {
    const outside = await temporary('amx-fixture-outside-'); await mkdir(join(outside, 'home'))
    process.env.HOME = join(outside, 'home'); process.env.AGENTMUX_RUNTIME_DIRECTORY = join(outside, 'runtime')
    const owner = await scope(); const native = child(); owner.ownChild(native)
    const owned = client(join(owner.root, 'workspace'))
    let release!: () => void; const entered = new Promise<void>(done => { release = done })
    const facts: unknown[] = []
    owned.connect.mockImplementation(async () => {
      await entered
      facts.push({ home: homedir(), runtime: defaultAgentMuxRuntimeDirectory(), state: defaultCtxmuxStateDirectory(), hook: defaultAgentMuxHookPort() })
      await writeFile(join(homedir(), 'late-connect-sentinel'), '')
    })
    const connecting = owner.connect(owned); const rejection = expect(connecting).rejects.toThrow('after scope closure')
    await Promise.resolve(); await Promise.resolve()
    await expect(owner.cleanup(15)).rejects.toThrow('did not settle')
    expect(native.kill).not.toHaveBeenCalled()
    release(); await rejection
    expect(facts).toEqual([{ home: join(owner.root, 'home'), runtime: join(owner.root, 'runtime'), state: join(owner.root, 'durable', 'ctxmux'), hook: defaultAgentMuxHookPort() }])
    expect(await stat(join(owner.root, 'home', 'late-connect-sentinel'))).toBeDefined()
    expect(await stat(join(outside, 'home', 'late-connect-sentinel')).catch(error => error.code)).toBe('ENOENT')
    await owner.cleanup(); forget(owner.root)
    expect(owned.dispose).toHaveBeenCalledTimes(1)
    expect(native.kill).toHaveBeenCalledExactlyOnceWith('SIGINT')
  })

  it('stops exact owned Run via public client before disposing/normal SIGINT, and never signals on cleanup error', async () => {
    const owner = await scope(); const owned = client(join(owner.root, 'workspace')); const native = child(); owner.ownChild(native)
    await owner.connect(owned)
    owned.stopAgent.mockRejectedValueOnce(new Error('stop uncertain'))
    await expect(owner.cleanup()).rejects.toThrow('Private cleanup failed')
    expect(owned.stopAgent).toHaveBeenCalledExactlyOnceWith('owned', { runId: 'owned-run' })
    expect(native.kill).not.toHaveBeenCalled()
    expect(await stat(join(owner.root, 'codex-home', 'auth.json'))).toBeDefined()
    expect(process.env.HOME).toBe(join(owner.root, 'home'))
  })

  it('only signals its child after exact public stop, no running Run and every client dispose', async () => {
    const owner = await scope(); const owned = client(join(owner.root, 'workspace')); const native = child(); owner.ownChild(native)
    await owner.connect(owned)
    const stop = owned.stopAgent; const dispose = owned.dispose
    const order: string[] = []
    owned.stopAgent.mockImplementation(async () => { order.push('stop'); owned.listRuns.mockResolvedValue([]) })
    owned.dispose.mockImplementation(async () => { order.push('dispose') })
    native.kill = vi.fn(() => { order.push('SIGINT'); native.emit('close', 0, null); return true })
    await owner.cleanup(); forget(owner.root)
    expect(order).toEqual(['stop', 'dispose', 'SIGINT'])
    expect(stop).toHaveBeenCalledExactlyOnceWith('owned', { runId: 'owned-run' })
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(native.kill).toHaveBeenCalledExactlyOnceWith('SIGINT')
    expect(await stat(owner.root).catch(error => error.code)).toBe('ENOENT')
  })

  it('keeps root and env when owned child does not close; sends no stronger signal', async () => {
    const owner = await scope(); const native = child(); native.kill = vi.fn(() => true); owner.ownChild(native)
    await expect(owner.cleanup(15)).rejects.toThrow('did not settle')
    expect(native.kill).toHaveBeenCalledExactlyOnceWith('SIGINT')
    expect(await stat(owner.root)).toBeDefined()
    expect(process.env.HOME).toBe(join(owner.root, 'home'))
    expect(await stat(join(owner.root, 'codex-home', 'auth.json')).catch(error => error.code)).toBe('ENOENT')
    native.emit('close', 0, null)
  })
})
