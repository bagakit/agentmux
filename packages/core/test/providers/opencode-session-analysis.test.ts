import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../../src/client.js'
import { AgentProviderRegistry } from '../../src/agent-provider.js'
import { AgentMuxFileAgentSessionStore } from '../../src/agent-session-store.js'
import { SESSION_HISTORY_MAX_PAGE_BYTES } from '../../src/session-history.js'
import type { AgentMuxStoredAgentSession, AgentProviderSessionHistoryContext } from '../../src/types.js'
import type { CtxmuxRunAdapter } from '../../src/ctxmux-run-adapter.js'

const OPENCODE_SCHEMA = `
  CREATE TABLE session (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, slug TEXT NOT NULL,
    directory TEXT NOT NULL, title TEXT NOT NULL, version TEXT NOT NULL, share_url TEXT,
    summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER,
    summary_diffs TEXT, revert TEXT, permission TEXT,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_compacting INTEGER,
    time_archived INTEGER, workspace_id TEXT, path TEXT, agent TEXT, model TEXT,
    cost REAL DEFAULT 0 NOT NULL, tokens_input INTEGER DEFAULT 0 NOT NULL,
    tokens_output INTEGER DEFAULT 0 NOT NULL, tokens_reasoning INTEGER DEFAULT 0 NOT NULL,
    tokens_cache_read INTEGER DEFAULT 0 NOT NULL, tokens_cache_write INTEGER DEFAULT 0 NOT NULL,
    metadata TEXT
  );
  CREATE TABLE message (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL, data TEXT NOT NULL
  );
  CREATE TABLE part (
    id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
  );
  CREATE TABLE project (
    id TEXT PRIMARY KEY, worktree TEXT NOT NULL, vcs TEXT, name TEXT, icon_url TEXT,
    icon_color TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
    time_initialized INTEGER, sandboxes TEXT NOT NULL, commands TEXT, icon_url_override TEXT
  );
`

interface FixtureMessage {
  id: string
  role: 'user' | 'assistant' | 'compaction'
  createdAt: number
  updatedAt?: number
  completedAt?: number
  system?: string
  parts: Array<
    | { type: 'text'; text: string; synthetic?: boolean; ignored?: boolean }
    | { type: 'reasoning'; text: string }
    | {
        type: 'tool'
        tool: string
        callID: string
        state?: {
          status?: 'pending' | 'running' | 'completed' | 'error'
          input?: unknown
          output?: string | unknown
          error?: string
          attachments?: Array<{
            id?: string
            sessionID?: string
            messageID?: string
            type: 'file'
            mime: string
            url: string
            filename?: string
          }>
        }
      }
    | {
        type: 'file'
        mime: string
        url: string
        filename?: string
      }
    | { type: 'compaction' }
    | { type: 'custom_unknown'; payload: Record<string, unknown> }
  >
}

interface FixtureOptions {
  runId?: string
  sessionId?: string
  workspacePath?: string
  sqliteDirectory?: string
  dbPathOverride?: string
  dbDirectory?: string
  messages?: FixtureMessage[]
  omitSessionRow?: boolean
  dropTables?: string[]
  storeTranscriptPath?: string
  omitTranscriptPath?: boolean
  omitNativeHandle?: boolean
}

const activeFixtures: Array<{ close: () => Promise<void> }> = []
afterEach(async () => {
  await Promise.all(activeFixtures.splice(0).map((f) => f.close()))
})

async function createOpenCodeFixture(options: FixtureOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-opencode-analysis-'))
  const sessionId = options.sessionId ?? 'ses_opencode_1'
  const workspacePath = options.workspacePath ?? root
  const dbDir = options.dbDirectory ?? join(root, '.local', 'share', 'opencode')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(dbDir, { recursive: true })
  const dbPath = options.dbPathOverride ?? join(dbDir, 'opencode.db')

  // Populate SQLite database with physical protocol schema
  const db = new DatabaseSync(dbPath)
  db.exec(OPENCODE_SCHEMA)

  if (options.dropTables) {
    for (const table of options.dropTables) {
      db.exec(`DROP TABLE IF EXISTS ${table};`)
    }
  }

  if (!options.omitSessionRow && !options.dropTables?.includes('session')) {
    db.prepare(`
      INSERT INTO session (id, project_id, parent_id, slug, directory, title, version,
        time_created, time_updated, agent, model, cost, tokens_input, tokens_output,
        tokens_reasoning, tokens_cache_read, tokens_cache_write)
      VALUES (?, 'proj-1', NULL, 'slug-1', ?, 'OpenCode Session Title', '1.0.0',
        1740000000000, 1740000060000, 'build', '{"id":"test-model"}', 0, 10, 20, 5, 0, 0)
    `).run(sessionId, options.sqliteDirectory ?? workspacePath)
  }

  if (!options.dropTables?.includes('message') && !options.dropTables?.includes('part')) {
    const insertMsg = db.prepare(
      'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)'
    )
    const insertPart = db.prepare(
      'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)'
    )

    const messages = options.messages ?? []
    for (const msg of messages) {
      const timePayload: { created: number; completed?: number } = { created: msg.createdAt }
      if (typeof msg.completedAt === 'number') {
        timePayload.completed = msg.completedAt
      }

      insertMsg.run(
        msg.id,
        sessionId,
        msg.createdAt,
        msg.updatedAt ?? msg.createdAt + 100,
        JSON.stringify({
          role: msg.role,
          time: timePayload,
          ...(msg.system !== undefined ? { system: msg.system } : {})
        })
      )

      for (let i = 0; i < msg.parts.length; i++) {
        const part = msg.parts[i]!
        insertPart.run(
          `${msg.id}_part_${i}`,
          msg.id,
          sessionId,
          msg.createdAt + i,
          msg.createdAt + i,
          JSON.stringify(part)
        )
      }
    }
  }
  db.close()

  const storePath = join(root, 'agent-sessions.json')
  const store = new AgentMuxFileAgentSessionStore(storePath)
  const session: AgentMuxStoredAgentSession = {
    kind: 'agent',
    agentSessionId: 'agent-session-opencode',
    providerId: 'opencode',
    executorId: 'opencode',
    hostId: 'local',
    workspacePath,
    run: { runId: options.runId ?? `run-opencode-${Math.random().toString(36).slice(2)}-${Date.now()}` },
    retiredRuns: [],
    createdAt: 1740000000000,
    updatedAt: 1740000000000,
    hookBindingId: 'binding-opencode',
    hookToken: 'token-opencode',
    ...(options.omitNativeHandle
      ? {}
      : {
          nativeHandle: {
            kind: 'provider' as const,
            providerId: 'opencode' as const,
            sessionId,
            ...(options.omitTranscriptPath
              ? {}
              : options.storeTranscriptPath
                ? { transcriptPath: options.storeTranscriptPath }
                : options.dbPathOverride
                  ? { transcriptPath: options.dbPathOverride }
                  : { transcriptPath: dbPath })
          }
        })
  }
  await store.compareAndSwap(null, session)

  const client = new AgentMuxClient({ store })
  const kernel = (client as unknown as { kernel: CtxmuxRunAdapter }).kernel
  const controls = ['start', 'input', 'resize', 'stop', 'attach', 'status'].map((name) =>
    vi.spyOn(kernel, name as 'start')
  )

  const before = {
    native: await readFile(dbPath),
    store: await readFile(storePath)
  }

  const fixture = {
    root,
    dbPath,
    storePath,
    store,
    session,
    client,
    controls,
    before,
    async bytes() {
      return {
        native: await readFile(dbPath),
        store: await readFile(storePath)
      }
    },
    async close() {
      await client.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }
  activeFixtures.push(fixture)
  return fixture
}

describe('OpenCode native session history and trace analysis', () => {
  it('exposes readSessionHistoryPage on the built-in OpenCode provider', () => {
    const providers = new AgentProviderRegistry()
    const opencode = providers.get('opencode')
    expect(opencode.readSessionHistoryPage).toBeTypeOf('function')
  })

  it('reads authentic user and mixed assistant turns with reasoning, tool-call and tool-result blocks, preserving assistant speaker', async () => {
    const f = await createOpenCodeFixture({
      messages: [
        {
          id: 'msg_user_1',
          role: 'user',
          createdAt: 1740000010000,
          completedAt: 1740000010500,
          parts: [{ type: 'text', text: 'Please check the build logs' }]
        },
        {
          id: 'msg_asst_1',
          role: 'assistant',
          createdAt: 1740000020000,
          completedAt: 1740000025000,
          parts: [
            { type: 'reasoning', text: 'I need to run the bash tool to check logs.' },
            {
              type: 'tool',
              tool: 'bash',
              callID: 'call_bash_1',
              state: {
                status: 'completed',
                input: { command: 'cat build.log' },
                output: 'build success 0 errors'
              }
            },
            { type: 'text', text: 'The build succeeded with zero errors.' }
          ]
        }
      ]
    })

    const page = await f.client.sessionHistoryPage('agent-session-opencode')

    expect(page.source).toEqual({ providerId: 'opencode', nativeSessionId: 'ses_opencode_1' })
    expect(page.items).toHaveLength(2)

    // User turn
    const userItem = page.items[0]!
    expect(userItem.id).toBe('msg_user_1')
    expect(userItem.kind).toBe('user-message')
    expect(userItem.contentParts).toEqual([{ kind: 'text', text: 'Please check the build logs' }])
    expect(userItem.startedAt).toBe(1740000010000)
    expect(userItem.completedAt).toBe(1740000010500)

    // Mixed assistant turn: has genuine text so retains assistant-message
    const asstItem = page.items[1]!
    expect(asstItem.id).toBe('msg_asst_1')
    expect(asstItem.kind).toBe('assistant-message')
    expect(asstItem.contentParts).toEqual([
      { kind: 'reasoning', text: 'I need to run the bash tool to check logs.' },
      { kind: 'tool-call', name: 'bash', input: '{"command":"cat build.log"}', callId: 'call_bash_1' },
      { kind: 'tool-result', name: 'bash', output: 'build success 0 errors', callId: 'call_bash_1' },
      { kind: 'text', text: 'The build succeeded with zero errors.' }
    ])
    expect(asstItem.startedAt).toBe(1740000020000)
    expect(asstItem.completedAt).toBe(1740000025000)

    // Zero Run controls invoked
    for (const control of f.controls) {
      expect(control).not.toHaveBeenCalled()
    }
    // Storage immutability
    const currentBytes = await f.bytes()
    expect(currentBytes.native).toEqual(f.before.native)
    expect(currentBytes.store).toEqual(f.before.store)
  })

  it('keeps pure tool/reasoning assistant turns as activity, and omits completedAt when in-progress', async () => {
    const f = await createOpenCodeFixture({
      messages: [
        {
          id: 'msg_pure_tool',
          role: 'assistant',
          createdAt: 1740000030000,
          updatedAt: 1740000035000,
          parts: [
            { type: 'reasoning', text: 'Thinking step without user-facing prose.' },
            {
              type: 'tool',
              tool: 'fetch_data',
              callID: 'call_f1',
              state: {
                status: 'completed',
                input: { url: 'https://api.internal/data' },
                output: '{"ok":true}'
              }
            }
          ]
        }
      ]
    })

    const page = await f.client.sessionHistoryPage('agent-session-opencode')
    expect(page.items).toHaveLength(1)
    const item = page.items[0]!
    expect(item.kind).toBe('activity')
    expect(item.title).toBe('OpenCode activity')
    expect(item.contentParts).toEqual([
      { kind: 'reasoning', text: 'Thinking step without user-facing prose.' },
      { kind: 'tool-call', name: 'fetch_data', input: '{"url":"https://api.internal/data"}', callId: 'call_f1' },
      { kind: 'tool-result', name: 'fetch_data', output: '{"ok":true}', callId: 'call_f1' }
    ])
    expect(item.startedAt).toBe(1740000030000)
    expect(item.completedAt).toBeUndefined()
  })

  it('maps first-party file resources with mime, url, and filename', async () => {
    const f = await createOpenCodeFixture({
      messages: [
        {
          id: 'msg_file_turn',
          role: 'user',
          createdAt: 1740000015000,
          parts: [
            {
              type: 'file',
              mime: 'image/png',
              url: 'https://storage.local/screenshot.png',
              filename: 'screenshot.png'
            },
            { type: 'text', text: 'Please review this screenshot' }
          ]
        }
      ]
    })

    const page = await f.client.sessionHistoryPage('agent-session-opencode')
    expect(page.items).toHaveLength(1)
    const item = page.items[0]!
    expect(item.kind).toBe('user-message')
    expect(item.contentParts).toEqual([
      {
        kind: 'resource',
        resourceType: 'image',
        reference: 'https://storage.local/screenshot.png',
        label: 'screenshot.png'
      },
      { kind: 'text', text: 'Please review this screenshot' }
    ])
  })

  it('handles failed tool calls and running tool calls without forging completions', async () => {
    const f = await createOpenCodeFixture({
      messages: [
        {
          id: 'msg_asst_tools',
          role: 'assistant',
          createdAt: 1740000030000,
          parts: [
            {
              type: 'tool',
              tool: 'read_file',
              callID: 'call_read_1',
              state: {
                status: 'error',
                input: { path: '/missing.txt' },
                error: 'ENOENT: no such file or directory'
              }
            },
            {
              type: 'tool',
              tool: 'long_calc',
              callID: 'call_calc_2',
              state: {
                status: 'running',
                input: { iterations: 10000 }
              }
            },
            {
              type: 'custom_unknown',
              payload: { debug: 'extra telemetry' }
            }
          ]
        }
      ]
    })

    const page = await f.client.sessionHistoryPage('agent-session-opencode')
    expect(page.items).toHaveLength(1)
    const item = page.items[0]!
    expect(item.kind).toBe('activity')
    expect(item.contentParts).toEqual([
      { kind: 'tool-call', name: 'read_file', input: '{"path":"/missing.txt"}', callId: 'call_read_1' },
      { kind: 'tool-result', name: 'read_file', output: 'ENOENT: no such file or directory', callId: 'call_read_1', failed: true },
      { kind: 'tool-call', name: 'long_calc', input: '{"iterations":10000}', callId: 'call_calc_2' },
      { kind: 'text', text: JSON.stringify({ type: 'custom_unknown', payload: { debug: 'extra telemetry' } }) }
    ])
  })

  it('preserves compaction and synthetic user messages as neutral activity', async () => {
    const f = await createOpenCodeFixture({
      messages: [
        {
          id: 'msg_compact_1',
          role: 'compaction',
          createdAt: 1740000025000,
          parts: [{ type: 'compaction' }]
        },
        {
          id: 'msg_synthetic_1',
          role: 'user',
          createdAt: 1740000026000,
          parts: [{ type: 'text', text: 'Synthetic injected guideline', synthetic: true }]
        }
      ]
    })

    const page = await f.client.sessionHistoryPage('agent-session-opencode')
    expect(page.items).toHaveLength(2)
    expect(page.items[0]!.kind).toBe('activity')
    expect(page.items[0]!.title).toBe('OpenCode compaction')
    expect(page.items[0]!.contentParts).toEqual([{ kind: 'text', text: 'What did we do so far?' }])
    expect(page.items[1]!.kind).toBe('activity')
    expect(page.items[1]!.contentParts).toEqual([{ kind: 'text', text: 'Synthetic injected guideline' }])
  })

  it('supports snapshot-bound keyset pagination and detects database mutation / message truncation', async () => {
    const messages: FixtureMessage[] = [
      { id: 'msg_1', role: 'user', createdAt: 1740000010000, parts: [{ type: 'text', text: 'Turn 1' }] },
      { id: 'msg_2', role: 'assistant', createdAt: 1740000020000, parts: [{ type: 'text', text: 'Turn 2' }] },
      { id: 'msg_3', role: 'user', createdAt: 1740000030000, parts: [{ type: 'text', text: 'Turn 3' }] },
      { id: 'msg_4', role: 'assistant', createdAt: 1740000040000, parts: [{ type: 'text', text: 'Turn 4' }] },
      { id: 'msg_5', role: 'user', createdAt: 1740000050000, parts: [{ type: 'text', text: 'Turn 5' }] }
    ]

    const f = await createOpenCodeFixture({ messages })

    const page1 = await f.client.sessionHistoryPage('agent-session-opencode', { limit: 2 })
    expect(page1.items.map((i) => i.id)).toEqual(['msg_4', 'msg_5'])
    expect(page1.nextCursor).not.toBeNull()

    const page2 = await f.client.sessionHistoryPage('agent-session-opencode', { limit: 2, cursor: page1.nextCursor! })
    expect(page2.items.map((i) => i.id)).toEqual(['msg_2', 'msg_3'])
    expect(page2.nextCursor).not.toBeNull()

    const page3 = await f.client.sessionHistoryPage('agent-session-opencode', { limit: 2, cursor: page2.nextCursor! })
    expect(page3.items.map((i) => i.id)).toEqual(['msg_1'])
    expect(page3.nextCursor).toBeNull()

    // Truncation detection: simulate concurrent deletion of the anchor message
    const db = new DatabaseSync(f.dbPath)
    db.prepare('DELETE FROM part WHERE message_id = ?').run('msg_4')
    db.prepare('DELETE FROM message WHERE id = ?').run('msg_4')
    db.close()

    await expect(
      f.client.sessionHistoryPage('agent-session-opencode', { limit: 2, cursor: page1.nextCursor! })
    ).rejects.toThrowError(/source changed|reopen/i)
  })

  it('rejects access when the session in SQLite belongs to a different workspace directory', async () => {
    const f = await createOpenCodeFixture({
      sqliteDirectory: '/other/workspace',
      messages: [{ id: 'msg_1', role: 'user', createdAt: 1740000010000, parts: [{ type: 'text', text: 'hi' }] }]
    })

    await expect(f.client.sessionHistoryPage('agent-session-opencode')).rejects.toThrowError(
      /Native history source does not match the main Session|belongs to another workspace/i
    )
  })

  it('rejects access when native session ID does not exist in SQLite database', async () => {
    const f = await createOpenCodeFixture({
      omitSessionRow: true
    })

    await expect(f.client.sessionHistoryPage('agent-session-opencode')).rejects.toThrowError(
      /OpenCode session not found in database|not established/i
    )
  })

  it('reports unsupported when required schema table is missing rather than hiding with empty page', async () => {
    const f = await createOpenCodeFixture({
      dropTables: ['message']
    })

    await expect(f.client.sessionHistoryPage('agent-session-opencode')).rejects.toThrowError(
      /lacks required message table|unsupported/i
    )
  })

  it('resolves canonical XDG_DATA_HOME path through sessionHistoryPage options and refuses to probe guessed workspace DBs', async () => {
    const f = await createOpenCodeFixture({
      omitTranscriptPath: true,
      messages: [{ id: 'msg_1', role: 'user', createdAt: 1740000010000, parts: [{ type: 'text', text: 'canonical resolution' }] }]
    })

    const page = await f.client.sessionHistoryPage('agent-session-opencode', {
      env: { XDG_DATA_HOME: join(f.root, '.local', 'share') }
    })
    expect(page.items).toHaveLength(1)
    expect(page.items[0]!.contentParts).toEqual([{ kind: 'text', text: 'canonical resolution' }])

    const emptyXdgDir = join(f.root, 'empty-xdg')
    await expect(
      f.client.sessionHistoryPage('agent-session-opencode', {
        env: { XDG_DATA_HOME: emptyXdgDir }
      })
    ).rejects.toThrowError(/not found at/i)
  })

  it('pages large legitimate history without memory blowup and isolates from concurrent sessions in the same database', async () => {
    const messages: FixtureMessage[] = []
    for (let i = 1; i <= 25; i++) {
      messages.push({
        id: `msg_legit_${i}`,
        role: i % 2 === 1 ? 'user' : 'assistant',
        createdAt: 1740000000000 + i * 1000,
        parts: [{ type: 'text', text: `Message content turn ${i}` }]
      })
    }

    const f = await createOpenCodeFixture({ messages })

    const db = new DatabaseSync(f.dbPath)
    db.prepare(`
      INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
      VALUES ('ses_other', 'proj-other', 'slug-other', ?, 'Other Title', '1.0.0', 1740000000000, 1740000000000)
    `).run(f.root)
    const insertOther = db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)')
    for (let j = 1; j <= 50; j++) {
      insertOther.run(`other_msg_${j}`, 'ses_other', 1740000000000 + j, 1740000000000 + j, JSON.stringify({ role: 'user', text: `Other text ${j}` }))
    }
    db.close()

    const page = await f.client.sessionHistoryPage('agent-session-opencode', { limit: 10 })
    expect(page.items).toHaveLength(10)
    expect(page.items.map((m) => m.id)).toEqual([
      'msg_legit_16', 'msg_legit_17', 'msg_legit_18', 'msg_legit_19', 'msg_legit_20',
      'msg_legit_21', 'msg_legit_22', 'msg_legit_23', 'msg_legit_24', 'msg_legit_25'
    ])
    for (const item of page.items) {
      expect(item.id).not.toContain('other_msg')
    }
  })

  it('fails promptly on enormous messages exceeding byte budget before memory allocation and closes DB', async () => {
    const largeData = 'X'.repeat(SESSION_HISTORY_MAX_PAGE_BYTES + 4096)
    const f = await createOpenCodeFixture({
      messages: [{ id: 'msg_giant', role: 'user', createdAt: 1740000010000, parts: [{ type: 'text', text: largeData }] }]
    })

    await expect(f.client.sessionHistoryPage('agent-session-opencode')).rejects.toThrowError(
      /exceeds its byte budget/i
    )

    const dbCheck = new DatabaseSync(f.dbPath, { readOnly: true })
    const row = dbCheck.prepare('SELECT id FROM session WHERE id = ?').get('ses_opencode_1')
    expect(row).toBeDefined()
    dbCheck.close()
  })

  it('rejects huge Unicode payload (>4MiB in UTF-8 bytes) before payload fetch even if character count < 4M', async () => {
    const largeUnicode = '中'.repeat(1_500_000)
    const f = await createOpenCodeFixture({
      messages: [{ id: 'msg_unicode_giant', role: 'user', createdAt: 1740000010000, parts: [{ type: 'text', text: largeUnicode }] }]
    })

    await expect(f.client.sessionHistoryPage('agent-session-opencode')).rejects.toThrowError(
      /exceeds its byte budget/i
    )
  })

  it('rejects cursor replay when anchor message grew beyond page byte budget before data fetch', async () => {
    const messages: FixtureMessage[] = [
      { id: 'msg_1', role: 'user', createdAt: 1740000010000, parts: [{ type: 'text', text: 'Turn 1' }] },
      { id: 'msg_2', role: 'assistant', createdAt: 1740000020000, parts: [{ type: 'text', text: 'Turn 2' }] },
      { id: 'msg_3', role: 'user', createdAt: 1740000030000, parts: [{ type: 'text', text: 'Turn 3' }] },
      { id: 'msg_4', role: 'assistant', createdAt: 1740000040000, parts: [{ type: 'text', text: 'Turn 4' }] }
    ]

    const f = await createOpenCodeFixture({ messages })
    const page1 = await f.client.sessionHistoryPage('agent-session-opencode', { limit: 2 })
    expect(page1.nextCursor).not.toBeNull()

    const giantText = 'X'.repeat(SESSION_HISTORY_MAX_PAGE_BYTES + 1024)
    const db = new DatabaseSync(f.dbPath)
    db.prepare('UPDATE message SET data = ? WHERE id = ?').run(
      JSON.stringify({ role: 'user', time: { created: 1740000030000 }, giant: giantText }),
      'msg_3'
    )
    db.close()

    await expect(
      f.client.sessionHistoryPage('agent-session-opencode', { limit: 2, cursor: page1.nextCursor! })
    ).rejects.toThrowError(/exceeds its byte budget/i)
  })

  it('rejects cursor replay when physical DB file was replaced with another DB having identical Session ID and timestamps', async () => {
    const messages: FixtureMessage[] = [
      { id: 'msg_1', role: 'user', createdAt: 1740000010000, parts: [{ type: 'text', text: 'Turn 1' }] },
      { id: 'msg_2', role: 'assistant', createdAt: 1740000020000, parts: [{ type: 'text', text: 'Turn 2' }] },
      { id: 'msg_3', role: 'user', createdAt: 1740000030000, parts: [{ type: 'text', text: 'Turn 3' }] },
      { id: 'msg_4', role: 'assistant', createdAt: 1740000040000, parts: [{ type: 'text', text: 'Turn 4' }] }
    ]

    const f = await createOpenCodeFixture({ messages })
    const page1 = await f.client.sessionHistoryPage('agent-session-opencode', { limit: 2 })
    expect(page1.items.map((i) => i.id)).toEqual(['msg_3', 'msg_4'])
    expect(page1.nextCursor).not.toBeNull()

    const { unlinkSync } = await import('node:fs')
    unlinkSync(f.dbPath)

    const newDb = new DatabaseSync(f.dbPath)
    newDb.exec(OPENCODE_SCHEMA)
    newDb.prepare(`
      INSERT INTO session (id, project_id, parent_id, slug, directory, title, version,
        time_created, time_updated, agent, model, cost, tokens_input, tokens_output,
        tokens_reasoning, tokens_cache_read, tokens_cache_write)
      VALUES ('ses_opencode_1', 'proj-1', NULL, 'slug-1', ?, 'OpenCode Session Title', '1.0.0',
        1740000000000, 1740000060000, 'build', '{"id":"test-model"}', 0, 10, 20, 5, 0, 0)
    `).run(f.root)
    const insMsg = newDb.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)')
    const insPrt = newDb.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)')
    for (const msg of messages) {
      insMsg.run(msg.id, 'ses_opencode_1', msg.createdAt, msg.createdAt + 100, JSON.stringify({ role: msg.role, time: { created: msg.createdAt } }))
      for (let i = 0; i < msg.parts.length; i++) {
        insPrt.run(`${msg.id}_part_${i}`, msg.id, 'ses_opencode_1', msg.createdAt + i, msg.createdAt + i, JSON.stringify(msg.parts[i]))
      }
    }
    newDb.close()

    await expect(
      f.client.sessionHistoryPage('agent-session-opencode', { limit: 2, cursor: page1.nextCursor! })
    ).rejects.toThrowError(/source changed|reopen/i)
  })

  it('rejects cursor replay when anchor message in the same inode was mutated', async () => {
    const messages: FixtureMessage[] = [
      { id: 'msg_1', role: 'user', createdAt: 1740000010000, parts: [{ type: 'text', text: 'Turn 1' }] },
      { id: 'msg_2', role: 'assistant', createdAt: 1740000020000, parts: [{ type: 'text', text: 'Turn 2' }] },
      { id: 'msg_3', role: 'user', createdAt: 1740000030000, parts: [{ type: 'text', text: 'Turn 3' }] },
      { id: 'msg_4', role: 'assistant', createdAt: 1740000040000, parts: [{ type: 'text', text: 'Turn 4' }] }
    ]

    const f = await createOpenCodeFixture({ messages })
    const page1 = await f.client.sessionHistoryPage('agent-session-opencode', { limit: 2 })
    expect(page1.items.map((i) => i.id)).toEqual(['msg_3', 'msg_4'])
    expect(page1.nextCursor).not.toBeNull()

    const db = new DatabaseSync(f.dbPath)
    db.prepare('UPDATE message SET data = ? WHERE id = ?').run(
      JSON.stringify({ role: 'user', time: { created: 1740000030000 }, mutated: true }),
      'msg_3'
    )
    db.close()

    await expect(
      f.client.sessionHistoryPage('agent-session-opencode', { limit: 2, cursor: page1.nextCursor! })
    ).rejects.toThrowError(/source changed|reopen/i)
  })

  it('does not trigger false SOURCE_CHANGED when unrelated session is added or mutated in WAL mode', async () => {
    const messages: FixtureMessage[] = [
      { id: 'msg_1', role: 'user', createdAt: 1740000010000, parts: [{ type: 'text', text: 'Turn 1' }] },
      { id: 'msg_2', role: 'assistant', createdAt: 1740000020000, parts: [{ type: 'text', text: 'Turn 2' }] },
      { id: 'msg_3', role: 'user', createdAt: 1740000030000, parts: [{ type: 'text', text: 'Turn 3' }] },
      { id: 'msg_4', role: 'assistant', createdAt: 1740000040000, parts: [{ type: 'text', text: 'Turn 4' }] }
    ]

    const f = await createOpenCodeFixture({ messages })
    const page1 = await f.client.sessionHistoryPage('agent-session-opencode', { limit: 2 })
    expect(page1.items.map((i) => i.id)).toEqual(['msg_3', 'msg_4'])
    expect(page1.nextCursor).not.toBeNull()

    const db = new DatabaseSync(f.dbPath)
    db.exec('PRAGMA journal_mode = WAL;')
    db.prepare(`
      INSERT INTO session (id, project_id, parent_id, slug, directory, title, version,
        time_created, time_updated, agent, model, cost, tokens_input, tokens_output,
        tokens_reasoning, tokens_cache_read, tokens_cache_write)
      VALUES ('ses_unrelated', 'proj-1', NULL, 'slug-u', ?, 'Unrelated Session', '1.0.0',
        1740000090000, 1740000095000, 'build', '{"id":"test-model"}', 0, 0, 0, 0, 0, 0)
    `).run(f.root)
    db.close()

    const page2 = await f.client.sessionHistoryPage('agent-session-opencode', { limit: 2, cursor: page1.nextCursor! })
    expect(page2.items.map((i) => i.id)).toEqual(['msg_1', 'msg_2'])
    expect(page2.nextCursor).toBeNull()
  })

  it('classifies genuine current synthetic text parts as activity rather than human speech', async () => {
    const f = await createOpenCodeFixture({
      messages: [
        {
          id: 'msg_synthetic_media',
          role: 'user',
          createdAt: 1740000010000,
          parts: [
            {
              type: 'text',
              text: 'Attached media from tool result:',
              synthetic: true
            }
          ]
        }
      ]
    })

    const page = await f.client.sessionHistoryPage('agent-session-opencode')
    expect(page.items).toHaveLength(1)
    const item = page.items[0]!
    expect(item.kind).toBe('activity')
    expect(item.contentParts).toEqual([{ kind: 'text', text: 'Attached media from tool result:' }])
  })

  it('preserves real native media, text, and tool ordering in a single assistant turn', async () => {
    const f = await createOpenCodeFixture({
      messages: [
        {
          id: 'msg_ordered_trace',
          role: 'assistant',
          createdAt: 1740000020000,
          parts: [
            { type: 'reasoning', text: 'Step 1: Check diagram' },
            {
              type: 'file',
              mime: 'image/png',
              url: 'https://cdn.internal/diagram.png',
              filename: 'diagram.png'
            },
            {
              type: 'tool',
              tool: 'analyze_image',
              callID: 'call_img_1',
              state: {
                status: 'completed',
                input: { path: 'diagram.png' },
                output: 'analysis: 3 components detected'
              }
            },
            { type: 'text', text: 'Step 2: Analysis confirmed 3 components.' }
          ]
        }
      ]
    })

    const page = await f.client.sessionHistoryPage('agent-session-opencode')
    expect(page.items).toHaveLength(1)
    const item = page.items[0]!
    expect(item.kind).toBe('assistant-message')
    expect(item.contentParts).toEqual([
      { kind: 'reasoning', text: 'Step 1: Check diagram' },
      { kind: 'resource', resourceType: 'image', reference: 'https://cdn.internal/diagram.png', label: 'diagram.png' },
      { kind: 'tool-call', name: 'analyze_image', input: '{"path":"diagram.png"}', callId: 'call_img_1' },
      { kind: 'tool-result', name: 'analyze_image', output: 'analysis: 3 components detected', callId: 'call_img_1' },
      { kind: 'text', text: 'Step 2: Analysis confirmed 3 components.' }
    ])
  })

  it('reads native history when workspacePath is a symlink alias sharing identical dev and ino with canonical session directory', async () => {
    const f = await createOpenCodeFixture({
      messages: [{ id: 'msg_1', role: 'user', createdAt: 1740000010000, parts: [{ type: 'text', text: 'alias workspace' }] }]
    })

    const { symlinkSync } = await import('node:fs')
    const aliasPath = join(f.root, 'workspace-alias')
    symlinkSync(f.root, aliasPath)

    const providers = new AgentProviderRegistry()
    const opencode = providers.get('opencode')

    const page = await opencode.readSessionHistoryPage!({
      source: { providerId: 'opencode', nativeSessionId: 'ses_opencode_1' },
      transcriptPath: f.dbPath,
      command: 'opencode',
      args: [],
      env: {},
      workspacePath: aliasPath,
      limit: 10,
      signal: new AbortController().signal
    })

    expect(page.items).toHaveLength(1)
    expect(page.items[0]!.contentParts).toEqual([{ kind: 'text', text: 'alias workspace' }])
  })

  it('honors OPENCODE_DB as an absolute path and as a relative path under XDG_DATA_HOME', async () => {
    // 1. Absolute OPENCODE_DB path
    const fAbs = await createOpenCodeFixture({
      omitTranscriptPath: true,
      messages: [{ id: 'msg_abs', role: 'user', createdAt: 1740000010000, parts: [{ type: 'text', text: 'absolute db' }] }]
    })

    const pageAbs = await fAbs.client.sessionHistoryPage('agent-session-opencode', {
      env: { OPENCODE_DB: fAbs.dbPath }
    })
    expect(pageAbs.items).toHaveLength(1)
    expect(pageAbs.items[0]!.contentParts).toEqual([{ kind: 'text', text: 'absolute db' }])

    // 2. Relative OPENCODE_DB path under XDG_DATA_HOME/opencode
    const xdgDir = join(fAbs.root, 'custom-xdg')
    const relDbDir = join(xdgDir, 'opencode')
    const { mkdirSync, copyFileSync } = await import('node:fs')
    mkdirSync(relDbDir, { recursive: true })
    copyFileSync(fAbs.dbPath, join(relDbDir, 'custom.db'))

    const pageRel = await fAbs.client.sessionHistoryPage('agent-session-opencode', {
      env: { XDG_DATA_HOME: xdgDir, OPENCODE_DB: 'custom.db' }
    })
    expect(pageRel.items).toHaveLength(1)
    expect(pageRel.items[0]!.contentParts).toEqual([{ kind: 'text', text: 'absolute db' }])

    // 3. In-memory OPENCODE_DB is rejected as non-durable
    await expect(
      fAbs.client.sessionHistoryPage('agent-session-opencode', {
        env: { OPENCODE_DB: ':memory:' }
      })
    ).rejects.toThrowError(/does not persist/i)
  })

  it('preserves completed tool attachments as actual resource references with exact ordering', async () => {
    const f = await createOpenCodeFixture({
      messages: [
        {
          id: 'msg_tool_attachment',
          role: 'assistant',
          createdAt: 1740000030000,
          parts: [
            {
              type: 'tool',
              tool: 'view_image',
              callID: 'call_media_1',
              state: {
                status: 'completed',
                input: { path: '/controlled/image.png' },
                output: 'Shown',
                attachments: [
                  {
                    id: 'prt_att_1',
                    type: 'file',
                    mime: 'image/png',
                    url: 'file:///controlled/tool-only.png',
                    filename: 'tool-only.png'
                  }
                ]
              }
            }
          ]
        }
      ]
    })

    const page = await f.client.sessionHistoryPage('agent-session-opencode', { limit: 1 })
    expect(page.items).toHaveLength(1)
    const item = page.items[0]!
    expect(item.id).toBe('msg_tool_attachment')
    expect(item.contentParts).toEqual([
      { kind: 'tool-call', name: 'view_image', input: '{"path":"/controlled/image.png"}', callId: 'call_media_1' },
      { kind: 'tool-result', name: 'view_image', output: 'Shown', callId: 'call_media_1' },
      { kind: 'resource', resourceType: 'image', reference: 'file:///controlled/tool-only.png', label: 'tool-only.png' }
    ])
  })

  it('keeps total SQLite returned payload bytes within 4MiB budget when paging messages with large system context', async () => {
    const f = await createOpenCodeFixture({
      messages: [
        { id: 'msg_early', role: 'user', createdAt: 1740000010000, parts: [{ type: 'text', text: 'Earlier' }] },
        {
          id: 'msg_huge_sys',
          role: 'user',
          createdAt: 1740000020000,
          system: 'S'.repeat(2_200_000),
          parts: [{ type: 'text', text: 'Visible tiny message' }]
        }
      ]
    })

    const sqlCalls: Array<{ sql: string; payloadBytes: number }> = []
    const originalPrepare = DatabaseSync.prototype.prepare
    DatabaseSync.prototype.prepare = function (this: unknown, sql: string) {
      const stmt = (originalPrepare as Function).call(this, sql)
      for (const method of ['get', 'all'] as const) {
        const origMethod = stmt[method] as Function
        stmt[method] = function (this: unknown, ...args: unknown[]) {
          const res = origMethod.apply(this, args)
          const rows = method === 'get' ? (res ? [res] : []) : (Array.isArray(res) ? res : [])
          let payloadBytes = 0
          for (const row of rows) {
            if (row && typeof row === 'object') {
              for (const col of ['data', 'data_blob', 'title'] as const) {
                const val = (row as Record<string, unknown>)[col]
                if (typeof val === 'string') payloadBytes += Buffer.byteLength(val)
                else if (ArrayBuffer.isView(val)) payloadBytes += val.byteLength
              }
            }
          }
          sqlCalls.push({ sql, payloadBytes })
          return res
        } as never
      }
      return stmt
    }

    try {
      const page = await f.client.sessionHistoryPage('agent-session-opencode', { limit: 1 })
      expect(page.items.map((i) => i.id)).toEqual(['msg_huge_sys'])
      expect(page.nextCursor).not.toBeNull()
      const totalPayloadBytes = sqlCalls.reduce((sum, c) => sum + c.payloadBytes, 0)
      expect(totalPayloadBytes).toBeGreaterThan(0)
      expect(totalPayloadBytes).toBeLessThanOrEqual(4 * 1024 * 1024)
    } finally {
      DatabaseSync.prototype.prepare = originalPrepare
    }
  })

  it('aborts promptly upon cancellation during metadata discovery without executing data payload queries', async () => {
    const f = await createOpenCodeFixture({
      messages: [
        { id: 'msg_1', role: 'user', createdAt: 1740000010000, parts: [{ type: 'text', text: 'Turn 1' }] },
        { id: 'msg_2', role: 'user', createdAt: 1740000020000, parts: [{ type: 'text', text: 'Turn 2' }] }
      ]
    })

    const executedSql: Array<{ sql: string; payloadBytes: number; triggeredCancellation?: boolean }> = []
    let triggeredCancel = false
    const originalPrepare = DatabaseSync.prototype.prepare

    DatabaseSync.prototype.prepare = function (this: unknown, sql: string) {
      const stmt = (originalPrepare as Function).call(this, sql)
      for (const method of ['get', 'all'] as const) {
        const origMethod = stmt[method] as Function
        stmt[method] = function (this: unknown, ...args: unknown[]) {
          let cancelHere = false
          if (/FROM part/.test(sql) && /data_bytes/.test(sql) && !triggeredCancel) {
            triggeredCancel = true
            cancelHere = true
            f.client.disconnect()
          }
          const res = origMethod.apply(this, args)
          const rows = method === 'get' ? (res ? [res] : []) : (Array.isArray(res) ? res : [])
          let payloadBytes = 0
          for (const row of rows) {
            if (row && typeof row === 'object') {
              for (const col of ['data', 'data_blob', 'title'] as const) {
                const val = (row as Record<string, unknown>)[col]
                if (typeof val === 'string') payloadBytes += Buffer.byteLength(val)
                else if (ArrayBuffer.isView(val)) payloadBytes += val.byteLength
              }
            }
          }
          executedSql.push({ sql, payloadBytes, triggeredCancellation: cancelHere })
          return res
        } as never
      }
      return stmt
    }

    try {
      await expect(
        f.client.sessionHistoryPage('agent-session-opencode', { limit: 1 })
      ).rejects.toThrowError(/cancelled|aborted/i)

      // Allow any async microtasks to settle
      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(triggeredCancel).toBe(true)
      const cancelIndex = executedSql.findIndex((c) => c.triggeredCancellation)
      expect(cancelIndex).toBeGreaterThanOrEqual(0)
      const afterCancelPayloadCalls = executedSql.slice(cancelIndex + 1).filter((c) => c.payloadBytes > 0)
      expect(afterCancelPayloadCalls).toHaveLength(0)
    } finally {
      DatabaseSync.prototype.prepare = originalPrepare
    }
  })

  it('recovers identical history through a fresh AgentMuxClient instance reading the durable store', async () => {
    const f = await createOpenCodeFixture({
      messages: [
        { id: 'msg_1', role: 'user', createdAt: 1740000010000, parts: [{ type: 'text', text: 'first prompt' }] },
        { id: 'msg_2', role: 'assistant', createdAt: 1740000020000, parts: [{ type: 'text', text: 'response' }] }
      ]
    })

    const firstPage = await f.client.sessionHistoryPage('agent-session-opencode')
    expect(firstPage.items).toHaveLength(2)

    await f.client.dispose()

    const freshClient = new AgentMuxClient({
      store: new AgentMuxFileAgentSessionStore(f.storePath)
    })

    try {
      const recoveredPage = await freshClient.sessionHistoryPage('agent-session-opencode')
      expect(recoveredPage.items).toEqual(firstPage.items)
      expect(recoveredPage.source).toEqual(firstPage.source)
    } finally {
      await freshClient.dispose()
    }
  })
})
