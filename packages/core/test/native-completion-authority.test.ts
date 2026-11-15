import { fixtureEpoch as reshapeFixtureEpoch } from './helpers/fixture-values.js'
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxClient, AgentMuxMemoryAgentSessionStore, AgentProviderRegistry, defineAgentProvider } from '../src/index.js'
import { agentTurnCompletionIdentity, agentTurnEndBoundary } from '../src/agent-session-identity.js'
import type { AgentNativeHookSpecification } from '../src/hook-normalizer.js'
import type { AgentProviderSessionStatusObservationContext } from '../src/agent-provider.js'
import type { AgentMuxClientEvent, AgentMuxStoredAgentSession, AgentProviderId } from '../src/types.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { agentPromptCondition } from '../src/agent-prompt-condition.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import type { DesktopRuntimeClient } from '../../../apps/desktop/src/main/desktop-host.js'
import type { AppConfig } from '../../../apps/desktop/src/shared/contracts.js'

vi.mock('electron', () => ({ app: { isPackaged: false } }))

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const native = new AgentProviderRegistry()
function mainActivityFact(session: AgentMuxStoredAgentSession) {
  const { currentActivityRevision: _projectionRevision, ...fact } = session.semanticStatus!
  return fact
}
const generic: AgentNativeHookSpecification = {
  nativeHandle: { sessionIdKeys: ['session_id'] },
  subagentTracking: { startEvents: ['child-begin'], stopEvents: ['child-settled'], idKeys: ['workerId'] },
  rules: [
    { events: ['begin'], state: 'working', lifecycleEvent: 'turn-start' },
    { events: ['parent-settled'], state: 'done', lifecycleEvent: 'turn-end' },
    { events: ['child-begin'], state: 'working', lifecycleEvent: 'subagent-start' }
  ]
}

// Controlled SDK/native observations are the fixture boundary. Actual candidate Core owns the bound
// HTTP ingress, normalization, registry, public status, event reader, native observer and raw input.
// Built-in declarations are exercised below; this does not claim that a real vendor emitted them.
type NativeFixture = boolean | 'codex-rollout' | 'codex-retained' | 'codex-retained-unavailable'
  | 'codex-retained-without-main' | 'codex-retained-oversized-suffix' | 'codex-retained-invalid-main'
async function fixture(providerId: AgentProviderId, hook = native.get(providerId).hook, observeNative: NativeFixture = false) {
  const root = await mkdtemp(join(tmpdir(), 'amx-completion-'))
  for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key)) vi.stubEnv(key, undefined)
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', root); vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  const retainedChildren = typeof observeNative === 'string' && observeNative !== 'codex-rollout'
  const codexRollout = observeNative === 'codex-rollout' || retainedChildren
  const transcriptPath = join(root, 'native-rollout.jsonl')
  let ordinal = 0
  const appendNative = (...events: Record<string, unknown>[]) => appendFile(transcriptPath, events.map(payload => JSON.stringify({
    type: 'event_msg', ...(payload.type === 'sub_agent_activity' ? {} : { ordinal: ++ordinal }), timestamp: new Date().toISOString(), payload,
  }) + '\n').join(''))
  const retainedAt = Date.now() - 20
  if (codexRollout) {
    await writeFile(transcriptPath, JSON.stringify({ type: 'session_meta', payload: { id: 'original-native', history_mode: 'paginated' } }) + '\n')
    await appendNative({ type: 'task_started', thread_id: 'original-native', turn_id: 'original-turn' })
    if (retainedChildren) {
      await appendNative(
        codexChildItem('retained-child', retainedAt + 1),
        codexChildItem('superseded-child', retainedAt + 2),
        codexChildItem('superseded-child', retainedAt + 3, 'interacted'),
        codexChildItem('legacy-superseded-child', retainedAt + 4),
        { type: 'sub_agent_activity', event_id: 'later-legacy-activity',
          agent_thread_id: 'legacy-superseded-child', kind: 'interrupted' },
        codexChildItem('foreign-child', retainedAt + 4, 'completed', 'foreign-parent'),
        codexChildItem('unlisted-child', retainedAt + 5),
        codexChildItem('retained-child', retainedAt + 10),
      )
      if (observeNative === 'codex-retained-unavailable') await appendFile(transcriptPath, '{invalid native history\n')
      // A regular multi-block native history puts child outcomes outside the recent window.
      if (observeNative === 'codex-retained-oversized-suffix') {
        await appendNative({ type: 'custom_note', text: 'x'.repeat(768 * 1024) })
      } else {
        for (let index = 0; index < 12; index++) await appendNative({ type: 'custom_note', text: 'x'.repeat(96 * 1024) })
      }
      if (observeNative === 'codex-retained-invalid-main')
        await appendNative({ type: 'task_complete', thread_id: 'original-native' })
      else if (observeNative !== 'codex-retained-without-main' && observeNative !== 'codex-retained-oversized-suffix')
        await appendNative({ type: 'task_complete', thread_id: 'original-native', turn_id: 'original-turn' })
    }
  }
  let nativeObserver: AgentProviderSessionStatusObservationContext | undefined
  const provider = defineAgentProvider({ catalog: {
    id: providerId, label: 'Private native completion fixture', executable: 'private-agent', expectedProcess: 'private-agent',
    promptDelivery: 'positional-argv', readySignal: { kind: 'foreground-process', expectedProcess: 'private-agent' },
    hookStrategy: { kind: 'native', installation: 'unmanaged' }, resumeStrategy: { kind: 'none' }, acpStrategy: { kind: 'none' },
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: false, replyCorrelation: 'none' }
  }, buildArgs: (_prompt, args) => [...args], hook,
    ...(observeNative ? { observeSessionStatus: async (context: AgentProviderSessionStatusObservationContext) => {
      nativeObserver = context
      return codexRollout ? native.get('codex').observeSessionStatus!(context) : { dispose() {} }
    } } : {}) })
  const original: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'original-agent', providerId, executorId: providerId,
    hostId: 'local', workspacePath: root, run: { runId: 'original-run' }, retiredRuns: [],
    hookBindingId: 'b'.repeat(43), hookToken: 't'.repeat(43), createdAt: reshapeFixtureEpoch(0, 0, 1), updatedAt: reshapeFixtureEpoch(0, 0, 1),
    nativeHandle: { kind: 'provider', providerId, sessionId: 'original-native', ...(codexRollout ? { transcriptPath } : {}) },
    ...(retainedChildren ? { updatedAt: retainedAt, nativeSubagents: {
      run: { runId: 'original-run' }, providerId, nativeSessionId: 'original-native', unconfirmed: false,
      sessions: ['retained-child', 'superseded-child', 'legacy-superseded-child', 'foreign-child'].map(nativeAgentId => ({
        nativeAgentId, phase: 'running' as const, state: 'working' as const, hookReceiptId: `${nativeAgentId}-start`, observedAt: retainedAt,
      }))
    } } : {}) }
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
  inner.kernel.openInput = async (runId: string) => {
    expect(runId).toBe(original.run.runId)
    return { run: run(), waitWritable: async () => {}, input: async (data: string | Uint8Array) => {
      const startByte = accepted
      accepted += typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength
      return { appliedByteRange: { startByte, endByte: accepted } }
    } }
  }
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
  cleanup.push(async () => { await client.dispose(); 
    expect(inner.kernel.start).not.toHaveBeenCalled(); expect(inner.kernel.stop).not.toHaveBeenCalled(); await rm(root, { recursive: true, force: true }) })
  // The source-mode resolver supplies the same runtime class to Desktop; published declarations have separate private member identities.
  return { client, desktopClient: client as unknown as DesktopRuntimeClient, events, feed, saved, original, root, store, transcriptPath, appendNative,
    rawInput: () => client.writeAgent({ agentSessionId: original.agentSessionId, expectedRun: original.run, source: 'user', data: 'private raw input\r' }),
    observer: async () => { await client.statusAgent(original.agentSessionId); expect(nativeObserver).toBeDefined(); return nativeObserver! } }
}

function codexChildItem(nativeAgentId: string, at: number, kind = 'completed', parent = 'original-native') {
  return { type: 'item_completed', thread_id: parent, turn_id: 'original-turn', completed_at_ms: at,
    item: { type: 'SubAgentActivity', id: 'native-item-' + nativeAgentId, kind, agent_thread_id: nativeAgentId, agent_path: '/root/review' } }
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
    const [{ RuntimeController }, { projectRuntimeEvent }, { agentContextForSession }, { observeAgentSession }] = await Promise.all([
      import('../../../apps/desktop/src/main/runtime-controller.js'), import('../../../apps/desktop/src/renderer/src/lib/session-state.js'),
      import('../../../apps/desktop/src/renderer/src/lib/focus-context.js'), import('../../../apps/desktop/src/renderer/src/lib/agent-observation.js')
    ])
    const h = await fixture('synthetic-raw-consumers', { ...generic,
      resolveSubject: payload => payload.workerId === 'real-child'
        ? { kind: 'child', basis: 'provider-protocol', reason: 'fixture-confirmed-child', nativeSessionId: 'real-child' }
        : { kind: 'main', basis: 'provider-protocol', reason: 'fixture-confirmed-main', nativeSessionId: 'original-native' }
    }, true)
    await h.feed('begin', { session_id: 'original-native' })
    const observer = await h.observer()
    observer.onStatus({ recordId: 'first-complete', nativeTurnId: 'first-turn', state: 'done', endReason: 'completed', sequence: 1 })
    await vi.waitFor(async () => expect((await h.saved()).semanticStatus?.state).toBe('done'))
    const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private fixture' }], executors: {}, workspaces: [],
      appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
    const controller = new RuntimeController(h.store, async () => h.desktopClient)
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
    expect(view.sessions[0]?.status.state).toBe('done')
    expect(observeAgentSession(view.sessions[0] as Extract<typeof view.sessions[number], { kind: 'agent' }>, Date.now()).semantic).toBe('active')
    await h.rawInput()
    expect((await project()).semanticStatus).toEqual(child.semanticStatus)
    await h.client.submitAgentPrompt({ ...agentPromptCondition(h.client.agentSession(h.original.agentSessionId)),
      agentSessionId: h.original.agentSessionId, operationId: 'next-submission', prompt: 'new semantic task', execution: 'immediate' })
    expect((await h.saved()).promptCompletionAdmission).toMatchObject({ submissionId: 'next-submission', intent: { plan: { kind: 'single-phase' } } })
    const consumed = await project()
    expect(consumed.semanticStatus?.idleEvidenceConsumed).toBe(true)
    expect(consumed.semanticStatus?.currentActivityRevision).toBeGreaterThan(child.semanticStatus!.currentActivityRevision!)
    expect(view.sessions[0]?.status.state).toBe('running')
    expect((await controller.snapshot(config)).sessions[0]?.status.state).toBe('running')
    expect(agentContextForSession(view.sessions[0]!, undefined, undefined, undefined, null).bucket).toBe('working')
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
      subagentTracking: { ...tracking, stopEvents: ['proven-child-end'] } }
    // These two final facts are synthetic additions to the protocol, not actual vendor Hook claims.
    const h = await fixture(providerId, hook)
    if (providerId === 'copilot') {
      await h.feed('subagentStart', { sessionId: 'original-native', agentName: 'same' })
      await h.feed('subagentStart', { sessionId: 'original-native', agentName: 'same' })
      await h.feed('proven-main-end', { sessionId: 'original-native' })
      expect((await h.saved()).semanticStatus?.state).toBe('done')
      await h.feed('proven-child-end', { sessionId: 'original-native', agentId: 'first', agentName: 'same' })
      expect(agentTurnCompletionIdentity(await h.saved())).toBeUndefined()
    } else {
      for (const sessionId of ['one', 'two']) await h.feed('subagent_start', { sessionId, subagentType: 'same' })
      await h.feed('proven-main-end', { sessionId: 'original-native' })
      await h.feed('proven-child-end', { sessionId: 'one', subagentType: 'same' })
      expect((await h.saved()).semanticStatus?.state).toBe('done')
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

  it('unique machine IDs retain separate child observations and the original main result', async () => {
    const h = await fixture('synthetic-roster', generic); await h.feed('begin', { session_id: 'original-native' })
    for (const workerId of ['first', 'second']) await h.feed('child-begin', { workerId, name: 'reviewer', type: 'reviewer' })
    await h.feed('parent-settled', {})
    const endedMain = await h.saved()
    expect(endedMain.semanticStatus?.state).toBe('done')
    expect(endedMain.nativeSubagents?.sessions.map(child => child.nativeAgentId)).toEqual(['first', 'second'])
    expect((await h.client.statusAgent(h.original.agentSessionId)).observation).toMatchObject({ semantic: 'active', mainSession: { semantic: 'idle' } })
    await h.feed('child-settled', { workerId: 'first', name: 'reviewer', type: 'reviewer' })
    expect(agentTurnCompletionIdentity(await h.saved())).toBeUndefined()
    await h.feed('child-settled', { workerId: 'second', name: 'reviewer', type: 'reviewer' })
    expect(mainActivityFact(await h.saved())).toEqual(mainActivityFact(endedMain))
    expect((await h.client.statusAgent(h.original.agentSessionId)).observation.semantic).toBe('idle')
    expect(agentTurnCompletionIdentity(await h.saved())).toBeDefined()
  })

  it('missing unique child identity produces unknown aggregate instead of success or permanent working', async () => {
    const h = await fixture('synthetic-roster', generic); await h.feed('begin', {})
    await h.feed('child-begin', { name: 'reviewer' }); await h.feed('parent-settled', {})
    const unknown = await h.saved(); expect(unknown.semanticStatus?.state).toBe('done')
    expect(unknown.nativeSubagents).toMatchObject({ unconfirmed: true, sessions: [] })
    expect(agentTurnCompletionIdentity(unknown)).toBeUndefined()
    expect((await h.client.statusAgent(h.original.agentSessionId)).observation.semantic).toBe('unknown')
    await h.feed('child-settled', { workerId: 'invented', name: 'reviewer' })
    expect((await h.saved()).semanticStatus).toEqual(unknown.semanticStatus)
    expect((await h.rawInput()).appliedByteRange).not.toBeNull()
  })

  it('generic unknown preserves child scope and main cancellation leaves children independent', async () => {
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
    expect((await h.saved()).nativeSubagents).toEqual(beforeUnknown.nativeSubagents)
    expect((await h.client.statusAgent(h.original.agentSessionId)).observation.semantic).toBe('active')
    expect((await h.rawInput()).appliedByteRange).not.toBeNull()
  })

  it('native main success preserves live children and only real child settlement completes the aggregate', async () => {
    const h = await fixture('synthetic-native-parent', generic, true); await h.feed('begin', {})
    for (const workerId of ['first', 'second']) await h.feed('child-begin', { workerId })
    const observer = await h.observer()
    observer.onStatus({ recordId: 'actual-main-end', nativeTurnId: 'original-turn', state: 'done', endReason: 'completed', sequence: 1 })
    await vi.waitFor(() => expect(h.events.some(e => e.type === 'agent-status' && e.evidence?.source === 'native-transcript')).toBe(true))
    const endedMain = await h.saved()
    expect(endedMain.semanticStatus?.state).toBe('done')
    expect((await h.client.statusAgent(h.original.agentSessionId)).observation).toMatchObject({ semantic: 'active', mainSession: { semantic: 'idle' } })
    expect(agentTurnCompletionIdentity(await h.saved())).toBeUndefined()
    expect((await h.rawInput()).appliedByteRange).not.toBeNull()
    await h.feed('child-settled', { workerId: 'first' })
    expect(mainActivityFact(await h.saved())).toEqual(mainActivityFact(endedMain))
    expect((await h.client.statusAgent(h.original.agentSessionId)).observation.semantic).toBe('active')
    await h.feed('child-settled', { workerId: 'second' })
    expect(mainActivityFact(await h.saved())).toEqual(mainActivityFact(endedMain))
    expect((await h.client.statusAgent(h.original.agentSessionId)).observation.semantic).toBe('idle')
    expect(agentTurnCompletionIdentity(await h.saved())).toBeDefined()
  })

  it('Codex observed completion reaches the original CLI and Focus child without altering the main turn', async () => {
    const [{ RuntimeController }, { projectRuntimeEvent }, { agentContextForSession }] = await Promise.all([
      import('../../../apps/desktop/src/main/runtime-controller.js'), import('../../../apps/desktop/src/renderer/src/lib/session-state.js'),
      import('../../../apps/desktop/src/renderer/src/lib/focus-context.js'),
    ])
    const h = await fixture('codex', generic, 'codex-rollout')
    await h.feed('begin', {}); await h.feed('child-begin', { workerId: 'first' }); await h.feed('child-begin', { workerId: 'second' })
    await h.observer()
    const firstStart = (await h.saved()).nativeSubagents!.sessions[0]!.observedAt
    await h.appendNative(
      codexChildItem('first', firstStart - 1),
      codexChildItem('first', Date.now(), 'completed', 'another-native'),
      codexChildItem('second', Date.now(), 'interacted'),
      codexChildItem('unobserved-child', Date.now()),
      { type: 'subagent_stop', thread_id: 'original-native', agent_id: 'second' },
      { type: 'task_complete', thread_id: 'original-native', turn_id: 'original-turn' },
    )
    await vi.waitFor(async () => expect((await h.saved()).semanticStatus).toMatchObject({ state: 'done', source: 'native-transcript' }))
    const original = await h.saved()
    expect(original.nativeSubagents?.sessions.map(child => [child.nativeAgentId, child.phase])).toEqual([['first', 'running'], ['second', 'running']])
    expect((await h.client.statusAgent(h.original.agentSessionId)).observation).toMatchObject({ semantic: 'active', mainSession: { semantic: 'idle' } })

    const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private fixture' }], executors: {}, workspaces: [],
      appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, more: true, saveBookmark: true } } }
    const controller = new RuntimeController(h.store, async () => h.desktopClient)
    controller.commit(await controller.prepare(config)); cleanup.push(async () => controller.dispose())
    const snapshot = await controller.snapshot(config)
    const view = { sessions: snapshot.sessions, timelines: {}, pendingAgentLaunches: {}, tabs: {}, layouts: {}, viewModes: {} }
    const eventStart = h.events.length, firstEnd = Date.now()
    await h.appendNative(codexChildItem('first', firstEnd))
    await vi.waitFor(async () => expect((await h.saved()).nativeSubagents?.sessions[0]).toMatchObject({
      nativeAgentId: 'first', phase: 'ended', state: 'done', outcome: 'completed', observedAt: firstEnd,
    }))
    const sessionEvent = await vi.waitFor(() => {
      const event = h.events.slice(eventStart).find(event => event.type === 'agent-session' && event.session.nativeSubagents?.sessions[0]?.phase === 'ended')
      expect(event).toBeDefined()
      return event!
    })
    const projected = projectRuntimeEvent(view, { type: 'core', hostId: 'local', event: sessionEvent }).state
    expect(projected.tabs).toBe(view.tabs); expect(projected.layouts).toBe(view.layouts)
    const focus = agentContextForSession(projected.sessions[0]!, undefined, undefined, undefined, null)
    expect(focus.nativeSubagents?.rows).toEqual([{ id: 'first', state: 'completed' }, { id: 'second', state: 'running' }])
    expect((await h.saved()).semanticStatus).toEqual(original.semanticStatus)
    expect(h.events.slice(eventStart).filter(event => event.type === 'agent-status')).toEqual([])
    expect((await h.rawInput()).appliedByteRange).not.toBeNull()

    const server = new AgentMuxControlServer({ socketPath: join(h.root, 'child-state.sock'), coreClients: () => [{ hostId: 'local', client: h.client }] })
    await server.start(); cleanup.push(() => server.stop())
    const cli = await runCompiledObjectCli(['--endpoint', `unix:${server.path}`, 'agent', 'inspect', '--session', h.original.agentSessionId], objectCliEnvironment(h.root))
    expect(cli.code, cli.stderr).toBe(0)
    expect(JSON.parse(cli.stdout).result.status).toMatchObject({ run: { runId: h.original.run.runId }, observation: {
      semantic: 'active', subagentSessions: { sessions: [{ nativeAgentId: 'first', outcome: 'completed' }, { nativeAgentId: 'second', phase: 'running' }] }
    } })
    await h.appendNative(codexChildItem('second', Date.now()))
    await vi.waitFor(async () => expect((await h.client.statusAgent(h.original.agentSessionId)).observation.semantic).toBe('idle'))
    expect((await h.saved()).semanticStatus).toEqual(original.semanticStatus)
  })

  it('Codex retained completion settles a known child when the original native source is first watched', async () => {
    const [{ RuntimeController }, { agentContextForSession }] = await Promise.all([
      import('../../../apps/desktop/src/main/runtime-controller.js'), import('../../../apps/desktop/src/renderer/src/lib/focus-context.js'),
    ])
    const h = await fixture('codex', generic, 'codex-retained')
    await h.client.statusAgent(h.original.agentSessionId)
    await vi.waitFor(async () => expect((await h.saved()).nativeSubagents?.sessions[0]).toMatchObject({
      nativeAgentId: 'retained-child', hookReceiptId: 'retained-child-start', phase: 'ended', state: 'done', outcome: 'completed',
    }))
    const saved = await h.saved(), done = saved.nativeSubagents
    expect(done?.sessions).toEqual([
      { ...h.original.nativeSubagents!.sessions[0], phase: 'ended', state: 'done', outcome: 'completed', observedAt: h.original.updatedAt + 10 },
      ...h.original.nativeSubagents!.sessions.slice(1)
    ])
    expect(saved.semanticStatus).toMatchObject({ state: 'done', nativeTurnId: 'original-turn' })
    for (let attempt = 0; attempt < 2; attempt++) await h.client.statusAgent(h.original.agentSessionId)
    expect((await h.saved()).nativeSubagents).toEqual(done)
    expect(done?.run).toEqual(h.original.run)
    const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private fixture' }], executors: {}, workspaces: [],
      appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, more: true, saveBookmark: true } } }
    const controller = new RuntimeController(h.store, async () => h.desktopClient)
    controller.commit(await controller.prepare(config)); cleanup.push(async () => controller.dispose())
    const { sessions } = await controller.snapshot(config)
    expect(agentContextForSession(sessions[0]!, undefined, undefined, undefined, null).nativeSubagents?.rows).toEqual([
      { id: 'retained-child', state: 'completed' }, { id: 'superseded-child', state: 'running' },
      { id: 'legacy-superseded-child', state: 'running' }, { id: 'foreign-child', state: 'running' },
    ])
    const server = new AgentMuxControlServer({ socketPath: join(h.root, 'child-state.sock'), coreClients: () => [{ hostId: 'local', client: h.client }] })
    await server.start(); cleanup.push(() => server.stop())
    const cli = await runCompiledObjectCli(['--endpoint', `unix:${server.path}`, 'agent', 'inspect', '--session', h.original.agentSessionId], objectCliEnvironment(h.root))
    expect(cli.code, cli.stderr).toBe(0)
    expect(JSON.parse(cli.stdout).result.status.observation.subagentSessions).toEqual(done)
    expect((await h.rawInput()).appliedByteRange).not.toBeNull()
  })

  it('Codex retained completion failure leaves original input and live child observation usable', async () => {
    const h = await fixture('codex', generic, 'codex-retained-unavailable')
    await h.client.statusAgent(h.original.agentSessionId)
    await vi.waitFor(() => expect(h.events.some(event => event.type === 'agent-error' &&
      event.code === 'AGENT_NATIVE_SUBAGENT_HISTORY_UNAVAILABLE')).toBe(true))
    expect((await h.saved()).nativeSubagents).toEqual(h.original.nativeSubagents)
    expect((await h.rawInput()).appliedByteRange).not.toBeNull()
    await h.appendNative(codexChildItem('retained-child', Date.now()))
    await vi.waitFor(async () => expect((await h.saved()).nativeSubagents?.sessions[0]).toMatchObject({
      nativeAgentId: 'retained-child', phase: 'ended', outcome: 'completed',
    }))
  })

  it.each([
    'codex-retained-without-main', 'codex-retained-oversized-suffix',
  ] as const)('Codex retained completion recovers independently with %s', async nativeFixture => {
    const h = await fixture('codex', generic, nativeFixture)
    await h.client.statusAgent(h.original.agentSessionId)
    await vi.waitFor(async () => expect((await h.saved()).nativeSubagents?.sessions[0]).toMatchObject({
      nativeAgentId: 'retained-child', phase: 'ended', outcome: 'completed',
    }))
    expect(h.events).toContainEqual(expect.objectContaining({ type: 'agent-error', code: 'AGENT_NATIVE_STATUS_GAP' }))
    expect((await h.saved()).semanticStatus).toBeUndefined()
    expect(h.events.filter(event => event.type === 'agent-status')).toEqual([])
    expect((await h.rawInput()).appliedByteRange).not.toBeNull()
    await h.appendNative({ type: 'task_complete', thread_id: 'original-native', turn_id: 'original-turn' })
    await vi.waitFor(async () => expect((await h.saved()).semanticStatus).toMatchObject({ state: 'done', nativeTurnId: 'original-turn' }))
    expect((await h.client.statusAgent(h.original.agentSessionId)).observation.subagentSessions?.sessions[0]?.outcome).toBe('completed')
  })

  it('Codex retained completion never reads a different native source as the original parent', async () => {
    const h = await fixture('codex', generic, 'codex-retained-without-main')
    await writeFile(h.transcriptPath, JSON.stringify({ type: 'session_meta', payload: { id: 'different-parent' } }) + '\n')
    await h.appendNative(codexChildItem('retained-child', Date.now()))
    await h.client.statusAgent(h.original.agentSessionId)
    await vi.waitFor(() => expect(h.events).toContainEqual(expect.objectContaining({ type: 'agent-error', code: 'AGENT_NATIVE_STATUS_SOURCE_CHANGED' })))
    expect((await h.saved()).nativeSubagents).toEqual(h.original.nativeSubagents)
    expect((await h.rawInput()).appliedByteRange).not.toBeNull()
  })

  it('Codex retained completion does not treat malformed main evidence as an empty recent window', async () => {
    const h = await fixture('codex', generic, 'codex-retained-invalid-main')
    await h.client.statusAgent(h.original.agentSessionId)
    await vi.waitFor(() => expect(h.events).toContainEqual(expect.objectContaining({ type: 'agent-error', code: 'AGENT_NATIVE_STATUS_UNCONFIRMED' })))
    expect((await h.saved()).nativeSubagents).toEqual(h.original.nativeSubagents)
    expect((await h.rawInput()).appliedByteRange).not.toBeNull()
  })

  it('actual original native outcomes retain independent unresolved child observations', async () => {
    const h = await fixture('synthetic-outcome', generic, true); await h.feed('begin', {})
    await h.feed('child-begin', { name: 'same-label' }); await h.feed('child-begin', { workerId: 'known' })
    const observer = await h.observer(), children = (await h.saved()).nativeSubagents
    for (const [sequence, state] of [[1, 'error'], [2, 'unknown'], [3, 'done']] as const) {
      observer.onStatus({ recordId: `native-result-${sequence}`, nativeTurnId: 'original-turn', state, sequence, ...(state === 'unknown' ? { endReason: 'interrupted' as const } : {}) })
      await vi.waitFor(async () => expect((await h.saved()).semanticStatus?.nativeTurnId).toBe('original-turn'))
      await vi.waitFor(async () => expect((await h.saved()).semanticStatus?.state).toBe(state === 'unknown' ? 'running' : state))
      expect((await h.client.statusAgent(h.original.agentSessionId)).session.nativeHandle).toEqual(h.original.nativeHandle)
      expect((await h.saved()).nativeSubagents).toEqual(children)
      expect((await h.client.statusAgent(h.original.agentSessionId)).observation.semantic).toBe('active')
      expect(agentTurnCompletionIdentity(await h.saved())).toBeUndefined()
    }
    expect(h.events.filter(e => e.type === 'agent-status' && e.evidence?.source === 'native-transcript').map(e => e.state)).toEqual(['error', 'unknown', 'done'])
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
  
})
