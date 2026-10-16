import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentMuxControlResult, AgentMuxInspectedRegion } from '../src/control.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

// The mutation proof selects one private compiled package for every public owner.
const dist = process.env.AMX_SELF_CONTEXT_DIST
const core: typeof import('../src/index.js') = dist ? await import(new URL('index.js', dist).href) : await import('../src/index.js')
const control: typeof import('../src/control-host.js') = dist ? await import(new URL('control-host.js', dist).href) : await import('../src/control-host.js')
const codec: typeof import('../src/rpc-native-codec.js') = dist ? await import(new URL('rpc-native-codec.js', dist).href) : await import('../src/rpc-native-codec.js')
const store: typeof import('../src/agent-session-store.js') = dist ? await import(new URL('agent-session-store.js', dist).href) : await import('../src/agent-session-store.js')
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  try { for (const close of cleanups.splice(0).reverse()) await close() }
  finally { vi.restoreAllMocks() }
})
const factKeys = ['session', 'status', 'unavailable', 'view']
async function readSelf(rpc: import('../src/public-rpc-client.js').AgentMuxRpcClient) {
  const result = rpc.call('whoami', {})
  await expect(result).resolves.toEqual(expect.any(Object))
  return await result
}

async function fixture(mode: 'attached' | 'headless' | 'absent' | 'unknown' = 'attached') {
  const f = await rpcOwnerFixture(['self-original', 'neighbor-original'], core)
  cleanups.push(f.close)
  const original = f.client.agentSession('self-original'), neighbor = f.client.agentSession('neighbor-original')
  cleanups.push(async () => {
    expect(f.client.agentSession('self-original').run).toEqual(original.run)
    expect(f.client.agentSession('neighbor-original')).toEqual(neighbor)
    for (const method of ['input', 'attach', 'detach', 'stop']) expect(f.inner.kernel[method]).not.toHaveBeenCalled()
  })
  if (dist) vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', new URL('agentmux.js', dist).pathname)
  const region: AgentMuxInspectedRegion = {
    kind: 'agent', agentSessionId: original.agentSessionId, providerId: original.providerId, executorId: original.executorId,
    tabId: 'original-tab', regionId: 'original-region', workspaceId: 'original-workspace',
    bounds: { x: 0.1, y: 0.2, width: 0.6, height: 0.7 },
    neighbors: { left: { kind: 'none' }, right: { kind: 'tab', tabId: 'neighbor-tab' }, up: { kind: 'none' }, down: { kind: 'none' } },
    terminalView: { runId: original.run.runId, sampledAt: _tailFixtureEpoch(0, 0, 123), visible: true, readOnly: false, liveReady: true, acceptsInput: true,
      viewGrid: { cols: 80, rows: 24 }, buffer: { type: 'normal', baseY: 100, viewportY: 40, length: 124 }, mouseTrackingMode: 'none' }
  }
  const execute = vi.fn(async (request: import('../src/control.js').AgentMuxControlRequest): Promise<AgentMuxControlResult> => {
    expect(request).toMatchObject({ operation: 'inspect.region', caller: f.credentials, target: { kind: 'self' } })
    if (mode === 'absent') throw new core.AgentMuxError('Original caller has no View.', 'CALLER_NOT_OPEN')
    if (mode === 'unknown') throw new core.AgentMuxError('Original View observation failed.', 'CONTROL_UNAVAILABLE')
    return { operation: 'inspect.region', region }
  })
  const server = new control.AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: f.coreClients,
    ...(mode === 'headless' ? {} : { execute }) })
  await server.start(); cleanups.push(() => server.stop())
  const rpc = await control.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(f.root, 'control.sock') }, credentials: f.credentials })
  cleanups.push(() => rpc.dispose())
  const cli = () => runCompiledObjectCli(['whoami'], objectCliEnvironment(f.root, {
    AGENTMUX_AGENT_SESSION_ID: f.credentials.agentSessionId, AGENTMUX_AGENT_CAPABILITY: f.capability
  }))
  return { ...f, region, execute, rpc, cli }
}

it('returns only complete original facts through the registered service, SDK codec and compiled CLI', async () => {
  const f = await fixture()
  const sdk = await readSelf(f.rpc)
  expect(Object.keys(sdk).sort()).toEqual(factKeys)
  expect(sdk.session).toEqual(f.client.agentSession('self-original'))
  expect(sdk.status).toMatchObject({ session: { agentSessionId: 'self-original', run: { runId: 'run-self-original' } },
    run: { runId: 'run-self-original', state: 'running', acceptedInputBytes: 0, cols: 80, rows: 24 },
    capabilities: { terminal: true, permission: 'respond', providerResume: true },
    observation: { process: 'running', semantic: 'unknown', readiness: 'ready', stale: false } })
  expect(Object.keys(sdk.status!).sort()).toEqual(Object.keys(await f.client.statusAgent('self-original')).sort())
  expect(sdk.status!.capabilities).toEqual(f.client.providers.get('codex').catalog.capabilities)
  expect(sdk.view).toEqual({ attached: true, region: f.region }); expect(sdk.unavailable).toEqual([])
  const cli = await f.cli()
  expect(cli.code, cli.stderr).toBe(0)
  const output = JSON.parse(cli.stdout)
  expect(output).toMatchObject({ ok: true, operation: 'whoami' })
  expect(Object.keys(output.result).sort()).toEqual(factKeys)
  expect(output.result.session).toEqual(sdk.session)
  expect(output.result.status.capabilities).toEqual(sdk.status!.capabilities)
  expect(output.result.status.observation).toMatchObject({ process: 'running', semantic: 'unknown' })
  expect(output.result.view).toEqual(sdk.view); expect(output.result.unavailable).toEqual([])
  expect(JSON.stringify(output)).not.toContain(f.capability)
  expect(f.execute).toHaveBeenCalledTimes(2)
})

it('preserves native failure details and a healthy original Run without a status summary', async () => {
  const f = await fixture('headless'), file = join(f.root, 'original-native.jsonl')
  await writeFile(file, [
    { type: 'session_meta', payload: { id: 'original-native', source: 'cli' } },
    { timestamp: new Date().toISOString(), ordinal: 1, type: 'event_msg', payload: { type: 'task_complete', turn_id: 'original-turn',
      error: { message: 'Original model at capacity.', codex_error_info: 'server_overloaded' } } }
  ].map(value => JSON.stringify(value) + '\n').join(''))
  const previous = (await store.loadAgentSessions(f.store)).find(record => record.agentSessionId === 'self-original')!
  const retained = { ...previous, nativeHandle: { kind: 'provider' as const, providerId: 'codex', sessionId: 'original-native', transcriptPath: file } }
  await f.store.compareAndSwap(previous, retained); await f.client.refreshAgentSession('self-original', retained.run)
  await vi.waitFor(async () => expect((await readSelf(f.rpc)).status?.session.semanticStatus?.failure?.code).toBe('AGENT_MODEL_OVERLOADED'), { timeout: 3000, interval: 20 })
  const sdk = await readSelf(f.rpc)
  expect(sdk.status).toMatchObject({ session: { semanticStatus: { state: 'error', source: 'native-transcript', failure: {
    code: 'AGENT_MODEL_OVERLOADED', nativeCode: 'server_overloaded', nativeTurnId: 'original-turn', message: 'Original model at capacity.' } } },
    run: { runId: previous.run.runId, state: 'running' }, capabilities: { terminal: true, permission: 'respond' } })
  const cli = await f.cli()
  expect(cli.code, cli.stderr).toBe(0)
  expect(JSON.parse(cli.stdout).result.status.session.semanticStatus.failure).toEqual(sdk.status!.session.semanticStatus!.failure)
})

it.each(['headless', 'absent', 'unknown'] as const)('keeps healthy capabilities when the View is %s', async mode => {
  const f = await fixture(mode), sdk = await readSelf(f.rpc)
  const view = mode === 'unknown' ? { attached: false, reason: 'view-unavailable',
    error: { code: 'CONTROL_UNAVAILABLE', message: 'Original View observation failed.' } } : { attached: false, reason: 'no-desktop-view' }
  expect(sdk.view).toEqual(view)
  expect(sdk.status).toMatchObject({ run: { runId: 'run-self-original', state: 'running' }, capabilities: { terminal: true, permission: 'respond' } })
  expect(sdk.unavailable).toEqual(mode === 'headless' ? [] : [expect.objectContaining({ code: mode === 'unknown' ? 'CONTROL_UNAVAILABLE' : 'CALLER_NOT_OPEN' })])
  const cli = await f.cli()
  expect(cli.code, cli.stderr).toBe(0)
  expect(JSON.parse(cli.stdout).result).toMatchObject({ view, session: { agentSessionId: 'self-original' },
    status: { run: { state: 'running' }, capabilities: { terminal: true } }, unavailable: sdk.unavailable })
})

it('retains the original Session and View with explicit unavailable status when Run observation fails', async () => {
  const f = await fixture()
  vi.spyOn(f.client, 'statusAgent').mockRejectedValue(new core.AgentMuxError('Original Runtime observation failed.', 'STATUS_UNAVAILABLE'))
  const sdk = await readSelf(f.rpc)
  expect(sdk).toEqual({ session: f.client.agentSession('self-original'), status: null, view: { attached: true, region: f.region },
    unavailable: [expect.objectContaining({ code: 'STATUS_UNAVAILABLE', message: 'Original Runtime observation failed.' })] })
  const cli = await f.cli()
  expect(cli.code, cli.stderr).toBe(0)
  expect(JSON.parse(cli.stdout).result).toEqual(sdk)
})

it('refuses missing or invalid caller credentials without inspecting a View or changing the Run', async () => {
  const f = await fixture()
  await expect(f.rpc.call('whoami', {}, { credentials: { ...f.credentials, capability: 'invalid-original-capability' } }))
    .rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
  const invalid = await runCompiledObjectCli(['whoami'], objectCliEnvironment(f.root, {
    AGENTMUX_AGENT_SESSION_ID: f.credentials.agentSessionId, AGENTMUX_AGENT_CAPABILITY: 'invalid-original-capability'
  }))
  expect(invalid.code).toBe(1); expect(JSON.parse(invalid.stderr).error.code).toBe('AGENT_CAPABILITY_INVALID')
  const unmanaged = await runCompiledObjectCli(['whoami'], objectCliEnvironment(f.root))
  expect(unmanaged.code).toBe(1); expect(JSON.parse(unmanaged.stderr).error.code).toBe('MANAGED_AGENT_CONTEXT_REQUIRED')
  expect(f.execute).not.toHaveBeenCalled()
})

it('strictly rejects old guidance fields, missing facts and foreign identities in the SDK result', async () => {
  const f = await fixture(), actual = await readSelf(f.rpc)
  expect(codec.parseRpcNativeResult('whoami', actual, {}, f.credentials)).toEqual(actual)
  const missing = { ...actual } as Partial<typeof actual>; delete missing.view
  const wrongStatus = structuredClone(actual); wrongStatus.status!.run.runId = 'foreign-run'
  const wrongView = structuredClone(actual)
  if (wrongView.view.attached && wrongView.view.region.kind === 'agent') wrongView.view.region.agentSessionId = 'neighbor-original'
  const foreign = { ...actual, session: f.client.agentSession('neighbor-original'), status: await f.client.statusAgent('neighbor-original'),
    view: { attached: false, reason: 'no-desktop-view' } }
  for (const corrupted of [
    { ...actual, topic: 'obsolete static topic' }, { ...actual, messaging: {} }, missing,
    foreign, wrongStatus, wrongView
  ]) expect(() => codec.parseRpcNativeResult('whoami', corrupted, {}, f.credentials)).toThrow(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
})
