import { mkdtemp, open, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { afterEach, expect, it, vi } from 'vitest'
import * as SourceCore from '../src/index.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { AgentMuxHostedTransferReader } from '../src/hosted-value.js'
import { sendHookReceipt, HOOK_OWNER_TIMEOUT_MS } from '../src/agent-hook-delivery.js'
import { hostedTestOwner, hostedTestFence } from './helpers/hosted-runtime-port.js'
import { ObjectCliProbe } from './helpers/object-cli-rpc.js'
import { runtimeDiagnosticNotice, projectRuntimeEvent } from '../../../apps/desktop/src/renderer/src/lib/session-state.js'
import { composerSubmitMode } from '../../../apps/desktop/src/renderer/src/lib/composer-submit-mode.js'
import { TransientErrorNotice } from '../../../apps/desktop/src/renderer/src/components/TransientErrorNotice.js'
import type { AgentMuxClientEvent, AgentMuxStoredAgentSession } from '../src/types.js'
import type { AgentProviderSessionStatusObservationContext } from '../src/agent-provider.js'
import type { RuntimeEvent, SessionSnapshot } from '../../../apps/desktop/src/shared/contracts.js'

// These are the first-party Desktop consumer's existing dependencies, not Core dependencies.
const desktopModules = createRequire(new URL('../../../apps/desktop/package.json', import.meta.url))
const { createElement } = desktopModules('react')
const { renderToStaticMarkup } = desktopModules('react-dom/server')

// Client, SQLite Store and durability Error share the same actually compiled module.
const core: typeof SourceCore & { sendHookReceipt?: typeof sendHookReceipt,
  AgentMuxRpcService?: typeof AgentMuxRpcService, AgentMuxHostedRuntimeService?: typeof AgentMuxHostedRuntimeService,
  AgentMuxHostedTransferReader?: typeof AgentMuxHostedTransferReader } = process.env.AMX_HOOK_CORE_ENTRY
  ? await import(/* @vite-ignore */ process.env.AMX_HOOK_CORE_ENTRY) : SourceCore
const sender = core.sendHookReceipt ?? sendHookReceipt
const SID = 'hook-owner', RUN = 'original-run', PROVIDER = 'controlled-hook-observer'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks(); vi.unstubAllEnvs()
})
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

async function fixture(observe: (context: AgentProviderSessionStatusObservationContext) => Promise<{ dispose(): void }>) {
  const root = await mkdtemp(join(tmpdir(), 'amx-hook-aux-')), path = join(root, 'sessions.sqlite')
  for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key)) vi.stubEnv(key, undefined)
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', root); vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  if (process.env.AMX_HOOK_OBJECT_CLI) vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', process.env.AMX_HOOK_OBJECT_CLI)
  const provider = core.defineAgentProvider({ catalog: {
    id: PROVIDER, label: 'Controlled auxiliary observer', executable: 'synthetic-agent', expectedProcess: 'synthetic-agent',
    promptDelivery: 'positional-argv', readySignal: { kind: 'foreground-process', expectedProcess: 'synthetic-agent' },
    hookStrategy: { kind: 'native', installation: 'unmanaged' }, resumeStrategy: { kind: 'none' }, acpStrategy: { kind: 'none' },
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'respond', providerResume: false, replyCorrelation: 'none' }
  }, buildArgs: (_prompt, args) => [...args], hook: {
    nativeHandle: { sessionIdKeys: ['session_id'] }, rules: [
      { events: ['begin'], state: 'working', lifecycleEvent: 'turn-start' },
      { events: ['finish'], state: 'done', lifecycleEvent: 'turn-end' }
    ] } })
  const observed = vi.fn(observe), configured = { ...provider, observeSessionStatus: observed }
  const store = new core.AgentMuxFileAgentSessionStore(path)
  const original: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: SID, providerId: PROVIDER, executorId: PROVIDER,
    hostId: 'local', workspacePath: root, run: { runId: RUN }, retiredRuns: [],
    hookBindingId: 'b'.repeat(43), hookToken: 't'.repeat(43), createdAt: 1, updatedAt: 1,
    nativeHandle: { kind: 'provider', providerId: PROVIDER, sessionId: 'original-native' },
    terminalPromptReadiness: { source: 'native-stop', id: 'prior-stop', observedAt: 1, run: { runId: RUN } } }
  await store.compareAndSwap(null, original)
  const client = new core.AgentMuxClient({ store, providers: [configured] }), inner = client as any
  await inner.registry.load('local'); inner.connected = true
  const run = (id: string) => ({ runId: id, lifecycleOperationId: null, program: 'synthetic-agent', args: [], workspacePath: root,
    pid: null, state: { type: 'running' }, cols: 80, rows: 24, latestOutputBytes: 12, firstAvailableByte: 0,
    acceptedInputBytes: 0, nativeService: null })
  inner.kernel.isConnected = () => true; inner.kernel.status = vi.fn(async (id: string) => run(id))
  inner.kernel.identity = () => ({ buildIdentity: 'controlled-hook-aux', protocolVersion: 1, daemonInstanceId: 'private-daemon' })
  for (const method of ['start', 'stop', 'connect', 'write', 'attach']) inner.kernel[method] = vi.fn(() => { throw new Error('Forbidden lifecycle/input: ' + method) })
  const cancel = vi.spyOn(inner.promptSubmission, 'cancelReadiness')
  const readiness = vi.spyOn(inner.promptSubmission, 'observeReadiness').mockImplementation(() => {})
  const events: AgentMuxClientEvent[] = []; client.onEvent(event => { events.push(event) })
  Object.defineProperty(inner.hookServer, 'port', { value: 0 })
  await inner.hookServer.start()
  const binding = inner.hookServer.createBinding(SID, PROVIDER); await binding.bindRun(RUN)
  const nativeFetch = globalThis.fetch.bind(globalThis), statuses: number[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (...args) => {
    const response = await nativeFetch(...args); statuses.push(response.status); return response
  })
  const body = (receiptId: string, eventName = 'begin') => JSON.stringify({ receiptId, eventName, payload: { session_id: 'original-native' } })
  const post = (receiptId: string, eventName = 'begin') => nativeFetch(binding.endpoint.url, { method: 'POST',
    headers: { authorization: `Bearer ${binding.endpoint.token}`, 'content-type': 'application/json' }, body: body(receiptId, eventName) })
  cleanup.push(async () => {
    await client.dispose()
    for (const method of ['start', 'stop', 'connect', 'write', 'attach']) expect(inner.kernel[method]).not.toHaveBeenCalled()
    await rm(root, { recursive: true, force: true })
  })
  const stored = async () => (await store.load() as readonly AgentMuxStoredAgentSession[]).find(item => item.agentSessionId === SID)!
  return { root, path, store, client, inner, binding, observed, events, statuses, cancel, readiness, stored, post,
    send: (id: string, eventName = 'begin') => sender(binding.endpoint.url, binding.endpoint.token, body(id, eventName)),
    coreClients: () => [{ hostId: 'local', client }], original }
}

it('acknowledges_confirmed_hook_before_auxiliary_setup_settles', async () => {
  const held = gate(), dispose = vi.fn(), f = await fixture(async () => { await held.promise; return { dispose } })
  cleanup.push(async () => { held.release(); await wait(5) })
  const delivery = await f.send('confirmed-setup').then(() => undefined, error => ({
    error: error instanceof Error ? error.message : String(error), statuses: [...f.statuses]
  }))
  expect((await f.stored()).hookReceipt?.id).toBe('confirmed-setup')
  expect(f.inner.registry.isDurabilityUnconfirmed(SID)).toBe(false)
  expect(delivery, JSON.stringify(delivery)).toBeUndefined() // Preserve the actual owner rejection without reporter truncation.
  expect(f.statuses).toEqual([204])
  expect(f.cancel).toHaveBeenCalledWith(SID) // Original prompt handling is inside this ACK.
  await wait(HOOK_OWNER_TIMEOUT_MS + 30)
  expect(f.observed).toHaveBeenCalledTimes(1); expect(f.inner.nativeStatusWatches.size).toBe(1)
  expect(f.events.some(event => event.type === 'agent-error' && event.code === 'HOOK_DELIVERY_TIMEOUT')).toBe(false)
  const before = await f.stored(); expect((await f.post('confirmed-setup')).status).toBe(204)
  expect(await f.stored()).toEqual(before); expect(f.observed).toHaveBeenCalledTimes(1)
})

it('acknowledges_confirmed_hook_without_waiting_for_existing_auxiliary_pending', async () => {
  const held = gate(), f = await fixture(async () => ({ dispose() {} }))
  await f.send('initial-watch')
  const watch = f.inner.nativeStatusWatches.get(SID)
  watch.pending = held.promise // Controlled original pending lane, not a forged Hook commit.
  cleanup.push(async () => { held.release() })
  await expect(f.send('confirmed-pending', 'finish')).resolves.toBeUndefined()
  expect(f.statuses).toEqual([204, 204]); expect((await f.stored()).hookReceipt?.id).toBe('confirmed-pending')
  expect(f.readiness).toHaveBeenCalled() // End-turn prompt observation precedes the ACK too.
  await wait(HOOK_OWNER_TIMEOUT_MS + 30)
  expect(f.observed).toHaveBeenCalledTimes(1); expect(f.inner.nativeStatusWatches.get(SID)).toBe(watch)
})

it('keeps_hook_unknown_while_the_real_store_lock_prevents_commit', async () => {
  const f = await fixture(async () => ({ dispose() {} })), handle = await open(`${f.path}.lock`, 'a+', 0o600)
  const { tryLock, unlock } = createRequire(import.meta.url)('fs-native-extensions')
  expect(tryLock(handle.fd)).toBe(true)
  try {
    const response = await f.post('precommit-held'); expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ accepted: 'unknown', stage: 'owner' })
    expect(f.client.agentSession(SID).hookReceipt).toBeUndefined(); expect(f.observed).not.toHaveBeenCalled()
  } finally { unlock(handle.fd); await handle.close() }
  expect((await f.stored()).hookReceipt).toBeUndefined()
})

it('keeps_readable_sqlite_receipt_unknown_after_real_commit_when_sync_fails', async () => {
  const f = await fixture(async () => ({ dispose() {} })), probe = await open(f.path, 'r'), prototype = Object.getPrototypeOf(probe)
  await probe.close()
  const identity = await stat(f.path), originalSync = prototype.sync
  let hits = 0, armed = true
  const fault = vi.spyOn(prototype, 'sync').mockImplementation(async function(this: any) {
    const current = await this.stat()
    if (armed && current.ino === identity.ino && current.dev === identity.dev) {
      armed = false; hits += 1
      throw Object.assign(new Error('Controlled current SQLite sync failure'), { code: 'ENOSPC' })
    }
    return await originalSync.call(this)
  })
  try {
    const response = await f.post('sync-unconfirmed'); expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ accepted: 'unknown', stage: 'owner' })
    expect(hits).toBe(1); expect(f.inner.registry.isDurabilityUnconfirmed(SID)).toBe(true)
    expect((await f.stored()).hookReceipt?.id).toBe('sync-unconfirmed')
    expect(f.observed).not.toHaveBeenCalled()
  } finally { fault.mockRestore() }
})

it('publishes_auxiliary_failure_through_hosted_desktop_and_same_owner_public_cli_retry', async () => {
  let unavailable!: AgentProviderSessionStatusObservationContext
  const dispose = vi.fn(), f = await fixture(async context => { unavailable = context; return { dispose } })
  const hosted = new (core.AgentMuxHostedRuntimeService ?? AgentMuxHostedRuntimeService)(f.client, null, () => hostedTestOwner(f.client))
  const service = new (core.AgentMuxRpcService ?? AgentMuxRpcService)({ coreClients: f.coreClients, hostedRuntime: () => hosted })
  const reader = new (core.AgentMuxHostedTransferReader ?? AgentMuxHostedTransferReader)(), observed: AgentMuxClientEvent[] = []
  const subscription = await service.subscribe('runtime.events', { fence: hostedTestFence, consumerId: 'aux-native-status-reader' }, event => {
    if (event.type !== 'snapshot') return
    const value = reader.accept(event.data) as { kind: string; event?: AgentMuxClientEvent } | undefined
    if (value?.kind === 'event' && value.event) observed.push(value.event)
  }, { principal: { kind: 'user', id: 'private-owner' } })
  await subscription.start?.(); cleanup.push(async () => { await subscription.dispose(); await service.dispose(); await hosted.dispose() })
  await f.send('aux-failure'); unavailable.onUnavailable('AGENT_NATIVE_STATUS_UNAVAILABLE', 'Controlled auxiliary source failure')
  await vi.waitFor(() => expect(observed.some(event => event.type === 'agent-error' && event.code === 'AGENT_NATIVE_STATUS_UNAVAILABLE')).toBe(true))
  const diagnostic = observed.find(event => event.type === 'agent-error' && event.code === 'AGENT_NATIVE_STATUS_UNAVAILABLE')!
  const saved = f.client.agentSession(SID)
  const snapshot: SessionSnapshot = { kind: 'agent', id: SID, providerId: saved.providerId, executorId: saved.executorId,
    hostId: saved.hostId, workspacePath: saved.workspacePath, createdAt: saved.createdAt, updatedAt: saved.updatedAt,
    label: 'Original Agent', processState: 'running', latestOutputBytes: 12, agentSessionUpdatedAt: saved.updatedAt,
    nativeHandle: saved.nativeHandle!, semanticStatus: saved.semanticStatus!, status: saved.semanticStatus!,
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'respond', providerResume: false, replyCorrelation: 'none' },
    control: { kind: 'agent', hostId: 'local', agentSessionId: SID, run: { runId: RUN } } }
  const state = { sessions: [snapshot], timelines: {}, pendingAgentLaunches: {}, tabs: {}, layouts: {}, viewModes: {} }
  const wrapped = { type: 'core', hostId: 'local', event: diagnostic } as RuntimeEvent
  const notice = runtimeDiagnosticNotice(state, wrapped)!
  expect(notice.subject).toEqual(snapshot.control); expect(notice.message).toContain('retained Session, Run and input remain available')
  const reduced = projectRuntimeEvent(state, wrapped).state
  expect(reduced.sessions[0]).toBe(snapshot); expect(reduced.tabs).toBe(state.tabs); expect(reduced.layouts).toBe(state.layouts)
  expect(composerSubmitMode(snapshot)).toMatchObject({ canType: true, canSubmit: true })
  const markup = renderToStaticMarkup(createElement(TransientErrorNotice, { error: notice.message, dismissed: false,
    lastError: notice.message, summary: notice.summary, kind: 'indeterminate', onDismiss() {}, onReopen() {} }))
  expect(markup).toContain('Controlled auxiliary source failure'); expect(markup).toContain('role="status"')
  expect(runtimeDiagnosticNotice(state, { ...wrapped, hostId: 'foreign' })).toBeNull()
  expect(f.inner.nativeStatusWatches.size).toBe(0); expect(dispose).toHaveBeenCalledTimes(1)
  const inspected = await service.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: SID } })
  expect(inspected.session.run).toEqual({ runId: RUN }); expect(inspected.status?.run.state).toBe('running')
  expect(f.observed).toHaveBeenCalledTimes(2); expect(f.inner.nativeStatusWatches.size).toBe(1)
  const probe = new ObjectCliProbe(request => service.call(request.method as any, request.params as any))
  await probe.start(); cleanup.push(() => probe.stop())
  const cli = await probe.run(['agent', 'inspect', '--session', SID])
  expect(cli.code, cli.stderr).toBe(0); expect(JSON.parse(cli.stdout).result.session.run).toEqual({ runId: RUN })
  expect(f.observed).toHaveBeenCalledTimes(2)
  const before = await f.stored(); expect((await f.post('aux-failure')).status).toBe(204)
  expect(await f.stored()).toEqual(before)
})

it('contains_detached_provider_lookup_rejection_without_changing_confirmed_receipt', async () => {
  const f = await fixture(async () => ({ dispose() {} })), get = f.inner.providers.get.bind(f.inner.providers)
  vi.spyOn(f.inner.providers, 'get').mockImplementation((id: unknown) => {
    if (f.inner.registry.get(SID).hookReceipt?.id === 'provider-rejection') throw new core.AgentMuxError('Controlled observer provider lookup rejection', 'AGENT_NATIVE_STATUS_UNAVAILABLE')
    return get(id)
  })
  await f.send('provider-rejection')
  await vi.waitFor(() => expect(f.events.some(event => event.type === 'agent-error' && event.message.includes('Controlled observer provider lookup rejection'))).toBe(true))
  expect(f.statuses).toEqual([204]); expect((await f.stored()).hookReceipt?.id).toBe('provider-rejection')
  expect(f.inner.registry.isDurabilityUnconfirmed(SID)).toBe(false)
})

it.each(['disconnect', 'replacement'] as const)('disposes_late_auxiliary_setup_handle_%s', async change => {
  const held = gate(), dispose = vi.fn(), f = await fixture(async () => { await held.promise; return { dispose } })
  cleanup.push(async () => { held.release(); await wait(10) })
  await f.send('late-setup'); const old = f.inner.nativeStatusWatches.get(SID)
  f.events.splice(0)
  if (change === 'disconnect') await f.client.disconnect()
  else { old.controller.abort(); f.inner.nativeStatusWatches.set(SID, { key: 'replacement', controller: new AbortController(), pending: Promise.resolve() }) }
  held.release(); await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1))
  expect(old.controller.signal.aborted).toBe(true)
  expect(f.events.some(event => event.type === 'agent-status')).toBe(false)
})

it.each(['Run', 'native source'] as const)('fences_late_auxiliary_callback_after_%s_changes', async changed => {
  let context!: AgentProviderSessionStatusObservationContext
  const f = await fixture(async c => { context = c; return { dispose() {} } })
  await f.send('before-change'); const current = await f.stored()
  const { nativeBinding: _binding, hookReceipt: _receipt, terminalPromptReadiness: _readiness, ...prior } = current
  const replacement = changed === 'Run' ? { ...prior, run: { runId: 'replacement-run' }, retiredRuns: [current.run], updatedAt: Date.now() }
    : { ...current, nativeHandle: { ...current.nativeHandle!, sessionId: 'replacement-native' }, updatedAt: Date.now() }
  await f.store.compareAndSwap(current, replacement); await f.client.refreshAgentSession(SID, replacement.run)
  const before = await f.stored()
  f.events.splice(0)
  context.onStatus({ recordId: 'late-old-source', nativeTurnId: 'late-turn', state: 'error', failure: {
    code: 'CONTROLLED_NATIVE_FAILURE', message: 'Old source must not write', nativeTurnId: 'late-turn', recovery: 'No replay' } })
  await f.inner.nativeStatusWatches.get(SID).pending
  expect(await f.stored()).toEqual(before)
  expect(f.events.some(event => event.type === 'agent-status')).toBe(false)
})
