import { fixturePath } from './helpers/fixture-values.js'
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient, type AgentMuxAgentCreateInput } from '../src/client.js'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { issueAgentCapability, hashAgentCapability } from '../src/agent-capability.js'
import { AgentMuxFileAgentSessionStore, loadAgentSessions } from '../src/agent-session-store.js'
import { AgentMuxError } from '../src/errors.js'
import type { CtxmuxAdapterRun, CtxmuxRunAdapter } from '../src/ctxmux-run-adapter.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  const results = []
  for (const cleanup of cleanups.splice(0).reverse()) results.push(...await Promise.allSettled([cleanup()]))
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Private fixture cleanup failed')
})
async function fixture(providerId: 'codex' | 'claude' = 'claude') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'amx-fork-lifecycle-'))), provider = new AgentProviderRegistry().get(providerId)
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.jsonl'))
  const file = join(root, providerId === 'codex' ? 'rollout-original.jsonl' : 'original.jsonl')
  await writeFile(file, JSON.stringify(providerId === 'codex' ? { type: 'session_meta', payload: { id: 'original', source: 'cli' } }
    : { type: 'user', sessionId: 'original', isSidechain: false, uuid: 'original', message: { role: 'user', content: 'private original' } }) + '\n')
  const holders: ReturnType<typeof spawn>[] = []
  const holder = async (path: string) => {
    const process = spawn(globalThis.process.execPath, ['-e', `const fs=require('fs');const fd=fs.openSync(process.argv[1],process.argv[2]);console.log('ready');process.stdin.on('data',d=>console.log('raw:'+d.toString()));setInterval(()=>{},1000)`, path, providerId === 'claude' ? 'a+' : 'r'],
      { detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    holders.push(process); await once(process.stdout!, 'data'); return process
  }
  cleanups.push(async () => { for (const process of holders) if (process.exitCode === null && process.signalCode === null) { const exited = once(process, 'exit'); process.kill(); await exited }; await rm(root, { recursive: true, force: true }) })
  const original = await holder(file), capability = issueAgentCapability()
  const store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
  const source: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'original-session', providerId, executorId: 'private', hostId: 'local', workspacePath: root,
    run: { runId: 'original-run' }, retiredRuns: [], createdAt: 1, updatedAt: 1, capabilityHash: hashAgentCapability(capability), hookBindingId: 's'.repeat(43), hookToken: 'o'.repeat(43),
    nativeHandle: { kind: 'provider', providerId, sessionId: 'original', transcriptPath: file }, nativeBinding: { source: 'process-witness', run: { runId: 'original-run' }, observedAt: 1 } }
  await store.compareAndSwap(null, source)
  const client = new AgentMuxClient({ store, providers: [provider] }), inner = client as any
  await inner.registry.load('local'); inner.connected = true
  const kernel = inner.kernel as CtxmuxRunAdapter, runs: CtxmuxAdapterRun[] = [{ runId: 'original-run', lifecycleOperationId: null, program: process.execPath, args: [], workspacePath: root,
    pid: original.pid!, state: { type: 'running' }, cols: null, rows: null, latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: 0, nativeService: null }]
  vi.spyOn(kernel, 'isConnected').mockReturnValue(true)
  vi.spyOn(kernel, 'identity').mockReturnValue({ daemonInstanceId: 'private', protocolVersion: 18, buildIdentity: 'private' } as ReturnType<CtxmuxRunAdapter['identity']>)
  vi.spyOn(kernel, 'status').mockImplementation(async id => runs.find(run => run.runId === id)!)
  vi.spyOn(kernel, 'list').mockImplementation(async () => runs)
  const start = vi.spyOn(kernel, 'start').mockImplementation(async launch => {
    const process = await holder(file), run: CtxmuxAdapterRun = { ...runs[0]!, runId: runs.length === 1 ? 'fork-run' : 'fork-run-' + runs.length, lifecycleOperationId: launch.operationKey!,
      pid: process.pid!, args: [...launch.args], program: launch.program }
    runs.push(run); return run
  })
  const stop = vi.spyOn(kernel, 'stop').mockImplementation(async () => { throw new Error('A healthy fixture Run must not be stopped') })
  const input = vi.spyOn(kernel, 'input').mockImplementation(async (id, value) => {
    const run = runs.find(run => run.runId === id)!, target = holders.find(holder => holder.pid === run.pid)!
    const bytes = typeof value === 'string' ? value : value.data, text = typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('utf8')
    const echo = once(target.stdout!, 'data'); target.stdin!.write(text); expect(String((await echo)[0])).toContain('raw:' + text)
    const startByte = run.acceptedInputBytes!; run.acceptedInputBytes = startByte + Buffer.byteLength(text)
    return { run, appliedByteRange: { startByte, endByte: run.acceptedInputBytes } } as Awaited<ReturnType<CtxmuxRunAdapter['input']>>
  })
  inner.hookServer.isRunning = () => true
  const close = vi.fn(async () => {}), bind = vi.fn(async () => {})
  inner.hookServer.createBinding = () => ({ bindingId: 'b'.repeat(43), endpoint: { url: 'http://127.0.0.1:0', token: 't'.repeat(43) }, bindRun: bind, close })
  vi.spyOn(client, 'probeAgent').mockResolvedValue({ providerId, executable: provider.executable, installed: true, capabilities: provider.catalog.capabilities })
  inner.ensureManagedHooks = async () => {}
  const handshake = vi.fn(async (session: AgentMuxStoredAgentSession) => session); inner.ensureTerminalHandshakeOrDegrade = handshake
  cleanups.push(async () => { await client.dispose(); expect(stop).not.toHaveBeenCalled() })
  const create: AgentMuxAgentCreateInput = { agentSessionId: 'fork-session', createOperationId: 'fork-operation', executorId: 'private', providerId, workspacePath: root,
    forkSource: { agentSessionId: source.agentSessionId, expectedRun: source.run, expectedNativeHandle: source.nativeHandle as NonNullable<AgentMuxAgentCreateInput['forkSource']>['expectedNativeHandle'] },
    injectAgentMuxGuide: true, prompt: 'same prompt', env: { PRIVATE_SECRET: 'must-not-be-written', OTHER_PRIVATE: 'second' }, args: ['--private'], cols: 80, rows: 24 }
  return { root, client, inner, store, source, capability, kernel, runs, create, start, stop, input, bind, close, handshake }
}

it.each(['codex', 'claude'] as const)('keeps a healthy %s fork through commit failure, preserves no-Run seed and reconciles the same operation without replay', async provider => {
  const f = await fixture(provider), commit = vi.spyOn(f.store, 'commitLifecycle').mockRejectedValue(new Error('private disk unavailable'))
  const creating = f.client.createAgentWithDelivery(f.create)
  await expect(creating).resolves.toBeDefined()
  const partial = await creating
  expect(partial.creation).toMatchObject({ persistence: 'unconfirmed', agentMuxContext: 'unknown', initialPrompt: 'unknown', failure: { step: 'session-commit' } })
  expect(partial.session.run).toEqual({ runId: 'fork-run' }); expect(f.close).not.toHaveBeenCalled()
  expect((await f.client.readAgentSessions()).find(session => session.agentSessionId === 'fork-session')?.creation?.persistence).toBe('unconfirmed')
  const document = JSON.parse(await readFile(join(f.root, 'sessions.json'), 'utf8')), seed = document.reservations[0].preparedCreation
  expect(seed).toBeDefined(); expect(seed.run).toBeUndefined(); expect(seed.creation.intentDigest).toMatch(/^[a-f0-9]{64}$/u)
  expect(JSON.stringify(document)).not.toContain('must-not-be-written'); expect(JSON.stringify(seed)).not.toContain('same prompt')
  await f.client.writeAgent({ agentSessionId: 'fork-session', expectedRun: partial.session.run, source: 'user', data: 'x' })
  expect(f.input).toHaveBeenCalledOnce(); expect(f.start).toHaveBeenCalledOnce()
  const repeatedUnknown = await f.client.createAgentWithDelivery(f.create)
  expect(repeatedUnknown.session.run).toEqual(partial.session.run); expect(repeatedUnknown.creation.persistence).toBe('unconfirmed')
  expect(f.start).toHaveBeenCalledOnce(); expect(f.input).toHaveBeenCalledOnce()
  await expect(f.inner.recoverStaleLifecycles()).resolves.toBeUndefined()
  expect(f.stop).not.toHaveBeenCalled(); expect(f.client.agentSession('fork-session').run).toEqual(partial.session.run)
  commit.mockRestore()
  const reconciled = await f.client.createAgentWithDelivery(f.create)
  expect(reconciled.creation.persistence).toBeUndefined(); expect(reconciled.creation.agentMuxContext).toBe('unknown')
  expect(reconciled.session.run).toEqual(partial.session.run); expect(f.start).toHaveBeenCalledOnce(); expect(f.input).toHaveBeenCalledOnce()
  expect((await loadAgentSessions(f.store)).find(session => session.agentSessionId === 'fork-session')?.run).toEqual(partial.session.run)
})

it('reconciles commit-after-write unknown outcome, and keeps Hook/handshake failures without closing or recreating a healthy Run', async () => {
  const f = await fixture(), commit = f.store.commitLifecycle.bind(f.store)
  vi.spyOn(f.store, 'commitLifecycle').mockImplementation(async (...args) => { await commit(...args); throw new Error('private lost write acknowledgment') })
  const committed = await f.client.createAgentWithDelivery(f.create)
  expect(committed.creation).toMatchObject({ agentMuxContext: 'confirmed', initialPrompt: 'confirmed' })
  expect(committed.creation.persistence).toBeUndefined(); expect(f.close).not.toHaveBeenCalled()
  const replay = await f.client.createAgentWithDelivery(f.create)
  expect(replay.session.run).toEqual(committed.session.run); expect(f.start).toHaveBeenCalledOnce(); expect(f.input).not.toHaveBeenCalled()
  for (const step of ['hook-bind', 'handshake'] as const) {
    const separate = await fixture()
    ;(step === 'hook-bind' ? separate.bind : separate.handshake).mockRejectedValue(new Error('private ' + step + ' failed'))
    const result = await separate.client.createAgentWithDelivery(separate.create)
    expect(result.creation.failure?.step).toBe(step); expect(result.creation.persistence).toBeUndefined()
    expect(separate.close).not.toHaveBeenCalled(); expect(separate.stop).not.toHaveBeenCalled()
    expect((await separate.client.createAgentWithDelivery(separate.create)).session.run).toEqual(result.session.run)
    expect(separate.start).toHaveBeenCalledOnce(); expect(separate.input).not.toHaveBeenCalled()
    await separate.client.writeAgent({ agentSessionId: result.session.agentSessionId, expectedRun: result.session.run, source: 'user', data: 'x' })
    expect(separate.input).toHaveBeenCalledOnce()
  }
})

it('binds the full creation intent and authenticates initialMessage before any replay', async () => {
  const f = await fixture(), result = await f.client.createAgentWithDelivery(f.create)
  for (const changed of [{ prompt: 'different prompt' }, { agentMuxNote: 'different context' }, { args: ['--changed'] }, { env: { PRIVATE_SECRET: 'changed' } },
    { commandOverride: fixturePath("private/other") }, { injectAgentMuxGuide: false }, { cols: 120 }, { rows: 60 }, { launchOptions: { approval: 'changed' } }]) {
    await expect(f.client.createAgentWithDelivery({ ...f.create, ...changed })).rejects.toMatchObject({ code: 'AGENT_FORK_OPERATION_CONFLICT' })
  }
  expect((await f.client.createAgentWithDelivery({ ...f.create, env: Object.fromEntries(Object.entries(f.create.env!).reverse()) })).session.run).toEqual(result.session.run)
  const authored = { ...f.create, agentSessionId: 'authored-fork', createOperationId: 'authored-operation', initialMessage: { callerAgentSessionId: f.source.agentSessionId, capability: f.capability, threadId: 'private-thread' } }
  await f.client.createAgentWithDelivery(authored)
  await expect(f.client.createAgentWithDelivery({ ...authored, initialMessage: { ...authored.initialMessage, capability: 'invalid' } })).rejects.toBeDefined()
  await expect(f.client.createAgentWithDelivery({ ...authored, initialMessage: { ...authored.initialMessage, threadId: 'different-thread' } })).rejects.toMatchObject({ code: 'AGENT_FORK_OPERATION_CONFLICT' })
  expect(f.start).toHaveBeenCalledTimes(2); expect(f.input).not.toHaveBeenCalled()
})

it('retains a lost start ACK for exact reconciliation and refuses a changed intent without another start', async () => {
  const f = await fixture(), start = f.start.getMockImplementation()!
  f.start.mockImplementationOnce(async (...args) => { await start(...args); throw new Error('private start ACK lost') })
  await expect(f.client.createAgentWithDelivery(f.create)).rejects.toMatchObject({ code: 'AGENT_CREATION_UNCONFIRMED', controlFailure: { disposition: 'unknown' } })
  expect(f.close).not.toHaveBeenCalled(); expect(f.start).toHaveBeenCalledOnce()
  await expect(f.client.createAgentWithDelivery({ ...f.create, prompt: 'changed' })).rejects.toMatchObject({ code: 'AGENT_FORK_OPERATION_CONFLICT' })
  const recovered = await f.client.createAgentWithDelivery(f.create)
  expect(recovered.session.run).toEqual({ runId: 'fork-run' }); expect(recovered.creation.agentMuxContext).toBe('unknown')
  expect(f.start).toHaveBeenCalledOnce(); expect(f.input).not.toHaveBeenCalled()
})

it('does not start when preparation fails, and retains the original reservation when no unique started Run can be confirmed', async () => {
  const f = await fixture()
  vi.spyOn(f.store, 'prepareCreate').mockRejectedValue(new Error('private preparation disk failed'))
  await expect(f.client.createAgentWithDelivery(f.create)).rejects.toBeDefined()
  expect(f.start).not.toHaveBeenCalled()
  const unknown = await fixture()
  unknown.start.mockRejectedValue(new Error('private start outcome unknown'))
  await expect(unknown.client.createAgentWithDelivery(unknown.create)).rejects.toMatchObject({ code: 'AGENT_CREATION_UNCONFIRMED' })
  await expect(unknown.client.createAgentWithDelivery(unknown.create)).rejects.toMatchObject({ code: 'AGENT_CREATION_UNCONFIRMED' })
  expect(unknown.start).toHaveBeenCalledOnce(); expect(unknown.stop).not.toHaveBeenCalled()
  expect(JSON.parse(await readFile(join(unknown.root, 'sessions.json'), 'utf8')).reservations[0].preparedCreation.run).toBeUndefined()
})

it('recovers the prepared creation in an independent Core process without starting, stopping or inputting to the retained real Run', async () => {
  const f = await fixture()
  vi.spyOn(f.store, 'commitLifecycle').mockRejectedValue(new Error('private first owner cannot save Session'))
  const partial = await f.client.createAgentWithDelivery(f.create)
  await f.client.dispose()
  const modulePath = join(f.root, 'recover.mjs'), core = resolve('packages/core/src')
  await build({ stdin: { contents: `import {AgentMuxClient} from ${JSON.stringify(join(core, 'client.ts'))};import {AgentMuxFileAgentSessionStore} from ${JSON.stringify(join(core, 'agent-session-store.ts'))};
const client=new AgentMuxClient({store:new AgentMuxFileAgentSessionStore(process.argv[2])}),runs=JSON.parse(process.argv[3]);await client.registry.load('local');client.connected=true;
client.kernel.list=async()=>runs;client.kernel.status=async id=>runs.find(r=>r.runId===id);client.kernel.isConnected=()=>true;client.kernel.start=async()=>{throw Error('restart must not start')};client.kernel.stop=async()=>{throw Error('restart must not stop')};client.kernel.input=async()=>{throw Error('restart must not input')};
client.hookServer.isRunning=()=>true;client.hookServer.createBinding=(sid,provider,bindingId,token)=>({bindingId,endpoint:{url:'http://127.0.0.1:0',token},bindRun:async()=>{},close:async()=>{}});
await client.recoverStaleLifecycles();console.log(JSON.stringify({pid:process.pid,sessions:await client.readAgentSessions()}));await client.dispose();`, resolveDir: core, loader: 'ts' },
    outfile: modulePath, bundle: true, platform: 'node', format: 'esm', packages: 'external' })
  // Resolve the repository's existing dependencies without installing or writing shared dist.
  const { symlink } = await import('node:fs/promises'); await symlink(resolve('packages/core/node_modules'), join(f.root, 'node_modules'))
  const child = spawn(process.execPath, [modulePath, join(f.root, 'sessions.json'), JSON.stringify(f.runs)], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', error = ''; child.stdout!.on('data', bytes => output += bytes); child.stderr!.on('data', bytes => error += bytes)
  expect((await once(child, 'exit'))[0], error).toBe(0)
  const restored = JSON.parse(output), session = restored.sessions.find((session: AgentMuxStoredAgentSession) => session.agentSessionId === 'fork-session')
  expect(restored.pid).not.toBe(process.pid); expect(session.run).toEqual(partial.session.run)
  expect(session.creation).toMatchObject({ intentDigest: partial.creation.intentDigest, agentMuxContext: 'unknown' })
  expect(session.creation.persistence).toBeUndefined(); expect(session.forkedFrom).toEqual(f.create.forkSource)
  expect(f.start).toHaveBeenCalledOnce(); expect(f.stop).not.toHaveBeenCalled(); expect(f.input).not.toHaveBeenCalled()
})
