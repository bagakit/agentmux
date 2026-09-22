import { DatabaseSync } from 'node:sqlite'
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes, randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../../src/client.js'
import { AgentProviderRegistry } from '../../src/agent-provider.js'
import { AgentMuxFileAgentSessionStore, AgentMuxMemoryAgentSessionStore, loadAgentSessions } from '../../src/agent-session-store.js'
import { CtxmuxRunAdapter } from '../../src/ctxmux-run-adapter.js'
import { defaultAgentMuxHookPort } from '../../src/runtime-paths.js'
import type { AgentMuxStoredAgentSession } from '../../src/types.js'
import { HERMES_HOOKS } from '../../src/providers/hermes.js'

describe('Hermes session analysis and native history', () => {
  let tempDir: string
  let dbPath: string
  let previousRuntimeDir: string | undefined
  const clients: AgentMuxClient[] = []

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agentmux-hermes-test-'))
    dbPath = join(tempDir, 'state.db')
    await mkdir(join(tempDir, 'workspace'), { recursive: true })
    const runtimeDir = join(tempDir, 'runtime')
    await mkdir(runtimeDir, { recursive: true })
    previousRuntimeDir = process.env.AGENTMUX_RUNTIME_DIRECTORY
    process.env.AGENTMUX_RUNTIME_DIRECTORY = runtimeDir
  })

  afterEach(async () => {
    if (previousRuntimeDir !== undefined) {
      process.env.AGENTMUX_RUNTIME_DIRECTORY = previousRuntimeDir
    } else {
      delete process.env.AGENTMUX_RUNTIME_DIRECTORY
    }
    await Promise.all(clients.splice(0).map((c) => c.dispose()))
    await rm(tempDir, { recursive: true, force: true })
  })

  function createTestDatabase(): DatabaseSync {
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        user_id TEXT,
        session_key TEXT,
        chat_id TEXT,
        chat_type TEXT,
        thread_id TEXT,
        model TEXT,
        model_config TEXT,
        system_prompt TEXT,
        parent_session_id TEXT,
        started_at REAL NOT NULL,
        ended_at REAL,
        end_reason TEXT,
        message_count INTEGER DEFAULT 0,
        cwd TEXT,
        title TEXT
      );

      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        role TEXT NOT NULL,
        content TEXT,
        tool_call_id TEXT,
        tool_calls TEXT,
        tool_name TEXT,
        timestamp REAL NOT NULL,
        token_count INTEGER,
        finish_reason TEXT,
        reasoning TEXT,
        reasoning_content TEXT,
        reasoning_details TEXT,
        active INTEGER NOT NULL DEFAULT 1
      );
    `)
    return db
  }

  describe('Public AgentMuxClient history reading from Hermes state.db', () => {
    it('reads authentic multi-turn conversation with reasoning, tool calls, and multimodal content', async () => {
      const db = createTestDatabase()
      const workspacePath = join(tempDir, 'workspace')

      db.exec(`
        INSERT INTO sessions (id, source, model, cwd, started_at, title)
        VALUES ('sess-main', 'cli', 'nous-hermes-3', '${workspacePath}', 1774920000.0, 'Test Session');

        INSERT INTO messages (session_id, role, content, timestamp)
        VALUES ('sess-main', 'user', 'Check files please', 1774920001.1);

        INSERT INTO messages (session_id, role, content, reasoning, tool_calls, timestamp)
        VALUES (
          'sess-main',
          'assistant',
          'Checking files now',
          'Need to run terminal command to check directory contents',
          '[{"id":"call-1","type":"function","function":{"name":"terminal","arguments":"{\\"command\\":\\"ls -la\\"}"}}]',
          1774920002.2
        );

        INSERT INTO messages (session_id, role, content, tool_name, tool_call_id, timestamp)
        VALUES ('sess-main', 'tool', 'package.json' || char(10) || 'src' || char(10), 'terminal', 'call-1', 1774920003.3);

        INSERT INTO messages (session_id, role, content, timestamp)
        VALUES ('sess-main', 'assistant', 'Directory contains package.json and src', 1774920004.4);

        INSERT INTO messages (session_id, role, content, timestamp, active)
        VALUES ('sess-main', 'user', 'Rewound text', 1774920006.6, 0);
      `)

      const insertStmt = db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
      insertStmt.run(
        'sess-main',
        'user',
        Buffer.from('\x00json:[{"type":"text","text":"Analyze chart"},{"type":"image_url","image_url":{"url":"https://example.com/chart.png"}}]'),
        1774920005.5
      )
      db.close()
      const dbBytesBefore = await readFile(dbPath)

      const store = new AgentMuxMemoryAgentSessionStore()
      const storedSession: AgentMuxStoredAgentSession = {
        kind: 'agent',
        agentSessionId: 'hermes-session-1',
        providerId: 'hermes',
        executorId: 'hermes',
        hostId: 'local',
        workspacePath,
        run: { runId: 'run-1' },
        retiredRuns: [],
        hookBindingId: 'bind-1',
        hookToken: 'token-1',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        nativeHandle: {
          kind: 'provider',
          providerId: 'hermes',
          sessionId: 'sess-main',
          transcriptPath: dbPath
        }
      }
      await store.compareAndSwap(null, storedSession)
      const storeBefore = await store.load()

      const registry = new AgentProviderRegistry()
      const client = new AgentMuxClient({ store, providers: [registry.get('hermes')] })
      clients.push(client)

      const page = await client.sessionHistoryPage('hermes-session-1', { limit: 10 })

      expect(page.agentSessionId).toBe('hermes-session-1')
      expect(page.source).toEqual({ providerId: 'hermes', nativeSessionId: 'sess-main' })
      expect(page.nextCursor).toBeNull()

      expect(page.items).toHaveLength(5)

      // Item 0: user text
      expect(page.items[0]).toMatchObject({
        kind: 'user-message',
        contentParts: [{ kind: 'text', text: 'Check files please' }],
        startedAt: Math.round(1774920001.1 * 1000)
      })

      // Item 1: assistant mixed
      expect(page.items[1]).toMatchObject({
        kind: 'assistant-message',
        contentParts: [
          { kind: 'reasoning', text: 'Need to run terminal command to check directory contents' },
          { kind: 'tool-call', name: 'terminal', input: '{"command":"ls -la"}', callId: 'call-1' },
          { kind: 'text', text: 'Checking files now' }
        ],
        startedAt: Math.round(1774920002.2 * 1000)
      })

      // Item 2: tool result activity
      expect(page.items[2]).toMatchObject({
        kind: 'activity',
        title: 'Tool: terminal',
        contentParts: [
          { kind: 'tool-result', name: 'terminal', output: 'package.json\nsrc\n', callId: 'call-1' }
        ],
        startedAt: Math.round(1774920003.3 * 1000)
      })

      // Item 3: assistant final response
      expect(page.items[3]).toMatchObject({
        kind: 'assistant-message',
        contentParts: [{ kind: 'text', text: 'Directory contains package.json and src' }],
        startedAt: Math.round(1774920004.4 * 1000)
      })

      // Item 4: user multimodal message
      expect(page.items[4]).toMatchObject({
        kind: 'user-message',
        contentParts: [
          { kind: 'text', text: 'Analyze chart' },
          { kind: 'resource', resourceType: 'image', reference: 'https://example.com/chart.png' }
        ],
        startedAt: Math.round(1774920005.5 * 1000)
      })

      const dbBytesAfter = await readFile(dbPath)
      expect(dbBytesAfter.equals(dbBytesBefore)).toBe(true)
      expect(await store.load()).toEqual(storeBefore)

      const freshClient = new AgentMuxClient({ store, providers: [registry.get('hermes')] })
      clients.push(freshClient)
      const freshPage = await freshClient.sessionHistoryPage('hermes-session-1', { limit: 10 })
      expect(freshPage.items).toEqual(page.items)
    })

    it('decodes \\0json: multimodal resources across assistant, tool, and system roles without exposing sentinel', async () => {
      const db = createTestDatabase()
      const workspacePath = join(tempDir, 'workspace')

      db.exec(`
        INSERT INTO sessions (id, source, model, cwd, started_at)
        VALUES ('sess-roles', 'cli', 'nous-hermes-3', '${workspacePath}', 1774920000.0);
      `)

      const stmt = db.prepare('INSERT INTO messages (session_id, role, content, tool_name, tool_call_id, timestamp) VALUES (?, ?, ?, ?, ?, ?)')
      const encodedImage = Buffer.from('\x00json:[{"type":"text","text":"caption"},{"type":"image_url","image_url":{"url":"data:image/png;base64,QUJD"}}]')

      stmt.run('sess-roles', 'assistant', encodedImage, null, null, 1774920001.0)
      stmt.run('sess-roles', 'tool', encodedImage, 'screenshot', 'call-img', 1774920002.0)
      stmt.run('sess-roles', 'system', encodedImage, null, null, 1774920003.0)
      db.close()

      const store = new AgentMuxMemoryAgentSessionStore()
      await store.compareAndSwap(null, {
        kind: 'agent',
        agentSessionId: 'hermes-roles-session',
        providerId: 'hermes',
        executorId: 'hermes',
        hostId: 'local',
        workspacePath,
        run: { runId: 'run-r' },
        retiredRuns: [],
        hookBindingId: 'b',
        hookToken: 't',
        createdAt: 1,
        updatedAt: 1,
        nativeHandle: {
          kind: 'provider',
          providerId: 'hermes',
          sessionId: 'sess-roles',
          transcriptPath: dbPath
        }
      })

      const client = new AgentMuxClient({ store, providers: [new AgentProviderRegistry().get('hermes')] })
      clients.push(client)

      const page = await client.sessionHistoryPage('hermes-roles-session', { limit: 10 })
      expect(page.items).toHaveLength(3)

      for (const item of page.items) {
        expect(JSON.stringify(item.contentParts)).not.toContain('json:')
        const resourcePart = item.contentParts.find((p) => p.kind === 'resource')
        expect(resourcePart).toBeDefined()
        expect(resourcePart).toMatchObject({
          kind: 'resource',
          resourceType: 'image',
          reference: 'data:image/png;base64,QUJD'
        })
      }
    })

    it('paginates newest-first across cursors without duplicates or gaps', async () => {
      const db = createTestDatabase()
      const workspacePath = join(tempDir, 'workspace')

      db.exec(`
        INSERT INTO sessions (id, source, model, cwd, started_at)
        VALUES ('sess-page', 'cli', 'nous-hermes-3', '${workspacePath}', 1774920000.0);
      `)

      for (let i = 1; i <= 5; i++) {
        db.exec(`
          INSERT INTO messages (session_id, role, content, timestamp)
          VALUES ('sess-page', 'user', 'Message ${i}', ${1774920000 + i});
        `)
      }
      db.close()

      const store = new AgentMuxMemoryAgentSessionStore()
      await store.compareAndSwap(null, {
        kind: 'agent',
        agentSessionId: 'hermes-page-session',
        providerId: 'hermes',
        executorId: 'hermes',
        hostId: 'local',
        workspacePath,
        run: { runId: 'run-p' },
        retiredRuns: [],
        hookBindingId: 'bind-p',
        hookToken: 'token-p',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        nativeHandle: {
          kind: 'provider',
          providerId: 'hermes',
          sessionId: 'sess-page',
          transcriptPath: dbPath
        }
      })

      const registry = new AgentProviderRegistry()
      const client = new AgentMuxClient({ store, providers: [registry.get('hermes')] })
      clients.push(client)

      const p1 = await client.sessionHistoryPage('hermes-page-session', { limit: 2 })
      expect(p1.items).toHaveLength(2)
      expect(p1.items.map((it) => (it.contentParts[0] as { text: string }).text)).toEqual(['Message 4', 'Message 5'])
      expect(p1.nextCursor).toBeTruthy()

      const p2 = await client.sessionHistoryPage('hermes-page-session', { limit: 2, cursor: p1.nextCursor! })
      expect(p2.items).toHaveLength(2)
      expect(p2.items.map((it) => (it.contentParts[0] as { text: string }).text)).toEqual(['Message 2', 'Message 3'])
      expect(p2.nextCursor).toBeTruthy()

      const p3 = await client.sessionHistoryPage('hermes-page-session', { limit: 2, cursor: p2.nextCursor! })
      expect(p3.items).toHaveLength(1)
      expect(p3.items.map((it) => (it.contentParts[0] as { text: string }).text)).toEqual(['Message 1'])
      expect(p3.nextCursor).toBeNull()

      const allTexts = [
        ...p3.items.map((it) => (it.contentParts[0] as { text: string }).text),
        ...p2.items.map((it) => (it.contentParts[0] as { text: string }).text),
        ...p1.items.map((it) => (it.contentParts[0] as { text: string }).text)
      ]
      expect(allTexts).toEqual(['Message 1', 'Message 2', 'Message 3', 'Message 4', 'Message 5'])
    })

    it('rejects session when workspace mismatch is detected', async () => {
      const wsA = join(tempDir, 'ws-a')
      const wsB = join(tempDir, 'ws-b')
      await mkdir(wsA, { recursive: true })
      await mkdir(wsB, { recursive: true })

      const db = createTestDatabase()
      db.exec(`
        INSERT INTO sessions (id, source, model, cwd, started_at)
        VALUES ('sess-ws', 'cli', 'nous-hermes-3', '${wsA}', 1774920000.0);
      `)
      db.close()

      const store = new AgentMuxMemoryAgentSessionStore()
      await store.compareAndSwap(null, {
        kind: 'agent',
        agentSessionId: 'hermes-ws-session',
        providerId: 'hermes',
        executorId: 'hermes',
        hostId: 'local',
        workspacePath: wsB,
        run: { runId: 'run-ws' },
        retiredRuns: [],
        hookBindingId: 'b',
        hookToken: 't',
        createdAt: 1,
        updatedAt: 1,
        nativeHandle: {
          kind: 'provider',
          providerId: 'hermes',
          sessionId: 'sess-ws',
          transcriptPath: dbPath
        }
      })

      const client = new AgentMuxClient({ store, providers: [new AgentProviderRegistry().get('hermes')] })
      clients.push(client)

      await expect(client.sessionHistoryPage('hermes-ws-session')).rejects.toMatchObject({
        code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED'
      })
    })

    it('rejects when native session ID is not found in database', async () => {
      const workspacePath = join(tempDir, 'workspace')
      const db = createTestDatabase()
      db.exec(`
        INSERT INTO sessions (id, source, model, cwd, started_at)
        VALUES ('other-session', 'cli', 'nous-hermes-3', '${workspacePath}', 1774920000.0);
      `)
      db.close()

      const store = new AgentMuxMemoryAgentSessionStore()
      await store.compareAndSwap(null, {
        kind: 'agent',
        agentSessionId: 'hermes-wrong-id',
        providerId: 'hermes',
        executorId: 'hermes',
        hostId: 'local',
        workspacePath,
        run: { runId: 'run-w' },
        retiredRuns: [],
        hookBindingId: 'b',
        hookToken: 't',
        createdAt: 1,
        updatedAt: 1,
        nativeHandle: {
          kind: 'provider',
          providerId: 'hermes',
          sessionId: 'target-session-missing',
          transcriptPath: dbPath
        }
      })

      const client = new AgentMuxClient({ store, providers: [new AgentProviderRegistry().get('hermes')] })
      clients.push(client)

      await expect(client.sessionHistoryPage('hermes-wrong-id')).rejects.toMatchObject({
        code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED'
      })
    })

    it('rejects when database file does not exist', async () => {
      const store = new AgentMuxMemoryAgentSessionStore()
      await store.compareAndSwap(null, {
        kind: 'agent',
        agentSessionId: 'hermes-missing-db',
        providerId: 'hermes',
        executorId: 'hermes',
        hostId: 'local',
        workspacePath: '/workspace',
        run: { runId: 'run-m' },
        retiredRuns: [],
        hookBindingId: 'b',
        hookToken: 't',
        createdAt: 1,
        updatedAt: 1,
        nativeHandle: {
          kind: 'provider',
          providerId: 'hermes',
          sessionId: 'sess-missing',
          transcriptPath: join(tempDir, 'nonexistent.db')
        }
      })

      const client = new AgentMuxClient({ store, providers: [new AgentProviderRegistry().get('hermes')] })
      clients.push(client)

      await expect(client.sessionHistoryPage('hermes-missing-db')).rejects.toMatchObject({
        code: 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE'
      })
    })

    it('rejects when database file is replaced or truncated while paging with cursor', async () => {
      const db = createTestDatabase()
      const workspacePath = join(tempDir, 'workspace')
      db.exec(`
        INSERT INTO sessions (id, source, model, cwd, started_at)
        VALUES ('sess-replace', 'cli', 'nous-hermes-3', '${workspacePath}', 1774920000.0);
        INSERT INTO messages (session_id, role, content, timestamp) VALUES ('sess-replace', 'user', 'M1', 1774920001.0);
        INSERT INTO messages (session_id, role, content, timestamp) VALUES ('sess-replace', 'user', 'M2', 1774920002.0);
      `)
      db.close()

      const store = new AgentMuxMemoryAgentSessionStore()
      await store.compareAndSwap(null, {
        kind: 'agent',
        agentSessionId: 'hermes-replace-session',
        providerId: 'hermes',
        executorId: 'hermes',
        hostId: 'local',
        workspacePath,
        run: { runId: 'run-r' },
        retiredRuns: [],
        hookBindingId: 'b',
        hookToken: 't',
        createdAt: 1,
        updatedAt: 1,
        nativeHandle: {
          kind: 'provider',
          providerId: 'hermes',
          sessionId: 'sess-replace',
          transcriptPath: dbPath
        }
      })

      const client = new AgentMuxClient({ store, providers: [new AgentProviderRegistry().get('hermes')] })
      clients.push(client)

      const page1 = await client.sessionHistoryPage('hermes-replace-session', { limit: 1 })
      expect(page1.nextCursor).toBeTruthy()

      await rm(dbPath)
      const newDb = createTestDatabase()
      newDb.exec(`
        INSERT INTO sessions (id, source, model, cwd, started_at)
        VALUES ('sess-replace', 'cli', 'nous-hermes-3', '${workspacePath}', 1774920000.0);
        INSERT INTO messages (session_id, role, content, timestamp) VALUES ('sess-replace', 'user', 'M1', 1774920001.0);
      `)
      newDb.close()

      await expect(
        client.sessionHistoryPage('hermes-replace-session', { limit: 1, cursor: page1.nextCursor! })
      ).rejects.toMatchObject({
        code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED'
      })
    })

    it('rejects with AGENT_SESSION_HISTORY_INVALID_CURSOR on malformed cursor text', async () => {
      const db = createTestDatabase()
      const workspacePath = join(tempDir, 'workspace')
      db.exec(`
        INSERT INTO sessions (id, source, model, cwd, started_at)
        VALUES ('sess-bad-cursor', 'cli', 'nous-hermes-3', '${workspacePath}', 1774920000.0);
        INSERT INTO messages (session_id, role, content, timestamp) VALUES ('sess-bad-cursor', 'user', 'M1', 1774920001.0);
      `)
      db.close()

      const store = new AgentMuxMemoryAgentSessionStore()
      await store.compareAndSwap(null, {
        kind: 'agent',
        agentSessionId: 'hermes-bad-cursor-session',
        providerId: 'hermes',
        executorId: 'hermes',
        hostId: 'local',
        workspacePath,
        run: { runId: 'run-b' },
        retiredRuns: [],
        hookBindingId: 'b',
        hookToken: 't',
        createdAt: 1,
        updatedAt: 1,
        nativeHandle: {
          kind: 'provider',
          providerId: 'hermes',
          sessionId: 'sess-bad-cursor',
          transcriptPath: dbPath
        }
      })

      const client = new AgentMuxClient({ store, providers: [new AgentProviderRegistry().get('hermes')] })
      clients.push(client)

      await expect(
        client.sessionHistoryPage('hermes-bad-cursor-session', { limit: 1, cursor: 'invalid-cursor-string' })
      ).rejects.toMatchObject({
        code: 'AGENT_SESSION_HISTORY_INVALID_CURSOR'
      })
    })

    it('honors AbortSignal and aborts promptly', async () => {
      const db = createTestDatabase()
      const workspacePath = join(tempDir, 'workspace')
      db.exec(`
        INSERT INTO sessions (id, source, model, cwd, started_at)
        VALUES ('sess-abort', 'cli', 'nous-hermes-3', '${workspacePath}', 1774920000.0);
      `)
      db.close()

      const hermes = new AgentProviderRegistry().get('hermes')
      const controller = new AbortController()
      controller.abort()

      await expect(
        hermes.readSessionHistoryPage!({
          source: { providerId: 'hermes', nativeSessionId: 'sess-abort' },
          transcriptPath: dbPath,
          command: 'hermes',
          args: [],
          env: {},
          workspacePath,
          limit: 10,
          signal: controller.signal
        })
      ).rejects.toThrow()
    })

    it('resolves real directory across symlink aliases without false-positive workspace mismatch', async () => {
      const realWorkspace = join(tempDir, 'real-workspace')
      const symlinkWorkspace = join(tempDir, 'symlink-workspace')
      await mkdir(realWorkspace, { recursive: true })
      await symlink(realWorkspace, symlinkWorkspace)

      const db = createTestDatabase()
      db.exec(`
        INSERT INTO sessions (id, source, model, cwd, started_at)
        VALUES ('sess-symlink', 'cli', 'nous-hermes-3', '${realWorkspace}', 1774920000.0);
        INSERT INTO messages (session_id, role, content, timestamp)
        VALUES ('sess-symlink', 'user', 'Hello through symlink', 1774920001.0);
      `)
      db.close()

      const store = new AgentMuxMemoryAgentSessionStore()
      await store.compareAndSwap(null, {
        kind: 'agent',
        agentSessionId: 'hermes-symlink-session',
        providerId: 'hermes',
        executorId: 'hermes',
        hostId: 'local',
        workspacePath: symlinkWorkspace,
        run: { runId: 'run-symlink' },
        retiredRuns: [],
        hookBindingId: 'b',
        hookToken: 't',
        createdAt: 1,
        updatedAt: 1,
        nativeHandle: {
          kind: 'provider',
          providerId: 'hermes',
          sessionId: 'sess-symlink',
          transcriptPath: dbPath
        }
      })

      const client = new AgentMuxClient({ store, providers: [new AgentProviderRegistry().get('hermes')] })
      clients.push(client)

      const page = await client.sessionHistoryPage('hermes-symlink-session', { limit: 10 })
      expect(page.items).toHaveLength(1)
      expect(page.items[0]).toMatchObject({
        kind: 'user-message',
        contentParts: [{ kind: 'text', text: 'Hello through symlink' }]
      })
    })

    it('rejects when cursor anchor is deleted or rewound in SQLite', async () => {
      const db = createTestDatabase()
      const workspacePath = join(tempDir, 'workspace')
      db.exec(`
        INSERT INTO sessions (id, source, model, cwd, started_at)
        VALUES ('sess-anchor-test', 'cli', 'nous-hermes-3', '${workspacePath}', 1774920000.0);
        INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (10, 'sess-anchor-test', 'user', 'M1', 1774920001.0);
        INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (20, 'sess-anchor-test', 'user', 'M2', 1774920002.0);
      `)
      db.close()

      const store = new AgentMuxMemoryAgentSessionStore()
      await store.compareAndSwap(null, {
        kind: 'agent',
        agentSessionId: 'hermes-anchor-session',
        providerId: 'hermes',
        executorId: 'hermes',
        hostId: 'local',
        workspacePath,
        run: { runId: 'run-a' },
        retiredRuns: [],
        hookBindingId: 'b',
        hookToken: 't',
        createdAt: 1,
        updatedAt: 1,
        nativeHandle: {
          kind: 'provider',
          providerId: 'hermes',
          sessionId: 'sess-anchor-test',
          transcriptPath: dbPath
        }
      })

      const client = new AgentMuxClient({ store, providers: [new AgentProviderRegistry().get('hermes')] })
      clients.push(client)

      const page1 = await client.sessionHistoryPage('hermes-anchor-session', { limit: 1 })
      expect(page1.items).toHaveLength(1)
      expect(page1.nextCursor).toBeTruthy()

      // Soft-delete / rewind the anchor message (id=20)
      const mutDb = new DatabaseSync(dbPath)
      mutDb.exec("UPDATE messages SET active = 0 WHERE id = 20;")
      mutDb.close()

      await expect(
        client.sessionHistoryPage('hermes-anchor-session', { limit: 1, cursor: page1.nextCursor! })
      ).rejects.toMatchObject({
        code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED'
      })
    })

    it('allows cursor pagination when unrelated sessions grow in the same state.db', async () => {
      const db = createTestDatabase()
      const workspacePath = join(tempDir, 'workspace')
      db.exec(`
        INSERT INTO sessions (id, source, model, cwd, started_at)
        VALUES ('sess-isolated-growth', 'cli', 'nous-hermes-3', '${workspacePath}', 1774920000.0);
        INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (100, 'sess-isolated-growth', 'user', 'Iso-1', 1774920001.0);
        INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (200, 'sess-isolated-growth', 'user', 'Iso-2', 1774920002.0);
      `)
      db.close()

      const store = new AgentMuxMemoryAgentSessionStore()
      await store.compareAndSwap(null, {
        kind: 'agent',
        agentSessionId: 'hermes-growth-session',
        providerId: 'hermes',
        executorId: 'hermes',
        hostId: 'local',
        workspacePath,
        run: { runId: 'run-g' },
        retiredRuns: [],
        hookBindingId: 'b',
        hookToken: 't',
        createdAt: 1,
        updatedAt: 1,
        nativeHandle: {
          kind: 'provider',
          providerId: 'hermes',
          sessionId: 'sess-isolated-growth',
          transcriptPath: dbPath
        }
      })

      const client = new AgentMuxClient({ store, providers: [new AgentProviderRegistry().get('hermes')] })
      clients.push(client)

      const page1 = await client.sessionHistoryPage('hermes-growth-session', { limit: 1 })
      expect(page1.items).toHaveLength(1)
      expect(page1.nextCursor).toBeTruthy()

      // Unrelated session inserts rows into the same state.db
      const growDb = new DatabaseSync(dbPath)
      growDb.exec(`
        INSERT INTO sessions (id, source, model, cwd, started_at)
        VALUES ('sess-unrelated', 'cli', 'nous-hermes-3', '/other', 1774920010.0);
        INSERT INTO messages (session_id, role, content, timestamp)
        VALUES ('sess-unrelated', 'user', 'Unrelated data', 1774920011.0);
      `)
      growDb.close()

      // Page 2 must succeed and return Iso-1 without being invalidated by unrelated session growth
      const page2 = await client.sessionHistoryPage('hermes-growth-session', { limit: 1, cursor: page1.nextCursor! })
      expect(page2.items).toHaveLength(1)
      expect(page2.items[0]).toMatchObject({
        kind: 'user-message',
        contentParts: [{ kind: 'text', text: 'Iso-1' }]
      })
    })

    it('rejects oversized single-message page exceeding byte budget with AGENT_SESSION_HISTORY_TOO_LARGE', async () => {
      const db = createTestDatabase()
      const workspacePath = join(tempDir, 'workspace')
      db.exec(`
        INSERT INTO sessions (id, source, model, cwd, started_at)
        VALUES ('sess-oversized', 'cli', 'nous-hermes-3', '${workspacePath}', 1774920000.0);
      `)

      const oversizedStmt = db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
      oversizedStmt.run('sess-oversized', 'user', 'x'.repeat(4 * 1024 * 1024 + 1024), 1774920001.0)
      db.close()

      const store = new AgentMuxMemoryAgentSessionStore()
      await store.compareAndSwap(null, {
        kind: 'agent',
        agentSessionId: 'hermes-oversized-session',
        providerId: 'hermes',
        executorId: 'hermes',
        hostId: 'local',
        workspacePath,
        run: { runId: 'run-o' },
        retiredRuns: [],
        hookBindingId: 'b',
        hookToken: 't',
        createdAt: 1,
        updatedAt: 1,
        nativeHandle: {
          kind: 'provider',
          providerId: 'hermes',
          sessionId: 'sess-oversized',
          transcriptPath: dbPath
        }
      })

      const client = new AgentMuxClient({ store, providers: [new AgentProviderRegistry().get('hermes')] })
      clients.push(client)

      await expect(client.sessionHistoryPage('hermes-oversized-session')).rejects.toMatchObject({
        code: 'AGENT_SESSION_HISTORY_TOO_LARGE'
      })
    })

    it('rejects >4MiB Unicode row exceeding byte budget with AGENT_SESSION_HISTORY_TOO_LARGE', async () => {
      const db = createTestDatabase()
      const workspacePath = join(tempDir, 'workspace')
      db.exec(`
        INSERT INTO sessions (id, source, model, cwd, started_at)
        VALUES ('sess-unicode-oversized', 'cli', 'nous-hermes-3', '${workspacePath}', 1774920000.0);
      `)

      const unicodeStmt = db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
      unicodeStmt.run('sess-unicode-oversized', 'user', '中'.repeat(2 * 1024 * 1024), 1774920001.0)
      db.close()

      const store = new AgentMuxMemoryAgentSessionStore()
      await store.compareAndSwap(null, {
        kind: 'agent',
        agentSessionId: 'hermes-unicode-session',
        providerId: 'hermes',
        executorId: 'hermes',
        hostId: 'local',
        workspacePath,
        run: { runId: 'run-u' },
        retiredRuns: [],
        hookBindingId: 'b',
        hookToken: 't',
        createdAt: 1,
        updatedAt: 1,
        nativeHandle: {
          kind: 'provider',
          providerId: 'hermes',
          sessionId: 'sess-unicode-oversized',
          transcriptPath: dbPath
        }
      })

      const client = new AgentMuxClient({ store, providers: [new AgentProviderRegistry().get('hermes')] })
      clients.push(client)

      await expect(client.sessionHistoryPage('hermes-unicode-session')).rejects.toMatchObject({
        code: 'AGENT_SESSION_HISTORY_TOO_LARGE'
      })
    })

    it('rejects >4MiB NUL-sentinel native multimodal message with AGENT_SESSION_HISTORY_TOO_LARGE', async () => {
      const db = createTestDatabase()
      const workspacePath = join(tempDir, 'workspace')
      db.exec(`
        INSERT INTO sessions (id, source, model, cwd, started_at)
        VALUES ('sess-multimodal-oversized', 'cli', 'nous-hermes-3', '${workspacePath}', 1774920000.0);
      `)

      const mmStmt = db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
      mmStmt.run('sess-multimodal-oversized', 'user', Buffer.from('\x00json:' + 'x'.repeat(4 * 1024 * 1024 + 1024)), 1774920001.0)
      db.close()

      const store = new AgentMuxMemoryAgentSessionStore()
      await store.compareAndSwap(null, {
        kind: 'agent',
        agentSessionId: 'hermes-multimodal-session',
        providerId: 'hermes',
        executorId: 'hermes',
        hostId: 'local',
        workspacePath,
        run: { runId: 'run-mm' },
        retiredRuns: [],
        hookBindingId: 'b',
        hookToken: 't',
        createdAt: 1,
        updatedAt: 1,
        nativeHandle: {
          kind: 'provider',
          providerId: 'hermes',
          sessionId: 'sess-multimodal-oversized',
          transcriptPath: dbPath
        }
      })

      const client = new AgentMuxClient({ store, providers: [new AgentProviderRegistry().get('hermes')] })
      clients.push(client)

      await expect(client.sessionHistoryPage('hermes-multimodal-session')).rejects.toMatchObject({
        code: 'AGENT_SESSION_HISTORY_TOO_LARGE'
      })
    })

    it('rejects with AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE when workspace is missing or unreadable without blanket fallback', async () => {
      const db = createTestDatabase()
      const nonExistentWorkspace = join(tempDir, 'nonexistent-workspace-dir-missing')
      db.exec(`
        INSERT INTO sessions (id, source, model, cwd, started_at)
        VALUES ('sess-missing-ws', 'cli', 'nous-hermes-3', '${nonExistentWorkspace}', 1774920000.0);
        INSERT INTO messages (session_id, role, content, timestamp) VALUES ('sess-missing-ws', 'user', 'hi', 1774920001.0);
      `)
      db.close()

      const store = new AgentMuxMemoryAgentSessionStore()
      await store.compareAndSwap(null, {
        kind: 'agent',
        agentSessionId: 'hermes-missing-ws-session',
        providerId: 'hermes',
        executorId: 'hermes',
        hostId: 'local',
        workspacePath: nonExistentWorkspace,
        run: { runId: 'run-mws' },
        retiredRuns: [],
        hookBindingId: 'b',
        hookToken: 't',
        createdAt: 1,
        updatedAt: 1,
        nativeHandle: {
          kind: 'provider',
          providerId: 'hermes',
          sessionId: 'sess-missing-ws',
          transcriptPath: dbPath
        }
      })

      const client = new AgentMuxClient({ store, providers: [new AgentProviderRegistry().get('hermes')] })
      clients.push(client)

      await expect(client.sessionHistoryPage('hermes-missing-ws-session')).rejects.toMatchObject({
        code: 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE'
      })
    })

    it('rejects with AGENT_SESSION_HISTORY_SOURCE_CHANGED when anchor content is rewritten on the same inode', async () => {
      const db = createTestDatabase()
      const workspacePath = join(tempDir, 'workspace')
      db.exec(`
        INSERT INTO sessions (id, source, model, cwd, started_at)
        VALUES ('sess-anchor-rewrite', 'cli', 'nous-hermes-3', '${workspacePath}', 1774920000.0);
        INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (50, 'sess-anchor-rewrite', 'user', 'Original M1', 1774920001.0);
        INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (60, 'sess-anchor-rewrite', 'user', 'Original M2', 1774920002.0);
      `)
      db.close()

      const store = new AgentMuxMemoryAgentSessionStore()
      await store.compareAndSwap(null, {
        kind: 'agent',
        agentSessionId: 'hermes-rewrite-session',
        providerId: 'hermes',
        executorId: 'hermes',
        hostId: 'local',
        workspacePath,
        run: { runId: 'run-rw' },
        retiredRuns: [],
        hookBindingId: 'b',
        hookToken: 't',
        createdAt: 1,
        updatedAt: 1,
        nativeHandle: {
          kind: 'provider',
          providerId: 'hermes',
          sessionId: 'sess-anchor-rewrite',
          transcriptPath: dbPath
        }
      })

      const client = new AgentMuxClient({ store, providers: [new AgentProviderRegistry().get('hermes')] })
      clients.push(client)

      const page1 = await client.sessionHistoryPage('hermes-rewrite-session', { limit: 1 })
      expect(page1.items).toHaveLength(1)
      expect(page1.nextCursor).toBeTruthy()

      const rewriteDb = new DatabaseSync(dbPath)
      rewriteDb.exec("UPDATE messages SET content = 'Rewritten M2 content' WHERE id = 60;")
      rewriteDb.close()

      await expect(
        client.sessionHistoryPage('hermes-rewrite-session', { limit: 1, cursor: page1.nextCursor! })
      ).rejects.toMatchObject({
        code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED'
      })
    })

    it('retains full structured bytes when function.arguments is an object or dictionary', async () => {
      const db = createTestDatabase()
      const workspacePath = join(tempDir, 'workspace')
      db.exec(`
        INSERT INTO sessions (id, source, model, cwd, started_at)
        VALUES ('sess-obj-args', 'cli', 'nous-hermes-3', '${workspacePath}', 1774920000.0);

        INSERT INTO messages (session_id, role, content, tool_calls, timestamp)
        VALUES (
          'sess-obj-args',
          'assistant',
          'Running command',
          '[{"id":"call-obj-1","type":"function","function":{"name":"run_tool","arguments":{"flag":true,"count":42}}}]',
          1774920001.0
        );
      `)
      db.close()

      const store = new AgentMuxMemoryAgentSessionStore()
      await store.compareAndSwap(null, {
        kind: 'agent',
        agentSessionId: 'hermes-obj-args-session',
        providerId: 'hermes',
        executorId: 'hermes',
        hostId: 'local',
        workspacePath,
        run: { runId: 'run-oa' },
        retiredRuns: [],
        hookBindingId: 'b',
        hookToken: 't',
        createdAt: 1,
        updatedAt: 1,
        nativeHandle: {
          kind: 'provider',
          providerId: 'hermes',
          sessionId: 'sess-obj-args',
          transcriptPath: dbPath
        }
      })

      const client = new AgentMuxClient({ store, providers: [new AgentProviderRegistry().get('hermes')] })
      clients.push(client)

      const page = await client.sessionHistoryPage('hermes-obj-args-session', { limit: 1 })
      expect(page.items).toHaveLength(1)
      const toolCallPart = page.items[0]?.contentParts.find((p) => p.kind === 'tool-call')
      expect(toolCallPart).toEqual({
        kind: 'tool-call',
        name: 'run_tool',
        input: '{"flag":true,"count":42}',
        callId: 'call-obj-1'
      })
    })

    it('resolves canonical hermes home from HERMES_HOME or defaults to ~/.hermes', async () => {
      const hermes = new AgentProviderRegistry().get('hermes')
      const customEnv = { HERMES_HOME: join(tempDir, 'custom-hermes') }
      const expectedDbPath = join(tempDir, 'custom-hermes', 'state.db')

      await expect(
        hermes.readSessionHistoryPage!({
          source: { providerId: 'hermes', nativeSessionId: 'sess-custom' },
          command: 'hermes',
          args: [],
          env: customEnv,
          workspacePath: join(tempDir, 'workspace'),
          limit: 10,
          signal: new AbortController().signal
        })
      ).rejects.toThrow(new RegExp(`Hermes state database not found: ${expectedDbPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
    })

    it('public first-party list content preserves the relative positions of text and resources', async () => {
      const db = createTestDatabase()
      const workspacePath = join(tempDir, 'workspace')
      db.exec(`
        INSERT INTO sessions (id, source, model, cwd, started_at)
        VALUES ('sess-interleaved', 'cli', 'nous-hermes-3', '${workspacePath}', 1774920000.0);
      `)

      const stmt = db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
      const encodedInterleaved = Buffer.from(
        '\x00json:' + JSON.stringify([
          { type: 'text', text: 'before image' },
          { type: 'image_url', image_url: { url: 'ordered-image' } },
          { type: 'text', text: 'after image before file' },
          { type: 'file', path: '/ordered-file', name: '/ordered-file' }
        ])
      )
      stmt.run('sess-interleaved', 'user', encodedInterleaved, 1774920001.0)
      db.close()

      const store = new AgentMuxMemoryAgentSessionStore()
      await store.compareAndSwap(null, {
        kind: 'agent',
        agentSessionId: 'hermes-interleaved-session',
        providerId: 'hermes',
        executorId: 'hermes',
        hostId: 'local',
        workspacePath,
        run: { runId: 'run-il' },
        retiredRuns: [],
        hookBindingId: 'b',
        hookToken: 't',
        createdAt: 1,
        updatedAt: 1,
        nativeHandle: {
          kind: 'provider',
          providerId: 'hermes',
          sessionId: 'sess-interleaved',
          transcriptPath: dbPath
        }
      })

      const client = new AgentMuxClient({ store, providers: [new AgentProviderRegistry().get('hermes')] })
      clients.push(client)

      const page = await client.sessionHistoryPage('hermes-interleaved-session', { limit: 1 })
      expect(page.items).toHaveLength(1)
      expect(page.items[0]!.contentParts).toEqual([
        { kind: 'text', text: 'before image' },
        { kind: 'resource', resourceType: 'image', reference: 'ordered-image' },
        { kind: 'text', text: 'after image before file' },
        { kind: 'resource', resourceType: 'file', reference: '/ordered-file', label: '/ordered-file' }
      ])
    })

    it('enforces shared whole-call 4MiB budget across cursor anchor and page payload', async () => {
      const db = createTestDatabase()
      const workspacePath = join(tempDir, 'workspace')
      db.exec(`
        INSERT INTO sessions (id, source, model, cwd, started_at)
        VALUES ('sess-shared-budget', 'cli', 'nous-hermes-3', '${workspacePath}', 1774920000.0);
      `)

      const each = 2_300_000 // 2.3 MB
      const stmt = db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
      stmt.run('sess-shared-budget', 'user', 'O'.repeat(each), 1774920001.0)
      stmt.run('sess-shared-budget', 'assistant', 'A'.repeat(each), 1774920002.0)
      db.close()

      const store = new AgentMuxMemoryAgentSessionStore()
      await store.compareAndSwap(null, {
        kind: 'agent',
        agentSessionId: 'hermes-shared-budget-session',
        providerId: 'hermes',
        executorId: 'hermes',
        hostId: 'local',
        workspacePath,
        run: { runId: 'run-sb' },
        retiredRuns: [],
        hookBindingId: 'b',
        hookToken: 't',
        createdAt: 1,
        updatedAt: 1,
        nativeHandle: {
          kind: 'provider',
          providerId: 'hermes',
          sessionId: 'sess-shared-budget',
          transcriptPath: dbPath
        }
      })

      const client = new AgentMuxClient({ store, providers: [new AgentProviderRegistry().get('hermes')] })
      clients.push(client)

      const p1 = await client.sessionHistoryPage('hermes-shared-budget-session', { limit: 1 })
      expect(p1.items).toHaveLength(1)
      expect(p1.nextCursor).toBeTruthy()

      // Page 2: anchor is 2.3 MB, user message is 2.3 MB. 2.3 + 2.3 = 4.6 MB > 4 MiB.
      // Must reject with AGENT_SESSION_HISTORY_TOO_LARGE because total BLOB bytes exceed whole-call budget.
      await expect(
        client.sessionHistoryPage('hermes-shared-budget-session', { limit: 1, cursor: p1.nextCursor! })
      ).rejects.toMatchObject({
        code: 'AGENT_SESSION_HISTORY_TOO_LARGE'
      })
    })

    it('aborts at anchor-metadata checkpoint with zero subsequent payload query', async () => {
      const db = createTestDatabase()
      const workspacePath = join(tempDir, 'workspace')
      db.exec(`
        INSERT INTO sessions (id, source, model, cwd, started_at)
        VALUES ('sess-anchor-cancel', 'cli', 'nous-hermes-3', '${workspacePath}', 1774920000.0);
        INSERT INTO messages (session_id, role, content, timestamp) VALUES ('sess-anchor-cancel', 'user', 'older', 1774920001.0);
        INSERT INTO messages (session_id, role, content, timestamp) VALUES ('sess-anchor-cancel', 'assistant', 'anchor', 1774920002.0);
      `)
      db.close()

      const hermes = new AgentProviderRegistry().get('hermes')
      const p1 = await hermes.readSessionHistoryPage!({
        source: { providerId: 'hermes', nativeSessionId: 'sess-anchor-cancel' },
        transcriptPath: dbPath,
        command: 'hermes',
        args: [],
        env: {},
        workspacePath,
        limit: 1,
        signal: new AbortController().signal
      })
      expect(p1.items).toHaveLength(1)
      expect(p1.nextCursor).toBeTruthy()

      const controller = new AbortController()
      const executedSqls: string[] = []
      let beforeAbortCalls = -1

      const originalPrepare = DatabaseSync.prototype.prepare
      const prepareSpy = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql: string) {
        const stmt = originalPrepare.call(this, sql)
        executedSqls.push(sql)
        if (sql.includes('anchor_bytes') && !controller.signal.aborted) {
          beforeAbortCalls = executedSqls.length
          controller.abort(new Error('private anchor-metadata checkpoint cancel'))
        }
        return stmt
      })

      try {
        await expect(
          hermes.readSessionHistoryPage!({
            source: { providerId: 'hermes', nativeSessionId: 'sess-anchor-cancel' },
            transcriptPath: dbPath,
            command: 'hermes',
            args: [],
            env: {},
            workspacePath,
            limit: 1,
            cursor: p1.nextCursor!,
            signal: controller.signal
          })
        ).rejects.toThrow('private anchor-metadata checkpoint cancel')

        expect(controller.signal.aborted).toBe(true)
        expect(beforeAbortCalls).toBeGreaterThan(0)
        // Assert that after anchor-metadata checkpoint abort, NO payload queries were executed
        const subsequentPayloadQueries = executedSqls.slice(beforeAbortCalls).filter((sql) => sql.includes('content_blob'))
        expect(subsequentPayloadQueries).toEqual([])
      } finally {
        prepareSpy.mockRestore()
      }
    })
  })
})
