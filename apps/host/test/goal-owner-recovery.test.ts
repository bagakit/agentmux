import { afterEach, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { AgentMuxRpcService, observeAgent, type ContinuousProgressObservation } from '@agentmux/core'
import { ContinuousProgressLoopManager } from '../src/continuous-progress-loop-manager.js'
import { ContinuousProgressLoopStore } from '../src/continuous-progress-loop-store.js'
import { createHostGoals } from '../src/goals.js'
import { bundleGoalOwnerStoreReader } from './goal-owner-recovery-mutations.mjs'

const directoryDurability = vi.hoisted(() => ({ directory: '', file: '', failure: null as Error | null,
  fileSyncs: 0, directorySyncs: 0, confirmedDirectorySyncs: 0, directoryCloses: 0, renames: 0, events: [] as string[] }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args), path = String(args[0])
      const originalSync = handle.sync.bind(handle)
      if (directoryDurability.file && path.startsWith(directoryDurability.file + '.') && path.endsWith('.tmp')) handle.sync = async () => {
        await originalSync(); directoryDurability.fileSyncs++; directoryDurability.events.push('file-sync')
      }
      if (path === directoryDurability.directory && args[1] === 'r' && (await handle.stat()).isDirectory()) {
        const originalClose = handle.close.bind(handle)
        handle.sync = async () => {
          directoryDurability.directorySyncs++; directoryDurability.events.push('directory-sync')
          if (directoryDurability.failure) throw directoryDurability.failure
          await originalSync(); directoryDurability.confirmedDirectorySyncs++
        }
        handle.close = async () => { await originalClose(); directoryDurability.directoryCloses++; directoryDurability.events.push('directory-close') }
      }
      return handle
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      await actual.rename(...args)
      if (String(args[1]) === directoryDurability.file) { directoryDurability.renames++; directoryDurability.events.push('rename') }
    }
  }
})
const context = { principal: { kind: 'user' as const, id: 'original-user' } }
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  Object.assign(directoryDurability, { directory: '', file: '', failure: null, fileSyncs: 0, directorySyncs: 0, confirmedDirectorySyncs: 0, directoryCloses: 0, renames: 0, events: [] })
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
  if (process.env.AGENTMUX_GOAL_OWNER_RECOVERY_FACTS) await appendFile(process.env.AGENTMUX_GOAL_OWNER_RECOVERY_FACTS,
    JSON.stringify({ case: expect.getState().currentTestName, cleanup: 'confirmed', scope: 'Actual public Host progress owner and file Store; Native observation is a controlled port, no Native input submitted.' }) + '\n')
})
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes }); return { promise, resolve } }
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'goal-owner-recovery-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  return root
}
async function fixture() {
  const root = await directory()
  const target = { hostId: 'local', agentSessionId: 'original-session', providerId: 'codex', workspacePath: root }
  const subscriptions = new Set<unknown>()
  const submitAgentPrompt = vi.fn(async () => { throw new Error('Recovery of an arrangement must not send input.') })
  const statusAgent = vi.fn(async () => ({ session: { ...target, run: { runId: 'original-run' } },
    run: { acceptedInputBytes: 0 }, observation: observeAgent({ process: 'running', status: { state: 'done', source: 'native-hook', observedAt: 1 },
      timelineCapability: 'complete-events', awaitingRequest: false, terminalCapabilityUnverified: false }, 1) }))
  const runtime = { client: { statusAgent, submitAgentPrompt, onEvent: (listener: unknown) => { subscriptions.add(listener); return () => subscriptions.delete(listener) } },
    ownerIdentity: () => ({ ownerInstanceId: 'original-owner' }) }
  const owner = createHostGoals({ configurationPath: join(root, 'configuration.json'), projects: async () => [],
    runtime: () => runtime as never,
    coreCall: async () => { throw new Error('Arrangement recovery must not dispatch another Core operation.') } })
  cleanup.push(() => owner.dispose())
  const service = new AgentMuxRpcService({ coreClients: () => [], progress: owner.progress })
  return { root, owner, service, target, subscriptions, submitAgentPrompt, statusAgent }
}
async function independentlyReadLoops(root: string, readerTag: string) {
  const repository = resolve(import.meta.dirname, '../../..'), facts = process.env.AGENTMUX_GOAL_OWNER_RECOVERY_FACTS
  const base = resolve(repository, '.local/state/mobile-independent-host/review-remediation/goal-owner-recovery')
  await mkdir(base, { recursive: true })
  const directory = facts ? resolve(dirname(facts), basename(facts, '-facts.jsonl') + '-' + readerTag + '-reader') : await mkdtemp(join(base, readerTag + '-reader-'))
  const reader = await bundleGoalOwnerStoreReader(repository, directory)
  const { stdout } = await promisify(execFile)(process.execPath, [reader.file, root], { env: process.env, timeout: 20_000 })
  const reopened = JSON.parse(stdout)
  expect(reopened.pid).not.toBe(process.pid)
  if (facts) await appendFile(facts, JSON.stringify({ phase: 'independent-store-reader', readerTag, pid: reopened.pid, parentPid: process.pid,
    provenance: relative(repository, reader.provenance), provenanceSHA256: createHash('sha256').update(await readFile(reader.provenance)).digest('hex'),
    file: reader.record.file, bundleSHA256: reader.record.bundleSHA256 }) + '\n')
  return reopened.loops
}

it('public create retries the original paused record until its real file write is confirmed, then a new process reads that same loop', async () => {
  const f = await fixture()
  await f.owner.start()
  const originalSave = ContinuousProgressLoopStore.prototype.save
  const unavailable = new Error('Original loop write unavailable before persistence')
  let failing = true
  const saves = vi.spyOn(ContinuousProgressLoopStore.prototype, 'save').mockImplementation(function (this: ContinuousProgressLoopStore, loops) {
    return failing ? Promise.reject(unavailable) : originalSave.call(this, loops)
  })
  const input = { target: f.target, operationId: 'original-create', intervalMs: 60_000, prompt: 'Retain this exact work' }
  await expect(f.service.call('agent.progress.create', input, context)).rejects.toBe(unavailable)
  const first = (await f.service.call('agent.progress.list', { target: f.target }, context)).loops[0]!
  expect(first).toMatchObject({ status: 'paused', creationOperationId: input.operationId, prompt: input.prompt })
  expect(await ContinuousProgressLoopStore.forUserData(f.root).load()).toEqual([])
  await expect(f.service.call('agent.progress.create', input, context)).rejects.toBe(unavailable)
  expect(saves).toHaveBeenCalledTimes(2)
  expect(await ContinuousProgressLoopStore.forUserData(f.root).load()).toEqual([])
  await expect(f.service.call('agent.progress.create', { ...input, prompt: 'Different intent' }, context)).rejects.toMatchObject({ code: 'CONTROL_REQUEST_CONFLICT' })
  expect(saves).toHaveBeenCalledTimes(2)
  failing = false
  const result = await f.service.call('agent.progress.create', input, context)
  expect(result).toMatchObject({ diskDurability: 'confirmed', loop: { loopId: first.loopId, status: 'paused', creationOperationId: input.operationId, prompt: input.prompt } })
  expect(saves).toHaveBeenCalledTimes(3)
  // Reopen before owner disposal: its final flush cannot manufacture the ACK under test.
  expect(await ContinuousProgressLoopStore.forUserData(f.root).load()).toEqual([result.loop])
  expect(await independentlyReadLoops(f.root, 'before-write')).toEqual([result.loop])
  expect(f.statusAgent).toHaveBeenCalledTimes(1)
  expect(f.submitAgentPrompt).not.toHaveBeenCalled()
}, 30_000)

it('public create retains after-replace directory sync uncertainty for the same operation until real fsync confirms it', async () => {
  const f = await fixture()
  await f.owner.start()
  const input = { target: f.target, operationId: 'directory-sync-create', intervalMs: 60_000, prompt: 'Retain the first published work' }
  const failure = Object.assign(new Error('Original directory sync unavailable'), { code: 'EIO' })
  directoryDurability.directory = f.root; directoryDurability.file = join(f.root, 'continuous-progress-loops.json'); directoryDurability.failure = failure
  try {
    await expect(f.service.call('agent.progress.create', input, context)).rejects.toMatchObject({ code: 'EIO', phase: 'after-replace', cause: failure })
    const first = (await f.service.call('agent.progress.list', { target: f.target }, context)).loops[0]!
    expect(first).toMatchObject({ status: 'paused', creationOperationId: input.operationId, prompt: input.prompt })
    // The replacement is physically visible. That readback is not a directory durability ACK.
    expect(await ContinuousProgressLoopStore.forUserData(f.root).load()).toMatchObject([{ loopId: first.loopId, status: 'active', creationOperationId: input.operationId, prompt: input.prompt }])
    expect(directoryDurability.events).toEqual(['file-sync', 'rename', 'directory-sync', 'directory-close'])
    await expect(f.service.call('agent.progress.create', input, context)).rejects.toMatchObject({ code: 'EIO', phase: 'after-replace', cause: failure })
    expect(directoryDurability.directorySyncs).toBe(2); expect(directoryDurability.renames).toBe(2)
    expect(directoryDurability.confirmedDirectorySyncs).toBe(0); expect(directoryDurability.directoryCloses).toBe(2)
    expect(await ContinuousProgressLoopStore.forUserData(f.root).load()).toMatchObject([{ loopId: first.loopId, status: 'paused', creationOperationId: input.operationId }])
    directoryDurability.failure = null
    const confirmed = await f.service.call('agent.progress.create', input, context)
    expect(confirmed).toMatchObject({ diskDurability: 'confirmed', loop: { loopId: first.loopId, status: 'paused', creationOperationId: input.operationId, prompt: input.prompt } })
    expect(directoryDurability.fileSyncs).toBe(3); expect(directoryDurability.renames).toBe(3)
    expect(directoryDurability.directorySyncs).toBe(3); expect(directoryDurability.confirmedDirectorySyncs).toBe(1); expect(directoryDurability.directoryCloses).toBe(3)
    expect(await independentlyReadLoops(f.root, 'directory-sync')).toEqual([confirmed.loop])
    expect(f.statusAgent).toHaveBeenCalledTimes(1); expect(f.submitAgentPrompt).not.toHaveBeenCalled()
  } finally {
    const facts = process.env.AGENTMUX_GOAL_OWNER_RECOVERY_FACTS
    if (facts) await appendFile(facts, JSON.stringify({ phase: 'directory-durability', operationId: input.operationId,
      fileSyncs: directoryDurability.fileSyncs, renames: directoryDurability.renames, directorySyncs: directoryDurability.directorySyncs,
      confirmedDirectorySyncs: directoryDurability.confirmedDirectorySyncs, directoryCloses: directoryDurability.directoryCloses,
      events: directoryDurability.events, nativeInputs: f.submitAgentPrompt.mock.calls.length }) + '\n')
    directoryDurability.failure = null
  }
}, 30_000)

it('a repaired load is retried through the same public owner without restarting healthy Goal observers', async () => {
  const f = await fixture(), path = join(f.root, 'continuous-progress-loops.json')
  await writeFile(path, '{original-invalid-json')
  await expect(f.owner.start()).rejects.toBeInstanceOf(AggregateError)
  const healthy = [...f.subscriptions]
  expect(healthy.length).toBeGreaterThan(0)
  await expect(f.service.call('agent.progress.list', { target: f.target }, context)).rejects.toBeInstanceOf(SyntaxError)
  await writeFile(path, '[]')
  await expect(f.service.call('agent.progress.list', { target: f.target }, context)).resolves.toEqual({ loops: [] })
  expect([...f.subscriptions]).toEqual(healthy)
  await expect(f.service.call('agent.progress.create', { target: f.target, operationId: 'after-repair', intervalMs: 60_000, prompt: 'Original work after repair' }, context)).resolves.toMatchObject({ diskDurability: 'confirmed' })
  expect(f.submitAgentPrompt).not.toHaveBeenCalled()
})

it('failed startup saves can retry while concurrent and successful starts share one scheduler', async () => {
  const root = await directory(), store = ContinuousProgressLoopStore.forUserData(root)
  const entered = deferred(), release = deferred(), originalLoad = store.load.bind(store)
  const load = vi.spyOn(store, 'load').mockImplementation(async () => { entered.resolve(); await release.promise; return originalLoad() })
  const originalSave = store.save.bind(store), unavailable = new Error('Initial save unavailable')
  const save = vi.spyOn(store, 'save').mockRejectedValueOnce(unavailable).mockImplementation(originalSave)
  const timer = vi.spyOn(globalThis, 'setInterval'), tick = vi.fn(async () => 'skipped' as const)
  const manager = new ContinuousProgressLoopManager(store, tick, () => 0, async () => ({}) as ContinuousProgressObservation)
  cleanup.push(() => manager.stop())
  const first = manager.start(), firstFailure = expect(first).rejects.toBe(unavailable)
  await entered.promise
  expect(manager.start()).toBe(first)
  release.resolve(); await firstFailure
  expect(timer).not.toHaveBeenCalled()
  const recovered = manager.start()
  expect(manager.start()).toBe(recovered)
  await expect(recovered).resolves.toBeUndefined()
  expect(manager.start()).toBe(recovered)
  expect(load).toHaveBeenCalledTimes(2); expect(save).toHaveBeenCalledTimes(2)
  expect(timer).toHaveBeenCalledTimes(1); expect(tick).not.toHaveBeenCalled()
})

it.each(['never-started', 'failed-load', 'failed-save'] as const)('stop releases its acquired Goal subscription after %s without concealing the original failure', async mode => {
  const root = await directory(), store = ContinuousProgressLoopStore.forUserData(root), release = vi.fn()
  const original = new Error('Original startup failure')
  if (mode === 'failed-load') vi.spyOn(store, 'load').mockRejectedValue(original)
  if (mode === 'failed-save') vi.spyOn(store, 'save').mockRejectedValue(original)
  const manager = new ContinuousProgressLoopManager(store, async () => 'skipped', () => 0, async () => ({}) as ContinuousProgressObservation, undefined,
    { read: async () => null, subscribe: () => release, inspectInitial: async () => 'unconfirmed' })
  cleanup.push(() => manager.stop())
  if (mode !== 'never-started') await expect(manager.start()).rejects.toBe(original)
  await expect(manager.stop()).resolves.toBeUndefined()
  await manager.stop()
  expect(release).toHaveBeenCalledTimes(1)
})
