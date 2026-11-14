import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AgentProviderSessionStatusObservationContext } from '../src/agent-provider.js'
import { observeAgent } from '../src/agent-status-freshness.js'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { AgentHookServer } from '../src/hook-server.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { parseRpcAgentSession } from "../src/agent-session-codec.js";
import { activityCertaintyClient } from './fixtures/activity-certainty-client.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import { RuntimeController } from '../../../apps/desktop/src/main/runtime-controller.js'
import { projectRuntimeEvent } from '../../../apps/desktop/src/renderer/src/lib/session-state.js'
import { agentContextForSession } from '../../../apps/desktop/src/renderer/src/lib/focus-context.js'
import type { AppConfig, SessionSnapshot } from '../../../apps/desktop/src/shared/contracts.js'
import type { AgentMuxAgentSessionRegistry } from '../src/agent-session-registry.js'
import type { AgentProviderSessionStatus, NativeHookEnvelope } from '../src/types.js'

vi.mock('electron', () => ({ app: { isPackaged: false } }))
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const native = (sequence: number, extra = {}) => ({ session_id: 'native-main', sourceId: 'original-source', sequence, turnId: 'original-turn', ...extra })
const tool = { session_id: 'native-main', tool_name: 'Bash', tool_use_id: 'main-tool', tool_input: { command: 'private fixture' } }
async function fixture(id = 'main-authority', provider = 'claude') {
  const h = await activityCertaintyClient(id, provider)
  cleanup.push(async () => { await h.client.dispose(); await rm(h.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }) })
  const registry = Reflect.get(h.client, 'registry') as AgentMuxAgentSessionRegistry
  await registry.update(id, { runId: h.run.runId }, current => ({ ...current, hookBindingId: 'b'.repeat(43), hookToken: 't'.repeat(43) }))
  const kernel = Reflect.get(h.client, 'kernel')
  kernel.list = async () => [h.run]
  kernel.identity = () => ({ buildIdentity: 'private', protocolVersion: 1, daemonInstanceId: 'private' })
  return { ...h, id, saved: async () => (await h.sessions())[0]!, status: () => h.client.statusAgent(id) }
}
async function coldOwner(h: Awaited<ReturnType<typeof fixture>>, disposeOriginal = true, http = false) {
  if (disposeOriginal) await h.client.dispose()
  const client = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(h.store.path) }); cleanup.push(() => client.dispose())
  const inner = client as unknown as { connected: boolean; registry: AgentMuxAgentSessionRegistry; kernel: Record<string, any>;
    acceptHookEvent(event: NativeHookEnvelope, signal: AbortSignal): Promise<void> }
  await inner.registry.load('local'); inner.connected = true
  inner.kernel.isConnected = () => true; inner.kernel.status = async () => h.run; inner.kernel.list = async () => [h.run]
  inner.kernel.identity = () => ({ buildIdentity: 'private', protocolVersion: 1, daemonInstanceId: 'private' })
  const direct = (eventName: string, receiptId: string, payload = {}) => inner.acceptHookEvent({
    agentSessionId: h.id, providerId: 'claude', runId: h.run.runId, eventName, receiptId,
    payload: { hook_event_name: eventName, ...payload } }, AbortSignal.timeout(5_000))
  if (!http) return { client, status: () => client.statusAgent(h.id), hook: direct }
  const hooks = Reflect.get(client, 'hookServer') as AgentHookServer
  Object.defineProperty(hooks, 'port', { value: 0 }); await hooks.start()
  const saved = (await h.saved())
  const binding = hooks.createBinding(h.id, 'claude', saved.hookBindingId, saved.hookToken)
  await binding.bindRun(h.run.runId)
  return { client, status: () => client.statusAgent(h.id), hook: async (eventName: string, receiptId: string, payload = {}) => {
    const response = await fetch(binding.endpoint.url, { method: 'POST', headers: { authorization: `Bearer ${binding.endpoint.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ eventName, receiptId, payload: { hook_event_name: eventName, ...payload } }) })
    expect(response.status, await response.text()).toBe(204)
  } }
}
const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private fixture' }], executors: {}, workspaces: [],
  appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
function context(session: SessionSnapshot) { return agentContextForSession(session, undefined, undefined, undefined, null) }

it.each([0, -1000])('a new main Hook replaces retained unknown through public CLI and Main/Focus with clock delta %i', async delta => {
  const h = await fixture()
  await h.hook('turn.start', 'native-start', native(1))
  // The original producer had already persisted an unconfirmed main fact. Preserve its identity and data.
  const inner = Reflect.get(h.client, 'registry') as AgentMuxAgentSessionRegistry
  await inner.update(h.id, { runId: h.run.runId }, current => {
    const { evidenceRevision: _revision, ...original } = current.recoveryActivity!
    return { ...current, recoveryActivity: { ...original, state: 'unknown' } }
  })
  const cold = await coldOwner(h, true, true)
  expect((await cold.status()).observation.semantic).toBe('unknown')
  const old = (await h.saved()).recoveryActivity
  const before = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(before + delta)
  await cold.hook('PreToolUse', 'new-main-tool', tool)
  clock.mockRestore()
  const status = await cold.status()
  expect(status.observation).toMatchObject({ semantic: 'active', readiness: 'ready' })
  expect(status.session.mainSessionActivity).toMatchObject({ state: 'unknown', sourceId: old!.sourceId, sequence: old!.sequence, nativeTurnId: old!.nativeTurnId })
  expect((await h.saved()).recoveryActivity).toMatchObject({ ...old!, evidenceRevision: 1 })
  expect(status.session.semanticStatus!.evidenceRevision).toBeGreaterThan(status.session.mainSessionActivity!.evidenceRevision!)
  expect(status.session.run.runId).toBe(h.run.runId)
  expect(parseRpcAgentSession(status.session)).toEqual(status.session)
  const server = new AgentMuxControlServer({ socketPath: join(h.directory, 'control.sock'), coreClients: () => [{ hostId: 'local', client: cold.client }] })
  await server.start(); cleanup.push(() => server.stop())
  const result = await runCompiledObjectCli(['--endpoint', `unix:${server.path}`, 'agent', 'inspect', '--session', h.id], objectCliEnvironment(h.directory), '', 60_000)
  expect(result.code, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout).result.status.observation.semantic).toBe('active')
  const main = new RuntimeController(h.store, async () => cold.client)
  main.commit(await main.prepare(config)); cleanup.push(async () => main.dispose())
  const snapshot = await main.snapshot(config)
  expect(snapshot.sessions).toHaveLength(1)
  const session = snapshot.sessions[0]!
  expect(context(session)).toMatchObject({ bucket: 'working', stateLabel: 'Working', activitySemantic: 'active' })
  const state = { sessions: [session], timelines: {}, pendingAgentLaunches: {}, tabs: {}, layouts: {}, viewModes: {} }
  const event = projectRuntimeEvent(state, { type: 'core', hostId: 'local', event: { type: 'agent-session', session: status.session } }).state
  expect(context(event.sessions[0]!)).toMatchObject({ bucket: 'working', activitySemantic: 'active' })
  expect(event.tabs).toBe(state.tabs); expect(event.layouts).toBe(state.layouts)
})

it('classic input and tools refresh semantic activity without rewriting the native turn or its admission', async () => {
  const h = await fixture()
  await h.hook('turn.start', 'native-start', native(1))
  const original = (await h.saved()).recoveryActivity
  await h.hook('UserPromptSubmit', 'merged-user-prompt', { session_id: 'native-main' })
  await h.hook('PreToolUse', 'in-turn-tool', tool)
  expect((await h.saved()).recoveryActivity).toEqual(original)
  expect((await h.status()).observation.semantic).toBe('active')
  const cold = await coldOwner(h)
  expect((await cold.status()).observation.semantic).toBe('active')
  await cold.hook('turn.complete', 'native-end', native(2, { reason: 'answer', isAborted: false, backgroundWork: 'none' }))
  expect((await cold.status()).observation.semantic).toBe('idle')
})

it.each(['native-end', 'delivery-gap'])('%s defeats old working and child-only updates cannot refresh main evidence', async kind => {
  const h = await fixture()
  await h.hook('turn.start', 'native-start', native(1))
  await h.hook('PreToolUse', 'working', tool)
  const accepted = (await h.saved()).semanticStatus!.evidenceRevision
  if (kind === 'native-end') await h.hook('turn.complete', 'native-end', native(2, { reason: 'answer', isAborted: false, backgroundWork: 'pending' }))
  else await h.hook('AgentMuxActivityUnavailable', 'gap', native(2, { reason: 'delivery-gap' }))
  expect((await h.status()).observation).toMatchObject({ semantic: 'unknown', mainSession: { semantic: kind === 'native-end' ? 'idle' : 'unknown' } })
  await h.hook('turn.start', 'child-start', native(3, { agent_id: 'child', turnId: 'child-turn' }))
  await h.hook('turn.complete', 'child-end', native(4, { agent_id: 'child', turnId: 'child-turn', reason: 'answer', isAborted: false }))
  const status = await h.status()
  expect(status.session.semanticStatus!.evidenceRevision).toBe(accepted)
  expect(status.observation.mainSession!.semantic).not.toBe('active')
  expect(status.observation.semantic).toBe('unknown')
})

it('a final native main turn suppresses late tools across owner replacement until a real new input', async () => {
  const h = await fixture()
  await h.hook('turn.start', 'native-start', native(1))
  await h.hook('turn.complete', 'native-end', native(2, { reason: 'answer', isAborted: false, backgroundWork: 'none' }))
  await h.hook('PostToolUse', 'late-tool', tool)
  expect((await h.status()).observation.semantic).toBe('idle')
  const cold = await coldOwner(h)
  await cold.hook('PreToolUse', 'late-tool-after-restart', { ...tool, tool_use_id: 'late-restart-call' })
  expect((await cold.status()).observation.semantic).toBe('idle')
  await cold.hook('UserPromptSubmit', 'actual-new-prompt', { session_id: 'native-main' })
  expect((await cold.status()).observation.semantic).toBe('active')
  // A semantic reopening does not borrow the old native ending as current input evidence.
  expect((await cold.status()).session.currentActivity?.state).not.toBe('idle')
})

it('a classic-only Provider contributes working and waiting through its own native wire', async () => {
  const h = await fixture('second-protocol', 'grok')
  await h.hook('user_prompt_submit', 'user-prompt', { sessionId: 'native-main', promptId: 'grok-turn' })
  await h.hook('pre_tool_use', 'main-tool', { sessionId: 'native-main', toolName: 'run_terminal_command', toolUseId: 'grok-call', toolInput: {} })
  expect((await h.status()).observation).toMatchObject({ semantic: 'active', readiness: 'ready' })
  await h.hook('pre_tool_use', 'question', { sessionId: 'native-main', toolName: 'ask_user_question', toolUseId: 'grok-question', toolInput: {} })
  expect((await h.status()).observation.semantic).toBe('awaiting-input')
})

it('a real source gap supersedes a more recent classic work signal and preserves the pending request owner', async () => {
  const h = await fixture()
  await h.hook('turn.start', 'native-start', native(1))
  await h.hook('PreToolUse', 'new-main-work', tool)
  await h.hook('AgentMuxActivityUnavailable', 'delivery-gap', native(2, { reason: 'delivery-gap' }))
  expect((await h.status()).observation).toMatchObject({ semantic: 'unknown', readiness: 'ready' })
  await h.hook('PermissionRequest', 'permission', { ...tool, tool_use_id: 'actual-permission' })
  const status = await h.status()
  expect(status.observation).toMatchObject({ semantic: 'awaiting-input', readiness: 'pending' })
  expect(status.session.pendingInteraction?.request.kind).toBe('permission')
  expect(status.run.runId).toBe(h.run.runId)
  expect(status.run.state).toBe('running')
})


it('a stale Core owner rechecks the canonical native end inside CAS before accepting a tool', async () => {
  const h = await fixture()
  await h.hook('turn.start', 'native-start', native(1))
  const peer = await coldOwner(h, false)
  await peer.hook('turn.complete', 'peer-native-end', native(2, { reason: 'answer', isAborted: false, backgroundWork: 'none' }))
  expect((await peer.status()).observation.semantic).toBe('idle')
  await h.hook('PreToolUse', 'stale-owner-tool', { ...tool, tool_use_id: 'late-call' })
  expect((await h.status()).observation.semantic).toBe('idle')
  expect((await h.status()).session.hookReceipt?.decision.activityApplied).toBe(false)
  await peer.hook('turn.start', 'peer-next-native-start', native(3, { turnId: 'next-turn' }))
  await h.hook('PreToolUse', 'stale-ended-owner-tool', { ...tool, tool_use_id: 'next-call' })
  expect((await h.status()).observation.semantic).toBe('active')
  expect((await h.status()).session.hookReceipt?.decision.activityApplied).toBe(true)
})


it('a Provider combining native turn activity and transcript status orders both authoritative sources', async () => {
  const h = await fixture()
  let observer: AgentProviderSessionStatusObservationContext | undefined
  const provider = h.client.providers.get('claude')
  const original = provider.observeSessionStatus
  provider.observeSessionStatus = async value => { observer = value; return { dispose() {} } }
  cleanup.push(async () => { if (original) provider.observeSessionStatus = original; else delete provider.observeSessionStatus })
  await h.hook('turn.start', 'native-start', native(1))
  await h.status()
  expect(observer).toBeDefined()
  observer!.onStatus({ recordId: 'confirmed-native-end', nativeTurnId: 'original-turn', state: 'done', endReason: 'completed', sequence: 1 } as AgentProviderSessionStatus)
  await Promise.all([...Reflect.get(h.client, 'nativeStatusSettlements')])
  const status = await h.status()
  expect(status.session.semanticStatus).toMatchObject({ state: 'done', source: 'native-transcript' })
  expect(status.observation.semantic).toBe('idle')
  expect(status.session.semanticStatus!.evidenceRevision).toBeGreaterThan(status.session.mainSessionActivity!.evidenceRevision!)
  const stamp = status.session.semanticStatus!.evidenceRevision
  const activity = (await h.saved()).recoveryActivity
  const cold = await coldOwner(h)
  // Before the new owner has a live transcript watch, its public SDK projection is unconfirmed.
  const projected = cold.client.agentSession(h.id)
  expect(projected.semanticStatus).toMatchObject({ state: 'running', evidenceRevision: stamp })
  expect(observeAgent({ process: 'running', status: projected.semanticStatus!, retainedStatus: projected.semanticStatus,
    currentActivity: projected.currentActivity, mainSessionActivity: projected.mainSessionActivity,
    timelineCapability: 'complete-events', awaitingRequest: false, terminalCapabilityUnverified: false }, Date.now()).semantic).toBe('unknown')
  expect((await h.saved()).semanticStatus!.evidenceRevision).toBe(stamp)
  expect((await h.saved()).recoveryActivity).toEqual(activity)
})

it('a stale Core owner cannot revive a classic main failure with a delayed tool', async () => {
  const h = await fixture()
  await h.hook('UserPromptSubmit', 'original-classic-prompt', { session_id: 'native-main' })
  const peer = await coldOwner(h, false)
  await peer.hook('StopFailure', 'peer-classic-failure', { session_id: 'native-main', error: 'native failure' })
  await h.hook('PreToolUse', 'late-classic-tool', tool)
  const status = await h.status()
  expect(status.session.semanticStatus?.state).toBe('error')
  expect(status.session.hookReceipt?.decision.activityApplied).toBe(false)
  expect(status.run.state).toBe('running')
})


it('different real Core owner processes retain the original main facts and semantic acceptance order', async () => {
  const h = await fixture('process-recovery')
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_') && key !== 'NODE_OPTIONS'))
  const owner = async (mode: string) => {
    const result = await promisify(execFile)(process.execPath, [new URL('./fixtures/main-activity-owner.mjs', import.meta.url).pathname, h.store.path, h.id, mode], {
      env: { ...env, AGENTMUX_STATE_DIRECTORY: h.directory, AGENTMUX_RUNTIME_DIRECTORY: join(h.directory, 'runtime') }, timeout: 30_000
    })
    return JSON.parse(result.stdout)
  }
  const first = await owner('first'), second = await owner('second'), end = await owner('end')
  expect(new Set([first.pid, second.pid, end.pid]).size).toBe(3)
  for (const value of [first, second, end]) {
    expect(value.sessionId).toBe(h.id)
    expect(value.run.runId).toBe(h.run.runId)
    expect(value.nativeHandle).toEqual(first.nativeHandle)
    expect(value.recoveryActivity.nativeTurnId).toBe('original-turn')
  }
  expect(first.observation.semantic).toBe('active')
  expect(second.observation.semantic).toBe('active')
  expect(second.semanticStatus.evidenceRevision).toBeGreaterThan(first.semanticStatus.evidenceRevision)
  expect(end.recoveryActivity.evidenceRevision).toBeGreaterThan(second.semanticStatus.evidenceRevision)
  expect(end.observation.semantic).toBe('idle')
})

it('child-only ingress leaves the priority of unstamped retained main facts unchanged', async () => {
  const h = await fixture()
  await h.hook('turn.start', 'native-start', native(1))
  const registry = Reflect.get(h.client, 'registry') as AgentMuxAgentSessionRegistry
  await registry.update(h.id, { runId: h.run.runId }, current => {
    const { evidenceRevision: _nativeStamp, ...activity } = current.recoveryActivity!
    const { evidenceRevision: _semanticStamp, ...semantic } = current.semanticStatus!
    return { ...current, semanticStatus: { ...semantic, state: 'error', observedAt: activity.observedAt + 1 },
      updatedAt: current.updatedAt + 1, recoveryActivity: { ...activity, state: 'unknown' } }
  })
  const main = (await h.saved()).recoveryActivity
  const cold = await coldOwner(h)
  expect((await cold.status()).observation.semantic).toBe('idle')
  await cold.hook('turn.start', 'child-start', native(2, { agent_id: 'child', turnId: 'child-turn' }))
  await cold.hook('turn.complete', 'child-end', native(3, { agent_id: 'child', turnId: 'child-turn', reason: 'answer', isAborted: false }))
  const status = await cold.status()
  expect(status.observation.mainSession?.semantic).toBe('idle')
  expect(status.observation.semantic).toBe('idle')
  expect((await h.saved()).recoveryActivity).toEqual(main)
})


it('strict public parsing rejects invalid fact positions without altering the original Session', async () => {
  const h = await fixture()
  await h.hook('turn.start', 'native-start', native(1))
  const original = (await h.status()).session
  for (const field of ['semanticStatus', 'currentActivity', 'mainSessionActivity'] as const) {
    for (const revision of [-1, 0, 'new']) {
      const broken = structuredClone(original)
      Object.assign(broken[field]!, { evidenceRevision: revision })
      expect(() => parseRpcAgentSession(broken)).toThrow()
    }
  }
  expect((await h.status()).session).toEqual(original)
})

it('the exact main activity consumer does not read unrelated Session metadata or reload the registry', async () => {
  const h = await fixture('bounded-consumer')
  await h.hook('turn.start', 'native-start', native(1))
  const original = await h.saved()
  const neighbors = Array.from({ length: 32 }, (_, index) => ({ kind: 'agent' as const, agentSessionId: `unrelated-${index}`,
    providerId: original.providerId, executorId: original.executorId, hostId: original.hostId, workspacePath: original.workspacePath,
    run: { runId: `unrelated-run-${index}` }, retiredRuns: [], hookBindingId: 'b'.repeat(43), hookToken: 't'.repeat(43),
    createdAt: original.createdAt, updatedAt: original.createdAt }))
  for (const neighbor of neighbors) await h.store.compareAndSwap(null, neighbor)
  await (Reflect.get(h.client, 'registry') as AgentMuxAgentSessionRegistry).load('local')
  expect(h.client.agentSessions()).toHaveLength(33)
  const load = vi.spyOn(h.store, 'load'), read = vi.spyOn(h.store, 'readMetadata')
  h.requests.length = 0
  const startedAt = performance.now()
  await h.hook('PreToolUse', 'target-work-only', tool)
  for (let index = 0; index < 20; index++) expect((await h.status()).observation.semantic).toBe('active')
  const elapsedMs = performance.now() - startedAt
  expect([...new Set(h.requests)]).toEqual([h.run.runId])
  expect(load).not.toHaveBeenCalled()
  expect(read.mock.calls.filter(([id]) => id !== h.id)).toEqual([])
  if (process.env.AGENTMUX_MAIN_ACTIVITY_COST_RECEIPT) {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(process.env.AGENTMUX_MAIN_ACTIVITY_COST_RECEIPT, JSON.stringify({ elapsedMs, unrelatedSessions: neighbors.length,
      statusReads: 20, runtimeTargets: [...new Set(h.requests)], metadataTargets: [...new Set(read.mock.calls.map(([id]) => id))], registryLoads: load.mock.calls.length }))
  }
})
