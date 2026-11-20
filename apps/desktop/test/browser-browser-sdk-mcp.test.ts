// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { build } from 'vite'
import { AgentMuxControlServer } from '../../../packages/core/src/control-host.js'
import { AgentMuxFileAgentSessionStore } from '../../../packages/core/src/agent-session-store.js'
import { hashAgentCapability, issueAgentCapability } from '../../../packages/core/src/agent-capability.js'
import { connectBrowserSdk, BROWSER_RPC_METHODS } from '../../../packages/core/src/browser-sdk.js'
import { browserTaskImportInput } from '../../../packages/core/src/browser-task-control.js'
import { privateRpcCorePort } from '../../../packages/core/test/helpers/private-rpc-core.js'
import { openBrowserMcp } from '../../../packages/browser-mcp/test/client.js'
import { BrowserTaskAssets, BrowserTaskAssetFileStore } from '../src/main/browser-task-assets.js'
import { executeBrowserTaskControl } from '../src/main/browser-task-control.js'
import { executeBrowserProfileControl, isBrowserProfileControlRequest } from '../src/main/browser-profile-control.js'
import { BrowserProfileStore } from '../src/main/browser-profile-store.js'
import { BrowserProfileManager } from '../src/main/browser-profile-manager.js'
import { BrowserOperationJournal, BrowserOperationFileStore } from '@agentmux/browser/operations'
vi.mock('electron', () => ({ WebContentsView: class {}, app: { getPath: () => '' } }))
import { BrowserViewManager } from '../src/main/browser-view-manager.js'

const roots: string[] = [], cleanups: Array<() => Promise<unknown>> = [], browserId = 'explicit-browser', neighborId = 'retained-neighbor'
let sdkConsumer: string
beforeAll(async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amx-sdk-code-')); roots.push(directory)
  await build({ configFile: false, logLevel: 'silent', build: { ssr: true, minify: false, emptyOutDir: false, outDir: directory,
    rollupOptions: { input: resolve('apps/desktop/test/fixtures/browser-sdk-consumer.ts'), external: id => !id.startsWith('.') && !id.startsWith('/'), output: { format: 'es', entryFileNames: 'consumer.mjs' } } } })
  await symlink(resolve('apps/desktop/node_modules'), join(directory, 'node_modules')); sdkConsumer = join(directory, 'consumer.mjs')
})
afterEach(async () => { await Promise.all(cleanups.splice(0).map(close => close())); vi.restoreAllMocks() })
afterAll(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))) })
function environment(overrides: Record<string, string | undefined> = {}) {
  const env = { ...process.env, NODE_NO_WARNINGS: '1', ...overrides }
  delete env.AGENTMUX_AGENT_SESSION_ID; delete env.AGENTMUX_AGENT_CAPABILITY
  return Object.fromEntries(Object.entries({ ...env, ...overrides }).filter((entry): entry is [string, string] => entry[1] !== undefined))
}
async function child(args: string[], env: Record<string, string>) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((accept, reject) => {
    const processChild = spawn(process.execPath, args, { cwd: resolve('.'), env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''; processChild.stdout.setEncoding('utf8').on('data', value => { stdout += value }); processChild.stderr.setEncoding('utf8').on('data', value => { stderr += value })
    const timer = setTimeout(() => { processChild.kill(); reject(Error('Private SDK caller did not finish')) }, 20_000)
    processChild.once('error', reject); processChild.once('close', code => { clearTimeout(timer); accept({ code: code ?? -1, stdout, stderr }) })
  })
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amx-sdk-mcp-')); roots.push(root)
  const capability = issueAgentCapability(), sessionPath = join(root, 'sessions.json')
  await new AgentMuxFileAgentSessionStore(sessionPath).compareAndSwap(null, { kind: 'agent', agentSessionId: 'managed-sdk-agent', providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: root,
    run: { runId: 'original-managed-run' }, retiredRuns: [], hookBindingId: 'original-hook', hookToken: 'fixture-hook', createdAt: 1, updatedAt: 1, capabilityHash: hashAgentCapability(capability) })
  const core = await privateRpcCorePort(sessionPath, join(root, 'messages.ndjson')); cleanups.push(() => core.dispose())
  const assetPath = join(root, 'assets.json'), assets = new BrowserTaskAssets(new BrowserTaskAssetFileStore(assetPath))
  const profiles = new BrowserProfileManager(new BrowserProfileStore(join(root, 'profiles.json'))); await profiles.initialize()
  const profileId = profiles.defaultProfileId(), signInWrites = vi.fn(async () => ({ reconnected: true }))
  const journal = new BrowserOperationJournal(new BrowserOperationFileStore(join(root, 'operations.db')), { maxEvents: 4 })
  const operation = await journal.start({ id: 'original-operation', browserId, operator: { id: 'test-user', name: 'User' }, summary: 'Original work', url: 'https://sdk.invalid/' })
  for (let i = 0; i < 8; i++) await journal.setPhase(operation.id, 'running', { summary: `Step ${i}` })
  const stop = vi.fn(() => { operation.phase = 'stopped' }), neighborStop = vi.fn()
  const manager = Object.create(BrowserViewManager.prototype) as BrowserViewManager
  const entry = { id: browserId, activity: { control: 'agent', operation }, humanControl: false, controlRevision: 1, inputIsolation: 'unconfirmed', activeRun: { operationId: operation.id, stop } }
  const neighbor = { ...entry, id: neighborId, activeRun: { operationId: 'neighbor-operation', stop: neighborStop } }
  Object.assign(manager, { taskAssets: assets, operationJournal: journal, entries: new Map([[browserId, entry], [neighborId, neighbor]]) })
  const targets = [browserId, neighborId].map(id => ({ id, workspaceId: null, source: 'embedded' as const, status: 'ready' as const, url: 'https://sdk.invalid/', title: 'Fixture', navigationId: id+'-document', capabilities: ['snapshot', 'click'] }))
  const seen: Array<{ operation: string; actor: unknown; caller?: string }> = []
  const methods = new Set<any>(['system.endpoint', 'system.subscription.cancel', 'browser.targets', 'browser.inspect', 'browser.stop', 'browser.follow', 'browser.task.import', 'browser.task.import-inspect', 'browser.task.draft', 'browser.task.export', 'browser.profile.ls', 'browser.profile.delete', 'browser.profile.proxy-sign-in.clear'])
  const server = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), exposedMethods: methods, coreClients: core.clients,
    execute: async (request, context) => {
      seen.push({ operation: request.operation, actor: context?.actor, ...(request.caller ? { caller: request.caller.agentSessionId } : {}) })
      if (isBrowserProfileControlRequest(request)) return executeBrowserProfileControl(request, { profiles, usage: {} as never, network: { setProxySignIn: signInWrites } as never }, context?.actor)
      if (request.operation === 'browser.targets') return { operation: request.operation, targets, coverage: 'complete' }
      if (request.operation === 'browser.operation') return { operation: request.operation, runOperation: await manager.getOperation(request.operationId) }
      if (request.operation === 'browser.stop') return { operation: request.operation, runOperation: await manager.stopOperationById(request.operationId) }
      return executeBrowserTaskControl(request, manager, false)
    },
    subscribeBrowserOperation: async (request, listener) => {
      const subscription = await journal.subscribe(request.operationId, request.afterSequence, listener)
      queueMicrotask(() => { for (const event of subscription.backlog) listener(event) })
      return { runOperation: subscription.operation, gap: subscription.gap, dispose: () => subscription.dispose() }
    }
  }); await server.start(); cleanups.push(() => server.stop())
  return { root, assetPath, assets, manager, profiles, profileId, signInWrites, journal, operation, entry, neighbor, stop, neighborStop, seen, socket: server.path, server, capability }
}
async function mcp(f: Awaited<ReturnType<typeof fixture>>, extra: Record<string, string | undefined> = {}) {
  const peer = await openBrowserMcp(process.execPath, [resolve('packages/browser-mcp/dist/stdio.js'), '--endpoint', 'unix:'+f.socket], environment(extra)); cleanups.push(() => peer.close()); return peer
}
function body(value: any) { return value.structuredContent ?? JSON.parse(value.content.find((item: any) => item.type === 'text').text) }
const portable = () => ({ format: 'agentmux.browser-task' as const, version: 1 as const, source: { assetId: 'package-origin', revision: 1 }, definition: { name: 'MCP imported task', url: 'https://sdk.invalid/', steps: [{ id: 'step', kind: 'navigate', url: 'https://sdk.invalid/', reviewed: false }], parameters: [] } })

it('an independent process consumes the compiled Core SDK and writes/reads one task through original RPC/Main/asset ownership', async () => {
  const f = await fixture(), reply = await child([sdkConsumer, f.socket, browserId], environment())
  expect(reply.code, reply.stderr).toBe(0)
  const result = JSON.parse(reply.stdout); expect(result.pid).not.toBe(process.pid)
  expect(result.discovery).toMatchObject({ availability: 'advertised', methods: expect.arrayContaining(['browser.task.import', 'browser.targets']) })
  expect(result.created.creation).toMatchObject({ assetId: result.input.assetId, browserId, status: 'created' })
  expect(result.draft.asset.draft.steps).toHaveLength(1); expect((await f.assets.state()).assets).toHaveLength(1)
  expect(await readFile(f.assetPath, 'utf8')).toContain(result.input.assetId)
}, 40_000)

it('the official MCP client initializes an independent stdio process, discovers exact targets and retains original import/draft/receipt identities', async () => {
  const f = await fixture(), peer = await mcp(f), listed = await peer.client.listTools()
  expect(listed.tools.map(tool => tool.name)).toEqual(['browser_discover', 'browser_call', 'browser_follow'])
  const discovered = body(await peer.client.callTool({ name: 'browser_discover', arguments: {} }))
  expect(discovered.targets.targets.map((target: any) => target.id)).toEqual([browserId, neighborId])
  expect(discovered.availability).toBe('advertised')
  const input = browserTaskImportInput(browserId, portable())
  const imported = body(await peer.client.callTool({ name: 'browser_call', arguments: { method: 'browser.task.import', params: { browserId, input } } }))
  expect(imported.result.creation).toEqual({ createOperationId: input.createOperationId, assetId: input.assetId, browserId, status: 'created' })
  const draft = body(await peer.client.callTool({ name: 'browser_call', arguments: { method: 'browser.task.draft', params: { browserId, assetId: input.assetId } } }))
  expect(draft.result.asset).toMatchObject({ id: input.assetId, browserId, importedFrom: portable().source, draft: { name: portable().definition.name } })
  expect(f.stop).not.toHaveBeenCalled(); expect(f.neighborStop).not.toHaveBeenCalled()
  const wrong = await peer.client.callTool({ name: 'browser_call', arguments: { method: 'browser.task.draft', params: { browserId: neighborId, assetId: input.assetId } } })
  expect(wrong.isError).toBe(true); expect(body(wrong).error.message).toContain('another Browser')
}, 40_000)

it('managed MCP credentials reach real Core authentication and cannot be downgraded to the person’s Profile sign-in authority', async () => {
  const f = await fixture(), peer = await mcp(f, { AGENTMUX_AGENT_SESSION_ID: 'managed-sdk-agent', AGENTMUX_AGENT_CAPABILITY: f.capability })
  const readable = await peer.client.callTool({ name: 'browser_call', arguments: { method: 'browser.profile.ls', params: {} } })
  expect(readable.isError).not.toBe(true); expect(body(readable).result.profiles).toHaveLength(1)
  const refused = await peer.client.callTool({ name: 'browser_call', arguments: { method: 'browser.profile.proxy-sign-in.clear', params: { profileId: f.profileId } } })
  expect(refused.isError).toBe(true); expect(body(refused).error.code).toBe('BROWSER_PROFILE_PROXY_AUTH_REQUIRES_PERSON'); expect(JSON.stringify([readable, refused])).not.toContain(f.capability)
  expect(f.signInWrites).not.toHaveBeenCalled()
  expect(f.seen.map(item => item.operation)).not.toContain('browser.profile.proxy-sign-in.clear') // Original Core refuses before Main writes.
  const forged = await peer.client.callTool({ name: 'browser_call', arguments: { method: 'browser.profile.proxy-sign-in.clear', params: { profileId: f.profileId, caller: { kind: 'user' } } } })
  expect(forged.isError).toBe(true); expect(body(forged).error.code).toBe('MCP_CONTROL_FIELDS_FORBIDDEN'); expect(f.signInWrites).not.toHaveBeenCalled()
  const invalid = await mcp(f, { AGENTMUX_AGENT_SESSION_ID: 'managed-sdk-agent', AGENTMUX_AGENT_CAPABILITY: 'invalid-original-capability' })
  const unauthenticated = await invalid.client.callTool({ name: 'browser_call', arguments: { method: 'browser.profile.ls', params: {} } })
  expect(unauthenticated.isError).toBe(true); expect(body(unauthenticated).error.code).toBe('AGENT_CAPABILITY_INVALID')
  const person = await mcp(f), cleared = await person.client.callTool({ name: 'browser_call', arguments: { method: 'browser.profile.proxy-sign-in.clear', params: { profileId: f.profileId } } })
  expect(cleared.isError).not.toBe(true); expect(f.signInWrites).toHaveBeenCalledTimes(1)
}, 40_000)

it('keeps original Gap/sequence facts, cancels only a follow reader, and stops only the explicitly addressed Main operation', async () => {
  const f = await fixture(), peer = await mcp(f)
  const observed = body(await peer.client.callTool({ name: 'browser_follow', arguments: { operationId: f.operation.id, afterSequence: 0, maxEvents: 2, durationMs: 200 } }))
  expect(observed.initial.gap.droppedThrough).toBeGreaterThan(0); expect(observed.events.length).toBeGreaterThan(0)
  expect(observed.events[0].data.sequence).toBeGreaterThan(observed.initial.gap.droppedThrough)
  expect(observed.afterSequence).toBe(observed.events.at(-1).data.sequence)
  const canceled = new AbortController(), waiting = peer.client.callTool({ name: 'browser_follow', arguments: { operationId: f.operation.id, afterSequence: observed.afterSequence, durationMs: 2000 } }, { signal: canceled.signal })
  const rejected = expect(waiting).rejects.toThrow(); await vi.waitFor(() => expect((f.journal as any).subscribers.size).toBe(1)); canceled.abort(); await rejected
  await vi.waitFor(() => expect((f.journal as any).subscribers.size).toBe(0))
  expect(f.stop).not.toHaveBeenCalled(); expect(f.neighborStop).not.toHaveBeenCalled(); expect(f.entry.activity.operation).toBe(f.operation)
  const stopped = body(await peer.client.callTool({ name: 'browser_call', arguments: { method: 'browser.stop', params: { operationId: f.operation.id } } }))
  expect(stopped.result.runOperation).toMatchObject({ id: f.operation.id, browserId, phase: 'stopped' })
  expect(f.stop).toHaveBeenCalledTimes(1); expect(f.neighborStop).not.toHaveBeenCalled(); expect(f.neighbor.activeRun.operationId).toBe('neighbor-operation')
}, 40_000)

it('preserves unsupported and disconnect as original service errors, leaves the original work available, and keeps readable help with partial credentials', async () => {
  const f = await fixture(), peer = await mcp(f)
  const unsupported = await peer.client.callTool({ name: 'browser_call', arguments: { method: 'browser.task.assets', params: { browserId } } })
  expect(unsupported.isError).toBe(true); expect(body(unsupported).error.code).toBe('HOST_CAPABILITY_UNAVAILABLE')
  const sdk = await connectBrowserSdk({ endpoint: { transport: 'unix', path: f.socket }, credentials: { agentSessionId: 'managed-sdk-agent', capability: 'wrong' } }); cleanups.push(() => sdk.dispose())
  await expect(sdk.call('browser.targets', {})).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
  const partial = await child([sdkConsumer, f.socket, browserId], environment({ AGENTMUX_AGENT_SESSION_ID: 'managed-sdk-agent' }))
  expect(partial.code).not.toBe(0); expect(partial.stderr).toContain('MANAGED_AGENT_CONTEXT_REQUIRED'); expect(partial.stdout).toBe('')
  await f.server.stop()
  const disconnected = await peer.client.callTool({ name: 'browser_call', arguments: { method: 'browser.targets', params: {} } })
  expect(disconnected.isError).toBe(true); expect(body(disconnected).error.code).not.toBeUndefined()
  expect(f.stop).not.toHaveBeenCalled(); expect(f.neighborStop).not.toHaveBeenCalled()
  const help = await child([resolve('packages/browser-mcp/dist/stdio.js'), '--help'], environment({ AGENTMUX_AGENT_SESSION_ID: 'managed-sdk-agent' }))
  expect(help.code, help.stderr).toBe(0); expect(help.stdout).toContain('--endpoint')
  const partialMcp = await child([resolve('packages/browser-mcp/dist/stdio.js'), '--endpoint', 'unix:'+f.socket], environment({ AGENTMUX_AGENT_SESSION_ID: 'managed-sdk-agent' }))
  expect(partialMcp.code).not.toBe(0); expect(JSON.parse(partialMcp.stderr).error.code).toBe('MANAGED_AGENT_CONTEXT_REQUIRED')
  expect(BROWSER_RPC_METHODS).toContain('browser.input.inspect')
}, 40_000)


it('unmanaged MCP tool JSON cannot manufacture real Profile approval DTOs or replace caller authority before the original RPC ingress', async () => {
  const f = await fixture(), disposable = await f.profiles.createProfile('Retained Profile'), peer = await mcp(f)
  const accepted = vi.spyOn(f.server as any, 'accept') // Observe the real server ingress without replacing it.
  const beforeConnections = accepted.mock.calls.length, beforeRequests = f.seen.length, bytes = await readFile(join(f.root, 'profiles.json'), 'utf8')
  const approval: import('../src/shared/contracts.js').BrowserProfileDeleteApproval = { kind: 'user-confirmed', operation: 'delete-profile', scope: 'profile', profileId: disposable.id }
  for (const control of [{ approval }, { caller: { agentSessionId: 'invented-person', capability: 'invented-capability' } }, { runtimeFence: { runtimeId: 'invented-runtime' } }]) {
    const refused = await peer.client.callTool({ name: 'browser_call', arguments: { method: 'browser.profile.delete', params: { profileId: disposable.id, ...control } } })
    expect(refused.isError).toBe(true)
    expect(accepted.mock.calls.length).toBe(beforeConnections); expect(f.seen).toHaveLength(beforeRequests)
    expect(body(refused).error.code).toBe('MCP_CONTROL_FIELDS_FORBIDDEN')
    expect(await readFile(join(f.root, 'profiles.json'), 'utf8')).toBe(bytes)
  }
  expect(f.signInWrites).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled(); expect(f.neighborStop).not.toHaveBeenCalled()
}, 40_000)
