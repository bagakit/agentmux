import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentProviderRegistry, type AgentProvider } from '../src/agent-provider.js'
import { AgentMuxFileAgentSessionStore, AgentMuxSessionDurabilityError, loadAgentSessions } from '../src/agent-session-store.js'
import { DurableWriteConfirmationError } from '../src/durable-write.js'
import type { CtxmuxRunAdapter, CtxmuxAdapterRun } from '../src/ctxmux-run-adapter.js'
import type { AgentMuxClientEvent, AgentMuxStoredAgentSession } from '../src/types.js'

const SID = 'lifecycle-original', RUN = 'lifecycle-original-run', NATIVE = 'lifecycle-native-main'
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  vi.restoreAllMocks(); vi.unstubAllEnvs()
})

async function fixture(options: { existing?: boolean; resume?: boolean; records?: Array<{ id: string; source: unknown }>;
  provider?: (base: AgentProvider) => AgentProvider } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'amx-native-lifecycle-')))
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'runtime'))
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  const records = options.records ?? [{ id: NATIVE, source: 'cli' },
    { id: 'lifecycle-native-child', source: { subagent: { thread_spawn: { parent_thread_id: NATIVE } } } }]
  const files = await Promise.all(records.map(async (record, i) => {
    const path = join(root, `rollout-witness-${i}.jsonl`)
    await writeFile(path, JSON.stringify({ type: 'session_meta', payload: record }) + '\n')
    return path
  }))
  const holder = spawn(process.execPath, ['-e',
    "const fs=require('fs');for(const p of process.argv.slice(1))fs.openSync(p,'r');console.log(process.pid);process.stdin.resume();setInterval(()=>{},1000)",
    ...files], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  await once(holder.stdout!, 'data')
  cleanups.push(async () => {
    if (holder.exitCode === null && holder.signalCode === null) { const end = once(holder, 'exit'); holder.kill('SIGTERM'); await end }
    await rm(root, { recursive: true, force: true })
  })
  const { terminalHandshake: _handshake, terminalPromptRender: _render, planManagedHooks: _hooks,
    ...base } = new AgentProviderRegistry().get('codex')
  const passive = { ...base, catalog: { ...base.catalog, hookStrategy: { kind: 'none' as const } } }
  const provider = options.provider?.(passive) ?? passive
  const store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
  const stored: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: SID, providerId: provider.id,
    executorId: provider.id, hostId: 'local', workspacePath: root, run: { runId: options.resume ? 'lifecycle-ended-run' : RUN }, retiredRuns: [],
    ...(options.resume ? { nativeHandle: { kind: 'provider' as const, providerId: provider.id, sessionId: NATIVE, transcriptPath: files[0]! } } : {}),
    hookBindingId: 'b'.repeat(43), hookToken: 't'.repeat(43), createdAt: 1, updatedAt: 1 }
  if (options.existing || options.resume) await store.compareAndSwap(null, stored)
  const client = new AgentMuxClient({ store, providers: [provider] })
  const kernel = Reflect.get(client, 'kernel') as CtxmuxRunAdapter
  let present = Boolean(options.existing)
  const run = { runId: RUN, state: { type: 'running' }, pid: holder.pid!, workspacePath: root,
    acceptedInputBytes: 0, latestOutputBytes: 0, nativeService: null } as CtxmuxAdapterRun
  vi.spyOn(kernel, 'connect').mockResolvedValue(undefined)
  vi.spyOn(kernel, 'isConnected').mockReturnValue(true)
  const ended = { ...run, runId: 'lifecycle-ended-run', state: { type: 'exited' as const, code: 0, signal: null } }
  vi.spyOn(kernel, 'list').mockImplementation(async () => present ? [run] : options.resume ? [ended] : [])
  const status = vi.spyOn(kernel, 'status').mockImplementation(async id => id === ended.runId ? ended : run)
  const start = vi.spyOn(kernel, 'start').mockImplementation(async () => { present = true; return run })
  vi.spyOn(kernel, 'identity').mockReturnValue({ daemonInstanceId: 'lifecycle-instance', protocolVersion: 1, buildIdentity: 'lifecycle-build' })
  const input = vi.spyOn(kernel, 'input').mockImplementation(async () => {
    holder.stdin!.write('fixture-input')
    return { run, appliedByteRange: { startByte: 0, endByte: 1 } } as Awaited<ReturnType<CtxmuxRunAdapter['input']>>
  })
  const stop = vi.spyOn(kernel, 'stop').mockImplementation(async () => { throw new Error('A healthy original Run must not be stopped') })
  const stopPreparation = vi.spyOn(kernel, 'prepareStop').mockImplementation(async () => { throw new Error('A healthy original Run must not prepare a stop') })
  const history = vi.spyOn(client, 'sessionHistoryPage'), observation = vi.spyOn(client, 'observeSessionHistory')
  const events: AgentMuxClientEvent[] = []; client.onEvent(event => events.push(event))
  cleanups.unshift(async () => {
    await client.dispose()
    expect(stop).not.toHaveBeenCalled(); expect(stopPreparation).not.toHaveBeenCalled(); expect(history).not.toHaveBeenCalled(); expect(observation).not.toHaveBeenCalled()
  })
  const create = async () => {
    await client.connect()
    return await client.createAgent({ agentSessionId: SID, createOperationId: 'lifecycle-create', providerId: provider.id,
      executorId: provider.id, workspacePath: root, commandOverride: process.execPath, injectAgentMuxGuide: false })
  }
  const saved = async () => (await loadAgentSessions(new AgentMuxFileAgentSessionStore(store.path))).find(s => s.agentSessionId === SID)!
  const waitIdentity = async () => { await vi.waitFor(async () => expect((await saved()).nativeHandle).toMatchObject({ sessionId: NATIVE }), { timeout: 3_000 }) }
  const write = () => client.writeAgent({ agentSessionId: SID, expectedRun: { runId: RUN }, source: 'user', data: 'z' })
  return { root, files, holder, provider, store, client, kernel, run, status, start, input, events, create, saved, waitIdentity, write }
}

it('public create persists the witnessed main without main Hook or any history consumer', async () => {
  const f = await fixture()
  expect((await f.create()).agentSessionId).toBe(SID)
  await f.waitIdentity()
  const saved = await f.saved()
  expect(saved.run).toEqual({ runId: RUN })
  expect(saved.nativeHandle).toEqual({ kind: 'provider', providerId: 'codex', sessionId: NATIVE, transcriptPath: f.files[0] })
  expect(saved.hookReceipt).toBeUndefined(); expect(f.start).toHaveBeenCalledOnce()
  await f.client.dispose()
  const second = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(f.store.path) })
  try { expect((await second.sessionHistorySources()).find(s => s.agentSessionId === SID)?.history?.nativeHandle).toEqual(saved.nativeHandle) }
  finally { await second.dispose() }
})

it('public healthy reconnect captures the original Run without a replacement start', async () => {
  const f = await fixture({ existing: true })
  await f.client.connect(); await f.waitIdentity()
  expect(f.start).not.toHaveBeenCalled()
  expect((await f.saved()).run).toEqual({ runId: RUN })
  expect(f.holder.exitCode).toBeNull()
})

it('create and input finish while discovery is slow, then refresh retries the same identity', async () => {
  let release!: () => void, calls = 0
  const delayed = new Promise<void>(resolve => { release = resolve })
  const f = await fixture({ provider: base => ({ ...base, async discoverNativeSession(context) {
    calls++; await delayed; return await base.discoverNativeSession!(context)
  } }) })
  await f.create()
  await vi.waitFor(() => expect(calls).toBe(1))
  await f.write(); expect(f.input).toHaveBeenCalledOnce()
  await f.client.refreshAgentSession(SID, { runId: RUN }); expect(calls).toBe(1)
  release(); await f.waitIdentity()
})

it.each([
  ['only child', [{ id: 'child', source: { subagent: { thread_spawn: { parent_thread_id: NATIVE } } } }]],
  ['two mains', [{ id: NATIVE, source: 'cli' }, { id: 'different-main', source: 'cli' }]]
])('keeps %s unconfirmed with a scoped service window and healthy input', async (_name, records) => {
  const f = await fixture({ records })
  await f.create()
  await vi.waitFor(() => expect(f.events).toContainEqual(expect.objectContaining({ type: 'agent-error',
    agentSessionId: SID, code: 'AGENT_NATIVE_IDENTITY_UNCONFIRMED', evidence: expect.objectContaining({ run: { runId: RUN } }) })), { timeout: 5_000 })
  expect((await f.saved()).nativeHandle).toBeUndefined()
  await f.write(); expect(f.input).toHaveBeenCalledOnce()
})

it('keeps an ENOSPC save failure visible and refresh retries without resending old input', async () => {
  const f = await fixture()
  const actual = f.store.compareAndSwap.bind(f.store)
  let fail = true
  vi.spyOn(f.store, 'compareAndSwap').mockImplementation(async (previous, next, signal) => {
    if (next?.nativeHandle && fail) throw Object.assign(new Error('controlled save ENOSPC'), { code: 'ENOSPC' })
    await actual(previous, next, signal)
  })
  await f.create()
  await vi.waitFor(() => expect(f.events.some(e => e.type === 'agent-error' && e.code === 'AGENT_NATIVE_IDENTITY_PERSIST_FAILED')).toBe(true), { timeout: 5_000 })
  expect((await f.saved()).nativeHandle).toBeUndefined()
  await f.write(); expect(f.input).toHaveBeenCalledOnce()
  fail = false
  await f.client.refreshAgentSession(SID, { runId: RUN }); await f.waitIdentity()
  expect(f.start).toHaveBeenCalledOnce(); expect(f.input).toHaveBeenCalledOnce()
})

it.each(['create', 'native-save'] as const)('keeps post-rename %s usable until a real durability retry acknowledges it', async phase => {
  const f = await fixture()
  const commit = f.store.commitLifecycle.bind(f.store), cas = f.store.compareAndSwap.bind(f.store)
  let fail = true
  const uncertainty = () => new AgentMuxSessionDurabilityError(new DurableWriteConfirmationError(f.store.path, new Error('controlled directory sync EIO')))
  vi.spyOn(f.store, 'commitLifecycle').mockImplementation(async (reservation, session) => {
    await commit(reservation, session)
    if (session && fail && phase === 'create') throw uncertainty()
  })
  vi.spyOn(f.store, 'compareAndSwap').mockImplementation(async (previous, next, signal) => {
    await cas(previous, next, signal)
    if (next && fail && (phase === 'create' || next.nativeHandle)) throw uncertainty()
  })
  const confirm = vi.spyOn(f.store, 'confirmDurability').mockImplementation(async () => { if (fail) throw uncertainty() })
  await f.create()
  await vi.waitFor(() => expect(f.events.some(e => e.type === 'agent-error' && e.code === 'AGENT_SESSION_STORE_DURABILITY_UNCONFIRMED')).toBe(true))
  await f.write(); expect(f.start).toHaveBeenCalledOnce(); expect(f.input).toHaveBeenCalledOnce()
  expect(Reflect.get(f.client, 'registry').isDurabilityUnconfirmed(SID)).toBe(true)
  if (phase === 'native-save') expect((await f.saved()).nativeHandle?.sessionId).toBe(NATIVE)
  await vi.waitFor(() => expect(Reflect.get(f.client, 'nativeIdentityCaptures').size).toBe(0), { timeout: 5_000 })
  expect(Reflect.get(f.client, 'registry').isDurabilityUnconfirmed(SID)).toBe(true)
  const actualConfirm = AgentMuxFileAgentSessionStore.prototype.confirmDurability
  fail = false
  confirm.mockImplementation(async (...args) => { await actualConfirm.apply(f.store, args) })
  await f.client.refreshAgentSession(SID, { runId: RUN }); await f.waitIdentity()
  await vi.waitFor(() => expect(Reflect.get(f.client, 'registry').isDurabilityUnconfirmed(SID)).toBe(false))
  expect(confirm).toHaveBeenCalled(); expect(f.input).toHaveBeenCalledOnce()
  expect(await readFile(f.store.path, 'utf8')).toContain(NATIVE)
})

it('public native resume keeps its healthy new Run and original native identity after post-rename uncertainty', async () => {
  const f = await fixture({ resume: true })
  const commit = f.store.commitLifecycle.bind(f.store)
  let fail = true
  const uncertainty = () => new AgentMuxSessionDurabilityError(new DurableWriteConfirmationError(f.store.path, new Error('controlled directory sync EIO')))
  vi.spyOn(f.store, 'commitLifecycle').mockImplementation(async (reservation, next) => {
    await commit(reservation, next)
    if (next && fail) throw uncertainty()
  })
  const confirm = vi.spyOn(f.store, 'confirmDurability').mockImplementation(async () => { throw uncertainty() })
  await f.client.connect()
  const continuation = f.client.ensureAgentContinuity({ agentSessionId: SID, expectedRun: { runId: 'lifecycle-ended-run' },
    operationId: 'original-native-resume', commandOverride: process.execPath })
  await expect(continuation).resolves.toMatchObject({ kind: 'resumed' })
  const result = await continuation
  expect(result.kind).toBe('resumed')
  if (result.kind !== 'resumed') throw new Error('The original native conversation must resume')
  const resumed = result.session
  expect(resumed).toMatchObject({ agentSessionId: SID, nativeHandle: { sessionId: NATIVE }, run: { runId: RUN },
    retiredRuns: [{ runId: 'lifecycle-ended-run' }] })
  expect(Reflect.get(f.client, 'registry').isDurabilityUnconfirmed(SID)).toBe(true)
  expect(f.events).toContainEqual(expect.objectContaining({ type: 'agent-error', agentSessionId: SID,
    code: 'AGENT_SESSION_STORE_DURABILITY_UNCONFIRMED' }))
  await f.write(); expect(f.input).toHaveBeenCalledOnce(); expect(f.start).toHaveBeenCalledOnce()
  await vi.waitFor(() => expect(Reflect.get(f.client, 'nativeIdentityCaptures').size).toBe(0), { timeout: 3_000 })
  fail = false
  confirm.mockImplementation(async (...args) => await AgentMuxFileAgentSessionStore.prototype.confirmDurability.apply(f.store, args))
  await f.client.refreshAgentSession(SID, { runId: RUN })
  await vi.waitFor(() => expect(Reflect.get(f.client, 'registry').isDurabilityUnconfirmed(SID)).toBe(false))
  expect((await f.saved()).nativeHandle?.sessionId).toBe(NATIVE)
  expect(f.input).toHaveBeenCalledOnce(); expect(f.start).toHaveBeenCalledOnce()
})

it.each(['pid', 'epoch', 'artifact', 'different-handle', 'run', 'workspace'] as const)('rejects discovery after %s changes', async change => {
  let f!: Awaited<ReturnType<typeof fixture>>, changed = false
  f = await fixture({ provider: base => ({ ...base, async discoverNativeSession(context) {
    const result = await base.discoverNativeSession!(context)
    if (!changed) {
      changed = true
      if (change === 'pid') f.status.mockResolvedValue({ ...f.run, pid: f.run.pid! + 1 })
      else if (change === 'epoch') f.client.disconnect()
      else if (change === 'artifact') { await rm(f.files[0]!); await writeFile(f.files[0]!, '{"type":"session_meta","payload":{"id":"replacement","source":"cli"}}\n') }
      else if (change === 'run' || change === 'workspace') {
        const current = await f.saved()
        await f.store.compareAndSwap(current, change === 'run' ? { ...current, run: { runId: 'concurrent-run' } } :
          { ...current, workspacePath: join(f.root, 'concurrent-workspace') })
      }
      else {
        const current = await f.saved()
        await f.store.compareAndSwap(current, { ...current, nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'concurrent-hook' } })
      }
    }
    return result
  } }) })
  await f.create()
  await vi.waitFor(() => expect(changed).toBe(true))
  if (change !== 'epoch') await vi.waitFor(() => expect(Reflect.get(f.client, 'nativeIdentityCaptures').size).toBe(0), { timeout: 5_000 })
  else await new Promise(resolve => setTimeout(resolve, 50))
  expect((await f.saved()).nativeHandle?.sessionId).not.toBe(NATIVE)
  if (change === 'different-handle') expect((await f.saved()).nativeHandle?.sessionId).toBe('concurrent-hook')
})
