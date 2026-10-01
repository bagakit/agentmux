import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  AgentMuxClient,
  AgentMuxFileAgentSessionStore,
  agentPromptCondition,
  normalizeAgentTimelineMutation,
  projectSessionUserMessages,
  type AgentMuxStoredAgentSession,
  type AgentSessionHistoryPage,
  type AgentSessionUserMessage,
  type AgentTimelineSnapshot
} from '@agentmux/core'

const roots: string[] = []
const clients: AgentMuxClient[] = []

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.dispose()))
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })))
})

const RUN_ID = 'author-run'
const AGENT_SESSION_ID = 'author-agent'
const WORKSPACE = '/tmp/author-agent'

function storedSession(extra: Partial<AgentMuxStoredAgentSession> = {}): AgentMuxStoredAgentSession {
  return {
    kind: 'agent',
    agentSessionId: AGENT_SESSION_ID,
    providerId: 'traex',
    executorId: 'traex',
    hostId: 'local',
    workspacePath: WORKSPACE,
    run: { runId: RUN_ID },
    retiredRuns: [],
    hookBindingId: 'binding-author',
    hookToken: 'token-author',
    createdAt: 100,
    updatedAt: 100,
    ...extra
  }
}

function runProjection(acceptedInputBytes: number) {
  return {
    nativeService: null,
    runId: RUN_ID,
    lifecycleOperationId: null,
    program: 'traex',
    args: [] as string[],
    workspacePath: WORKSPACE,
    pid: 999,
    state: { type: 'running' as const },
    cols: 80,
    rows: 24,
    latestOutputBytes: 0,
    firstAvailableByte: 0,
    acceptedInputBytes
  }
}

type Internals = {
  kernel: Record<string, unknown>
  registry: { load(hostId: string): Promise<void> }
}

async function createFixtureClient(): Promise<{
  client: AgentMuxClient
  store: AgentMuxFileAgentSessionStore
  writes: string[]
}> {
  const storePath = join(await mkdtemp(join(tmpdir(), 'author-test-')), 'sessions.json')
  roots.push(dirname(storePath))
  const store = new AgentMuxFileAgentSessionStore(storePath)
  await store.compareAndSwap(null, storedSession())

  const client = new AgentMuxClient({ store })
  clients.push(client)

  const state = client as unknown as Internals
  await state.registry.load('local')

  let cursor = 0
  const writes: string[] = []
  const appliedOperations = new Map<string, { startByte: number; endByte: number }>()

  state.kernel.isConnected = () => true
  state.kernel.identity = () => ({
    daemonInstanceId: 'daemon-author',
    protocolVersion: 1,
    buildIdentity: 'test'
  })
  state.kernel.status = async () => runProjection(cursor)
  state.kernel.input = async (_runId: string, operation: { operationId: string; expectedByte: number; data: string }) => {
    const existing = appliedOperations.get(operation.operationId)
    if (existing) {
      return {
        run: runProjection(cursor),
        appliedByteRange: existing
      }
    }
    writes.push(operation.data)
    const range = {
      startByte: operation.expectedByte,
      endByte: operation.expectedByte + Buffer.byteLength(operation.data)
    }
    cursor = range.endByte
    appliedOperations.set(operation.operationId, range)
    return {
      run: runProjection(cursor),
      appliedByteRange: range
    }
  }
  ;(client as unknown as { connected: boolean }).connected = true

  return { client, store, writes }
}

describe('Core user message author facts and projection', () => {
  it('accepts a prompt with an empty Agent field without upgrading its conflicting Human claim', async () => {
    const { client, store, writes } = await createFixtureClient()
    await client.submitAgentPrompt({
      ...agentPromptCondition(client.agentSession(AGENT_SESSION_ID)),
      agentSessionId: AGENT_SESSION_ID,
      operationId: 'empty-agent-conflict',
      prompt: 'Keep this accepted input unattributed',
      authorAgentSessionId: '',
      authorHuman: true,
      allowUncertainTurn: true
    })
    expect(writes).toEqual(['Keep this accepted input unattributed\r'])
    const timeline = await new AgentMuxFileAgentSessionStore(store.path).loadTimeline(AGENT_SESSION_ID)
    expect(timeline.items).toHaveLength(1)
    expect(timeline.items[0]!.authorAgentSessionId).toBeUndefined()
    expect(timeline.items[0]!.authorHuman).toBeUndefined()
    expect(projectSessionUserMessages({ agentSessionId: AGENT_SESSION_ID, timeline }).map(message => message.author))
      .toEqual([{ kind: 'unknown' }])
  })

  it('projects explicit human, known agent, and unknown authors with conflict precedence', () => {
    const timeline: AgentTimelineSnapshot = {
      agentSessionId: AGENT_SESSION_ID,
      revision: 1,
      items: [
        {
          id: 'msg-human',
          agentSessionId: AGENT_SESSION_ID,
          kind: 'user_message',
          status: 'complete',
          source: 'user',
          createdAt: 1000,
          updatedAt: 1000,
          title: 'Prompt',
          content: 'Hello from human',
          authorHuman: true
        },
        {
          id: 'msg-agent',
          agentSessionId: AGENT_SESSION_ID,
          kind: 'user_message',
          status: 'complete',
          source: 'user',
          createdAt: 2000,
          updatedAt: 2000,
          title: 'Prompt',
          content: 'Hello from agent',
          authorAgentSessionId: 'agent-peer-1'
        },
        {
          id: 'msg-conflict',
          agentSessionId: AGENT_SESSION_ID,
          kind: 'user_message',
          status: 'complete',
          source: 'user',
          createdAt: 3000,
          updatedAt: 3000,
          title: 'Prompt',
          content: 'Conflicting author attribution',
          authorAgentSessionId: 'agent-peer-2',
          authorHuman: true
        },
        {
          id: 'msg-unknown',
          agentSessionId: AGENT_SESSION_ID,
          kind: 'user_message',
          status: 'complete',
          source: 'user',
          createdAt: 4000,
          updatedAt: 4000,
          title: 'Prompt',
          content: 'Standard prompt without explicit attribution'
        }
      ]
    }

    const historyPage: AgentSessionHistoryPage = {
      agentSessionId: AGENT_SESSION_ID,
      source: {
        providerId: 'traex',
        nativeSessionId: 'native-sess-1'
      },
      items: [
        {
          kind: 'user-message',
          id: 'native-msg-1',
          contentParts: [{ kind: 'text', text: 'Native user prompt' }],
          startedAt: 5000
        }
      ],
      nextCursor: null
    }

    const messages = projectSessionUserMessages({
      agentSessionId: AGENT_SESSION_ID,
      timeline,
      historyPage
    })

    expect(messages.length).toBe(5)

    const humanMsg = messages.find((m) => m.rawId === 'msg-human')
    expect(humanMsg).toBeDefined()
    expect(humanMsg!.author).toEqual({ kind: 'human' })
    expect(humanMsg!.source).toEqual({ kind: 'captured', submissionId: 'msg-human' })

    const agentMsg = messages.find((m) => m.rawId === 'msg-agent')
    expect(agentMsg).toBeDefined()
    expect(agentMsg!.author).toEqual({ kind: 'agent', agentSessionId: 'agent-peer-1' })

    const conflictMsg = messages.find((m) => m.rawId === 'msg-conflict')
    expect(conflictMsg).toBeDefined()
    expect(conflictMsg!.author).toEqual({ kind: 'agent', agentSessionId: 'agent-peer-2' })

    const unknownCaptured = messages.find((m) => m.rawId === 'msg-unknown')
    expect(unknownCaptured).toBeDefined()
    expect(unknownCaptured!.author).toEqual({ kind: 'unknown' })

    const nativeMsg = messages.find((m) => m.rawId === 'native-msg-1')
    expect(nativeMsg).toBeDefined()
    expect(nativeMsg!.author).toEqual({ kind: 'unknown' })
    expect(nativeMsg!.source.kind).toBe('native')
  })

  it('persists authorHuman through public Client submitAgentPrompt and private FileStore reload', async () => {
    const { client, store, writes } = await createFixtureClient()

    // 1. Submit explicit manual prompt
    await client.submitAgentPrompt({
      ...agentPromptCondition(client.agentSession(AGENT_SESSION_ID)),
      agentSessionId: AGENT_SESSION_ID,
      operationId: 'op-human-1',
      prompt: 'Human instruction',
      authorHuman: true
    })

    // Immediate replay of op-human-1 with conflicting author attempt:
    // PTY write is not repeated and author remains human.
    const writesAfterFirst = writes.length
    await client.submitAgentPrompt({
      ...agentPromptCondition(client.agentSession(AGENT_SESSION_ID)),
      agentSessionId: AGENT_SESSION_ID,
      operationId: 'op-human-1',
      prompt: 'Human instruction',
      authorAgentSessionId: 'agent-trying-to-change'
    })
    expect(writes.length).toBe(writesAfterFirst)

    // 2. Submit attributed agent prompt with conflicting authorHuman: true (positive control)
    await client.submitAgentPrompt({
      ...agentPromptCondition(client.agentSession(AGENT_SESSION_ID)),
      agentSessionId: AGENT_SESSION_ID,
      operationId: 'op-agent-1',
      prompt: 'Agent instruction',
      authorAgentSessionId: 'agent-peer-x',
      authorHuman: true,
      allowUncertainTurn: true
    })

    // 3. Submit ordinary prompt without author attribution (unknown)
    await client.submitAgentPrompt({
      ...agentPromptCondition(client.agentSession(AGENT_SESSION_ID)),
      agentSessionId: AGENT_SESSION_ID,
      operationId: 'op-unknown-1',
      prompt: 'Default instruction',
      allowUncertainTurn: true
    })

    // Immediate replay of op-unknown-1 with authorHuman: true:
    // PTY write is not repeated and author remains unknown (no upgrade on replay).
    const writesAfterThird = writes.length
    await client.submitAgentPrompt({
      ...agentPromptCondition(client.agentSession(AGENT_SESSION_ID)),
      agentSessionId: AGENT_SESSION_ID,
      operationId: 'op-unknown-1',
      prompt: 'Default instruction',
      authorHuman: true,
      allowUncertainTurn: true
    })
    expect(writes.length).toBe(writesAfterThird)

    expect(writes).toEqual([
      'Human instruction\r',
      'Agent instruction\r',
      'Default instruction\r'
    ])

    // Verify live client timeline
    const liveTimeline = await client.sessionTimeline(AGENT_SESSION_ID)
    const liveHumanItem = liveTimeline.items.find((i) => i.id === 'prompt:op-human-1')
    expect(liveHumanItem).toBeDefined()
    expect(liveHumanItem!.authorHuman).toBe(true)
    expect(liveHumanItem!.authorAgentSessionId).toBeUndefined()

    const liveAgentItem = liveTimeline.items.find((i) => i.id === 'prompt:op-agent-1')
    expect(liveAgentItem).toBeDefined()
    expect(liveAgentItem!.authorAgentSessionId).toBe('agent-peer-x')
    expect(liveAgentItem!.authorHuman).toBeUndefined()

    const liveUnknownItem = liveTimeline.items.find((i) => i.id === 'prompt:op-unknown-1')
    expect(liveUnknownItem).toBeDefined()
    expect(liveUnknownItem!.authorAgentSessionId).toBeUndefined()
    expect(liveUnknownItem!.authorHuman).toBeUndefined()

    // Reload from private FileStore
    const reloadedStore = new AgentMuxFileAgentSessionStore(store.path)
    const reloadedTimeline = await reloadedStore.loadTimeline(AGENT_SESSION_ID)

    const reloadedHumanItem = reloadedTimeline.items.find((i) => i.id === 'prompt:op-human-1')
    expect(reloadedHumanItem).toBeDefined()
    expect(reloadedHumanItem!.authorHuman).toBe(true)

    // Project from reloaded timeline
    const projected = projectSessionUserMessages({
      agentSessionId: AGENT_SESSION_ID,
      timeline: reloadedTimeline
    })

    expect(projected.length).toBe(3)
    const projHuman = projected.find((p) => p.rawId === 'prompt:op-human-1')
    expect(projHuman).toBeDefined()
    expect(projHuman!.author).toEqual({ kind: 'human' })

    const projAgent = projected.find((p) => p.rawId === 'prompt:op-agent-1')
    expect(projAgent).toBeDefined()
    expect(projAgent!.author).toEqual({ kind: 'agent', agentSessionId: 'agent-peer-x' })

    const projUnknown = projected.find((p) => p.rawId === 'prompt:op-unknown-1')
    expect(projUnknown).toBeDefined()
    expect(projUnknown!.author).toEqual({ kind: 'unknown' })
  })

  it('canonical normalized mutation and FileStore drop authorHuman and preserve authorAgentSessionId on conflict', async () => {
    const rawConflictMutation = {
      type: 'append' as const,
      agentSessionId: AGENT_SESSION_ID,
      item: {
        id: 'msg-direct-conflict',
        agentSessionId: AGENT_SESSION_ID,
        kind: 'user_message' as const,
        status: 'complete' as const,
        source: 'user' as const,
        createdAt: 1000,
        updatedAt: 1000,
        title: 'Prompt',
        content: 'Direct conflict mutation',
        authorAgentSessionId: 'agent-peer-9',
        authorHuman: true
      }
    }
    const normalized = normalizeAgentTimelineMutation(rawConflictMutation)
    expect(normalized.type).toBe('append')
    if (normalized.type === 'append') {
      expect(normalized.item.authorAgentSessionId).toBe('agent-peer-9')
      expect(normalized.item.authorHuman).toBeUndefined()
    }

    const { store } = await createFixtureClient()
    await store.applyTimelineMutation(rawConflictMutation)
    const reloadedStore = new AgentMuxFileAgentSessionStore(store.path)
    const timeline = await reloadedStore.loadTimeline(AGENT_SESSION_ID)
    const storedItem = timeline.items.find((i) => i.id === 'msg-direct-conflict')
    expect(storedItem).toBeDefined()
    expect(storedItem!.authorAgentSessionId).toBe('agent-peer-9')
    expect(storedItem!.authorHuman).toBeUndefined()
  })
})
