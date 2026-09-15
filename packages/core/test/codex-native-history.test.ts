import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { describe, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore, loadAgentSessions } from '../src/agent-session-store.js'

type Request = { id?: number; method: string; params?: Record<string, unknown> }
const nativeId = 'main-native-id'
const entries = [
  { turnId: 'turn-2', startedAtMs: 100, completedAtMs: 200,
    item: { type: 'agentMessage', id: 'assistant-latest', text: '\n  exact assistant 中\n' } },
  { turnId: 'turn-2', startedAtMs: null, completedAtMs: null,
    item: { type: 'futureActivity', id: 'unknown-activity', nested: { complete: 'never discard', reference: 'native:resource' } } },
  { turnId: 'turn-1', item: { type: 'userMessage', id: 'user-older', content: [
    { type: 'text', text: '\n  exact user 中\n' }, { type: 'image', url: 'https://synthetic.invalid/image.png' },
    { type: 'text', text: 'after image ' }, { type: 'image', fileId: 'native-image-file-id' },
    { type: 'localImage', path: '/synthetic/local.png' }, { type: 'audio', url: 'native:audio' },
    { type: 'localAudio', path: '/synthetic/local.wav' }, { type: 'skill', name: 'skill', path: '/synthetic/SKILL.md' },
    { type: 'mention', name: 'file', path: '/synthetic/file.ts' }
  ] } }
]

async function fixture(
  verify: (owner: { client: AgentMuxClient; store: AgentMuxFileAgentSessionStore; requests: Request[]; sockets: WebSocketServer; socketPath: string }) => Promise<void>,
  override?: (request: Request, socket: WebSocket) => boolean
): Promise<void> {
  // macOS Unix socket paths are limited to 104 bytes; this is a synthetic owner.
  const home = await mkdtemp('/tmp/amxh-')
  const directory = join(home, 'app-server-control')
  const socketPath = join(directory, 'app-server-control.sock')
  await mkdir(directory)
  const http = createServer()
  const sockets = new WebSocketServer({ server: http, perMessageDeflate: false })
  const requests: Request[] = []
  sockets.on('connection', (socket) => socket.on('message', (bytes) => {
    const request = JSON.parse(bytes.toString()) as Request
    requests.push(request)
    if (override?.(request, socket)) return
    const respond = (result: unknown) => socket.send(JSON.stringify({ id: request.id, result }))
    if (request.method === 'initialize') respond({ userAgent: 'synthetic-native-server' })
    else if (request.method === 'thread/read') respond({ thread: { id: nativeId, historyMode: 'paginated', turns: [] } })
    else if (request.method === 'thread/items/list') {
      if (request.params?.cursor === 'foreign-source-cursor') {
        socket.send(JSON.stringify({ id: request.id, error: { code: -32602, message: 'Cursor belongs to another thread' } }))
      } else if (request.params?.cursor === 'native-opaque-next') {
        respond({ data: [{ turnId: 'turn-0', item: { type: 'userMessage', id: 'oldest-user',
          content: [{ type: 'text', text: 'earlier complete conversation' }] } }], nextCursor: null })
      } else respond({ data: entries, nextCursor: 'native-opaque-next' })
    }
  }))
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(socketPath, () => resolve())
  })
  const oldHome = process.env.CODEX_HOME
  process.env.CODEX_HOME = home
  const path = join(home, 'agent-sessions.json')
  const store = new AgentMuxFileAgentSessionStore(path)
  await store.compareAndSwap(null, { kind: 'agent', agentSessionId: 'main-session', providerId: 'codex', executorId: 'codex',
    hostId: 'local', workspacePath: '/synthetic', run: { runId: 'original-run' }, retiredRuns: [],
    outputCursorBytes: 100, hookBindingId: 'synthetic-binding', hookToken: 'synthetic-token', createdAt: 1, updatedAt: 1,
    nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: nativeId,
      transcriptPath: '/synthetic/untrusted-child-path-is-ignored.jsonl' } })
  const client = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(path) })
  try {
    await verify({ client, store, requests, sockets, socketPath })
    await vi.waitFor(() => expect(sockets.clients.size).toBe(0), { timeout: 1_000, interval: 5 })
  } finally {
    await client.dispose()
    if (oldHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = oldHome
    for (const socket of sockets.clients) socket.terminate()
    await new Promise<void>((resolve) => sockets.close(() => resolve()))
    await new Promise<void>((resolve) => http.close(() => resolve()))
    await rm(home, { recursive: true, force: true })
  }
}

describe('actual public Client to native Unix WebSocket read protocol', () => {
  it('reads exact metadata and two indexed pages with text/resource fidelity and chronological items', async () => {
    await fixture(async ({ client, store, requests }) => {
      const first = await client.sessionHistoryPage('main-session', { limit: 3 })
      expect(first.source).toEqual({ providerId: 'codex', nativeSessionId: nativeId })
      expect(first.items.map((item) => item.id)).toEqual(['user-older', 'unknown-activity', 'assistant-latest'])
      expect(first.items[0]!.contentParts).toEqual([
        { kind: 'text', text: '\n  exact user 中\n' },
        { kind: 'resource', resourceType: 'image', reference: 'https://synthetic.invalid/image.png' },
        { kind: 'text', text: 'after image ' },
        { kind: 'resource', resourceType: 'image', reference: 'native-image-file-id' },
        { kind: 'resource', resourceType: 'image', reference: '/synthetic/local.png' },
        { kind: 'resource', resourceType: 'audio', reference: 'native:audio' },
        { kind: 'resource', resourceType: 'audio', reference: '/synthetic/local.wav' },
        { kind: 'resource', resourceType: 'file', reference: '/synthetic/SKILL.md', label: 'skill' },
        { kind: 'resource', resourceType: 'file', reference: '/synthetic/file.ts', label: 'file' }
      ])
      expect(first.items[1]).toEqual({ id: 'unknown-activity', turnId: 'turn-2', kind: 'activity', title: 'futureActivity',
        contentParts: [{ kind: 'text', text: JSON.stringify(entries[1]!.item, null, 2) }] })
      expect(first.items[2]).toMatchObject({ kind: 'assistant-message', startedAt: 100, completedAt: 200,
        contentParts: [{ kind: 'text', text: '\n  exact assistant 中\n' }] })
      expect(first.nextCursor).toBe('native-opaque-next')
      const older = await client.sessionHistoryPage('main-session', { limit: 3, cursor: first.nextCursor! })
      expect(older.items.map((item) => item.id)).toEqual(['oldest-user'])
      expect(older.nextCursor).toBeNull()
      expect(requests.map((request) => request.method)).toEqual([
        'initialize', 'initialized', 'thread/read', 'thread/items/list',
        'initialize', 'initialized', 'thread/read', 'thread/items/list'
      ])
      expect(requests[2]!.params).toEqual({ threadId: nativeId, includeTurns: false })
      expect(requests[7]!.params).toEqual({ threadId: nativeId, limit: 3, sortDirection: 'desc', cursor: 'native-opaque-next' })
      expect((await loadAgentSessions(store)).map((session) => session.run)).toEqual([{ runId: 'original-run' }])
    })
  })

  it.each(['wrong-identity', 'legacy-mode'] as const)('rejects %s metadata before any item read and closes the connection', async (reason) => {
    await fixture(async ({ client, requests }) => {
      await expect(client.sessionHistoryPage('main-session')).rejects.toMatchObject({
        code: reason === 'wrong-identity' ? 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' : 'AGENT_SESSION_HISTORY_UNSUPPORTED'
      })
      expect(requests.map((request) => request.method)).toEqual(['initialize', 'initialized', 'thread/read'])
    }, (request, socket) => {
      if (request.method !== 'thread/read') return false
      socket.send(JSON.stringify({ id: request.id, result: { thread: {
        id: reason === 'wrong-identity' ? 'fork-child-id' : nativeId,
        historyMode: reason === 'legacy-mode' ? 'legacy' : 'paginated'
      } } }))
      return true
    })
  })

  it('preserves empty continuation and delegates foreign cursor scope refusal to the native owner', async () => {
    await fixture(async ({ client }) => {
      expect(await client.sessionHistoryPage('main-session', { cursor: 'empty-window' })).toEqual({
        agentSessionId: 'main-session', source: { providerId: 'codex', nativeSessionId: nativeId },
        items: [], nextCursor: 'native-opaque-next'
      })
      await expect(client.sessionHistoryPage('main-session', { cursor: 'foreign-source-cursor' })).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_UNAVAILABLE' })
    }, (request, socket) => {
      if (request.method !== 'thread/items/list' || request.params?.cursor !== 'empty-window') return false
      socket.send(JSON.stringify({ id: request.id, result: { data: [], nextCursor: 'native-opaque-next' } }))
      return true
    })
  })

  it('binds responses to the exact request ID instead of accepting a different read result', async () => {
    await fixture(async ({ client }) => {
      await expect(client.sessionHistoryPage('main-session')).rejects.toMatchObject({ code: 'INVALID_AGENT_SESSION_HISTORY_PAGE' })
    }, (request, socket) => {
      if (request.method !== 'thread/read') return false
      socket.send(JSON.stringify({ id: 999, result: { thread: { id: nativeId, historyMode: 'paginated' } } }))
      return true
    })
  })

  it('bounds actual WebSocket payload bytes and closes an oversized response', async () => {
    await fixture(async ({ client }) => {
      await expect(client.sessionHistoryPage('main-session')).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_TOO_LARGE' })
    }, (request, socket) => {
      if (request.method !== 'thread/items/list') return false
      socket.send(JSON.stringify({ id: request.id, result: { data: [{ turnId: 'large-turn', item: {
        type: 'agentMessage', id: 'large', text: 'x'.repeat(4 * 1024 * 1024)
      } }], nextCursor: null } }))
      return true
    })
  })

  it('bounds the whole read connection even when each native notification fits one message', async () => {
    await fixture(async ({ client }) => {
      await expect(client.sessionHistoryPage('main-session')).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_TOO_LARGE' })
    }, (request, socket) => {
      if (request.method !== 'thread/items/list') return false
      const notification = JSON.stringify({ method: 'synthetic/notice', params: { text: 'x'.repeat(2_200_000) } })
      socket.send(notification)
      socket.send(notification)
      socket.send(JSON.stringify({ id: request.id, result: { data: [], nextCursor: null } }))
      return true
    })
  })

  it('disposal aborts the real outstanding read socket while the same Session remains intact', async () => {
    await fixture(async ({ client, store, requests }) => {
      const reading = client.sessionHistoryPage('main-session')
      const rejection = expect(reading).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_CANCELLED' })
      await vi.waitFor(() => expect(requests.at(-1)?.method).toBe('thread/items/list'), { timeout: 1_000, interval: 5 })
      await client.dispose()
      await rejection
      expect((await loadAgentSessions(store)).map((session) => session.nativeHandle?.sessionId)).toEqual([nativeId])
    }, (request) => request.method === 'thread/items/list')
  })

  it('reports a missing endpoint as an explicit reading failure without requiring a connected Run', async () => {
    await fixture(async ({ client, store, socketPath }) => {
      await rm(socketPath)
      await expect(client.sessionHistoryPage('main-session')).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_UNAVAILABLE' })
      expect((await loadAgentSessions(store)).map((session) => session.run)).toEqual([{ runId: 'original-run' }])
    })
  })
})
