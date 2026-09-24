import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const core = fileURLToPath(new URL('../dist/index.js', import.meta.url))
const cli = fileURLToPath(new URL('../bin/agentmux', import.meta.url))
const roots: string[] = []
const ownedPids: number[] = []
const receipts = process.env.AMX_CLI_IMPORT_PROOF_DIRECTORY
function fingerprint(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
async function record(name: string, value: unknown) {
  if (!receipts) return
  await mkdir(receipts, { recursive: true })
  await writeFile(join(receipts, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`)
}
afterEach(async () => {
  // execFile callbacks run only after close; do not remove private inputs while a
  // child could still reference them. No fixture starts an Agent or native daemon.
  for (const pid of ownedPids.splice(0)) {
    let gone = false
    try { process.kill(pid, 0) } catch (error) { gone = (error as NodeJS.ErrnoException).code === 'ESRCH' }
    expect(gone, `Owned cold Node child ${pid} must have exited before cleanup`).toBe(true)
  }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true })))
})
async function privateRoot() {
  const root = await mkdtemp('/tmp/amx-cli-import-'); roots.push(root)
  return root
}
async function node(root: string, args: string[]) {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_') &&
      key !== 'NODE_OPTIONS' && key !== 'NODE_NO_WARNINGS') env[key] = value
  }
  env.AGENTMUX_RUNTIME_DIRECTORY = join(root, 'runtime')
  env.AGENTMUX_STATE_DIRECTORY = join(root, 'state')
  env.AGENTMUX_AGENT_SESSION_STORE = join(root, 'sessions.json')
  env.AGENTMUX_MESSAGE_QUEUE_PATH = join(root, 'messages.ndjson')
  return await new Promise<{ stdout: string; stderr: string; code: number | string | null; signal: string | null }>((resolve) => {
    const child = execFile(process.execPath, args, { cwd: root, env, timeout: 15_000,
      killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const failure = error as (NodeJS.ErrnoException & { signal?: string }) | null
      resolve({ stdout, stderr, code: failure?.code ?? 0, signal: failure?.signal ?? null })
    })
    if (child.pid !== undefined) ownedPids.push(child.pid)
  })
}
function program(body: string): string[] { return ['--input-type=module', '-e', body] }

describe('cold compiled Core import boundary', () => {
  it('imports the public Core and constructs default Registry/Client without activating SQLite', async () => {
    const root = await privateRoot()
    const result = await node(root, program(`
      const { AgentMuxClient, AgentProviderRegistry, AgentMuxMemoryAgentSessionStore,
        defaultAgentMuxRuntimeDirectory, defaultAgentMuxStateDirectory, defaultCtxmuxStateDirectory,
        defaultAgentMuxAgentSessionStorePath } = await import(${JSON.stringify(core)});
      const registry = new AgentProviderRegistry();
      const client = new AgentMuxClient({store: new AgentMuxMemoryAgentSessionStore()});
      await new Promise(resolve => setImmediate(resolve));
      await client.dispose();
      process.stdout.write(JSON.stringify({ providers: registry.list().map(provider => provider.id),
        clientConstructed: client instanceof AgentMuxClient, nodeVersion: process.versions.node,
        paths: {runtime: defaultAgentMuxRuntimeDirectory(), state: defaultAgentMuxStateDirectory(),
          ctxmux: defaultCtxmuxStateDirectory(), store: defaultAgentMuxAgentSessionStorePath()} }));
    `))
    await record('cold-core', result)
    expect(result.code).toBe(0)
    expect(result.signal).toBeNull()
    expect(result.stderr).toBe('')
    const receipt = JSON.parse(result.stdout)
    expect(receipt.clientConstructed).toBe(true)
    expect(receipt.providers.length).toBeGreaterThan(0)
    expect(receipt.providers).toEqual(expect.arrayContaining(['hermes', 'opencode', 'cursor']))
    expect(receipt.paths).toEqual({ runtime: join(root, 'runtime'), state: join(root, 'state'),
      ctxmux: join(root, 'state', 'ctxmux'), store: join(root, 'sessions.json') })
  })

  it('keeps actual package CLI help readable with separate clean stderr', async () => {
    const root = await privateRoot()
    const result = await node(root, [cli, '--help'])
    await record('cold-help', result)
    expect(result.code).toBe(0)
    expect(result.signal).toBeNull()
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('typed local Agent and Desktop control')
  })

  it('preserves the actual non-history typed failure as the complete stderr JSON', async () => {
    const root = await privateRoot()
    const result = await node(root, [cli, 'handoff', '--to-session', 'synthetic-worker', '--task', 'synthetic-task'])
    await record('cold-cli-error', result)
    expect(result.code).toBe(1)
    expect(result.signal).toBeNull()
    expect(result.stdout).toBe('')
    // Deliberately parse the full original stream; no stripping or merging.
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, operation: 'handoff',
      error: { code: 'MANAGED_AGENT_CONTEXT_REQUIRED' } })
  })
})

async function nativeFixture(providerId: 'hermes' | 'opencode') {
  const root = await privateRoot(), dbPath = join(root, `${providerId}.db`)
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(dbPath)
  if (providerId === 'hermes') {
    // Existing Hermes native analysis schema, with only one ordinary session.
    db.exec(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, user_id TEXT, session_key TEXT,
      chat_id TEXT, chat_type TEXT, thread_id TEXT, model TEXT, model_config TEXT,
      system_prompt TEXT, parent_session_id TEXT, started_at REAL NOT NULL,
      ended_at REAL, end_reason TEXT, message_count INTEGER DEFAULT 0, cwd TEXT, title TEXT);
      CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id),
      role TEXT NOT NULL, content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT,
      timestamp REAL NOT NULL, token_count INTEGER, finish_reason TEXT, reasoning TEXT,
      reasoning_content TEXT, reasoning_details TEXT, active INTEGER NOT NULL DEFAULT 1);`)
    db.prepare('INSERT INTO sessions(id,source,started_at,cwd) VALUES(?,?,?,?)').run('native-source', 'cli', 99, root)
    db.prepare('INSERT INTO messages(session_id,role,content,timestamp) VALUES(?,?,?,?)')
      .run('native-source', 'user', 'Synthetic native hermes body', 100)
  } else {
    // Existing OpenCode native analysis SQLite table shapes.
    db.exec(`CREATE TABLE session (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, slug TEXT NOT NULL,
      directory TEXT NOT NULL, title TEXT NOT NULL, version TEXT NOT NULL, share_url TEXT,
      summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER,
      summary_diffs TEXT, revert TEXT, permission TEXT,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_compacting INTEGER,
      time_archived INTEGER, workspace_id TEXT, path TEXT, agent TEXT, model TEXT,
      cost REAL DEFAULT 0 NOT NULL, tokens_input INTEGER DEFAULT 0 NOT NULL,
      tokens_output INTEGER DEFAULT 0 NOT NULL, tokens_reasoning INTEGER DEFAULT 0 NOT NULL,
      tokens_cache_read INTEGER DEFAULT 0 NOT NULL, tokens_cache_write INTEGER DEFAULT 0 NOT NULL, metadata TEXT);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, vcs TEXT, name TEXT,
      icon_url TEXT, icon_color TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
      time_initialized INTEGER, sandboxes TEXT NOT NULL, commands TEXT, icon_url_override TEXT);`)
    db.prepare('INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES(?,?,?,?,?,?,?,?)')
      .run('native-source', 'project-source', 'synthetic', root, 'Synthetic', '1', 99, 100)
    db.prepare('INSERT INTO message VALUES(?,?,?,?,?)').run('message-source', 'native-source', 100, 100,
      JSON.stringify({ role: 'user', time: { created: 100 } }))
    db.prepare('INSERT INTO part VALUES(?,?,?,?,?,?)').run('part-source', 'message-source', 'native-source', 100, 100,
      JSON.stringify({ type: 'text', text: 'Synthetic native opencode body' }))
  }
  db.close()
  const { AgentMuxFileAgentSessionStore } = await import('../dist/index.js')
  const storePath = join(root, 'sessions.json')
  const store = new AgentMuxFileAgentSessionStore(storePath)
  await store.compareAndSwap(null, { kind: 'agent', agentSessionId: 'private-history',
    providerId, executorId: providerId, hostId: 'local', workspacePath: root, run: { runId: 'private-history-run' },
    retiredRuns: [], hookBindingId: 'synthetic-binding', hookToken: 'synthetic-token', createdAt: 100, updatedAt: 100,
    nativeHandle: { kind: 'provider', providerId, sessionId: 'native-source', transcriptPath: dbPath } })
  return { root, dbPath, storePath }
}

describe('cold public Client native SQLite positive controls', () => {
  it.each(['hermes', 'opencode'] as const)('still reads an exact nonempty %s native page and retains the real warning', async (providerId) => {
    const fixture = await nativeFixture(providerId)
    const beforeDatabase = await readFile(fixture.dbPath), beforeStore = await readFile(fixture.storePath)
    const result = await node(fixture.root, program(`
      const { AgentMuxClient, AgentMuxFileAgentSessionStore } = await import(${JSON.stringify(core)});
      const client = new AgentMuxClient({store: new AgentMuxFileAgentSessionStore(${JSON.stringify(fixture.storePath)})});
      const page = await client.sessionHistoryPage('private-history', {limit: 10});
      await new Promise(resolve => setImmediate(resolve));
      await client.dispose();
      process.stdout.write(JSON.stringify({page, nodeVersion: process.versions.node}));
    `))
    const afterDatabase = await readFile(fixture.dbPath), afterStore = await readFile(fixture.storePath)
    await record(`native-${providerId}`, { ...result, databaseBefore: fingerprint(beforeDatabase),
      databaseAfter: fingerprint(afterDatabase), storeBefore: fingerprint(beforeStore), storeAfter: fingerprint(afterStore) })
    expect(result.code).toBe(0)
    expect(result.signal).toBeNull()
    expect(result.stderr).toContain('ExperimentalWarning: SQLite is an experimental feature')
    const { page } = JSON.parse(result.stdout)
    expect(page.agentSessionId).toBe('private-history')
    expect(page.source).toEqual({ providerId, nativeSessionId: 'native-source' })
    expect(page.items).toEqual([{ id: providerId === 'hermes' ? 'hermes-msg-1' : 'message-source',
      ...(providerId === 'opencode' ? { turnId: 'message-source' } : {}), kind: 'user-message',
      contentParts: [{ kind: 'text', text: `Synthetic native ${providerId} body` }],
      startedAt: providerId === 'hermes' ? 100000 : 100 }])
    expect(page.nextCursor).toBeNull()
    expect(afterDatabase).toEqual(beforeDatabase)
    expect(afterStore).toEqual(beforeStore)
  })
})
