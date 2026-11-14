import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import type { CtxmuxAdapterRun, CtxmuxRunAdapter } from '../src/ctxmux-run-adapter.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'
import { discoverClaudeNativeSession } from '../src/providers/claude-native-sources.js'
import { hostedTestClient } from './helpers/hosted-runtime-port.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { objectCliEnvironment } from './helpers/object-cli-rpc.js'
import { runSourceObjectCli } from './helpers/source-object-cli.js'

// Keep the existing listener protocol real while loading this source candidate.
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, fork: ((path: string | URL, args: readonly string[], options: import('node:child_process').ForkOptions) =>
    actual.fork(String(path).endsWith('/control-endpoint-listener-worker.js')
      ? fileURLToPath(new URL('../src/control-endpoint-listener-worker.ts', import.meta.url)) : path, args, options)) as typeof actual.fork }
})

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks() })

async function fixture(openTranscript = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'amx-claude-registry-')))
  const config = join(root, 'config'), project = join(config, 'projects', 'original-project')
  await mkdir(project, { recursive: true }); await mkdir(join(config, 'sessions'))
  const transcriptPath = join(project, 'original.jsonl')
  await writeFile(transcriptPath, JSON.stringify({ type: 'user', sessionId: 'original', isSidechain: false,
    uuid: 'original-message', message: { role: 'user', content: 'recorded original request' } }) + '\n')
  // This real process intentionally never opens its transcript. Registry lifetime
  // evidence must work in the same gap as the reported live Claude process.
  const child = spawn(process.execPath, ['-e', "if(process.argv[1])require('fs').openSync(process.argv[1],'a+');console.log('ready');setInterval(()=>{},1000)",
    ...(openTranscript ? [transcriptPath] : [])], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  await once(child.stdout!, 'data')
  const pid = child.pid!
  const start = process.platform === 'linux'
    ? (await readFile(`/proc/${pid}/stat`, 'utf8')).split(') ').at(-1)!.split(/\s+/u)[19]!
    : execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }).toString().trim()
  const binding = { pid, sessionId: 'original', procStart: start, kind: 'interactive', status: 'working' }
  const registryPath = join(config, 'sessions', `${pid}.json`)
  await writeFile(registryPath, JSON.stringify(binding), { mode: 0o600 })
  const nativeHandle = { kind: 'provider' as const, providerId: 'claude', sessionId: 'original', transcriptPath }
  const context = { processId: pid, nativeHandle, command: process.execPath, args: [], env: {}, workspacePath: root, signal: new AbortController().signal }
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill(); await exit }
    await rm(root, { recursive: true, force: true })
  })
  return { root, child, binding, registryPath, context, nativeHandle }
}

it('confirms the same native process without an open transcript and ignores mutable display metadata', async () => {
  const f = await fixture(), witness = await discoverClaudeNativeSession(f.context)
  expect(witness?.handle).toEqual(f.nativeHandle)
  const replacement = f.registryPath + '.next'
  await writeFile(replacement, JSON.stringify({ ...f.binding, name: 'changed title', status: 'idle', updatedAt: Date.now() }), { mode: 0o600 })
  await rename(replacement, f.registryPath)
  await expect(witness!.assertCurrent!()).resolves.toBeUndefined()
  await expect(witness!.assertPresent!()).resolves.toBeUndefined()
})

it.each(['pid', 'sessionId', 'procStart'] as const)('rejects a changed registered %s even when the retained locator exists', async key => {
  const f = await fixture(), witness = await discoverClaudeNativeSession(f.context)
  expect(witness?.handle).toEqual(f.nativeHandle)
  await writeFile(f.registryPath, JSON.stringify({ ...f.binding, [key]: key === 'pid' ? f.binding.pid + 1 : 'changed' }))
  await expect(witness!.assertCurrent!()).rejects.toBeInstanceOf(Error)
  await expect(discoverClaudeNativeSession(f.context)).rejects.toBeInstanceOf(Error)
  expect(f.child.exitCode).toBeNull()
})

it('does not reuse a registration after its original process exits', async () => {
  const f = await fixture(), witness = await discoverClaudeNativeSession(f.context)
  expect(witness?.handle).toEqual(f.nativeHandle)
  const exit = once(f.child, 'exit'); f.child.kill(); await exit
  await expect(witness!.assertCurrent!()).rejects.toBeInstanceOf(Error)
})

it.each(['malformed', 'symlink', 'writable'] as const)('keeps %s registration unconfirmed', async kind => {
  const f = await fixture()
  if (kind === 'malformed') await writeFile(f.registryPath, '{broken')
  if (kind === 'writable') await chmod(f.registryPath, 0o666)
  if (kind === 'symlink') { const path = f.registryPath + '.original'; await rename(f.registryPath, path); await symlink(path, f.registryPath) }
  await expect(discoverClaudeNativeSession(f.context)).rejects.toBeInstanceOf(Error)
  expect(f.child.exitCode).toBeNull()
})

it('a locator alone cannot confirm a process without native registration or an open transcript', async () => {
  const f = await fixture(); await rm(f.registryPath)
  await expect(discoverClaudeNativeSession(f.context)).resolves.toBeNull()
})

it('keeps an independent writable-transcript witness available when native registration is absent', async () => {
  const f = await fixture(true); await rm(f.registryPath)
  const witness = await discoverClaudeNativeSession(f.context)
  expect(witness?.handle).toEqual(f.nativeHandle)
  await expect(witness!.assertCurrent!()).resolves.toBeUndefined()
})

it('does not mask a conflicting current native registration with an older writable transcript', async () => {
  const f = await fixture(true)
  await writeFile(f.registryPath, JSON.stringify({ ...f.binding, sessionId: 'different-current-main' }))
  await expect(discoverClaudeNativeSession(f.context)).rejects.toBeInstanceOf(Error)
  expect(f.child.exitCode).toBeNull()
})

it.each(['malformed', 'old-process', 'old-start'] as const)('preserves independent current transcript evidence after %s registration observation fails', async kind => {
  const f = await fixture(true)
  await writeFile(f.registryPath, kind === 'malformed' ? '{broken' : JSON.stringify({ ...f.binding,
    ...(kind === 'old-process' ? { pid: f.binding.pid + 1 } : { procStart: 'stale-process-start' }) }))
  const witness = await discoverClaudeNativeSession(f.context)
  expect(witness?.handle).toEqual(f.nativeHandle)
  await expect(witness!.assertCurrent!()).resolves.toBeUndefined()
})

it('public source refresh clears unknown and the same registered Provider witness permits exactly one fork', async () => {
  const f = await fixture(), store = new AgentMuxFileAgentSessionStore(join(f.root, 'sessions.json'))
  const source: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'source', providerId: 'claude', executorId: 'claude',
    hostId: 'local', workspacePath: f.root, run: { runId: 'original-run' }, retiredRuns: [], createdAt: 1, updatedAt: 2,
    hookBindingId: 's'.repeat(43), hookToken: 'o'.repeat(43),
    nativeHandle: f.nativeHandle, nativeBinding: { source: 'native-hook', run: { runId: 'original-run' }, observedAt: 1 },
    nativeSourceObservation: { state: 'unknown', reason: 'current-main-unconfirmed', run: { runId: 'original-run' }, observedAt: 2 } }
  await store.compareAndSwap(null, source)
  const { prepareManagedLaunch: _managed, ...provider } = new AgentProviderRegistry().get('claude')
  const client = new AgentMuxClient({ store, providers: [provider] }), inner = client as any
  await inner.registry.load('local'); inner.connected = true
  const kernel = inner.kernel as CtxmuxRunAdapter
  const original: CtxmuxAdapterRun = { runId: 'original-run', lifecycleOperationId: null, program: process.execPath, args: [], workspacePath: f.root,
    pid: f.child.pid!, state: { type: 'running' }, cols: null, rows: null, latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: 0, nativeService: null }
  vi.spyOn(kernel, 'isConnected').mockReturnValue(true)
  vi.spyOn(kernel, 'identity').mockReturnValue({ daemonInstanceId: 'private', protocolVersion: 18, buildIdentity: 'private' } as ReturnType<CtxmuxRunAdapter['identity']>)
  const runs = [original]
  vi.spyOn(kernel, 'status').mockImplementation(async id => runs.find(run => run.runId === id)!)
  vi.spyOn(kernel, 'list').mockImplementation(async () => runs)
  const start = vi.spyOn(kernel, 'start').mockImplementation(async launch => {
    const run = { ...original, runId: 'fork-run', lifecycleOperationId: launch.operationKey!, program: launch.program, args: [...launch.args] }
    runs.push(run); return run
  })
  const stop = vi.spyOn(kernel, 'stop').mockRejectedValue(new Error('Must keep healthy original'))
  const input = vi.spyOn(kernel, 'input').mockRejectedValue(new Error('No input may be replayed'))
  inner.hookServer.isRunning = () => true
  inner.hookServer.createBinding = () => ({ bindingId: 'b'.repeat(43), endpoint: { url: 'http://127.0.0.1:0', token: 't'.repeat(43) }, bindRun: async () => {}, close: async () => {} })
  inner.ensureManagedHooks = async () => {}
  inner.ensureTerminalHandshakeOrDegrade = async (session: AgentMuxStoredAgentSession) => session
  vi.spyOn(client, 'probeAgent').mockResolvedValue({ providerId: 'claude', executable: 'claude', installed: true, capabilities: provider.catalog.capabilities })
  vi.spyOn(client as any, 'probePreparedAgent').mockResolvedValue({ providerId: 'claude', executable: 'claude', installed: true, capabilities: provider.catalog.capabilities })
  cleanups.push(async () => { await client.dispose(); expect(stop).not.toHaveBeenCalled(); expect(input).not.toHaveBeenCalled() })
  const h = await hostedTestClient(client)
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'rpc.sock'), coreClients: () => [{ hostId: 'local', client }] })
  await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  try {
    const page = await h.sdk.sessionHistoryPage('source', { refreshNativeSource: true, requireCurrentSource: true, limit: 1 })
    expect(page.source).toMatchObject({ providerId: 'claude', nativeSessionId: 'original' })
    expect((await store.readMetadata('source'))?.nativeSourceObservation).toBeUndefined()
    const inspected = await rpc.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: 'source' } })
    expect(inspected.session.nativeHandle).toEqual(f.nativeHandle)
    expect(inspected.session.nativeSourceObservation).toBeUndefined()
    const cli = await runSourceObjectCli(['agent', 'history', '--host', 'local', '--session', 'source', '--source', 'native', '--limit', '1'],
      objectCliEnvironment(f.root, { AGENTMUX_RPC_ENDPOINT: `unix:${server.path}` }))
    expect(cli.code, cli.stderr || cli.stdout).toBe(0)
    expect(JSON.parse(cli.stdout)).toMatchObject({ ok: true, operation: 'agent.history' })
    const request = { agentSessionId: 'fork-session', createOperationId: 'fork-op', providerId: 'claude', executorId: 'claude', workspacePath: f.root,
      forkSource: { agentSessionId: 'source', expectedRun: source.run, expectedNativeHandle: f.nativeHandle }, cols: 80, rows: 24 }
    const forked = await h.sdk.createAgentWithDelivery(request)
    expect(forked.session.forkedFrom).toEqual(request.forkSource)
    expect(start).toHaveBeenCalledOnce()
    expect(start.mock.calls[0]![0].args).toEqual(expect.arrayContaining(['--resume', 'original', '--fork-session']))
    expect((await h.sdk.createAgentWithDelivery(request)).session.run).toEqual(forked.session.run)
    expect(start).toHaveBeenCalledOnce()
    expect((await store.readMetadata('source'))?.run).toEqual(source.run)
  } finally { await rpc.dispose(); await server.stop(); await h.dispose() }
})
