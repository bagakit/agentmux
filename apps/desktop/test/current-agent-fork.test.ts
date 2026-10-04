import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { activateRuntime } from '@ctxmux/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../../../packages/core/src/client.js'
import { AgentMuxFileAgentSessionStore } from '../../../packages/core/src/agent-session-store.js'
import { AgentProviderRegistry } from '../../../packages/core/src/agent-provider.js'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { createWorkspaceLayout } from '../../../packages/core/src/spatial-layout.js'
import { AgentMuxSpatialStateStore } from '../../../packages/core/src/spatial-state.js'
import { executeSpatialControl, type SpatialWorkbench, type SpatialControlPorts } from '../src/renderer/src/lib/space-agent-control'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import { directoryIdentity, workspaceZoneId } from '../src/shared/space-addresses'
import type { AgentMuxAgentSession, AgentMuxSpaceControlRequest } from '../../../packages/core/src/index.js'
import type { SessionSnapshot, AppConfig } from '../src/shared/contracts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs(); vi.restoreAllMocks() })
const waitUntil = async (test: () => Promise<boolean>) => { const end = Date.now() + 5000; do { if (await test()) return; await new Promise(r => setTimeout(r, 25)) } while (Date.now() < end); throw new Error('Private native fixture did not become ready') }

// This bounded native protocol fixture consumes the real Provider launch argv and Core-injected
// environment in a real ctxmux PTY. It has no authentication, network or upstream agent work.
const executable = `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
if(process.argv.includes('--version')){console.log('private-native-fixture 1');process.exit(0)}
if(process.argv.includes('app-server')){process.exit(2)}
const provider=process.env.AGENTMUX_PROVIDER_ID,id=crypto.randomUUID(),sid=process.env.AGENTMUX_AGENT_SESSION_ID;
const file=path.join(process.cwd(),provider==='codex'?'rollout-'+id+'.jsonl':id+'.jsonl');
const meta=provider==='codex'?{type:'session_meta',payload:{id,source:'cli'}}:{type:'user',sessionId:id,isSidechain:false,uuid:id,message:{role:'user',content:'private native conversation'}};
fs.writeFileSync(file,JSON.stringify(meta)+'\\n');const fd=fs.openSync(file,provider==='codex'?'r':'a+');
fs.writeFileSync(path.join(process.cwd(),sid+'.launch.json'),JSON.stringify({pid:process.pid,sid,nativeId:id,file,args:process.argv.slice(2),lifecycle:process.env.AGENTMUX_LIFECYCLE_OPERATION_ID}));
process.stdout.write('\\x1b[?u\\x1b[?1;2cprivate native ready\\r\\n');
process.stdin.on('data',data=>{process.stdout.write('private input received\\r\\n')});setInterval(()=>{},1000);
`

async function fixture(providerId: 'codex' | 'claude', executionRoute = 'local') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'amx-current-fork-')))
  for (const key of Object.keys(process.env).filter(key => (key.startsWith('AGENTMUX_') || key.startsWith('CTXMUX_')) && key !== 'AGENTMUX_TEST_OBJECT_CLI')) vi.stubEnv(key, undefined)
  if (process.env.AMX_FORK_LOADED) expect(process.env.AGENTMUX_TEST_OBJECT_CLI).toBeTruthy()
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'runtime')); vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  await mkdir(join(root, 'runtime'), { mode: 0o700 }); await mkdir(join(root, 'state/ctxmux'), { recursive: true, mode: 0o700 })
  const activation = await activateRuntime({ executable: resolve('packages/core/vendor/ctxmux/darwin-arm64/bin/ctxmuxd'),
    socketPath: join(root, 'runtime/ctxmux.sock'), stateDir: join(root, 'state/ctxmux'), timeoutMs: 5000,
    childDisposition: { mode: 'detached', stdout: 'ignore', stderr: 'ignore' } })
  const cliPath = join(root, 'private-native'); await writeFile(cliPath, executable, { mode: 0o700 })
  const provider = new AgentProviderRegistry().get(providerId), store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
  const client = new AgentMuxClient({ providers: [provider], store, controlSocketPath: join(root, 'headless.sock') })
  // The fixture consumes native argv/files; managed-hook config installation is a separate
  // Provider feature and must never write the user's real config in this protocol scene.
  vi.spyOn(client as any, 'ensureManagedHooks').mockResolvedValue(undefined)
  const ids: string[] = []
  cleanups.push(async () => { for (const id of ids) try { const s = client.agentSession(id); const status = await client.statusAgent(id); if (status.run.state === 'running') await client.stopAgent(id, s.run) } catch {}
    await client.dispose(); await activation.dispose({ shutdown: true }); await rm(root, { recursive: true, force: true }) })
  await client.connect()
  const parent = await client.createAgent({ providerId, executorId: 'private', workspacePath: root, commandOverride: cliPath, injectAgentMuxGuide: false })
  ids.push(parent.agentSessionId)
  const launchPath = join(root, parent.agentSessionId + '.launch.json')
  await waitUntil(async () => !!(await readFile(launchPath).catch(() => undefined)))
  // Discovery occurs before the optional native reader. Codex's app-server page protocol is not
  // provided by this fixture; its explicit read failure cannot erase the witnessed main identity.
  try { await client.sessionHistoryPage(parent.agentSessionId, { refreshNativeSource: true, limit: 1, commandOverride: cliPath }) }
  catch (error) { if (providerId !== 'codex' || !String((error as { code?: string }).code).startsWith('AGENT_SESSION_HISTORY_')) throw error }
  const current = client.agentSession(parent.agentSessionId)
  expect(current.nativeHandle?.kind).toBe('provider')
  const source = { agentSessionId: parent.agentSessionId, expectedRun: parent.run, expectedNativeHandle: current.nativeHandle as Extract<NonNullable<AgentMuxAgentSession['nativeHandle']>, { kind: 'provider' }> }
  const snapshot = (session: AgentMuxAgentSession): Extract<SessionSnapshot, { kind: 'agent' }> => ({ id: session.agentSessionId, kind: 'agent',
    providerId: session.providerId, executorId: session.executorId, hostId: executionRoute, workspacePath: session.workspacePath, label: session.agentSessionId,
    capabilities: provider.catalog.capabilities, createdAt: session.createdAt, updatedAt: session.updatedAt, agentSessionUpdatedAt: session.updatedAt,
    creation: session.creation, forkedFrom: session.forkedFrom, latestOutputBytes: 0, processState: 'running', status: { state: 'running', source: 'run-process', observedAt: Date.now() },
    control: { kind: 'agent', agentSessionId: session.agentSessionId, hostId: executionRoute, run: session.run } })
  // The private transport exposes a distinct Desktop route to the same real Core. This
  // verifies route projection and server-local identity, without claiming an SSH transport test.
  const config: AppConfig = { version: 9, hosts: [{ id: executionRoute, kind: 'local', label: 'Private' }],
    executors: { private: { providerId, label: 'Private', command: cliPath, args: [], env: {}, injectAgentMuxGuide: false } },
    workspaces: [{ id: 'private-workspace', hostId: executionRoute, name: 'Private', kind: 'folder', path: root },
      { id: 'other-display', hostId: executionRoute, name: 'Other display', kind: 'folder', path: join(root, 'other-directory') }],
    appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
  const tab = createWorkbenchTab('original-tab', { kind: 'agent', phase: 'attached', regionId: 'original-region', workspaceId: 'private-workspace', sessionId: parent.agentSessionId })
  let state: SpatialWorkbench = { config, sessions: [snapshot(current)], tabs: { [tab.id]: tab }, layouts: { 'private-workspace': createWorkspaceLayout('original-group', [tab.id]) }, spaceZoneBindings: {}, spatialRequests: {} }
  const spatial = new AgentMuxSpatialStateStore(join(root, 'spatial.json'))
  let focus: unknown = { tabId: tab.id, regionId: 'original-region' }
  const save = async (layoutApplied: boolean) => { const previous = await spatial.read(); await spatial.commit({ expectedRevision: previous?.revision ?? 0,
    graph: desktopSpatialGraph(state, [], previous?.graph ?? null) }); await writeFile(join(root, 'workbench.json'), JSON.stringify({ state, focus }));
    return { layoutApplied, localStorageWritten: true, storageFlushRequested: true, diskDurability: 'confirmed' as const, reason: null } }
  const ports: SpatialControlPorts = { get: () => state, patch: patch => { state = { ...state, ...patch } }, topics: async () => [],
    createResource: async () => { throw new Error('Fork may not create execution resources') },
    creation: async (host, id) => { expect(host).toBe(executionRoute); return client.refreshAgentSession(id, client.agentSession(id).run) },
    launch: async input => { expect(input.hostId).toBe(executionRoute)
      // Admission, including its original fork source, must precede native creation.
      expect(state.spatialRequests[input.createOperationId!]!.forkSource).toEqual(source)
      expect(state.spatialRequests[input.createOperationId!]!.forkSource).not.toBe(input.forkSource)
      const persisted = JSON.parse(await readFile(join(root, 'workbench.json'), 'utf8'))
      expect(persisted.state.spatialRequests[input.createOperationId!]!.forkSource).toEqual(source)
      const created = await client.createAgentWithDelivery({ ...input, providerId, commandOverride: cliPath, injectAgentMuxGuide: false }); ids.push(created.session.agentSessionId)
      expect(created.session.hostId).toBe('local')
      return { created: created.session, creation: created.creation, session: snapshot(created.session), timeline: await client.sessionTimeline(created.session.agentSessionId), projectionFailures: [] } },
    attach: async (regionId, result) => { state = { ...state, sessions: [...state.sessions, result.session], tabs: Object.fromEntries(Object.entries(state.tabs).map(([id, t]) => [id, t.regions[regionId] ? { ...t, regions: { ...t.regions, [regionId]: { ...t.regions[regionId], phase: 'attached' } } } : t])) } },
    save, focus: address => { focus = address }, isFocused: address => JSON.stringify(focus) === JSON.stringify(address), notice: () => {}, closing: () => false }
  const server = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), coreClients: () => [{ hostId: executionRoute, client }],
    execute: async request => executeSpatialControl(ports, request as AgentMuxSpaceControlRequest) })
  await server.start(); const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  cleanups.push(async () => { await rpc.dispose(); await server.stop() })
  return { root, client, provider, parent, source, ports, snapshot, ids, rpc, server, spatial, state: () => state,
    cli: (args: string[], stdin = '') => runCompiledObjectCli(args, objectCliEnvironment(root, { AGENTMUX_RPC_ENDPOINT: `unix:${server.path}` }), stdin) }
}

it.each([['codex', 'local'], ['claude', 'local'], ['codex', 'remote-core-route']] as const)('forks current %s on route %s through actual CLI and original spatial owner, retains both real Runs and reconciles without replay', async (providerId, executionRoute) => {
  const f = await fixture(providerId, executionRoute), operationId = 'current-fork-' + providerId
  const args = ['agent', 'open', '--fork-from', f.parent.agentSessionId, '--fork-source', '-', '--tab', 'original-tab', '--region', 'original-region', '--split', 'right', '--operation-id', operationId, '--focus']
  const result = await f.cli(args, JSON.stringify(f.source))
  expect(result.code, result.stderr).toBe(0)
  const frame = JSON.parse(result.stdout), receipt = frame.result
  expect(frame.operation).toBe('agent.open')
  expect(receipt).toMatchObject({ outcome: 'opened', agent: { agentMuxContext: 'confirmed', forkedFrom: f.source } })
  expect(receipt.agent.hostId).toBe(executionRoute)
  expect(receipt.agent.agentSessionId).not.toBe(f.parent.agentSessionId); expect(receipt.agent.runId).not.toBe(f.parent.run.runId)
  expect(receipt.to).toMatchObject({ tabId: 'original-tab' }); expect(receipt.to.regionId).not.toBe('original-region')
  expect(f.state().tabs['original-tab']!.regions['original-region']).toMatchObject({ sessionId: f.parent.agentSessionId })
  expect(f.state().spatialRequests[operationId]?.executionHostId).toBe(executionRoute)
  expect(f.state().spatialRequests[operationId]?.forkSource).toEqual(f.source)
  const fork = f.client.agentSession(receipt.agent.agentSessionId)
  await waitUntil(async () => !!await readFile(join(f.root, fork.agentSessionId + '.launch.json')).catch(() => undefined))
  const launch = JSON.parse(await readFile(join(f.root, fork.agentSessionId + '.launch.json'), 'utf8'))
  expect(launch.args.join('\n')).toContain('Your current AgentMux Session ID is ' + fork.agentSessionId)
  expect(launch.args.join('\n')).toContain('ancestry only')
  if (providerId === 'codex') expect(launch.args.slice(0, 2)).toEqual(['fork', f.source.expectedNativeHandle.sessionId])
  else { expect(launch.args.slice(0, 3)).toEqual(['--resume', f.source.expectedNativeHandle.sessionId, '--fork-session']) }
  expect(launch.nativeId).not.toBe(f.source.expectedNativeHandle.sessionId)
  expect(f.client.agentSession(f.parent.agentSessionId).run).toEqual(f.parent.run)
  expect((await f.client.statusAgent(f.parent.agentSessionId)).run.state).toBe('running')
  expect((await f.client.statusAgent(fork.agentSessionId)).run.state).toBe('running')
  const originalLayout = structuredClone(f.state().tabs)
  const replay = await f.rpc.call('agent.open', { operationId,
    content: { kind: 'fork-agent', source: f.source }, destination: { tabId: 'original-tab', regionId: 'original-region', split: 'right' }, focus: true })
  expect(replay.agent?.agentSessionId).toBe(fork.agentSessionId)
  expect(replay.agent?.hostId).toBe(executionRoute)
  expect(f.ids).toHaveLength(2); expect(f.state().tabs).toEqual(originalLayout)
  await expect(f.client.createAgentWithDelivery({ providerId, executorId: 'private', workspacePath: f.root, agentSessionId: fork.agentSessionId,
    createOperationId: operationId, forkSource: f.source, commandOverride: launch.args.length ? join(f.root, 'private-native') : '', prompt: 'different intent' })).rejects.toMatchObject({ code: 'AGENT_FORK_OPERATION_CONFLICT' })
  const wrong = { ...f.source, expectedRun: { runId: 'stale-run' } }
  const refused = await f.cli(args.map(value => value === operationId ? 'stale-fork' : value), JSON.stringify(wrong))
  expect(refused.code).toBe(1); expect(JSON.parse(refused.stdout).result.issues[0].code).toBe('AGENT_FORK_SOURCE_CHANGED')
  expect(f.ids).toHaveLength(2)
  await f.client.writeAgent({ agentSessionId: f.parent.agentSessionId, expectedRun: f.parent.run, source: 'user', data: 'x' })
  // A new display Tab can point at another local resource; it cannot rewrite the fork's cwd.
  const tabOperation = operationId + '-new-tab', otherPath = join(f.root, 'other-directory')
  const tabResult = await f.cli(['agent', 'open', '--fork-from', f.parent.agentSessionId, '--fork-source', '-',
    '--zone', workspaceZoneId(directoryIdentity(executionRoute, otherPath), 'other-display'), '--new-tab', '--operation-id', tabOperation], JSON.stringify(f.source))
  expect(tabResult.code, tabResult.stderr || tabResult.stdout).toBe(0)
  const tabReceipt = JSON.parse(tabResult.stdout).result, tabFork = f.client.agentSession(tabReceipt.agent.agentSessionId)
  expect(tabReceipt.to.tabId).not.toBe('original-tab'); expect(tabReceipt.to.regionId).not.toBe(receipt.to.regionId)
  expect(tabReceipt.to.workspaceId).toBe('other-display'); expect(tabReceipt.agent.cwd).toBe(f.root)
  expect(tabReceipt.agent.hostId).toBe(executionRoute)
  expect(tabFork.workspacePath).toBe(f.root); expect(f.ids).toHaveLength(3)
  expect((await f.client.statusAgent(f.parent.agentSessionId)).run.state).toBe('running')
  const modulePath = process.env.AMX_FORK_STORE_MODULE
  const spatialModule = process.env.AMX_FORK_SPATIAL_MODULE
  expect(modulePath).toBeTruthy()
  expect(spatialModule).toBeTruthy()
  const restored = spawn(process.execPath, ['--input-type=module', '-e', `const fs=await import('node:fs/promises'),m=await import(process.argv[1]),s=await import(process.argv[4]);console.log(JSON.stringify({pid:process.pid,sessions:await m.loadAgentSessions(new m.AgentMuxFileAgentSessionStore(process.argv[2])),workbench:JSON.parse(await fs.readFile(process.argv[3],'utf8')),spatial:await new s.AgentMuxSpatialStateStore(process.argv[5]).read()}))`, modulePath!, join(f.root, 'sessions.json'), join(f.root, 'workbench.json'), spatialModule!, join(f.root, 'spatial.json')], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', error = ''; restored.stdout!.on('data', data => output += data); restored.stderr!.on('data', data => error += data)
  expect((await once(restored, 'exit'))[0], error).toBe(0)
  const restoredFacts = JSON.parse(output); expect(restoredFacts.pid).not.toBe(process.pid)
  expect(restoredFacts.sessions.map((s: AgentMuxAgentSession) => s.agentSessionId).sort()).toEqual([f.parent.agentSessionId, fork.agentSessionId, tabFork.agentSessionId].sort())
  expect(restoredFacts.workbench.state.tabs).toEqual(f.state().tabs)
  expect(restoredFacts.spatial).toEqual(await f.spatial.read())
  expect(restoredFacts.spatial.graph.tabs).toHaveLength(2); expect(restoredFacts.spatial.graph.regions).toHaveLength(3)
  expect(restoredFacts.sessions.find((s: AgentMuxAgentSession) => s.agentSessionId === fork.agentSessionId).forkedFrom).toEqual(f.source)
}, 60000)

it('reports unsupported and partial mounting through the public client while retaining both healthy Runs', async () => {
  const f = await fixture('claude')
  const originalBuild = f.provider.buildForkLaunch
  f.provider.buildForkLaunch = undefined
  try {
    await expect(f.client.createAgentWithDelivery({ providerId: 'claude', executorId: 'private', workspacePath: f.root,
      commandOverride: join(f.root, 'private-native'), forkSource: f.source })).rejects.toMatchObject({ code: 'AGENT_FORK_UNSUPPORTED' })
  } finally { f.provider.buildForkLaunch = originalBuild }
  expect(f.ids).toHaveLength(1)
  const attach = f.ports.attach
  f.ports.attach = async () => { throw new Error('Private client mount unavailable after Core creation') }
  const request = { operationId: 'fork-partial-mount', content: { kind: 'fork-agent' as const, source: f.source },
    destination: { tabId: 'original-tab', regionId: 'original-region', split: 'below' as const }, focus: false }
  const result = await f.rpc.call('agent.open', request)
  expect(result.outcome).toBe('partial'); expect(result.agent?.agentSessionId).toBeTruthy()
  const forkId = result.agent!.agentSessionId
  expect(forkId).not.toBe(f.parent.agentSessionId); expect(f.ids).toHaveLength(2)
  expect((await f.client.statusAgent(forkId)).run.state).toBe('running')
  expect((await f.client.statusAgent(f.parent.agentSessionId)).run.state).toBe('running')
  f.ports.attach = attach
  const replay = await f.rpc.call('agent.open', request)
  expect(replay.agent?.agentSessionId).toBe(forkId); expect(f.ids).toHaveLength(2)
  await f.client.writeAgent({ agentSessionId: f.parent.agentSessionId, expectedRun: f.parent.run, source: 'user', data: 'x' })
}, 60000)
