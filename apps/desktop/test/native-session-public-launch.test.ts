import { sep as _tail_sep } from 'node:path'
import { fixtureIso as _tail_fixtureIso } from '../../../test/fixture-values.mjs'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  AgentMuxClient, AgentMuxFileAgentSessionStore, AgentProviderRegistry, AgentMuxControlServer,
  connectAgentMuxRpc, type AgentMuxControlResult
} from '@agentmux/core'
import type { AgentMuxSpaceControlRequest } from '@agentmux/core/control'
import { RuntimeController } from '../src/main/runtime-controller.js'
import { executeSpatialControl, type SpatialControlPorts, type SpatialWorkbench } from '../src/renderer/src/lib/space-agent-control.js'
import { directoryIdentity, workspaceZoneId } from '../src/shared/space-addresses.js'
import { createWorkspaceLayout } from '@agentmux/layout'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import type { AppConfig } from '../src/shared/contracts.js'
import type { CtxmuxAdapterRun, CtxmuxRunAdapter } from '../../../packages/core/src/ctxmux-run-adapter.js'

vi.mock('electron', () => ({ app: {}, nativeImage: {} }))
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks() })

it('continues one exact native conversation through the real CLI, public service, Desktop spatial/Main owners and Core creation', async () => {
  const root = await realpath(await mkdtemp(join(_tail_sep, 'tmp', "amx-native-launch-")))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace'), home = join(root, 'codex-profile')
  const transcript = join(home, 'sessions', ..._tail_fixtureIso(0).slice(0, 10).split('-'), 'rollout-public-original.jsonl')
  const nativeId = '59a899bf-58ed-41cb-a3f6-19be8dadb2c4'
  await mkdir(dirname(transcript), { recursive: true }); await mkdir(workspace)
  await writeFile(transcript, JSON.stringify({ type: 'session_meta', timestamp: _tail_fixtureIso(0), payload: {
    id: nativeId, cwd: workspace, source: 'cli', timestamp: _tail_fixtureIso(0)
  } }) + '\n')
  const store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json')), core = new AgentMuxClient({ store })
  // Only the test-owned Native transport is controlled. All Provider, Core creation,
  // public parsing and Desktop launch/spatial behavior use the candidate's actual owners.
  const inner = core as any, kernel = inner.kernel as CtxmuxRunAdapter, runs: CtxmuxAdapterRun[] = []
  await inner.registry.load('local'); inner.connected = true
  vi.spyOn(core, 'connect').mockResolvedValue(undefined)
  vi.spyOn(kernel, 'isConnected').mockReturnValue(true)
  vi.spyOn(kernel, 'identity').mockReturnValue({ daemonInstanceId: 'private-public-launch', protocolVersion: 18, buildIdentity: 'test-owned-native' } as ReturnType<CtxmuxRunAdapter['identity']>)
  vi.spyOn(kernel, 'list').mockImplementation(async () => runs)
  vi.spyOn(kernel, 'status').mockImplementation(async id => runs.find(run => run.runId === id)!)
  const start = vi.spyOn(kernel, 'start').mockImplementation(async launch => {
    const run: CtxmuxAdapterRun = { runId: 'private-public-native-run', lifecycleOperationId: launch.operationKey!, program: launch.program,
      args: [...launch.args], workspacePath: launch.cwd, pid: null, state: { type: 'running' }, cols: 80, rows: 24,
      latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: 0, nativeService: null }
    runs.push(run); return run
  })
  const input = vi.spyOn(kernel, 'input').mockImplementation(async () => { throw new Error('A no-prompt public native resume must never invent input') })
  const stop = vi.spyOn(kernel, 'stop').mockImplementation(async () => { throw new Error('This native continuation must preserve its healthy Run') })
  inner.hookServer.isRunning = () => true
  inner.hookServer.createBinding = () => ({ bindingId: 'b'.repeat(43), endpoint: { url: 'http://127.0.0.1:0', token: 't'.repeat(43) }, bindRun: async () => {}, close: async () => {} })
  const provider = new AgentProviderRegistry().get('codex')
  vi.spyOn(core, 'probeAgent').mockResolvedValue({ providerId: 'codex', executable: provider.executable, installed: true, capabilities: provider.catalog.capabilities })
  inner.ensureManagedHooks = async () => {}
  inner.ensureTerminalHandshakeOrDegrade = async (session: unknown) => session
  const runtime = new RuntimeController(store, async () => core)
  const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Test-owned Host' }],
    executors: { original: { label: 'Original', providerId: 'codex', command: process.execPath, args: [], env: { CODEX_HOME: home }, injectAgentMuxGuide: true } },
    workspaces: [{ id: 'original-workspace', name: 'Original', hostId: 'local', path: workspace, kind: 'folder' }],
    appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
  runtime.commit(await runtime.prepare(config)); cleanups.push(() => runtime.dispose())
  const state: SpatialWorkbench = { config, sessions: [], tabs: {}, layouts: { 'original-workspace': createWorkspaceLayout('original-group') }, spaceZoneBindings: {}, spatialRequests: {} }
  const launch = vi.fn(async (request: Parameters<SpatialControlPorts['launch']>[0]) => await runtime.launchAgent(request, config))
  const ports: SpatialControlPorts = {
    get: () => state, patch: patch => Object.assign(state, patch), topics: async () => [],
    createResource: async () => { throw new Error('Native resume must preserve the original execution resource') },
    launch, creation: (hostId, sessionId) => runtime.agentCreation(hostId, sessionId),
    attach: async (regionId, result) => {
      expect(result.session).toBeDefined(); state.sessions.push(result.session!)
      const tab = Object.values(state.tabs).find(tab => regionId in tab.regions)!
      const region = tab.regions[regionId]!
      expect(region.kind).toBe('agent')
      if (region.kind === 'agent') tab.regions[regionId] = { ...region, phase: 'attached' }
    },
    // Layout durability is independently tested by the product restart proof.
    save: async layoutApplied => ({ layoutApplied, localStorageWritten: true, storageFlushRequested: true, diskDurability: 'confirmed', reason: null }),
    focus: () => {}, isFocused: () => false, notice: () => {}, closing: () => false
  }
  const server = new AgentMuxControlServer({ coreClients: () => [{ hostId: 'local', client: core }],
    nativeAgentSessions: params => runtime.nativeAgentSessions({ hostId: params.hostId, executorId: params.executorId, ...(params.workspacePath === undefined ? {} : { workspacePath: params.workspacePath }) }, config),
    execute: async request => {
      if (!['agent.open', 'space.inspect', 'space.ls'].includes(request.operation)) throw new Error('Unrelated public action is not authorized by this fixture')
      return await executeSpatialControl(ports, request as Extract<AgentMuxSpaceControlRequest, { operation: 'agent.open' | 'space.inspect' | 'space.ls' }>) as AgentMuxControlResult
    }
  }, join(root, 'control.sock'))
  await server.start(); cleanups.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanups.push(() => rpc.dispose())
  const catalog = await rpc.call('agent.native.ls', { hostId: 'local', executorId: 'original', workspacePath: workspace })
  expect(catalog.sessions).toHaveLength(1); expect(catalog.sessions[0]!.managed).toBeUndefined()
  const source = catalog.sessions[0]!.source, sourceFile = join(root, 'source.json')
  await writeFile(sourceFile, JSON.stringify(source))
  const zone = workspaceZoneId(directoryIdentity('local', workspace), 'original-workspace'), operationId = 'original-public-native-resume'
  const cli = (args: string[], stdin = '') => runCompiledObjectCli(['--endpoint', `unix:${server.path}`, ...args], objectCliEnvironment(root), stdin)
  const response = await cli(['agent', 'open', '--executor', 'original', '--native-source', sourceFile, '--execution-workspace', 'original-workspace',
    '--zone', zone, '--new-tab', '--operation-id', operationId])
  expect(response.code, response.stdout + response.stderr).toBe(0)
  const report = JSON.parse(response.stdout).result
  expect(report).toMatchObject({ outcome: 'opened', agent: { initialPrompt: 'not-requested', runId: 'private-public-native-run', cwd: workspace, providerId: 'codex' } })
  expect(launch).toHaveBeenCalledOnce(); expect(launch.mock.calls[0]![0]).toMatchObject({ nativeResumeSource: source, workspacePath: workspace, createOperationId: operationId })
  expect(launch.mock.calls[0]![0]).not.toHaveProperty('prompt')
  expect(start).toHaveBeenCalledOnce(); expect(start.mock.calls[0]![0].args).toContain('resume'); expect(start.mock.calls[0]![0].args).toContain(nativeId)
  expect(core.agentSession(report.agent.agentSessionId).nativeHandle).toEqual(source.nativeHandle)
  expect(core.agentSession(report.agent.agentSessionId).creation?.initialPrompt).toBe('not-requested')
  expect(input).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled()
  const inspected = await cli(['space', 'inspect', '--operation-id', operationId])
  expect(inspected.code, inspected.stdout + inspected.stderr).toBe(0)
  expect(JSON.parse(inspected.stdout).result.request).toMatchObject({ operationId, known: true, report: { agent: { agentSessionId: report.agent.agentSessionId, runId: 'private-public-native-run' } } })
  const replay = await cli(['agent', 'open', '--executor', 'original', '--native-source', sourceFile, '--execution-workspace', 'original-workspace', '--zone', zone, '--new-tab', '--operation-id', operationId])
  expect(replay.code, replay.stdout + replay.stderr).toBe(0)
  expect(start).toHaveBeenCalledOnce(); expect(launch).toHaveBeenCalledOnce()
  const stdinReplay = await cli(['agent', 'open', '--executor', 'original', '--native-source', '-', '--execution-workspace', 'original-workspace',
    '--zone', zone, '--new-tab', '--operation-id', operationId], JSON.stringify(source))
  expect(stdinReplay.code, stdinReplay.stdout + stdinReplay.stderr).toBe(0)
  expect(start).toHaveBeenCalledOnce(); expect(launch).toHaveBeenCalledOnce()
  const managed = await rpc.call('agent.native.ls', { hostId: 'local', executorId: 'original' })
  expect(managed.sessions[0]!.managed).toMatchObject({ agentSessionId: report.agent.agentSessionId, executorId: 'original', run: { runId: 'private-public-native-run' }, state: 'active' })
  const refused = await cli(['agent', 'open', '--executor', 'original', '--native-source', sourceFile, '--execution-workspace', 'original-workspace',
    '--zone', zone, '--new-tab', '--operation-id', 'explicit-duplicate-native-resume'])
  expect(refused.code).not.toBe(0)
  expect(JSON.parse(refused.stdout).result.issues).toContainEqual(expect.objectContaining({ code: 'AGENT_NATIVE_SESSION_ALREADY_MANAGED' }))
  const originalRegion = state.tabs[report.to.tabId]!.regions[report.to.regionId]!
  expect(originalRegion).toMatchObject({ kind: 'agent', phase: 'attached', sessionId: report.agent.agentSessionId })
  await writeFile(sourceFile, JSON.stringify({ ...source, workspacePath: join(root, 'wrong-directory') }))
  const wrongDirectory = await cli(['agent', 'open', '--executor', 'original', '--native-source', sourceFile, '--execution-workspace', 'original-workspace',
    '--zone', zone, '--new-tab', '--operation-id', 'wrong-original-native-directory'])
  expect(wrongDirectory.code).not.toBe(0)
  expect(JSON.parse(wrongDirectory.stdout).result.issues).toContainEqual(expect.objectContaining({ code: 'AGENT_NATIVE_WORKSPACE_MISMATCH' }))
  expect(launch).toHaveBeenCalledTimes(2); expect(start).toHaveBeenCalledOnce()
  expect(core.agentSession(report.agent.agentSessionId).run).toEqual({ runId: 'private-public-native-run' })
  expect(input).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled()
  if (process.env.AMX_NATIVE_PUBLIC_RECEIPT) await writeFile(process.env.AMX_NATIVE_PUBLIC_RECEIPT, JSON.stringify({
    schema: 'agentmux.native-resume.public-business-chain.v1',
    invocation: 'compiled CLI → Unix RPC → public service → Desktop spatial owner → Main RuntimeController → Core creation → Provider resume plan',
    runtimeTransport: 'controlled test-owned ctxmux adapter; real process continuity is verified separately',
    layoutDurability: 'fixture receipt; product restart verifies real durability separately',
    source, success: report, inspected: JSON.parse(inspected.stdout).result, stdinReplay: JSON.parse(stdinReplay.stdout).result,
    refusedDuplicate: JSON.parse(refused.stdout).result, wrongDirectory: JSON.parse(wrongDirectory.stdout).result,
    nativeOwnership: managed.sessions[0]!.managed, launches: start.mock.calls.map(([launch]) => ({
      operationKey: launch.operationKey, program: launch.program, args: launch.args, cwd: launch.cwd })),
    promptWrites: input.mock.calls.length, stops: stop.mock.calls.length
  }, null, 2))
})
