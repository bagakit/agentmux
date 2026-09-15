import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentProviderRegistry, type AgentProvider } from '../src/agent-provider.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { normalizeNativeHook, releaseSubagentRoster } from '../src/hook-normalizer.js'
import type {
  AgentMuxClientEvent,
  AgentMuxStoredAgentSession,
  NativeHookEnvelope
} from '../src/types.js'

const mainNativeId = 'shared-root-native-id'
const mainPath = '/synthetic/main-native.jsonl'
const childPath = '/synthetic/child-native.jsonl'
const providers = ['codex', 'claude'] as const
type ProviderId = typeof providers[number]

type HookAdmission = {
  registry: { load(hostId: string): Promise<void> }
  acceptHookEvent(envelope: NativeHookEnvelope, signal: AbortSignal): Promise<void>
}

async function withSession(
  providerId: ProviderId,
  hasMainHandle: boolean,
  verify: (harness: {
    feed(eventName: string, payload?: Record<string, unknown>): Promise<void>
    stored(): Promise<AgentMuxStoredAgentSession>
    reopened(): Promise<AgentMuxStoredAgentSession>
    events: AgentMuxClientEvent[]
  }) => Promise<void>,
  provider?: AgentProvider
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-hook-identity-'))
  const path = join(root, 'agent-sessions.json')
  const store = new AgentMuxFileAgentSessionStore(path)
  const agentSessionId = randomUUID()
  const runId = randomUUID()
  await store.compareAndSwap(null, {
    kind: 'agent', agentSessionId, providerId, executorId: providerId,
    hostId: 'local', workspacePath: '/synthetic', run: { runId }, retiredRuns: [],
    hookBindingId: 'synthetic-binding', hookToken: 'synthetic-token',
    outputCursorBytes: 0, createdAt: 1, updatedAt: 1,
    ...(hasMainHandle ? {
      nativeHandle: { kind: 'provider' as const, providerId, sessionId: mainNativeId, transcriptPath: mainPath }
    } : {})
  })
  // Actual Hook admission and persistence; no kernel connection, input, resize or Agent process.
  const client = new AgentMuxClient({ store, ...(provider ? { providers: [provider] } : {}) })
  const owner = client as unknown as HookAdmission
  const events: AgentMuxClientEvent[] = []
  client.onEvent((event) => events.push(event))
  let receipt = 0
  const readOne = async (reader: AgentMuxFileAgentSessionStore): Promise<AgentMuxStoredAgentSession> => {
    const sessions = await reader.load() as readonly AgentMuxStoredAgentSession[]
    expect(sessions).toHaveLength(1)
    return sessions[0]!
  }
  try {
    await owner.registry.load('local')
    await verify({
      feed: async (eventName, payload = {}) => {
        await owner.acceptHookEvent({
          receiptId: `receipt-${++receipt}`, agentSessionId, runId, providerId, eventName,
          payload: { hook_event_name: eventName, session_id: mainNativeId,
            transcript_path: mainPath, tool_name: 'shell', tool_use_id: `tool-${receipt}`,
            tool_input: { command: 'SYNTHETIC' }, ...payload }
        }, AbortSignal.timeout(5_000))
      },
      stored: () => readOne(store),
      reopened: () => readOne(new AgentMuxFileAgentSessionStore(path)),
      events
    })
  } finally {
    releaseSubagentRoster(runId)
    await client.dispose()
    await rm(root, { recursive: true, force: true })
  }
}

describe('Provider Hook native handle belongs to the main subject', () => {
  it.each(providers.flatMap((providerId) =>
    ['PreToolUse', 'PostToolUse', 'PermissionRequest'].map((eventName) => ({ providerId, eventName }))
  ))('$providerId child $eventName sharing the root ID cannot replace the durable main handle', async ({ providerId, eventName }) => {
    await withSession(providerId, true, async ({ feed, stored, reopened, events }) => {
      // Codex 0.159 ordinary child hooks pair the shared root session_id with child agent_id/path.
      await feed(eventName, { agent_id: 'child-thread-id', transcript_path: childPath })
      const session = await stored()
      expect(session.nativeHandle).toEqual({ kind: 'provider', providerId,
        sessionId: mainNativeId, transcriptPath: mainPath })
      expect(session.hookReceipt).toMatchObject({ id: 'receipt-1', eventName })
      expect(session.semanticStatus?.state).toBe(eventName === 'PermissionRequest' ? 'waiting' : 'working')
      const statuses = events.filter((event) => event.type === 'agent-status')
      const timeline = events.filter((event) => event.type === 'agent-timeline')
      expect(statuses).toHaveLength(1)
      expect(timeline.length).toBeGreaterThan(0)
      expect((await reopened()).nativeHandle).toEqual(session.nativeHandle)
    })
  })

  it.each(providers.flatMap((providerId) =>
    ['PreToolUse', 'PostToolUse', 'PermissionRequest', 'SubagentStart', 'SubagentStop']
      .map((eventName) => ({ providerId, eventName }))
  ))('$providerId child $eventName cannot first adopt a native handle', async ({ providerId, eventName }) => {
    await withSession(providerId, false, async ({ feed, stored, reopened, events }) => {
      await feed(eventName, {
        transcript_path: childPath,
        ...(!eventName.startsWith('Subagent') ? { agent_id: 'child-thread-id' } : {})
      })
      expect((await stored()).nativeHandle).toBeUndefined()
      expect((await stored()).hookReceipt).toMatchObject({ eventName })
      expect(events.filter((event) => event.type === 'agent-timeline').length).toBeGreaterThan(0)
      await feed('SessionStart')
      expect((await reopened()).nativeHandle).toEqual({ kind: 'provider', providerId,
        sessionId: mainNativeId, transcriptPath: mainPath })
    })
  })

  it.each(providers)('%s lifecycle child events without an ID cannot replace an existing handle', async (providerId) => {
    await withSession(providerId, true, async ({ feed, stored, reopened }) => {
      await feed('SubagentStart', { transcript_path: childPath })
      expect((await stored()).nativeHandle).toMatchObject({ transcriptPath: mainPath })
      await feed('SubagentStop', { transcript_path: childPath })
      expect((await reopened()).nativeHandle).toMatchObject({ transcriptPath: mainPath })
    })
  })

  it.each(providers)('%s main adoption and valid path updates survive Store reopen', async (providerId) => {
    await withSession(providerId, false, async ({ feed, stored, reopened }) => {
      await feed('SessionStart')
      expect((await stored()).nativeHandle).toMatchObject({ transcriptPath: mainPath })
      await feed('PreToolUse', { agent_id: null, transcript_path: '/synthetic/updated-main.jsonl',
        tool_input: { agent_id: 'tool-argument-is-not-the-hook-subject' } })
      expect((await stored()).nativeHandle).toMatchObject({ transcriptPath: '/synthetic/updated-main.jsonl' })
      await feed('PostToolUse', { agent_id: '  ', transcript_path: '/synthetic/final-main.jsonl' })
      await feed('Stop', { transcript_path: '/synthetic/stopped-main.jsonl' })
      expect((await reopened()).nativeHandle).toEqual({ kind: 'provider', providerId,
        sessionId: mainNativeId, transcriptPath: '/synthetic/stopped-main.jsonl' })
    })
  })

  it.each(providers)('%s child metadata filtering preserves roster completion and timeline', async (providerId) => {
    await withSession(providerId, true, async ({ feed, stored, reopened, events }) => {
      await feed('SubagentStart', { agent_id: 'child-thread-id', transcript_path: childPath })
      await feed('Stop')
      expect((await stored()).semanticStatus?.state).toBe('working')
      await feed('SubagentStop', { agent_id: 'child-thread-id', transcript_path: childPath })
      const session = await reopened()
      expect(session.semanticStatus?.state).toBe('done')
      expect(session.nativeHandle).toMatchObject({ transcriptPath: mainPath })
      expect(events.filter((event) => event.type === 'agent-status').at(-1)).toMatchObject({ state: 'done' })
      expect(events.filter((event) => event.type === 'agent-timeline')).toHaveLength(3)
    })
  })

  it('uses declared identity keys and event names, without a Provider-name branch', () => {
    const runId = randomUUID()
    const specification = {
      rules: [{ events: ['Work', 'ChildBorn'], state: 'working' as const }],
      subagentTracking: { startEvents: ['ChildBorn'], stopEvents: ['ChildFinished'],
        mainStopEvents: ['MainDone'], idKeys: ['worker_key'] },
      nativeHandle: { sessionIdKeys: ['native_id'], transcriptPathKeys: ['record_path'] }
    }
    const normalize = (eventName: string, payload: Record<string, unknown> = {}) => normalizeNativeHook(specification, {
      receiptId: randomUUID(), agentSessionId: 'synthetic-session', runId, providerId: 'codex', eventName,
      payload: { native_id: mainNativeId, record_path: mainPath, ...payload }
    })
    try {
      expect(normalize('Work', { worker_key: 'worker-1', record_path: childPath }).nativeHandle).toBeUndefined()
      expect(normalize('ChildBorn', { record_path: childPath }).nativeHandle).toBeUndefined()
      expect(normalize('ChildFinished', { record_path: childPath }).nativeHandle).toBeUndefined()
      expect(normalize('Work', { agent_id: 'undeclared-field' }).nativeHandle).toMatchObject({ transcriptPath: mainPath })
    } finally {
      releaseSubagentRoster(runId)
    }
  })

  it('preserves a Provider without subordinate subject declarations', () => {
    const event = new AgentProviderRegistry().get('pi').normalizeHook({
      receiptId: 'pi-main', agentSessionId: 'pi-session', runId: randomUUID(), providerId: 'pi',
      eventName: 'agent_start', payload: { session_id: 'pi-native-id', session_file: mainPath,
        agent_id: 'ordinary-unowned-field' }
    })
    expect(event.nativeHandle).toEqual({ kind: 'provider', providerId: 'pi',
      sessionId: 'pi-native-id', transcriptPath: mainPath })
  })

  it.each(['agent_id', 'agentId', 'subagent_id'])('omitted optional idKeys uses the same %s child subject as the roster', async (idKey) => {
    const base = new AgentProviderRegistry().get('codex')
    const specification = {
      ...base.hook,
      subagentTracking: { startEvents: ['ChildBorn'], stopEvents: ['ChildFinished'], mainStopEvents: ['Stop'] }
    }
    const provider: AgentProvider = { ...base, hook: specification,
      normalizeHook: (envelope) => normalizeNativeHook(specification, envelope) }
    await withSession('codex', false, async ({ feed, stored, reopened, events }) => {
      await feed('PreToolUse', { [idKey]: 'child-native-id', transcript_path: childPath })
      expect((await stored()).nativeHandle).toBeUndefined()
      await feed('SessionStart')
      await feed('ChildBorn', { [idKey]: 'child-native-id', transcript_path: childPath })
      await feed('PostToolUse', { [idKey]: 'child-native-id', transcript_path: childPath })
      expect((await stored()).nativeHandle).toMatchObject({ transcriptPath: mainPath })
      await feed('Stop')
      expect((await stored()).semanticStatus?.state).toBe('working')
      await feed('ChildFinished', { [idKey]: 'child-native-id', transcript_path: childPath })
      expect((await reopened()).nativeHandle).toMatchObject({ transcriptPath: mainPath })
      expect((await stored()).semanticStatus?.state).toBe('done')
      expect(events.filter((event) => event.type === 'agent-timeline')).toHaveLength(6)
    }, provider)
  })
})
