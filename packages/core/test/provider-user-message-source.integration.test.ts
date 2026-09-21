import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import {
  AgentMuxClient,
  AgentMuxFileAgentSessionStore,
  projectSessionUserMessages,
  type AgentMuxStoredAgentSession,
  type AgentTimelineSnapshot
} from '@agentmux/core'

const clients: AgentMuxClient[] = []

afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.dispose()
  }
  vi.restoreAllMocks()
})

async function createFixtureSession(options: {
  providerId: 'claude' | 'pi'
  nativeSessionId: string
  transcriptPath: string
  workspacePath?: string
}) {
  const rootDir = options.workspacePath ?? (await mkdtemp(join(tmpdir(), `core-msg-test-${options.providerId}-`)))
  const storePath = join(rootDir, 'sessions.json')
  const store = new AgentMuxFileAgentSessionStore(storePath)
  const agentSessionId = `test-agent-${options.providerId}`

  const session: AgentMuxStoredAgentSession = {
    kind: 'agent',
    agentSessionId,
    providerId: options.providerId,
    executorId: options.providerId,
    hostId: 'local',
    workspacePath: rootDir,
    run: { runId: `test-run-${options.providerId}` },
    retiredRuns: [],
    hookBindingId: 'test-binding',
    hookToken: 'test-token',
    createdAt: 1000,
    updatedAt: 1000,
    nativeHandle: {
      kind: 'provider',
      providerId: options.providerId,
      sessionId: options.nativeSessionId,
      transcriptPath: options.transcriptPath
    }
  }

  await store.compareAndSwap(null, session)
  const client = new AgentMuxClient({ store })
  clients.push(client)

  const inner = client as unknown as {
    kernel: Record<string, (...args: unknown[]) => unknown>
    registry: { load(host: string): Promise<void> }
  }
  await inner.registry.load('local')

  const controlNames = ['connect', 'start', 'input', 'resize', 'stop', 'attach', 'status'] as const
  const controls = controlNames.map((name) => ({
    name,
    spy: vi.spyOn(inner.kernel, name).mockImplementation(() => {
      throw new Error(`Forbidden Runtime operation in read-only test: ${name}`)
    })
  }))
  expect(controls).toHaveLength(7)
  expect(controls.map((c) => c.name)).toEqual(['connect', 'start', 'input', 'resize', 'stop', 'attach', 'status'])
  const verifyZeroControls = () => {
    expect(controls.map((c) => c.spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0, 0])
  }

  return { client, store, storePath, rootDir, agentSessionId, controls, verifyZeroControls, session }
}

it('reads Claude native user inputs through production reader, projecting ordered content and unknown author', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'claude-fixture-'))
  const transcriptPath = join(rootDir, 'claude.jsonl')
  const nativeSessionId = 'claude-sess-alpha'
  const time1 = 1790900000000
  const time2 = 1790900010000

  const lines = [
    {
      sessionId: nativeSessionId,
      uuid: 'claude-input-001',
      type: 'user',
      message: { role: 'user', content: 'Terminal entered prompt line' },
      timestamp: new Date(time1).toISOString()
    },
    {
      sessionId: nativeSessionId,
      uuid: 'claude-input-002',
      type: 'user',
      message: { role: 'user', content: 'Second native input from session' },
      timestamp: new Date(time2).toISOString()
    }
  ]
  await writeFile(transcriptPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')

  const f = await createFixtureSession({
    providerId: 'claude',
    nativeSessionId,
    transcriptPath
  })

  const page = await f.client.sessionHistoryPage(f.agentSessionId)
  expect(page.items).toHaveLength(2)
  expect(page.items.map((i) => i.id)).toEqual(['claude-input-001', 'claude-input-002'])

  const userMessages = projectSessionUserMessages({
    agentSessionId: f.agentSessionId,
    historyPage: page
  })

  expect(userMessages).toHaveLength(2)
  expect(userMessages.map((m) => m.content)).toEqual([
    'Terminal entered prompt line',
    'Second native input from session'
  ])

  // Stable IDs are scoped by providerId, nativeSessionId, and item ID
  expect(userMessages[0]!.id).toBe(`native:claude:${nativeSessionId}:claude-input-001`)
  expect(userMessages[1]!.id).toBe(`native:claude:${nativeSessionId}:claude-input-002`)

  // Native role=user denotes an Agent input turn; author is truthfully unknown, not "You" or "Human"
  expect(userMessages[0]!.author).toEqual({ kind: 'unknown' })
  expect(userMessages[1]!.author).toEqual({ kind: 'unknown' })

  // Timestamps accurately recorded
  expect(userMessages[0]!.recordedAt).toBe(time1)
  expect(userMessages[1]!.recordedAt).toBe(time2)

  // Zero runtime controls invoked
  f.verifyZeroControls()
})

it('reads Pi v3 native messages preserving equal bodies, distinct IDs, and absent timestamps', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'pi-fixture-'))
  const transcriptPath = join(rootDir, 'pi.jsonl')
  const nativeSessionId = 'pi-sess-beta'
  const sameBody = 'Identical prompt content entered twice'

  const lines = [
    { type: 'session', version: 3, id: nativeSessionId, cwd: rootDir, timestamp: '2026-10-03T01:00:00Z' },
    {
      type: 'message',
      id: 'pi-msg-1',
      parentId: null,
      timestamp: '2026-10-03T01:01:00Z',
      message: { role: 'user', content: sameBody }
    },
    {
      type: 'message',
      id: 'pi-msg-2',
      parentId: 'pi-msg-1',
      timestamp: '2026-10-03T01:02:00Z',
      message: { role: 'user', content: sameBody }
    },
    {
      type: 'message',
      id: 'pi-msg-no-time',
      parentId: 'pi-msg-2',
      timestamp: 'unknown',
      message: { role: 'user', content: 'Message with unknown time' }
    }
  ]
  await writeFile(transcriptPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')

  const f = await createFixtureSession({
    providerId: 'pi',
    nativeSessionId,
    transcriptPath,
    workspacePath: rootDir
  })

  const page = await f.client.sessionHistoryPage(f.agentSessionId)
  expect(page.items).toHaveLength(3)

  const userMessages = projectSessionUserMessages({
    agentSessionId: f.agentSessionId,
    historyPage: page
  })

  expect(userMessages).toHaveLength(3)

  // Both records with identical text must be preserved with distinct IDs
  expect(userMessages[0]!.content).toBe(sameBody)
  expect(userMessages[1]!.content).toBe(sameBody)
  expect(userMessages[0]!.id).not.toBe(userMessages[1]!.id)
  expect(userMessages[0]!.rawId).toBe('pi-msg-1')
  expect(userMessages[1]!.rawId).toBe('pi-msg-2')

  // Third message has unknown time; recordedAt must remain undefined, never Date.now()
  expect(userMessages[2]!.rawId).toBe('pi-msg-no-time')
  expect(userMessages[2]!.recordedAt).toBeUndefined()

  f.verifyZeroControls()
})

it('unambiguous tuple encoding prevents ID collision between (a:b, c) and (a, b:c)', async () => {
  const rootDir1 = await mkdtemp(join(tmpdir(), 'tuple-fixture-1-'))
  const transcriptPath1 = join(rootDir1, 'pi.jsonl')
  const nativeSessionId1 = 'a:b'
  const recordId1 = 'c'
  const lines1 = [
    { type: 'session', version: 3, id: nativeSessionId1, cwd: rootDir1, timestamp: '2026-10-03T01:00:00Z' },
    {
      type: 'message',
      id: recordId1,
      parentId: null,
      timestamp: '2026-10-03T01:01:00Z',
      message: { role: 'user', content: 'Message from a:b with c' }
    }
  ]
  await writeFile(transcriptPath1, lines1.map((l) => JSON.stringify(l)).join('\n') + '\n')
  const f1 = await createFixtureSession({
    providerId: 'pi',
    nativeSessionId: nativeSessionId1,
    transcriptPath: transcriptPath1,
    workspacePath: rootDir1
  })
  const page1 = await f1.client.sessionHistoryPage(f1.agentSessionId)

  const rootDir2 = await mkdtemp(join(tmpdir(), 'tuple-fixture-2-'))
  const transcriptPath2 = join(rootDir2, 'pi.jsonl')
  const nativeSessionId2 = 'a'
  const recordId2 = 'b:c'
  const lines2 = [
    { type: 'session', version: 3, id: nativeSessionId2, cwd: rootDir2, timestamp: '2026-10-03T01:00:00Z' },
    {
      type: 'message',
      id: recordId2,
      parentId: null,
      timestamp: '2026-10-03T01:01:00Z',
      message: { role: 'user', content: 'Message from a with b:c' }
    }
  ]
  await writeFile(transcriptPath2, lines2.map((l) => JSON.stringify(l)).join('\n') + '\n')
  const f2 = await createFixtureSession({
    providerId: 'pi',
    nativeSessionId: nativeSessionId2,
    transcriptPath: transcriptPath2,
    workspacePath: rootDir2
  })
  const page2 = await f2.client.sessionHistoryPage(f2.agentSessionId)

  const msg1 = projectSessionUserMessages({ agentSessionId: f1.agentSessionId, historyPage: page1 })[0]!
  const msg2 = projectSessionUserMessages({ agentSessionId: f2.agentSessionId, historyPage: page2 })[0]!

  expect(msg1.id).not.toBe(msg2.id)
  expect(msg1.id).toBe('native:pi:a%3Ab:c')
  expect(msg2.id).toBe('native:pi:a:b%3Ac')

  f1.verifyZeroControls()
  f2.verifyZeroControls()
})

it('idempotently deduplicates repeated reads of the same record without duplicating messages', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'idempotent-fixture-'))
  const transcriptPath = join(rootDir, 'claude.jsonl')
  const nativeSessionId = 'claude-sess-gamma'

  const lines = [
    {
      sessionId: nativeSessionId,
      uuid: 'claude-single-001',
      type: 'user',
      message: { role: 'user', content: 'Single prompt' },
      timestamp: new Date().toISOString()
    }
  ]
  await writeFile(transcriptPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')

  const f = await createFixtureSession({
    providerId: 'claude',
    nativeSessionId,
    transcriptPath
  })

  const page1 = await f.client.sessionHistoryPage(f.agentSessionId)
  const page2 = await f.client.sessionHistoryPage(f.agentSessionId)
  expect(page1).toEqual(page2)

  // Combined duplicate items across two simulated pages
  const combinedPage = {
    ...page1,
    items: [...page1.items, ...page2.items]
  }

  const userMessages = projectSessionUserMessages({
    agentSessionId: f.agentSessionId,
    historyPage: combinedPage
  })

  expect(userMessages).toHaveLength(1)
  expect(userMessages[0]!.rawId).toBe('claude-single-001')
  f.verifyZeroControls()
})

it('distinguishes known Agent author from unknown native input and maintains both layers', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'author-fixture-'))
  const transcriptPath = join(rootDir, 'claude.jsonl')
  const nativeSessionId = 'claude-sess-delta'

  const lines = [
    {
      sessionId: nativeSessionId,
      uuid: 'native-record-001',
      type: 'user',
      message: { role: 'user', content: 'Terminal user prompt' },
      timestamp: new Date(1790900000000).toISOString()
    }
  ]
  await writeFile(transcriptPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')

  const f = await createFixtureSession({
    providerId: 'claude',
    nativeSessionId,
    transcriptPath
  })

  const page = await f.client.sessionHistoryPage(f.agentSessionId)

  // Timeline contains an incoming message from another Agent (via Message Tool / A2A)
  const timeline: AgentTimelineSnapshot = {
    agentSessionId: f.agentSessionId,
    revision: 1,
    items: [
      {
        id: 'prompt:from-peer',
        agentSessionId: f.agentSessionId,
        kind: 'user_message',
        status: 'complete',
        source: 'user',
        createdAt: 1790900005000,
        updatedAt: 1790900005000,
        title: 'Peer agent message',
        authorAgentSessionId: 'peer-agent-777',
        content: 'Instructions from peer'
      }
    ]
  }

  const userMessages = projectSessionUserMessages({
    agentSessionId: f.agentSessionId,
    historyPage: page,
    timeline
  })

  expect(userMessages).toHaveLength(2)

  const nativeMsg = userMessages.find((m) => m.source.kind === 'native')!
  const capturedMsg = userMessages.find((m) => m.source.kind === 'captured')!

  expect(nativeMsg).toBeDefined()
  expect(nativeMsg.author).toEqual({ kind: 'unknown' })
  expect(nativeMsg.content).toBe('Terminal user prompt')

  expect(capturedMsg).toBeDefined()
  expect(capturedMsg.author).toEqual({ kind: 'agent', agentSessionId: 'peer-agent-777' })
  expect(capturedMsg.content).toBe('Instructions from peer')
  expect(capturedMsg.deliveryStatus).toBe('complete')
  f.verifyZeroControls()
})

it('recovers identical history from fresh Client with same durable store and respects negative boundaries', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'boundaries-fixture-'))
  const transcriptPath = join(rootDir, 'claude.jsonl')
  const nativeSessionId = 'claude-sess-epsilon'

  const lines = [
    {
      sessionId: nativeSessionId,
      uuid: 'claude-rec-1',
      type: 'user',
      message: { role: 'user', content: 'Durable message' },
      timestamp: new Date().toISOString()
    }
  ]
  await writeFile(transcriptPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')

  const f = await createFixtureSession({
    providerId: 'claude',
    nativeSessionId,
    transcriptPath
  })

  const pageBefore = await f.client.sessionHistoryPage(f.agentSessionId)

  // Fresh Client on same store
  const freshClient = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(f.storePath) })
  clients.push(freshClient)
  const pageAfter = await freshClient.sessionHistoryPage(f.agentSessionId)
  expect(pageAfter).toEqual(pageBefore)

  // Negative boundary: unknown session throws
  await expect(f.client.sessionHistoryPage('non-existent-session')).rejects.toThrow('Unknown Agent Session')

  // Negative boundary: invalid limit throws
  await expect(f.client.sessionHistoryPage(f.agentSessionId, { limit: 0 })).rejects.toThrow(
    'History page requires a finite limit'
  )

  // Negative boundary: reading on disposed client throws AGENT_SESSION_HISTORY_CANCELLED
  const cancelStore = new AgentMuxFileAgentSessionStore(f.storePath)
  const cancelClient = new AgentMuxClient({ store: cancelStore })
  await cancelClient.dispose()
  await expect(cancelClient.sessionHistoryPage(f.agentSessionId)).rejects.toThrow(
    'History reading client was disposed.'
  )

  // Projection contract preserves message array and respects public page nextCursor
  const projectedMessages = projectSessionUserMessages({ agentSessionId: f.agentSessionId, historyPage: pageAfter })
  expect(projectedMessages).toHaveLength(1)
  expect(pageAfter.nextCursor).toBeNull()

  f.verifyZeroControls()
})

it('public projection preserves the real owner of an actual foreign Session page and excludes misattributed pages', async () => {
  const rootDir1 = await mkdtemp(join(tmpdir(), 'foreign-fixture-1-'))
  const transcriptPath1 = join(rootDir1, 'claude.jsonl')
  const lines1 = [
    {
      sessionId: 'sess-left',
      uuid: 'msg-left-1',
      type: 'user',
      message: { role: 'user', content: 'Left message 1' },
      timestamp: new Date().toISOString()
    }
  ]
  await writeFile(transcriptPath1, lines1.map((l) => JSON.stringify(l)).join('\n') + '\n')
  const left = await createFixtureSession({
    providerId: 'claude',
    nativeSessionId: 'sess-left',
    transcriptPath: transcriptPath1,
    workspacePath: rootDir1
  })
  const leftPage = await left.client.sessionHistoryPage(left.agentSessionId)

  // Valid attribution matching the session
  const valid = projectSessionUserMessages({ agentSessionId: left.agentSessionId, historyPage: leftPage })
  expect(valid).toHaveLength(1)
  expect(valid[0]!.agentSessionId).toBe(left.agentSessionId)

  // Attempted foreign projection with a different requested session id
  const foreignProjected = projectSessionUserMessages({ agentSessionId: 'foreign-right-session', historyPage: leftPage })
  const reattributed = foreignProjected.filter((m) => m.agentSessionId === 'foreign-right-session')
  expect(reattributed).toEqual([])

  left.verifyZeroControls()
})

it('native and captured observations remain separate when legal opaque public IDs coincide', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'collision-fixture-'))
  const transcriptPath = join(rootDir, 'claude.jsonl')
  const nativeSessionId = 'sess-collision'
  const lines = [
    {
      sessionId: nativeSessionId,
      uuid: 'part-0',
      type: 'user',
      message: { role: 'user', content: 'Native message 0' },
      timestamp: new Date(1790900000000).toISOString()
    },
    {
      sessionId: nativeSessionId,
      uuid: 'part-1',
      type: 'user',
      message: { role: 'user', content: 'Native message 1' },
      timestamp: new Date(1790900001000).toISOString()
    }
  ]
  await writeFile(transcriptPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  const f = await createFixtureSession({
    providerId: 'claude',
    nativeSessionId,
    transcriptPath,
    workspacePath: rootDir
  })
  const page = await f.client.sessionHistoryPage(f.agentSessionId)
  const native = projectSessionUserMessages({ agentSessionId: f.agentSessionId, historyPage: page })
  expect(native.map((m) => m.rawId)).toEqual(['part-0', 'part-1'])

  const collisionId = native[1]!.id
  expect(native[1]!.id).toBe(collisionId)

  // Public FileStore accepts opaque ID equal to collisionId
  await f.store.applyTimelineMutation({
    type: 'append',
    agentSessionId: f.agentSessionId,
    item: {
      id: collisionId,
      agentSessionId: f.agentSessionId,
      kind: 'user_message',
      status: 'streaming',
      source: 'user',
      createdAt: 1790900002000,
      updatedAt: 1790900002000,
      title: 'Captured observation with colliding ID',
      content: 'Captured content'
    }
  })
  const timeline = await f.client.sessionTimeline(f.agentSessionId)

  const combined = projectSessionUserMessages({
    agentSessionId: f.agentSessionId,
    historyPage: page,
    timeline
  })

  expect(combined.map((m) => [m.source.kind, m.rawId])).toEqual([
    ['native', 'part-0'],
    ['native', 'part-1'],
    ['captured', collisionId]
  ])

  f.verifyZeroControls()
})
