import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { defineAgentProvider } from '../src/agent-provider.js'
import { createNumberedTerminalInteractionProtocol } from '../src/agent-interaction.js'
import { AgentMuxFileAgentSessionStore, normalizeStoredAgentSession } from '../src/agent-session-store.js'
import { CtxmuxRunAdapter } from '../src/ctxmux-run-adapter.js'
import { defaultAgentMuxHookPort } from '../src/runtime-paths.js'
import {
  nativeHookHasSubagentSubject, normalizeNativeHook, releaseSubagentRoster,
  type AgentNativeHookSpecification
} from '../src/hook-normalizer.js'
import type { AgentMuxClientEvent, AgentMuxStoredAgentSession, NativeHookEnvelope } from '../src/types.js'

const isolation = vi.hoisted(() => ({ homedir: '/synthetic/unset-home' }))
vi.mock('node:os', async importOriginal => ({
  ...await importOriginal<typeof import('node:os')>(), homedir: () => isolation.homedir
}))

type Payload = Record<string, unknown>
type Profile = {
  id: string
  eventName: string
  cancellation: Payload
  waiting: Payload
  ordinary: Payload
  child: Payload
  cancelled(payload: Readonly<Payload>): boolean
  awaits(payload: Readonly<Payload>): boolean
  isChild(payload: Readonly<Payload>): boolean
}
// Two synthetic protocol shapes. These fixtures prove the generic contribution contract, not any
// vendor's native wire format; no native executable, user config or transcript is opened.
const profiles: Profile[] = [
  {
    id: 'flat-payload', eventName: 'notice',
    cancellation: { notice_type: 'cancelled' }, waiting: { notice_type: 'approval' },
    ordinary: { notice_type: 'information' }, child: { parent_session: 'parent-native' },
    cancelled: p => p.notice_type === 'cancelled', awaits: p => p.notice_type === 'approval',
    isChild: p => typeof p.parent_session === 'string' && p.parent_session.length > 0
  },
  {
    id: 'nested-payload', eventName: 'signal',
    cancellation: { extra: { category: 'turn', reason: 'halt' } },
    waiting: { extra: { category: 'input', reason: 'choose' } },
    ordinary: { extra: { category: 'background', reason: 'update' } },
    child: { extra: { scope: 'child' } },
    cancelled: p => p.category === 'turn' && p.reason === 'halt',
    awaits: p => p.category === 'input' && p.reason === 'choose', isChild: p => p.scope === 'child'
  }
]
const agentSessionId = 'payload-session', runId = 'payload-run', token = 't'.repeat(43)
const exec = promisify(execFile)
function specification(profile: Profile): AgentNativeHookSpecification {
  return {
    rules: [
      { events: [profile.eventName], state: 'unknown', matches: profile.cancelled, lifecycleEvent: 'turn-end' },
      { events: [profile.eventName], state: 'waiting', matches: profile.awaits },
      { events: ['turn_open'], state: 'working', lifecycleEvent: 'turn-start' },
      { events: ['PostToolUse'], state: 'blocked' },
      { events: ['ask'], state: 'waiting', toolNames: ['select'] }
    ],
    subagentSubject: profile.isChild,
    nativeHandle: { sessionIdKeys: ['session_id'], transcriptPathKeys: ['transcript_path'] }
  }
}
function envelope(profile: Profile, payload: Payload): NativeHookEnvelope {
  return { receiptId: 'receipt-1', agentSessionId, runId, providerId: profile.id,
    eventName: profile.eventName, payload }
}
function seed(profile: Profile, workspacePath: string): AgentMuxStoredAgentSession {
  return { kind: 'agent', agentSessionId, providerId: profile.id, executorId: profile.id,
    hostId: 'local', workspacePath, run: { runId }, retiredRuns: [],
    hookBindingId: 'b'.repeat(43), hookToken: token, createdAt: 1, updatedAt: 1 }
}

afterEach(() => vi.unstubAllEnvs())
async function harness(profile: Profile) {
  const root = await mkdtemp(join(tmpdir(), 'amux-hook-payload-'))
  const path = join(root, 'sessions.json'), workspacePath = join(root, 'workspace')
  isolation.homedir = join(root, 'home')
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'runtime'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'queue.ndjson'))
  const store = new AgentMuxFileAgentSessionStore(path)
  await store.compareAndSwap(null, seed(profile, workspacePath))
  const provider = defineAgentProvider({
    catalog: {
      id: profile.id, label: 'Synthetic payload protocol', executable: 'synthetic-agent',
      expectedProcess: 'synthetic-agent', promptDelivery: 'positional-argv',
      readySignal: { kind: 'foreground-process', expectedProcess: 'synthetic-agent' },
      hookStrategy: { kind: 'native', installation: 'unmanaged' },
      resumeStrategy: { kind: 'none' }, acpStrategy: { kind: 'none' },
      capabilities: { terminal: true, timeline: 'complete-events', permission: 'respond',
        providerResume: false, replyCorrelation: 'none' }
    },
    buildArgs: (_prompt, args) => [...args], hook: specification(profile),
    interaction: createNumberedTerminalInteractionProtocol({
      questionEvents: ['ask'], questionTools: ['select'], questionCompletionEvents: ['answer-observed'],
      permissionOptions: [
        { id: 'allow', label: 'Allow', kind: 'allow-once', input: '1' },
        { id: 'deny', label: 'Deny', kind: 'reject-once', input: '2' }
      ]
    })
  })
  const run = {
    id: runId, spec: { program: 'synthetic-agent', args: [], cwd: workspacePath, env: {} },
    lineage: null, pid: 123, state: { type: 'running' as const }, latest_output_bytes: 123,
    durable_output_bytes: 123, first_available_byte: 0, attachments: 0, applied_input_bytes: 0,
    current_size: { cols: 80, rows: 24 }
  }
  const create = vi.fn(async () => { throw new Error('Unexpected native Run creation') })
  const input = vi.fn(async () => { throw new Error('Unexpected Agent input') })
  const stop = vi.fn(async () => { throw new Error('Unexpected native Run stop') })
  const status = vi.fn(async (id: string) => { expect(id).toBe(runId); return run })
  const clients: AgentMuxClient[] = [], events: AgentMuxClientEvent[] = []
  async function connect() {
    const adapter = new CtxmuxRunAdapter()
    // Only the SDK transport is controlled. Public connect restores the real durable registry,
    // Run projection, authenticated Hook binding, HTTP listener and Client admission owners.
    Object.assign(adapter, { client: { list: async () => [{ id: runId }], status, start: create, input, stop },
      runtime: { daemonInstanceId: 'synthetic-daemon' } })
    const client = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(path), providers: [provider] })
    Object.assign(client, { kernel: adapter })
    clients.push(client)
    client.onEvent(event => events.push(event))
    await client.connect()
    expect(client.agentSessions().map(s => [s.agentSessionId, s.run.runId])).toEqual([[agentSessionId, runId]])
    expect((await client.listRuns()).map(r => [r.runId, r.state])).toEqual([[runId, 'running']])
    return client
  }
  let client: AgentMuxClient
  try { client = await connect() } catch (error) {
    for (const c of clients) await c.dispose()
    await rm(root, { recursive: true, force: true })
    throw error
  }
  let receipts = 0
  const feed = async (eventName: string, payload: Payload = {}, badToken = false) => {
    const response = await fetch(`http://127.0.0.1:${defaultAgentMuxHookPort()}/v1/events`, {
      method: 'POST', headers: { authorization: `Bearer ${badToken ? 'wrong' : token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ receiptId: `receipt-${++receipts}`, eventName, payload })
    })
    return response.status
  }
  const stored = async () => {
    const sessions = (await new AgentMuxFileAgentSessionStore(path).load()).map(normalizeStoredAgentSession)
    expect(sessions).toHaveLength(1)
    return sessions[0]!
  }
  return { get client() { return client }, root, events, feed, stored, create, input, stop, status,
    reopen: async () => {
      await client.dispose()
      const expected = await new AgentMuxFileAgentSessionStore(path).load()
      const env = { ...process.env }
      for (const key of Object.keys(env)) if (key.startsWith('AGENTMUX_')) delete env[key]
      Object.assign(env, { AGENTMUX_RUNTIME_DIRECTORY: join(root, 'runtime'),
        AGENTMUX_MESSAGE_QUEUE_PATH: join(root, 'queue.ndjson'), AGENTMUX_AGENT_SESSION_STORE: path })
      const script = `
        import os from 'node:os';import {syncBuiltinESMExports} from 'node:module';
        os.homedir=()=>${JSON.stringify(join(root, 'home'))};syncBuiltinESMExports();
        const {AgentMuxFileAgentSessionStore}=await import(${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)});
        console.log(JSON.stringify({pid:process.pid,sessions:await new AgentMuxFileAgentSessionStore(process.argv[1]).load()}));`
      const reopened = JSON.parse((await exec(process.execPath, ['--input-type=module', '-e', script, path], { env, timeout: 8000 })).stdout)
      expect(reopened.pid).not.toBe(process.pid)
      expect(reopened.sessions).toEqual(expected)
      client = await connect()
      return client
    },
    close: async () => {
      for (const c of clients) await c.dispose()
      releaseSubagentRoster(runId)
      await rm(root, { recursive: true, force: true })
    } }
}

describe('payload-dependent Hook contributions', () => {
  it.each(profiles)('$id matches state and lifecycle together, leaving ordinary and unknown payloads neutral', profile => {
    const spec = specification(profile)
    expect(normalizeNativeHook(spec, envelope(profile, profile.cancellation)))
      .toMatchObject({ eventName: profile.eventName, semanticState: 'unknown', lifecycleEvent: 'turn-end' })
    const waiting = normalizeNativeHook(spec, envelope(profile, profile.waiting))
    expect(waiting.semanticState).toBe('waiting')
    expect(waiting.lifecycleEvent).toBeUndefined()
    for (const payload of [profile.ordinary, {}, { tool_input: profile.cancellation }]) {
      const unknown = normalizeNativeHook(spec, envelope(profile, payload))
      expect(unknown.semanticState).toBe('unknown')
      expect(unknown.lifecycleEvent).toBeUndefined()
    }
  })

  it('event, tool and payload predicates all constrain the same first matching rule, evaluated once', () => {
    const matches = vi.fn(p => p.reason === 'halt')
    const spec: AgentNativeHookSpecification = { rules: [
      { events: ['signal'], toolNames: ['shell'], state: 'unknown', matches, lifecycleEvent: 'turn-end' },
      { events: ['signal'], state: 'waiting' }
    ] }
    const profile = profiles[1]!
    expect(normalizeNativeHook(spec, envelope(profile, { tool_name: 'SHELL', extra: { reason: 'halt' } })))
      .toMatchObject({ semanticState: 'unknown', lifecycleEvent: 'turn-end' })
    expect(matches).toHaveBeenCalledOnce()
    expect(normalizeNativeHook(spec, envelope(profile, { tool_name: 'other', reason: 'halt' })).semanticState).toBe('waiting')
    expect(matches).toHaveBeenCalledOnce()
    const topLevelWins = normalizeNativeHook(spec, envelope(profile, { tool_name: 'shell', reason: 'update', extra: { reason: 'halt' } }))
    expect(topLevelWins.semanticState).toBe('waiting')
    expect(topLevelWins.lifecycleEvent).toBeUndefined()
  })

  it.each(profiles)('$id cancellation reaches HTTP, durable receipt and phase while success admission stays unconfirmed', async profile => {
    const h = await harness(profile)
    try {
      expect(await h.feed(profile.eventName, profile.cancellation, true)).toBe(403)
      expect((await h.stored()).hookReceipt).toBeUndefined()
      expect(await h.feed(profile.eventName, profile.waiting)).toBe(204)
      const waiting = (await h.stored()).semanticStatus
      expect(waiting?.state).toBe('waiting')
      expect(await h.feed(profile.eventName, profile.ordinary)).toBe(204)
      expect((await h.stored()).semanticStatus).toEqual(waiting)
      expect((await h.stored()).terminalPromptReadiness).toBeUndefined()
      expect((await h.stored()).hookReceipt?.lifecycleEvent).toBeUndefined()
      h.status.mockClear()
      expect(await h.feed(profile.eventName, profile.cancellation)).toBe(204)
      expect(h.status).toHaveBeenCalledExactlyOnceWith(runId)
      const cancelled = await h.stored()
      expect(cancelled.hookReceipt).toMatchObject({ id: 'receipt-4', eventName: profile.eventName,
        lifecycleEvent: 'turn-end', outputCursorBytes: 123, run: { runId } })
      expect(cancelled.semanticStatus).toEqual(waiting)
      expect(cancelled.terminalPromptReadiness).toEqual({ source: 'native-stop', id: 'receipt-4', run: { runId },
        outputCursorBytes: 123, observedAt: cancelled.hookReceipt!.observedAt })
      await expect(h.client.submitAgentPrompt({ agentSessionId, operationId: 'cancel-is-not-success',
        prompt: 'Synthetic automatic prompt', expectedCompletionId: JSON.stringify([runId, cancelled.hookReceipt!.observedAt]) }))
        .rejects.toMatchObject({ code: 'AGENT_COMPLETION_CHANGED' })
      expect(await h.feed('PostToolUse')).toBe(204)
      expect((await h.stored()).semanticStatus).toEqual(waiting)
      expect(await h.feed('turn_open')).toBe(204)
      expect((await h.stored()).semanticStatus?.state).toBe('working')
      expect(await h.feed('PostToolUse')).toBe(204)
      expect((await h.stored()).semanticStatus?.state).toBe('blocked')
      expect(await h.feed(profile.eventName, profile.cancellation)).toBe(204)
      const beforeRestart = await h.stored()
      await h.reopen()
      expect(h.client.agentSession(agentSessionId).hookReceipt).toEqual(beforeRestart.hookReceipt)
      expect(h.client.agentSession(agentSessionId).terminalPromptReadiness).toEqual(beforeRestart.terminalPromptReadiness)
      expect(await h.feed(profile.eventName, profile.ordinary)).toBe(204)
      const ordinary = await h.stored()
      expect(ordinary.hookReceipt?.lifecycleEvent).toBeUndefined()
      expect(ordinary.terminalPromptReadiness).toEqual(beforeRestart.terminalPromptReadiness)
      expect(ordinary.semanticStatus?.state).toBe('blocked')
      expect(h.events.filter(e => e.type === 'agent-status').map(e => e.state))
        .toEqual(['waiting', 'unknown', 'unknown', 'working', 'blocked', 'unknown', 'unknown'])
      expect((await h.client.listRuns()).map(r => [r.runId, r.state])).toEqual([[runId, 'running']])
      expect(h.create).not.toHaveBeenCalled()
      expect(h.input).not.toHaveBeenCalled()
      expect(h.stop).not.toHaveBeenCalled()
    } finally { await h.close() }
  })

  it.each(profiles)('$id child subject protects the main locator and question completion without a roster', async profile => {
    const h = await harness(profile)
    try {
      const spec = specification(profile)
      expect(spec.subagentTracking).toBeUndefined()
      const main = { session_id: 'main-native', transcript_path: join(h.root, 'main.jsonl') }
      expect(await h.feed('SessionStart', main)).toBe(204)
      const handle = (await h.stored()).nativeHandle
      expect(handle).toEqual({ kind: 'provider', providerId: profile.id, sessionId: 'main-native', transcriptPath: main.transcript_path })
      expect(await h.feed('SessionStart', { ...profile.child, session_id: 'child-native', transcript_path: join(h.root, 'child.jsonl') })).toBe(204)
      expect.soft((await h.stored()).nativeHandle).toEqual(handle)
      const call = { tool_name: 'select', tool_use_id: 'shared-call',
        tool_input: { questions: [{ question: 'Synthetic choice?', options: [{ label: 'First' }, { label: 'Second' }] }] } }
      expect(await h.feed('ask', call)).toBe(204)
      expect((await h.stored()).pendingInteraction?.request).toMatchObject({ kind: 'question', id: 'receipt-3', nativeToolCallId: 'shared-call' })
      expect(await h.feed('answer-observed', { ...call, ...profile.child })).toBe(204)
      expect.soft((await h.stored()).pendingInteraction?.request.id).toBe('receipt-3')
      expect(await h.feed('answer-observed', call)).toBe(204)
      expect((await h.stored()).pendingInteraction).toBeUndefined()
      expect((await h.stored()).nativeHandle).toEqual(handle)
      expect(nativeHookHasSubagentSubject(spec, 'SessionStart', profile.child)).toBe(true)
      expect(nativeHookHasSubagentSubject(spec, 'SessionStart', { tool_input: profile.child })).toBe(false)
      expect(releaseSubagentRoster(runId)).toBe(false)
      await h.reopen()
      expect(h.client.agentSession(agentSessionId).nativeHandle).toEqual(handle)
      expect(h.client.agentSession(agentSessionId).pendingInteraction).toBeUndefined()
      expect((await h.client.listRuns()).map(r => [r.runId, r.state])).toEqual([[runId, 'running']])
      expect(h.create).not.toHaveBeenCalled()
      expect(h.input).not.toHaveBeenCalled()
      expect(h.stop).not.toHaveBeenCalled()
    } finally { await h.close() }
  })

  it('the durable store validates declared canonical evidence and keeps unknown notifications absent', () => {
    const base = seed(profiles[0]!, '/synthetic')
    const receipt = { id: 'receipt', providerId: base.providerId, agentSessionId, run: { runId }, eventName: 'notice', observedAt: 2 }
    expect(normalizeStoredAgentSession({ ...base, hookReceipt: receipt }).hookReceipt).toEqual(receipt)
    expect(normalizeStoredAgentSession({ ...base, hookReceipt: { ...receipt, lifecycleEvent: 'turn-end', outputCursorBytes: 123 } }).hookReceipt)
      .toEqual({ ...receipt, lifecycleEvent: 'turn-end', outputCursorBytes: 123 })
    for (const lifecycleEvent of ['invented', null, 7]) {
      expect(() => normalizeStoredAgentSession({ ...base, hookReceipt: { ...receipt, lifecycleEvent } })).toThrow(/lifecycleEvent is invalid/)
    }
    for (const lifecycleEvent of [undefined, 'permission-request', 'tool-use-end']) {
      expect(() => normalizeStoredAgentSession({ ...base, hookReceipt: { ...receipt, lifecycleEvent, outputCursorBytes: 123 } }))
        .toThrow(/authoritative output cursor/)
    }
  })
})
