import { fixtureEpoch as reshapeFixtureEpoch } from './helpers/fixture-values.js'
import { fixtureIso as _tail_fixtureIso } from '../../../test/fixture-values.mjs'
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { appendFile, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient, type AgentMuxAgentCreateInput } from '../src/client.js'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { AgentMuxFileAgentSessionStore, loadAgentSessions } from '../src/agent-session-store.js'
import { AgentMuxError } from '../src/errors.js'
import type { AgentMuxStoredAgentSession, AgentNativeResumeSource } from '../src/types.js'
import type { CtxmuxAdapterRun, CtxmuxRunAdapter } from '../src/ctxmux-run-adapter.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

async function fixture(providerId: 'codex' | 'claude' = 'codex') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'amx-native-catalog-'))), workspace = join(root, 'workspace')
  const provider = new AgentProviderRegistry().get(providerId), home = join(root, 'native-home')
  const env = providerId === 'codex' ? { CODEX_HOME: home } : { CLAUDE_CONFIG_DIR: home }
  const file = providerId === 'codex' ? join(home, 'sessions', ..._tail_fixtureIso(0).slice(0, 10).split('-'), 'rollout-private-native.jsonl')
    : join(home, 'projects', '-private-workspace', 'private-native.jsonl')
  await mkdir(dirname(file), { recursive: true }); await mkdir(workspace)
  const record = providerId === 'codex' ? { type: 'session_meta', timestamp: _tail_fixtureIso(3_600_000), payload: {
    id: 'private-native', cwd: workspace, source: 'cli', timestamp: _tail_fixtureIso(3_600_000) } }
    : { type: 'user', sessionId: 'private-native', cwd: workspace, isSidechain: false, timestamp: _tail_fixtureIso(3_600_000), uuid: 'original-user', message: { role: 'user', content: 'original-private-history-marker' } }
  await writeFile(file, JSON.stringify(record) + '\n')
  if (providerId === 'codex') await writeFile(join(home, 'session_index.jsonl'), JSON.stringify({ id: 'private-native', thread_name: 'Actual original title' }) + '\n')
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.jsonl'))
  const store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json')), client = new AgentMuxClient({ store, providers: [provider] }), inner = client as any
  await inner.registry.load('local'); inner.connected = true
  const kernel = inner.kernel as CtxmuxRunAdapter, runs: CtxmuxAdapterRun[] = []
  vi.spyOn(kernel, 'isConnected').mockReturnValue(true)
  vi.spyOn(kernel, 'identity').mockReturnValue({ daemonInstanceId: 'private', protocolVersion: 18, buildIdentity: 'private' } as ReturnType<CtxmuxRunAdapter['identity']>)
  vi.spyOn(kernel, 'list').mockImplementation(async () => runs)
  vi.spyOn(kernel, 'status').mockImplementation(async id => runs.find(run => run.runId === id)!)
  const start = vi.spyOn(kernel, 'start').mockImplementation(async launch => {
    const run: CtxmuxAdapterRun = { runId: `private-run-${runs.length}`, lifecycleOperationId: launch.operationKey!, program: launch.program,
      args: [...launch.args], workspacePath: launch.cwd, pid: process.pid, state: { type: 'running' }, cols: 80, rows: 24,
      latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: 0, nativeService: null }
    runs.push(run); return run
  })
  const stop = vi.spyOn(kernel, 'stop').mockImplementation(async () => { throw new Error('Healthy native resume must not be stopped') })
  const input = vi.spyOn(kernel, 'input').mockImplementation(async () => { throw new Error('A no-prompt native resume must not receive input') })
  inner.hookServer.isRunning = () => true
  const close = vi.fn(async () => {}), bind = vi.fn(async () => {})
  inner.hookServer.createBinding = () => ({ bindingId: 'b'.repeat(43), endpoint: { url: 'http://127.0.0.1:0', token: 't'.repeat(43) }, bindRun: bind, close })
  vi.spyOn(client, 'probeAgent').mockResolvedValue({ providerId, executable: provider.executable, installed: true, capabilities: provider.catalog.capabilities })
  inner.ensureManagedHooks = async () => {}; inner.ensureTerminalHandshakeOrDegrade = async (session: AgentMuxStoredAgentSession) => session
  cleanups.push(async () => { await client.dispose(); expect(stop).not.toHaveBeenCalled(); await rm(root, { recursive: true, force: true }) })
  const catalog = await client.listNativeAgentSessions({ providerId, env }), source = catalog.sessions[0]!.source
  const create: AgentMuxAgentCreateInput = { createOperationId: 'original-native-resume-operation', providerId, executorId: 'private', workspacePath: workspace,
    nativeResumeSource: source, injectAgentMuxGuide: true, agentMuxNote: 'A generated note is not a request.', env, args: ['--private'] }
  return { root, home, workspace, provider, file, record, client, inner, store, kernel, runs, catalog, source, create, start, stop, input, close, bind }
}

it.each(['codex', 'claude'] as const)('discovers persisted %s without Run control, filters exact cwd, and keeps valid candidates beside failed metadata', async providerId => {
  const f = await fixture(providerId)
  expect(f.catalog.sessions).toHaveLength(1); expect(f.catalog.sessions[0]!.source.nativeHandle).toEqual({ kind: 'provider', providerId, sessionId: 'private-native', transcriptPath: f.file })
  expect(f.catalog.sessions[0]!.source.workspacePath).toBe(f.workspace); expect(f.catalog.sessions[0]!.source.revision).toMatch(/^[a-f0-9]{64}$/u)
  expect(f.catalog.capabilities).toEqual(f.provider.catalog.capabilities); expect(f.catalog.sessions[0]!.createdAt).toBe(Date.parse(_tail_fixtureIso(3_600_000)))
  if (providerId === 'codex') expect(f.catalog.sessions[0]!.title).toBe('Actual original title')
  const bad = join(dirname(f.file), providerId === 'codex' ? 'rollout-bad.jsonl' : 'bad.jsonl')
  await writeFile(bad, '{bad}\n')
  const child = join(dirname(f.file), providerId === 'codex' ? 'rollout-child.jsonl' : 'child.jsonl')
  await writeFile(child, JSON.stringify(providerId === 'codex' ? { type: 'session_meta', payload: { id: 'child', cwd: f.workspace,
    source: { subagent: { thread_spawn: { parent_thread_id: 'private-native' } } } } }
    : { ...f.record, sessionId: 'child', isSidechain: true }) + '\n')
  const observed = await f.client.listNativeAgentSessions({ providerId, env: f.create.env })
  expect(observed.sessions.map(entry => entry.source.nativeHandle.sessionId)).toEqual(['private-native'])
  expect(observed.issues.length).toBeGreaterThan(0)
  expect((await f.client.listNativeAgentSessions({ providerId, env: f.create.env, workspacePath: join(f.workspace, 'different') })).sessions).toEqual([])
  expect(f.start).not.toHaveBeenCalled(); expect(f.input).not.toHaveBeenCalled()
})

it.each(['codex', 'claude'] as const)('uses exact %s native resume argv with no generated Prompt, preserves native identity and replays one durable creation', async providerId => {
  const f = await fixture(providerId), receipt = await f.client.createAgentWithDelivery(f.create)
  const args = f.start.mock.calls[0]![0].args
  expect(args).toEqual(providerId === 'codex' ? ['resume', 'private-native', '--dangerously-bypass-hook-trust', '--private'] : ['--resume', 'private-native', '--private'])
  expect(receipt.session.nativeHandle).toEqual(f.source.nativeHandle); expect(receipt.creation.initialPrompt).toBe('not-requested')
  expect(receipt.creation.intentDigest).toMatch(/^[a-f0-9]{64}$/u)
  expect(await f.client.resolveAgentCreationSessionId(f.create.createOperationId!)).toBe(receipt.session.agentSessionId)
  const again = await f.client.createAgentWithDelivery(f.create)
  expect(again.session.agentSessionId).toBe(receipt.session.agentSessionId); expect(again.session.run).toEqual(receipt.session.run)
  expect(f.start).toHaveBeenCalledOnce(); expect(f.input).not.toHaveBeenCalled()
  expect((await loadAgentSessions(f.store))[0]!.nativeHandle).toEqual(f.source.nativeHandle)
  const managed = (await f.client.listNativeAgentSessions({ providerId, env: f.create.env })).sessions[0]!.managed
  expect(managed).toEqual({ agentSessionId: receipt.session.agentSessionId, executorId: 'private', run: receipt.session.run, state: 'active' })
  await expect(f.client.createAgent({ ...f.create, createOperationId: 'another-operation' })).rejects.toMatchObject({ code: 'AGENT_NATIVE_SESSION_ALREADY_MANAGED' })
  expect(f.start).toHaveBeenCalledOnce()
})

it.each(['codex', 'claude'] as const)('refuses forged/replaced %s native source while append retains the original lifetime', async providerId => {
  const f = await fixture(providerId)
  const assert = (source: AgentNativeResumeSource) => f.provider.assertNativeResumeSource!({ source, env: f.create.env!, workspacePath: f.workspace, signal: new AbortController().signal })
  await appendFile(f.file, JSON.stringify({ type: 'private-unrelated-record' }) + '\n'); await expect(assert(f.source)).resolves.toBeUndefined()
  for (const changed of [{ ...f.source, workspacePath: join(f.workspace, 'other') }, { ...f.source, nativeHandle: { ...f.source.nativeHandle, sessionId: 'wrong' } }]) {
    await expect(assert(changed)).rejects.toMatchObject({ code: 'AGENT_NATIVE_RESUME_SOURCE_CHANGED' })
  }
  const outside = join(f.root, providerId === 'codex' ? 'rollout-outside.jsonl' : 'private-native.jsonl'); await writeFile(outside, JSON.stringify(f.record) + '\n')
  await expect(assert({ ...f.source, nativeHandle: { ...f.source.nativeHandle, transcriptPath: outside } })).rejects.toMatchObject({ code: 'INVALID_AGENT_NATIVE_RESUME_SOURCE' })
  const replacement = f.file + '.replace'; await writeFile(replacement, JSON.stringify(f.record) + '\n'); await rename(replacement, f.file)
  await expect(f.client.createAgentWithDelivery(f.create)).rejects.toMatchObject({ code: 'AGENT_NATIVE_RESUME_SOURCE_CHANGED' })
  expect(f.start).not.toHaveBeenCalled(); expect(f.input).not.toHaveBeenCalled()
})

it('keeps lost start ACK and prepared nativeHandle, rejects changed intent, and reconciles one original Run', async () => {
  const f = await fixture(), start = f.start.getMockImplementation()!
  f.start.mockImplementationOnce(async (...args) => { await start(...args); throw new AgentMuxError('ACK lost', 'PRIVATE_START_ACK_UNKNOWN') })
  await expect(f.client.createAgentWithDelivery(f.create)).rejects.toMatchObject({ code: 'AGENT_CREATION_UNCONFIRMED', controlFailure: { disposition: 'unknown' } })
  const seed = (await f.store.loadCreationCorrelation(await f.client.resolveAgentCreationSessionId(f.create.createOperationId!)))!.preparedCreation!
  expect(seed.nativeHandle).toEqual(f.source.nativeHandle); expect(seed.run).toBeUndefined(); expect(f.close).not.toHaveBeenCalled()
  await expect(f.client.createAgentWithDelivery({ ...f.create, args: ['--changed'] })).rejects.toMatchObject({ code: 'AGENT_FORK_OPERATION_CONFLICT' })
  await expect(f.client.createAgentWithDelivery({ ...f.create, createOperationId: 'different-operation' })).rejects.toMatchObject({ code: 'AGENT_NATIVE_SESSION_ALREADY_MANAGED' })
  const recovered = await f.client.createAgentWithDelivery(f.create)
  expect(recovered.session.agentSessionId).toBe(seed.agentSessionId); expect(recovered.session.run).toEqual({ runId: 'private-run-0' })
  expect(recovered.session.nativeHandle).toEqual(f.source.nativeHandle); expect(f.start).toHaveBeenCalledOnce(); expect(f.input).not.toHaveBeenCalled()
})

it('preserves a real Run and original native source through a second Core process after commit ACK failure', async () => {
  const f = await fixture(), holder = spawn(process.execPath, ['-e', "console.log('ready'); setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'pipe'] })
  await once(holder.stdout!, 'data')
  cleanups.push(async () => { if (holder.exitCode === null && holder.signalCode === null) { const exited = once(holder, 'exit'); holder.kill(); await exited } })
  const originalStart = f.start.getMockImplementation()!
  f.start.mockImplementation(async (...args) => { const run = await originalStart(...args); run.pid = holder.pid!; return run })
  vi.spyOn(f.store, 'commitLifecycle').mockRejectedValue(new Error('First Core persistence ACK unavailable'))
  const partial = await f.client.createAgentWithDelivery(f.create)
  expect(partial.creation.persistence).toBe('unconfirmed'); await f.client.dispose()
  const modulePath = join(f.root, 'recover.mjs'), core = resolve('packages/core/src')
  await build({ stdin: { contents: `import {AgentMuxClient} from ${JSON.stringify(join(core, 'client.ts'))}; import {AgentMuxFileAgentSessionStore} from ${JSON.stringify(join(core, 'agent-session-store.ts'))};
const client=new AgentMuxClient({store:new AgentMuxFileAgentSessionStore(${JSON.stringify(join(f.root, 'sessions.json'))})});
client.kernel.isConnected=()=>true;client.connected=true;client.kernel.list=async()=>${JSON.stringify(f.runs)};client.kernel.status=async()=>(${JSON.stringify(f.runs[0])});
for(const name of ['start','stop','input'])client.kernel[name]=async()=>{throw Error('Forbidden replay '+name)};
client.hookServer.isRunning=()=>true;client.hookServer.createBinding=()=>({bindingId:'b'.repeat(43),endpoint:{url:'http://127.0.0.1:0',token:'t'.repeat(43)},bindRun:async()=>{},close:async()=>{}});
await client.registry.load('local');const receipt=await client.createAgentWithDelivery(${JSON.stringify(f.create)});process.kill(${holder.pid},0);console.log(JSON.stringify(receipt));await client.dispose();`,
    resolveDir: process.cwd(), sourcefile: 'native-resume-recovery.ts' }, bundle: true, platform: 'node', format: 'esm', outfile: modulePath,
    plugins: [{ name: 'private-source-package-locators', setup(build) { build.onResolve({ filter: /^(?:stream-json\/|fs-native-extensions$|yaml$|@xmldom\/xmldom$|@ctxmux\/sdk$)/ }, async args => {
      if (args.pluginData?.resolved) return
      const resolved = await build.resolve(args.path, { resolveDir: resolve('packages/core'), kind: args.kind, pluginData: { resolved: true } })
      return { path: resolved.path, external: true }
    }) } }] })
  const child = spawn(process.execPath, [modulePath], { cwd: process.cwd(), env: { ...process.env, NODE_PATH: resolve('packages/core/node_modules') }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''; child.stdout!.on('data', data => { stdout += data }); child.stderr!.on('data', data => { stderr += data })
  const [code] = await once(child, 'exit'); expect({ code, stderr: stderr.replace(/\(node:\d+\) ExperimentalWarning.*\n|\(Use `node --trace-warnings.*\n/gu, '') }).toEqual({ code: 0, stderr: '' })
  const recovered = JSON.parse(stdout.trim())
  expect(recovered.session.agentSessionId).toBe(partial.session.agentSessionId); expect(recovered.session.run).toEqual(partial.session.run)
  expect(recovered.session.nativeHandle).toEqual(f.source.nativeHandle); expect(f.start).toHaveBeenCalledOnce(); expect(f.input).not.toHaveBeenCalled()
})

it.each(['codex', 'claude'] as const)('durably commits a no-args no-Prompt %s resume with its new Run composer readiness', async providerId => {
  const f = await fixture(providerId), receipt = await f.client.createAgentWithDelivery({ ...f.create, args: [] })
  expect(receipt.creation.persistence).toBeUndefined(); expect(receipt.creation.failure).toBeUndefined()
  expect(receipt.creation.initialPrompt).toBe('not-requested')
  if (f.provider.terminalHandshake) expect(receipt.session.terminalPromptReadiness).toMatchObject({ source: 'initial-composer', run: receipt.session.run, outputCursorBytes: 0 })
  else expect(receipt.session.terminalPromptReadiness).toBeUndefined()
  const persisted = (await loadAgentSessions(f.store))[0]!
  expect(persisted.nativeHandle).toEqual(f.source.nativeHandle)
  expect(persisted.terminalPromptReadiness).toEqual(receipt.session.terminalPromptReadiness)
  expect((await f.store.loadCreationCorrelation(receipt.session.agentSessionId))).toBeNull()
  expect(f.start).toHaveBeenCalledOnce(); expect(f.input).not.toHaveBeenCalled()
})

it('keeps a witnessed active native source under its original Core owner while semantic rebinding is unconfirmed', async () => {
  const f = await fixture()
  const original: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'original-core-owner', providerId: 'codex', executorId: 'private', hostId: 'local',
    workspacePath: f.workspace, run: { runId: 'original-core-run' }, retiredRuns: [], createdAt: reshapeFixtureEpoch(0, 0, 1), updatedAt: reshapeFixtureEpoch(0, 0, 2),
    hookBindingId: 'o'.repeat(43), hookToken: 't'.repeat(43),
    nativeHandle: { ...f.source.nativeHandle, sessionId: 'previous-native' }, observedNativeHandle: f.source.nativeHandle,
    nativeSourceObservation: { state: 'changed', run: { runId: 'original-core-run' }, observedAt: reshapeFixtureEpoch(0, 0, 2), reason: 'current-main-differs' } }
  await f.store.compareAndSwap(null, original)
  const catalog = await f.client.listNativeAgentSessions({ providerId: 'codex', env: f.create.env })
  expect(catalog.sessions).toHaveLength(1)
  expect(catalog.sessions[0]!.managed).toEqual({ agentSessionId: original.agentSessionId, executorId: 'private', run: original.run, state: 'active' })
  await expect(f.client.createAgentWithDelivery(f.create)).rejects.toMatchObject({ code: 'AGENT_NATIVE_SESSION_ALREADY_MANAGED' })
  expect(f.start).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled(); expect(f.input).not.toHaveBeenCalled()
  expect((await f.store.readMetadata(original.agentSessionId))!.nativeSourceObservation).toEqual(original.nativeSourceObservation)
})
