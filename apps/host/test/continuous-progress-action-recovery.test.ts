import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { type AgentMuxRpcCallContext, type ContinuousProgressLoop, observeAgent } from '@agentmux/core'
import { ContinuousProgressLoopStore } from '../src/continuous-progress-loop-store.js'
import { ContinuousProgressLoopManager } from '../src/continuous-progress-loop-manager.js'

const writeFailure = vi.hoisted(() => ({ path: '', phase: undefined as 'before-replace' | 'after-replace' | undefined }))
vi.mock('node:fs/promises', async actual => {
  const fs = await actual<typeof import('node:fs/promises')>()
  return { ...fs,
    rename: async (from: string, to: string) => {
      if (to === writeFailure.path && writeFailure.phase === 'before-replace') throw new Error('Private replacement failure')
      return fs.rename(from, to)
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args)
      if (args[0] === writeFailure.path.slice(0, writeFailure.path.lastIndexOf('/')) && writeFailure.phase === 'after-replace')
        handle.sync = async () => { throw new Error('Private directory sync acknowledgement failure') }
      return handle
    }
  }
})

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { writeFailure.phase = undefined; vi.restoreAllMocks(); for (const dispose of cleanup.splice(0).reverse()) await dispose() })
const person: AgentMuxRpcCallContext = { principal: { kind: 'user', id: 'original-person' } }

it('the original check operation survives a Host reload without executing another check', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amx-progress-operation-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const store = new ContinuousProgressLoopStore(join(root, 'loops.json'))
  const original: ContinuousProgressLoop = { loopId: 'original-loop', hostId: 'local', agentSessionId: 'original-agent', providerId: 'fixture',
    workspacePath: root, intervalMs: 60_000, prompt: 'Keep the original task', nextCheckAt: 60_100, status: 'active', revision: 1 }
  await store.save([original])
  let observations = 0
  const create = () => {
    const manager = new ContinuousProgressLoopManager(store, async () => 'skipped', () => 100, async (loop, tickId) => {
      observations++
      const status = { state: 'working' as const, source: 'native-hook' as const, observedAt: 100 }
      return { session: { ...loop, run: { runId: 'original-run' }, semanticStatus: status }, tickId, now: 100, inputByte: 0,
        observation: observeAgent({ process: 'running', status, timelineCapability: 'complete-events', awaitingRequest: false, terminalCapabilityUnverified: false }, 100) }
    })
    cleanup.push(() => manager.stop()); return manager
  }
  const request = { target: { hostId: original.hostId, agentSessionId: original.agentSessionId, providerId: original.providerId, workspacePath: root },
    loopId: original.loopId, expectedLoop: original, action: 'check' as const, operationId: 'original-check-operation' }
  const first = create()
  await first.callProgress('agent.progress.action', request, person)
  const count = observations
  expect(count).toBeGreaterThan(0)
  await first.stop()
  const restarted = create()
  const receipt = await restarted.callProgress('agent.progress.action', request, person)
  expect(observations, 'A restored request must return its saved original action rather than execute check again.').toBe(count)
  expect(receipt.loop.lastMutation).toMatchObject({ operationId: request.operationId, action: 'check', phase: 'settled' })
})

async function runProgressProcess(root: string, role: string, phase: string) {
  const loader = new URL('./helpers/continuous-progress-source-loader.mjs', import.meta.url)
  const entry = fileURLToPath(new URL('./fixtures/continuous-progress-operation-process.ts', import.meta.url))
  return await new Promise<any>((resolve, reject) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_)/u.test(key)))
    Object.assign(env, { AGENTMUX_RUNTIME_DIRECTORY: join(root, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(root, 'state'),
      AGENTMUX_MESSAGE_QUEUE_PATH: join(root, 'messages.ndjson'), AGENTMUX_AGENT_SESSION_STORE: join(root, 'sessions.json'),
      ...(process.env.PROGRESS_PROCESS_EVIDENCE ? { AGENTMUX_PROGRESS_SOURCE_LOADS: join(process.env.PROGRESS_PROCESS_EVIDENCE, phase + '-loaded.jsonl') } : {}) })
    const registration = `import {register} from 'node:module';register(${JSON.stringify(loader.href)},${JSON.stringify(import.meta.url)});`
    const child = spawn(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(registration), entry, root, role, phase], { env, stdio: ['ignore','pipe','pipe'] })
    let stdout = '', stderr = ''
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('The private Host process did not finish. ' + stderr)) }, 20_000)
    child.stdout.on('data', text => { stdout += text }); child.stderr.on('data', text => { stderr += text })
    child.once('error', error => { clearTimeout(timeout); reject(error) })
    child.once('exit', code => { clearTimeout(timeout); code === 0 ? resolve(JSON.parse(stdout.trim().split('\n').at(-1)!)) : reject(new Error('Private Host process failed: ' + stderr)) })
  })
}

it.each(['settled', 'prepared'] as const)('the original %s action crosses a real Host process restart without another check', async phase => {
  const root = await mkdtemp(join(tmpdir(), 'amx-progress-process-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const run = (role: string) => runProgressProcess(root, role, phase)
  const writer = await run('writer'), request = await readFile(join(root, 'request.json'), 'utf8')
  const before = await readFile(join(root, 'observations.ndjson'), 'utf8')
  const reader = await run('reader')
  expect(reader.pid).not.toBe(writer.pid)
  expect(await readFile(join(root, 'request.json'), 'utf8')).toBe(request)
  expect(await readFile(join(root, 'observations.ndjson'), 'utf8'), 'A restarted Host must not replay the original check or schedule its prepared unknown action.').toBe(before)
  expect(reader.result.loop).toMatchObject({ loopId: 'original-loop', agentSessionId: 'original-agent',
    lastMutation: { operationId: 'original-check-operation', phase } })
  expect(reader.cli).toMatchObject({ ok: true, operation: 'agent.progress.list', result: { loops: [{ loopId: 'original-loop', lastMutation: { operationId: 'original-check-operation', phase } }] } })
  if (phase === 'prepared') {
    expect(writer.receivedReply).toBe(false)
    expect(reader.result.loop).toMatchObject({ status: 'paused', lastOutcome: 'unknown' })
  }
  if (process.env.PROGRESS_PROCESS_EVIDENCE) await writeFile(join(process.env.PROGRESS_PROCESS_EVIDENCE, phase + '-process.json'), JSON.stringify({ writer, reader, originalRequest: JSON.parse(request), observations: before.trim().split('\n').map(line => JSON.parse(line)) }, null, 2))
}, 50_000)

it.each(['before-replace', 'after-replace'] as const)('an original creation query reads only stored evidence after a %s failure', async phase => {
  const root = await mkdtemp(join(tmpdir(), 'amx-progress-save-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'loops.json'), store = new ContinuousProgressLoopStore(path)
  let observations = 0
  const manager = new ContinuousProgressLoopManager(store, async () => { throw new Error('No input is authorized by a recovery read') }, () => 100, async () => { observations++; return { inputOccupied: false } as never })
  cleanup.push(() => manager.stop())
  await manager.start()
  const target = { hostId: 'local', agentSessionId: 'original-agent', providerId: 'fixture', workspacePath: root }
  const request = { target, intervalMs: 60_000, prompt: 'Keep the original request', operationId: 'original-create-operation' }
  writeFailure.path = path; writeFailure.phase = phase
  try { await expect(manager.callProgress('agent.progress.create', request, person)).rejects.toMatchObject({ phase }) }
  finally { writeFailure.phase = undefined }
  expect(manager.list(target)).toHaveLength(1)
  const before = await readFile(path, 'utf8'), saves = vi.spyOn(store, 'save')
  const evidence = await manager.callProgress('agent.progress.list', { target, operationId: request.operationId }, person)
  expect(evidence.loops).toHaveLength(phase === 'before-replace' ? 0 : 1)
  if (phase === 'after-replace') expect(evidence.loops[0]).toMatchObject({ ...target, creationOperationId: request.operationId })
  expect(await manager.callProgress('agent.progress.list', { target }, person)).toMatchObject({ loops: [manager.list(target)[0]] })
  expect((await manager.callProgress('agent.progress.list', { target, operationId: 'another-operation' }, person)).loops).toEqual([])
  expect((await manager.callProgress('agent.progress.list', { target: { ...target, agentSessionId: 'another-agent' }, operationId: request.operationId }, person)).loops).toEqual([])
  expect(await readFile(path, 'utf8')).toBe(before)
  expect(saves, 'Recovery queries cannot replay creation or turn observed bytes into a writer ACK.').not.toHaveBeenCalled()
  expect(observations).toBe(1)
})

it('stored creation evidence cannot replace the current live state after a later failed pause save', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amx-progress-live-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const store = new ContinuousProgressLoopStore(join(root, 'loops.json'))
  const manager = new ContinuousProgressLoopManager(store, async () => 'skipped', () => 100, async () => ({ inputOccupied: false }) as never)
  cleanup.push(() => manager.stop()); await manager.start()
  const target = { hostId: 'local', agentSessionId: 'original-agent', providerId: 'fixture', workspacePath: root }
  const created = await manager.callProgress('agent.progress.create', { target, intervalMs: 60_000, prompt: 'Keep original work', operationId: 'original-create-operation' }, person)
  const save = vi.spyOn(store, 'save').mockRejectedValue(new Error('Private pause save failure'))
  await expect(manager.callProgress('agent.progress.action', { target, loopId: created.loop.loopId, expectedLoop: created.loop, action: 'pause', operationId: 'original-pause-operation' }, person)).rejects.toThrow('Private pause save failure')
  const stored = await manager.callProgress('agent.progress.list', { target, operationId: 'original-create-operation' }, person)
  const live = await manager.callProgress('agent.progress.list', { target }, person)
  expect(stored.loops[0]).toMatchObject({ status: 'active', creationOperationId: 'original-create-operation' })
  expect(live.loops[0]).toMatchObject({ status: 'paused', lastMutation: { operationId: 'original-pause-operation', phase: 'prepared' } })
  expect((await manager.callProgress('agent.progress.list', { target, operationId: 'original-pause-operation' }, person)).loops).toEqual([])
  expect(save).toHaveBeenCalledTimes(1)
})

it.each(['pause', 'stop'] as const)('the original %s action commits its state and operation together once', async action => {
  const root = await mkdtemp(join(tmpdir(), 'amx-progress-state-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const store = new ContinuousProgressLoopStore(join(root, 'loops.json'))
  const manager = new ContinuousProgressLoopManager(store, async () => 'skipped', () => 100, async () => ({ inputOccupied: false }) as never)
  cleanup.push(() => manager.stop()); await manager.start()
  const target = { hostId: 'local', agentSessionId: 'original-agent', providerId: 'fixture', workspacePath: root }
  const created = await manager.callProgress('agent.progress.create', { target, intervalMs: 60_000, prompt: 'Keep original work', operationId: 'original-create-operation' }, person)
  const save = vi.spyOn(store, 'save'), request = { target, loopId: created.loop.loopId, expectedLoop: created.loop, action, operationId: 'original-state-operation' }
  await manager.callProgress('agent.progress.action', request, person)
  expect(save).toHaveBeenCalledTimes(1)
  expect(save.mock.calls[0]![0][0]).toMatchObject({ status: action === 'pause' ? 'paused' : 'stopped', lastMutation: { operationId: request.operationId, action, phase: 'settled' } })
  await expect(manager.callProgress('agent.progress.action', { ...request, action: action === 'pause' ? 'stop' : 'pause' }, person)).rejects.toMatchObject({ code: 'CONTROL_REQUEST_CONFLICT' })
  expect(save).toHaveBeenCalledTimes(1)
})

it('a failed prepared check cannot be executed by the restarted scheduler', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amx-progress-prepared-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const store = new ContinuousProgressLoopStore(join(root, 'loops.json'))
  const original: ContinuousProgressLoop = { loopId: 'original-loop', hostId: 'local', agentSessionId: 'original-agent', providerId: 'fixture', workspacePath: root,
    intervalMs: 60_000, prompt: 'Keep original work', nextCheckAt: 1, status: 'active', revision: 1 }
  await store.save([original]); let observations = 0
  const create = () => {
    const manager = new ContinuousProgressLoopManager(store, async () => { throw new Error('No automatic input should be replayed') }, () => 100, async (loop, tickId) => {
      observations++
      const status = { state: 'working' as const, source: 'native-hook' as const, observedAt: 100 }
      return { session: { ...loop, run: { runId: 'original-run' }, semanticStatus: status }, tickId, now: 100, inputByte: 0,
        observation: observeAgent({ process: 'running', status, timelineCapability: 'complete-events', awaitingRequest: false, terminalCapabilityUnverified: false }, 100) }
    })
    cleanup.push(() => manager.stop()); return manager
  }
  const writer = create(); await writer.start()
  let recorded: readonly ContinuousProgressLoop[] = []
  const save = store.save.bind(store), failing = vi.spyOn(store, 'save').mockImplementationOnce(async records => {
    recorded = structuredClone(records)
    await save(records); throw new Error('Private lost preparation reply')
  })
  const { hostId, agentSessionId, providerId, workspacePath } = original
  await expect(writer.callProgress('agent.progress.action', { target: { hostId, agentSessionId, providerId, workspacePath }, loopId: original.loopId,
    expectedLoop: original, operationId: 'original-check-operation', action: 'check' }, person)).rejects.toThrow('Private lost preparation reply')
  expect(recorded[0]?.lastMutation).toMatchObject({ operationId: 'original-check-operation', phase: 'prepared' })
  const before = observations; failing.mockRestore(); await writer.stop()
  const reader = create(); await reader.start(); await reader.check(1_000_000)
  expect(observations, 'Startup and nextCheckAt cannot schedule the old prepared action again.').toBe(before)
  expect(reader.list()[0]).toMatchObject({ status: 'paused', lastOutcome: 'unknown', lastMutation: { operationId: 'original-check-operation', phase: 'prepared' } })
})

it('an action identity includes its exact loop and expected revision rather than a globally reserved bare id', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amx-progress-scope-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const store = new ContinuousProgressLoopStore(join(root, 'loops.json')); let observations = 0
  const create = () => {
    const manager = new ContinuousProgressLoopManager(store, async () => { throw new Error('No new input') }, () => 100, async (loop, tickId) => {
      observations++; const status = { state: 'working' as const, source: 'native-hook' as const, observedAt: 100 }
      return { session: { ...loop, run: { runId: 'original-run' }, semanticStatus: status }, tickId, now: 100, inputByte: 0,
        observation: observeAgent({ process: 'running', status, timelineCapability: 'complete-events', awaitingRequest: false, terminalCapabilityUnverified: false }, 100) }
    })
    cleanup.push(() => manager.stop()); return manager
  }
  const writer = create(), target = { hostId: 'local', agentSessionId: 'original-agent', providerId: 'fixture', workspacePath: root }
  const first = (await writer.callProgress('agent.progress.create', { target, intervalMs: 60_000, prompt: 'Original work', operationId: 'first-create' }, person)).loop
  const otherTarget = { ...target, agentSessionId: 'other-original-agent' }
  const other = (await writer.callProgress('agent.progress.create', { target: otherTarget, intervalMs: 60_000, prompt: 'Other explicit work', operationId: 'second-create' }, person)).loop
  const original = { target, loopId: first.loopId, expectedLoop: first, action: 'pause' as const, operationId: 'original-X' }
  await writer.callProgress('agent.progress.action', original, person)
  await writer.callProgress('agent.progress.action', { target, loopId: first.loopId, expectedLoop: writer.list(target)[0]!, action: 'resume', operationId: 'later-Y' }, person)
  await writer.stop(); const reader = create(); await reader.start(); const before = observations
  const old = await reader.callProgress('agent.progress.action', original, person).then(() => null, error => error)
  expect(old, 'The old full transaction cannot become a new request after a later revision.').toMatchObject({ code: 'CONTROL_REQUEST_CONFLICT' })
  expect(observations).toBe(before)
  const B = await reader.callProgress('agent.progress.action', { target: otherTarget, loopId: other.loopId, expectedLoop: other, action: 'check', operationId: original.operationId }, person)
  expect(B.loop.lastMutation).toMatchObject({ operationId: original.operationId, expectedRevision: other.revision })
  const newTransaction = { target, loopId: first.loopId, expectedLoop: reader.list(target)[0]!, action: 'check' as const, operationId: original.operationId }
  const A = await reader.callProgress('agent.progress.action', newTransaction, person)
  expect(A.loop.lastMutation).toMatchObject({ operationId: original.operationId, expectedRevision: newTransaction.expectedLoop.revision })
  // Same latest full identity, changed payload is a conflict. A new confirmed
  // basis is another explicit transaction, never a retry of original X.
  await expect(reader.callProgress('agent.progress.action', { ...newTransaction, action: 'pause' }, person)).rejects.toMatchObject({ code: 'CONTROL_REQUEST_CONFLICT' })
  const fresh = await reader.callProgress('agent.progress.action', { ...newTransaction, expectedLoop: A.loop }, person).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }))
  expect(fresh.error, 'A newly confirmed basis is a new transaction, not a retry selected only by its bare id.').toBeUndefined()
  expect(fresh.value!.loop.lastMutation).toMatchObject({ operationId: original.operationId, expectedRevision: A.loop.revision })
  expect(observations).toBeGreaterThan(before)
})

it('a real client writer exit after started storage and before API dispatch retains its unknown original request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amx-progress-client-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const writer = await runProgressProcess(root, 'writer', 'client-started')
  const before = await readFile(join(root, 'user-document.json'), 'utf8')
  const reader = await runProgressProcess(root, 'reader', 'client-started')
  expect(reader.pid).not.toBe(writer.pid)
  expect(writer.receivedReply).toBe(false)
  expect(reader.restoredRequest).toEqual(writer.request)
  expect(reader.restoredRequest).toMatchObject({ dispatch: 'started', input: { operationId: 'original-create-before-api', target: { agentSessionId: 'original-agent' } } })
  expect(reader.result.loops).toEqual([]); expect(reader.live.loops).toEqual([])
  expect(await readFile(join(root, 'user-document.json'), 'utf8')).toBe(before)
  expect(reader.cli).toMatchObject({ ok: true, operation: 'agent.progress.list', result: { loops: [] } })
  expect(await readFile(join(root, 'effects.ndjson'), 'utf8')).toBe('')
  if (process.env.PROGRESS_PROCESS_EVIDENCE) await writeFile(join(process.env.PROGRESS_PROCESS_EVIDENCE, 'client-started-process.json'), JSON.stringify({ writer, reader, nativeDocument: JSON.parse(before), scope: 'Actual native Desktop document owner and Host SDK in separate OS processes; no Electron Renderer lifecycle is claimed.' }, null, 2))
}, 50_000)

it('an update identity includes the expected revision and keeps old full requests immutable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amx-progress-update-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const store = new ContinuousProgressLoopStore(join(root, 'loops.json'))
  const manager = new ContinuousProgressLoopManager(store, async () => 'skipped', () => 100, async () => ({ inputOccupied: false }) as never)
  cleanup.push(() => manager.stop())
  const target = { hostId: 'local', agentSessionId: 'original-agent', providerId: 'fixture', workspacePath: root }
  const original = (await manager.callProgress('agent.progress.create', { target, intervalMs: 60_000, prompt: 'Original work', operationId: 'create' }, person)).loop
  const first = { target, loopId: original.loopId, expectedLoop: original, intervalMs: 60_000, prompt: 'First value', operationId: 'update-X' }
  const one = await manager.callProgress('agent.progress.update', first, person)
  await expect(manager.callProgress('agent.progress.update', { ...first, prompt: 'Different payload for the same full identity' }, person)).rejects.toMatchObject({ code: 'CONTROL_REQUEST_CONFLICT' })
  const next = await manager.callProgress('agent.progress.update', { ...first, expectedLoop: one.loop, prompt: 'Separately authorized value' }, person).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }))
  expect(next.error, 'A new confirmed update basis must not be rejected by a stale bare-id match.').toBeUndefined()
  expect(next.value!.loop).toMatchObject({ prompt: 'Separately authorized value', revision: 3, lastMutation: { operationId: 'update-X', expectedRevision: 2 } })
  await expect(manager.callProgress('agent.progress.update', first, person)).rejects.toMatchObject({ code: 'CONTROL_REQUEST_CONFLICT' })
  expect(manager.list(target)[0]?.prompt).toBe('Separately authorized value')
})
