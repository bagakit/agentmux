import { fixturePath as upstreamFixturePath } from './helpers/fixture-values.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  AgentMuxClient,
  issueAgentCapability,
  hashAgentCapability,
  AgentMuxFileAgentSessionStore,
  agentPromptCondition,
  normalizeAgentTimelineMutation,
  projectSessionUserMessages,
  type AgentMuxStoredAgentSession,
  type AgentSessionHistoryPage,
  type AgentSessionUserMessage,
  type AgentMessageChannel,
  type AgentTimelineSnapshot
} from '@agentmux/core'

const peerCapability = issueAgentCapability()
const roots: string[] = []
const clients: AgentMuxClient[] = []

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.dispose()))
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })))
})

const RUN_ID = 'author-run'
const AGENT_SESSION_ID = 'author-agent'
const WORKSPACE = upstreamFixturePath("tmp/author-agent")

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

  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(dirname(storePath), 'messages.ndjson'))
  await store.compareAndSwap(null, storedSession({ agentSessionId: 'agent-peer-x', run: { runId: 'peer-run' }, capabilityHash: hashAgentCapability(peerCapability) }))
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
  it('rejects the removed raw Agent author field without upgrading its Human claim', async () => {
    const { client, store, writes } = await createFixtureClient()
    await expect(client.submitAgentPrompt({
      ...agentPromptCondition(client.agentSession(AGENT_SESSION_ID)), agentSessionId: AGENT_SESSION_ID,
      operationId: 'empty-agent-conflict', prompt: 'Keep this input unattributed',
      ...{ authorAgentSessionId: '' }, authorHuman: true
    })).rejects.toMatchObject({ code: 'MESSAGE_ENVELOPE_REQUIRED' })
    expect(writes).toEqual([])
    expect((await store.loadTimeline(AGENT_SESSION_ID)).items).toEqual([])
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

    // A raw author attempt cannot enter either the manual or authenticated message path.
    const writesAfterFirst = writes.length
    await expect(client.submitAgentPrompt({
      ...agentPromptCondition(client.agentSession(AGENT_SESSION_ID)), agentSessionId: AGENT_SESSION_ID,
      operationId: 'op-human-1', prompt: 'Human instruction', ...{ authorAgentSessionId: 'agent-trying-to-change' }
    })).rejects.toMatchObject({ code: 'MESSAGE_ENVELOPE_REQUIRED' })
    expect(writes.length).toBe(writesAfterFirst)

    await client.submitAgentMessage({ agentSessionId: AGENT_SESSION_ID,
      condition: agentPromptCondition(client.agentSession(AGENT_SESSION_ID)), caller: { agentSessionId: 'agent-peer-x', capability: peerCapability },
      envelope: { schema: 'agentmux.a2a.v1', messageId: 'op-agent-1', operationId: 'agent-message-operation', createdAt: 100,
        sender: { kind: 'agent-session', agentSessionId: 'agent-peer-x' }, recipient: { kind: 'agent-session', agentSessionId: AGENT_SESSION_ID },
        senderSessionId: 'agent-peer-x', senderRunId: 'peer-run', recipientSessionId: AGENT_SESSION_ID, recipientRunId: RUN_ID,
        threadId: 'thread', correlationId: 'correlation', replyTo: null, workspaceId: null, body: 'Agent instruction' } })

    // 3. Submit ordinary prompt without author attribution (unknown)
    await client.submitAgentPrompt({
      ...agentPromptCondition(client.agentSession(AGENT_SESSION_ID)),
      agentSessionId: AGENT_SESSION_ID,
      operationId: 'op-unknown-1',
      prompt: 'Default instruction',
      allowUncertainTurn: true
    })

    // Reusing the accepted operation cannot change its frozen author facts.
    // The original coordinator rejects this conflict; PTY and stored author stay intact.
    const writesAfterThird = writes.length
    await expect(client.submitAgentPrompt({
      ...agentPromptCondition(client.agentSession(AGENT_SESSION_ID)),
      agentSessionId: AGENT_SESSION_ID,
      operationId: 'op-unknown-1',
      prompt: 'Default instruction',
      authorHuman: true,
      allowUncertainTurn: true
    })).rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
    expect(writes.length).toBe(writesAfterThird)

    expect(writes).toEqual([
      'Human instruction\r',
      '[Message from Agent agent-peer-x]\nAgent instruction\r',
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


describe('Frozen delivery channel and device over the original admission and durable message record', () => {
  it('persists Message Tool channel with the original sending device independently of execution Host', async () => {
    const { client, store, writes } = await createFixtureClient()
    const device = { hostId: 'physical-origin-host', deviceId: 'linked-phone', name: 'My phone' }
    await client.submitAgentPrompt({ ...agentPromptCondition(client.agentSession(AGENT_SESSION_ID)), agentSessionId: AGENT_SESSION_ID,
      operationId: 'origin-device-message', prompt: 'Exact original content', authorHuman: true, sourceChannel: 'message-tool', sourceDevice: device })
    device.name = 'Changed after acceptance'
    const timeline = await new AgentMuxFileAgentSessionStore(store.path).loadTimeline(AGENT_SESSION_ID)
    const messages = projectSessionUserMessages({ agentSessionId: AGENT_SESSION_ID, timeline })
    expect(messages).toHaveLength(1)
    expect(messages[0]!.source).toEqual({ kind: 'captured', submissionId: 'prompt:origin-device-message', channel: 'message-tool',
      device: { hostId: 'physical-origin-host', deviceId: 'linked-phone', name: 'My phone' } })
    expect(messages[0]!.author).toEqual({ kind: 'human' })
    expect(messages[0]!.content).toBe('Exact original content')
    expect(writes.join('')).toContain('Exact original content')
  })

  it('rejects only invalid channel input before side effects and keeps the original healthy manual input', async () => {
    const { client, store, writes } = await createFixtureClient()
    const input = { ...agentPromptCondition(client.agentSession(AGENT_SESSION_ID)), agentSessionId: AGENT_SESSION_ID,
      operationId: 'invalid-origin-message', prompt: 'Original healthy input', sourceChannel: 'forged' as AgentMessageChannel }
    await expect(client.submitAgentPrompt(input)).rejects.toMatchObject({ code: 'INVALID_AGENT_PROMPT' })
    expect(writes).toHaveLength(0)
    expect((await store.loadTimeline(AGENT_SESSION_ID)).items).toHaveLength(0)
    await client.submitAgentPrompt({ ...input, sourceChannel: 'cli' })
    expect(projectSessionUserMessages({ agentSessionId: AGENT_SESSION_ID, timeline: await store.loadTimeline(AGENT_SESSION_ID) })[0]!.source)
      .toEqual({ kind: 'captured', submissionId: 'prompt:invalid-origin-message', channel: 'cli' })
    expect(writes).toHaveLength(1)
  })

  it('does not invent Terminal delivery or a sending device from native input role and execution metadata', () => {
    const page: AgentSessionHistoryPage = { agentSessionId: AGENT_SESSION_ID,
      source: { providerId: 'codex', nativeSessionId: 'original-codex' }, nextCursor: null,
      items: [{ id: 'native-same-body', kind: 'user-message', contentParts: [{ kind: 'text', text: 'Exact original content' }] }] }
    const messages = projectSessionUserMessages({ agentSessionId: AGENT_SESSION_ID, historyPage: page })
    expect(messages).toHaveLength(1)
    expect(messages[0]!.source).toEqual({ kind: 'native', providerId: 'codex', nativeSessionId: 'original-codex', recordId: 'native-same-body' })
    expect(messages[0]!.author).toEqual({ kind: 'unknown' })
  })

  it('does not change the channel of an already accepted intent when the same operation is retried', async () => {
    const { client, store, writes } = await createFixtureClient()
    const input = { ...agentPromptCondition(client.agentSession(AGENT_SESSION_ID)), agentSessionId: AGENT_SESSION_ID,
      operationId: 'frozen-origin-message', prompt: 'Frozen input', sourceChannel: 'message-tool' as const }
    await client.submitAgentPrompt(input)
    const before = structuredClone(await store.loadTimeline(AGENT_SESSION_ID)), accepted = [...writes]
    await expect(client.submitAgentPrompt({ ...input, sourceChannel: 'reaction' })).rejects.toBeDefined()
    expect(await store.loadTimeline(AGENT_SESSION_ID)).toEqual(before)
    expect(writes).toEqual(accepted)
  })
})
