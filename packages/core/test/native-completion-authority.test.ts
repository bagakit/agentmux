import { fixtureEpoch as reshapeFixtureEpoch } from './helpers/fixture-values.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxClient, AgentMuxMemoryAgentSessionStore, AgentProviderRegistry, defineAgentProvider } from '../dist/index.js'
import { agentTurnCompletionIdentity, agentTurnEndBoundary } from '../dist/agent-session-identity.js'
import { releaseSubagentRoster } from '../dist/hook-normalizer.js'
import type { AgentNativeHookSpecification } from '../src/hook-normalizer.js'
import type { AgentProviderSessionStatusObservationContext } from '../src/agent-provider.js'
import type { AgentMuxClientEvent, AgentMuxStoredAgentSession, AgentProviderId } from '../src/types.js'
import { AgentMuxControlServer } from '../dist/public-rpc-server.js'
import { agentPromptCondition } from '../dist/agent-prompt-condition.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import { RuntimeController } from '../../../apps/desktop/src/main/runtime-controller.js'
import { projectRuntimeEvent } from '../../../apps/desktop/src/renderer/src/lib/session-state.js'
import { agentContextForSession } from '../../../apps/desktop/src/renderer/src/lib/focus-context.js'
import type { AppConfig } from '../../../apps/desktop/src/shared/contracts.js'

vi.mock('electron', () => ({ app: { isPackaged: false } }))

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const native = new AgentProviderRegistry()
const generic: AgentNativeHookSpecification = {
  nativeHandle: { sessionIdKeys: ['session_id'] },
  subagentTracking: { startEvents: ['child-begin'], stopEvents: ['child-settled'], mainStopEvents: ['parent-settled'], idKeys: ['workerId'] },
  rules: [
    { events: ['begin'], state: 'working', lifecycleEvent: 'turn-start' },
    { events: ['parent-settled'], state: 'done', lifecycleEvent: 'turn-end' },
    { events: ['child-begin'], state: 'working', lifecycleEvent: 'subagent-start' }
  ]
}

// Controlled SDK/native observations are the fixture boundary. Actual built Core owns the bound
// HTTP ingress, normalization, registry, public status, event reader, native observer and raw input.
// Built-in declarations are exercised below; this does not claim that a real vendor emitted them.
async function fixture(providerId: AgentProviderId, hook = native.get(providerId).hook, observeNative = false) {
  const root = await mkdtemp(join(tmpdir(), 'amx-completion-'))
  for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key)) vi.stubEnv(key, undefined)
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', root); vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  let nativeObserver: AgentProviderSessionStatusObservationContext | undefined
  const provider = defineAgentProvider({ catalog: {
    id: providerId, label: 'Private native completion fixture', executable: 'private-agent', expectedProcess: 'private-agent',
    promptDelivery: 'positional-argv', readySignal: { kind: 'foreground-process', expectedProcess: 'private-agent' },
    hookStrategy: { kind: 'native', installation: 'unmanaged' }, resumeStrategy: { kind: 'none' }, acpStrategy: { kind: 'none' },
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'respond', providerResume: false, replyCorrelation: 'none' }
  }, buildArgs: (_prompt, args) => [...args], hook,
    ...(observeNative ? { observeSessionStatus: async (context: AgentProviderSessionStatusObservationContext) => {
      nativeObserver = context; return { dispose() {} }
    } } : {}) })
  const original: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'original-agent', providerId, executorId: providerId,
    hostId: 'local', workspacePath: root, run: { runId: 'original-run' }, retiredRuns: [],
    hookBindingId: 'b'.repeat(43), hookToken: 't'.repeat(43), createdAt: reshapeFixtureEpoch(0, 0, 1), updatedAt: reshapeFixtureEpoch(0, 0, 1),
    nativeHandle: { kind: 'provider', providerId, sessionId: 'original-native' } }
  const store = new AgentMuxMemoryAgentSessionStore(); await store.compareAndSwap(null, original)
  const client = new AgentMuxClient({ store, providers: [provider] }), inner = client as any
  await inner.registry.load('local'); inner.connected = true
  let accepted = 0
  const run = () => ({ nativeService: null, runId: original.run.runId, lifecycleOperationId: null, program: 'private-agent', args: [],
    workspacePath: root, pid: null, state: { type: 'running' }, cols: 80, rows: 24, latestOutputBytes: 0,
    firstAvailableByte: 0, acceptedInputBytes: accepted })
  inner.kernel.isConnected = () => true; inner.kernel.status = async () => run()
  inner.kernel.list = async () => [run()]
  inner.kernel.identity = () => ({ buildIdentity: 'private', protocolVersion: 1, daemonInstanceId: 'private-daemon' })
  for (const method of ['start', 'stop']) inner.kernel[method] = vi.fn(() => { throw new Error('Forbidden lifecycle: ' + method) })
  // Control the SDK transport only; raw input still goes through the public Core original-target guards.
  inner.kernel.client = { status: async () => ({ id: original.run.runId, state: { type: 'running' }, spec: { program: 'private-agent', args: [], cwd: root, env: {} },
    pid: null, current_size: { cols: 80, rows: 24 }, latest_output_bytes: 0, first_available_byte: 0, applied_input_bytes: accepted, native_service: null }),
    recoverableInput: async (input: { data: string; runId: string }) => {
      expect(input.runId).toBe(original.run.runId)
      const start_byte = accepted; accepted += Buffer.byteLength(input.data)
      return { run: { id: original.run.runId, state: { type: 'running' }, spec: { program: 'private-agent', args: [], cwd: root, env: {} },
        pid: null, current_size: { cols: 80, rows: 24 }, latest_output_bytes: 0, first_available_byte: 0, applied_input_bytes: accepted, native_service: null },
        receipt: { start_byte, end_byte: accepted, data: input.data } }
    } }
  inner.kernel.runtime = { daemonInstanceId: 'private-daemon' }
  vi.spyOn(inner.promptSubmission, 'observeReadiness').mockImplementation(() => {})
  const events: AgentMuxClientEvent[] = []; client.onEvent(event => events.push(event))
  Object.defineProperty(inner.hookServer, 'port', { value: 0 }); await inner.hookServer.start()
  const binding = inner.hookServer.createBinding(original.agentSessionId, providerId); await binding.bindRun(original.run.runId)
  let nextReceipt = 0
  const feed = async (eventName: string, payload: Record<string, unknown> = {}) => {
    const response = await fetch(binding.endpoint.url, { method: 'POST', headers: { authorization: `Bearer ${binding.endpoint.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ receiptId: `native-${++nextReceipt}`, eventName, payload }) })
    const body = await response.text(); expect(response.status, body).toBe(204)
  }
  const saved = async () => (await store.load() as readonly AgentMuxStoredAgentSession[])[0]!
  cleanup.push(async () => { await client.dispose(); releaseSubagentRoster(original.run.runId)
    expect(inner.kernel.start).not.toHaveBeenCalled(); expect(inner.kernel.stop).not.toHaveBeenCalled(); await rm(root, { recursive: true, force: true }) })
  return { client, events, feed, saved, original, root, store,
    rawInput: () => client.writeAgent({ agentSessionId: original.agentSessionId, expectedRun: original.run, source: 'user', data: 'private raw input\r' }),
    observer: async () => { await client.statusAgent(original.agentSessionId); expect(nativeObserver).toBeDefined(); return nativeObserver! } }
}

const gates = [
  { provider: 'copilot', begin: 'userPromptSubmitted', gate: 'agentStop', next: 'postToolUse', key: 'sessionId' },
  { provider: 'gemini', begin: 'BeforeAgent', gate: 'AfterAgent', next: 'AfterTool', key: 'session_id' },
  { provider: 'grok', begin: 'user_prompt_submit', gate: 'stop', next: 'post_tool_use', key: 'sessionId' }
] as const

describe('native completion authority through actual Core consumers', () => {
  it.each([
    { provider: 'synthetic-raw-state', hook: generic, end: 'parent-settled', payload: {} },
    { provider: 'hermes', hook: native.get('hermes').hook, end: 'on_session_end', payload: { extra: { completed: true } } }
  ])('$provider raw editing and paste preserve completed work through Core and actual CLI', async p => {
    const h = await fixture(p.provider, p.hook)
    await h.feed(p.end, p.payload)
    const before = await h.saved(), completion = agentTurnCompletionIdentity(before)
    expect(completion).toBeDefined()
    for (const data of ['draft', '\r', '\u001b[A', '\u001b[<64;20;10M']) {
      expect((await h.client.writeAgent({ agentSessionId: h.original.agentSessionId, expectedRun: h.original.run, source: 'user', data })).appliedByteRange).not.toBeNull()
    }
    await h.client.pasteAgent({ agentSessionId: h.original.agentSessionId, expectedRun: h.original.run,
      text: 'first line\nsecond line', terminalData: 'first line\nsecond line' })
    expect((await h.saved()).semanticStatus).toEqual(before.semanticStatus)
    expect(agentTurnCompletionIdentity(await h.saved())).toBe(completion)
    const server = new AgentMuxControlServer({ socketPath: join(h.root, 'raw-state.sock'), coreClients: () => [{ hostId: 'local', client: h.client }] })
    await server.start(); cleanup.push(() => server.stop())
    const result = await runCompiledObjectCli(['--endpoint', `unix:${server.path}`, 'agent', 'inspect', '--session', h.original.agentSessionId], objectCliEnvironment(h.root))
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout).result.status.observation).toMatchObject({ process: 'running', semantic: 'idle', readiness: 'ready' })
  })

  it('semantic admission still consumes completion and native events update Main Renderer and Focus in order', async () => {
    const h = await fixture('synthetic-raw-consumers', { ...generic,
      resolveSubject: payload => payload.workerId === 'real-child'
        ? { kind: 'child', basis: 'provider-protocol', reason: 'fixture-confirmed-child', nativeSessionId: 'real-child' }
        : { kind: 'main', basis: 'provider-protocol', reason: 'fixture-confirmed-main', nativeSessionId: 'original-native' }
    }, true)
    const observer = await h.observer()
    observer.onStatus({ recordId: 'first-complete', nativeTurnId: 'first-turn', state: 'done', endReason: 'completed', sequence: 1 })
    await vi.waitFor(async () => expect((await h.saved()).semanticStatus?.state).toBe('done'))
    const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private fixture' }], executors: {}, workspaces: [],
      appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
    const controller = new RuntimeController(h.store, async () => h.client)
    controller.commit(await controller.prepare(config)); cleanup.push(async () => controller.dispose())
    const snapshot = await controller.snapshot(config)
    let view = { sessions: snapshot.sessions, timelines: {}, pendingAgentLaunches: {}, tabs: {}, layouts: {}, viewModes: {} }
    const originalTabs = view.tabs, originalLayouts = view.layouts
    const project = async () => {
      const session = (await h.client.statusAgent(h.original.agentSessionId)).session
      view = projectRuntimeEvent(view, { type: 'core', hostId: 'local', event: { type: 'agent-session', session } }).state
      expect(view.tabs).toBe(originalTabs); expect(view.layouts).toBe(originalLayouts)
      return session
    }
    await h.rawInput(); await project()
    expect(view.sessions[0]?.status.state).toBe('done')
    expect((await controller.snapshot(config)).sessions[0]?.status.state).toBe('done')
    await h.feed('child-begin', { workerId: 'real-child' })
    const child = await project()
    expect(view.sessions[0]?.status.state).toBe('working')
    await h.rawInput()
    expect((await project()).semanticStatus).toEqual(child.semanticStatus)
    await h.client.submitAgentPrompt({ ...agentPromptCondition(h.client.agentSession(h.original.agentSessionId)),
      agentSessionId: h.original.agentSessionId, operationId: 'next-submission', prompt: 'new semantic task' })
    expect((await h.saved()).promptCompletionAdmission).toMatchObject({ submissionId: 'next-submission', intent: { plan: { kind: 'single-phase' } } })
    const consumed = await project()
    expect(consumed.semanticStatus?.idleEvidenceConsumed).toBe(true)
    expect(consumed.semanticStatus?.currentActivityRevision).toBeGreaterThan(child.semanticStatus!.currentActivityRevision!)
    expect(view.sessions[0]?.status.state).toBe('running')
    expect((await controller.snapshot(config)).sessions[0]?.status.state).toBe('running')
    expect(agentContextForSession(view.sessions[0]!, undefined, undefined, undefined, null).stateLabel).toBe('Activity unknown')
    expect(projectRuntimeEvent(view, { type: 'core', hostId: 'local', event: { type: 'agent-session', session: child } }).state).toBe(view)
    observer.onStatus({ recordId: 'next-start', nativeTurnId: 'next-turn', state: 'working', sequence: 2 })
    await vi.waitFor(async () => expect((await h.saved()).semanticStatus?.state).toBe('working'))
    await project()
    expect(agentContextForSession(view.sessions[0]!, undefined, undefined, undefined, null).bucket).toBe('working')
    observer.onStatus({ recordId: 'next-complete', nativeTurnId: 'next-turn', state: 'done', endReason: 'completed', sequence: 3 })
    await h.feed('child-settled', { workerId: 'real-child' })
    await vi.waitFor(async () => expect((await h.saved()).semanticStatus?.state).toBe('done'))
    await project()
    expect(view.sessions[0]?.status.state).toBe('done')
    expect((await controller.snapshot(config)).sessions[0]?.status.state).toBe('done')
  })
  it.each(gates)('$provider gate cannot complete, mint readiness or latch out continued work', async p => {
    const h = await fixture(p.provider), main = { [p.key]: 'original-native' }
    await h.feed(p.begin, main); const started = await h.saved()
    await h.feed(p.gate, { ...main, stopReason: 'end_turn', stop_hook_active: true, stopHookActive: true, lastAssistantMessage: 'Finished' })
    const gated = await h.saved()
    expect(gated.semanticStatus).toEqual(started.semanticStatus)
    expect(gated.hookReceipt).toMatchObject({ lifecycleEvent: null, decision: { activityApplied: false, lifecycleApplied: false } })
    expect(gated.terminalPromptReadiness).toBeUndefined(); expect(agentTurnCompletionIdentity(gated)).toBeUndefined()
    expect(agentTurnEndBoundary(gated)).toBeUndefined()
    await h.feed(p.next, { ...main, tool_name: 'shell', toolName: 'shell' })
    expect((await h.saved()).hookReceipt?.decision?.activityApplied).toBe(true)
    expect((await h.client.statusAgent(h.original.agentSessionId)).observation.semantic).toBe('active')
    expect(h.events.filter(e => e.type === 'agent-status').map(e => e.state)).toEqual(['working', 'working'])
    expect((await h.rawInput()).appliedByteRange).not.toBeNull()
  })

  it('Copilot same-name starts with no unique ID never masquerade as one finished child', async () => {
    const h = await fixture('copilot'); await h.feed('userPromptSubmitted', { sessionId: 'original-native' })
    for (let i = 0; i < 2; i++) await h.feed('subagentStart', { sessionId: 'original-native', agentName: 'reviewer' })
    await h.feed('agentStop', { sessionId: 'original-native' })
    for (const agentId of ['first', 'second']) {
      await h.feed('subagentStop', { sessionId: 'original-native', agentName: 'reviewer', agentId, stopReason: 'end_turn' })
      const s = await h.saved(); expect(s.hookReceipt?.subject?.kind).toBe('child')
      expect(s.hookReceipt?.lifecycleEvent).toBeNull(); expect(agentTurnCompletionIdentity(s)).toBeUndefined()
    }
    expect(h.events.some(e => e.type === 'agent-status' && e.state === 'done')).toBe(false)
    expect((await h.rawInput()).appliedByteRange).not.toBeNull()
  })

  it.each(['copilot', 'grok'] as const)('%s declared identity keys survive an explicitly proven generic final fact', async providerId => {
    const source = native.get(providerId).hook, tracking = source.subagentTracking!
    const hook = { ...source, rules: [...source.rules,
      { events: ['proven-main-end'], state: 'done' as const, lifecycleEvent: 'turn-end' as const }],
      subagentTracking: { ...tracking, mainStopEvents: ['proven-main-end'], stopEvents: ['proven-child-end'] } }
    // These two final facts are synthetic additions to the protocol, not actual vendor Hook claims.
    const h = await fixture(providerId, hook)
    if (providerId === 'copilot') {
      await h.feed('subagentStart', { sessionId: 'original-native', agentName: 'same' })
      await h.feed('subagentStart', { sessionId: 'original-native', agentName: 'same' })
      await h.feed('proven-main-end', { sessionId: 'original-native' })
      expect((await h.saved()).semanticStatus?.state).toBe('running')
      await h.feed('proven-child-end', { sessionId: 'original-native', agentId: 'first', agentName: 'same' })
      expect(agentTurnCompletionIdentity(await h.saved())).toBeUndefined()
    } else {
      for (const sessionId of ['one', 'two']) await h.feed('subagent_start', { sessionId, subagentType: 'same' })
      await h.feed('proven-main-end', { sessionId: 'original-native' })
      await h.feed('proven-child-end', { sessionId: 'one', subagentType: 'same' })
      expect((await h.saved()).semanticStatus?.state).toBe('working')
      expect(agentTurnCompletionIdentity(await h.saved())).toBeUndefined()
      await h.feed('proven-child-end', { sessionId: 'two', subagentType: 'same' })
      expect((await h.saved()).semanticStatus?.state).toBe('done')
    }
  })

  it('Grok same-type native children retain distinct identity and never replace the original main', async () => {
    const h = await fixture('grok'); await h.feed('user_prompt_submit', { sessionId: 'original-native' })
    for (const sessionId of ['child-one', 'child-two']) {
      await h.feed('subagent_start', { sessionId, subagentType: 'reviewer' })
      expect((await h.saved()).hookReceipt?.subject).toMatchObject({ kind: 'child', nativeSessionId: sessionId })
      expect((await h.saved()).nativeHandle).toEqual(h.original.nativeHandle)
    }
    await h.feed('stop', { sessionId: 'original-native' })
    await h.feed('subagent_stop', { sessionId: 'child-one', subagentType: 'reviewer' })
    const s = await h.saved(); expect(s.hookReceipt?.lifecycleEvent).toBeNull(); expect(agentTurnCompletionIdentity(s)).toBeUndefined()
    await h.feed('stop_failure', { sessionId: 'child-two', subagentType: 'reviewer', error: 'server_error' })
    expect((await h.saved()).nativeHandle).toEqual(h.original.nativeHandle)
    expect((await h.saved()).semanticStatus?.state).toBe('working')
  })

  it.each([{ event: 'stop_failure', state: 'error' }, { event: 'stop_cancelled', state: 'running' }])('Grok $event is a real non-success end', async p => {
    const h = await fixture('grok'); await h.feed('user_prompt_submit', { sessionId: 'original-native' })
    await h.feed(p.event, { sessionId: 'original-native', error: 'server_error', reason: 'user_interrupt' })
    const ended = await h.saved(); expect(ended.semanticStatus?.state).toBe(p.state)
    expect(ended.hookReceipt?.lifecycleEvent).toBe('turn-end'); expect(agentTurnCompletionIdentity(ended)).toBeUndefined()
    expect(ended.terminalPromptReadiness?.source).toBe('native-stop')
    expect(h.events.some(e => e.type === 'agent-status' && e.state === 'done')).toBe(false)
    expect((await h.rawInput()).appliedByteRange).not.toBeNull()
  })

  it('unique machine IDs survive same labels and types in the shared roster', async () => {
    const h = await fixture('synthetic-roster', generic); await h.feed('begin', { session_id: 'original-native' })
    for (const workerId of ['first', 'second']) await h.feed('child-begin', { workerId, name: 'reviewer', type: 'reviewer' })
    await h.feed('parent-settled', {}); expect((await h.saved()).semanticStatus?.state).toBe('working')
    await h.feed('child-settled', { workerId: 'first', name: 'reviewer', type: 'reviewer' })
    expect(agentTurnCompletionIdentity(await h.saved())).toBeUndefined()
    await h.feed('child-settled', { workerId: 'second', name: 'reviewer', type: 'reviewer' })
    expect((await h.saved()).semanticStatus?.state).toBe('done'); expect(agentTurnCompletionIdentity(await h.saved())).toBeDefined()
  })

  it('missing unique child identity produces unknown aggregate instead of success or permanent working', async () => {
    const h = await fixture('synthetic-roster', generic); await h.feed('begin', {})
    await h.feed('child-begin', { name: 'reviewer' }); await h.feed('parent-settled', {})
    const unknown = await h.saved(); expect(unknown.semanticStatus?.state).toBe('running')
    expect(agentTurnCompletionIdentity(unknown)).toBeUndefined()
    expect((await h.client.statusAgent(h.original.agentSessionId)).observation.semantic).toBe('unknown')
    await h.feed('child-settled', { workerId: 'invented', name: 'reviewer' })
    expect((await h.saved()).semanticStatus).toEqual(unknown.semanticStatus)
    expect((await h.rawInput()).appliedByteRange).not.toBeNull()
  })

  it('generic unknown preserves child scope and continued tool activity; explicit cancellation ends that scope', async () => {
    const hook = { ...generic, rules: [...generic.rules, { events: ['tool-continued'], state: 'working' as const, lifecycleEvent: 'tool-use-end' as const }] }
    const h = await fixture('synthetic-unknown', hook, true)
    await h.feed('begin', {}); await h.feed('child-begin', { workerId: 'still-live' })
    const observer = await h.observer(), beforeUnknown = await h.saved()
    observer.onStatus({ recordId: 'unconfirmed-state', nativeTurnId: 'original-turn', state: 'unknown', sequence: 1 })
    await vi.waitFor(() => expect(h.events.some(e => e.type === 'agent-error' && e.code === 'AGENT_NATIVE_STATUS_UNCONFIRMED')).toBe(true))
    expect((await h.saved()).semanticStatus).toEqual(beforeUnknown.semanticStatus)
    expect((await h.saved()).activityCommit).toEqual(beforeUnknown.activityCommit)
    await h.feed('tool-continued', {})
    expect((await h.saved()).hookReceipt?.decision?.activityApplied).toBe(true)
    await h.feed('parent-settled', {})
    expect((await h.saved()).semanticStatus?.state).toBe('working')
    expect(agentTurnCompletionIdentity(await h.saved())).toBeUndefined()
    observer.onStatus({ recordId: 'exact-cancelled', nativeTurnId: 'original-turn', state: 'unknown', endReason: 'interrupted', sequence: 2 })
    await vi.waitFor(async () => expect((await h.saved()).semanticStatus?.state).toBe('running'))
    expect(releaseSubagentRoster(h.original.run.runId)).toBe(false)
    expect((await h.rawInput()).appliedByteRange).not.toBeNull()
  })

  it('native main success preserves live children and only real child settlement completes the aggregate', async () => {
    const h = await fixture('synthetic-native-parent', generic, true); await h.feed('begin', {})
    for (const workerId of ['first', 'second']) await h.feed('child-begin', { workerId })
    const observer = await h.observer()
    observer.onStatus({ recordId: 'actual-main-end', nativeTurnId: 'original-turn', state: 'done', endReason: 'completed', sequence: 1 })
    await vi.waitFor(() => expect(h.events.some(e => e.type === 'agent-status' && e.evidence?.source === 'native-transcript')).toBe(true))
    expect((await h.saved()).semanticStatus?.state).toBe('working')
    expect(agentTurnCompletionIdentity(await h.saved())).toBeUndefined()
    expect((await h.rawInput()).appliedByteRange).not.toBeNull()
    await h.feed('child-settled', { workerId: 'first' })
    expect((await h.saved()).semanticStatus?.state).toBe('working')
    await h.feed('child-settled', { workerId: 'second' })
    expect((await h.saved()).semanticStatus?.state).toBe('done')
    expect(agentTurnCompletionIdentity(await h.saved())).toBeDefined()
  })

  it('actual original native outcome settles unresolved children and releases the existing roster', async () => {
    const h = await fixture('synthetic-outcome', generic, true); await h.feed('begin', {})
    await h.feed('child-begin', { name: 'same-label' }); await h.feed('child-begin', { workerId: 'known' })
    const observer = await h.observer()
    for (const [sequence, state] of [[1, 'error'], [2, 'unknown'], [3, 'done']] as const) {
      observer.onStatus({ recordId: `native-result-${sequence}`, nativeTurnId: 'original-turn', state, sequence, ...(state === 'unknown' ? { endReason: 'interrupted' as const } : {}) })
      await vi.waitFor(async () => expect((await h.saved()).semanticStatus?.nativeTurnId).toBe('original-turn'))
      await vi.waitFor(async () => expect((await h.saved()).semanticStatus?.state).toBe(state === 'unknown' ? 'running' : state))
      expect((await h.client.statusAgent(h.original.agentSessionId)).session.nativeHandle).toEqual(h.original.nativeHandle)
    }
    expect(h.events.filter(e => e.type === 'agent-status' && e.evidence?.source === 'native-transcript').map(e => e.state)).toEqual(['error', 'unknown', 'done'])
    expect(releaseSubagentRoster(h.original.run.runId)).toBe(false)
  })
})

it('Codex Stop and SubagentStop remain pre-veto even with confirmed original process-native identity', () => {
  const main = { kind: 'provider' as const, providerId: 'codex', sessionId: 'original-native' }
  for (const eventName of ['Stop', 'SubagentStop']) {
    const child = eventName === 'SubagentStop' ? { agent_id: 'child-native' } : {}
    const normalized = native.get('codex').normalizeHook({ receiptId: eventName, agentSessionId: 'original-agent', runId: 'codex-private-run',
      providerId: 'codex', eventName, payload: { session_id: main.sessionId, ...child } },
    { nativeHandle: main, processNativeHandle: main, processNativeChildSessionIds: ['child-native'] })
    expect(normalized.semanticState).toBe('unknown'); expect(normalized.lifecycleEvent).toBeNull()
  }
  releaseSubagentRoster('codex-private-run')
})
