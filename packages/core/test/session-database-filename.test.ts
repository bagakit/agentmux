import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { link, lstat, mkdtemp, readFile, readlink, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { headlessFixture } from './helpers/headless-runtime-fixture.js'

let root: string
let legacy: string
let canonical: string
let store: AgentMuxFileAgentSessionStore

const session = { kind: 'agent' as const, agentSessionId: 'session-1', providerId: 'codex', executorId: 'codex',
  hostId: 'local', workspacePath: tmpdir(), run: { runId: 'run-1' }, retiredRuns: [],
  hookBindingId: 'binding-1', hookToken: 'token-1', createdAt: 100, updatedAt: 100 }

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentmux-sqlite-filename-'))
  legacy = join(root, 'agent-sessions.json')
  canonical = join(root, 'agent-sessions.sqlite')
  store = new AgentMuxFileAgentSessionStore(legacy)
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

function seedLegacyJson() {
  return writeFile(legacy, JSON.stringify({ version: 5, sessions: [session], reservations: [], retiredRuns: [], retiredAgentSessions: [] }), { mode: 0o600 })
}

async function update(owner: AgentMuxFileAgentSessionStore, updatedAt: number) {
  const [current] = await owner.loadMetadata()
  if (!current) throw new Error('Fixture Session was not found.')
  await owner.compareAndSwap(current, { ...current, updatedAt })
}

describe('managed SQLite Session filename', () => {
  it('writes new stores to .sqlite while both names use the original owner', async () => {
    await expect(store.hasLegacyDatabaseName()).resolves.toBe(false)
    await store.compareAndSwap(null, session)
    expect((await lstat(canonical)).isFile()).toBe(true)
    await expect(readlink(legacy)).resolves.toBe('agent-sessions.sqlite')
    const byPhysicalName = new AgentMuxFileAgentSessionStore(canonical)
    expect(byPhysicalName.path).toBe(legacy)
    await expect(byPhysicalName.load()).resolves.toEqual([expect.objectContaining(session)])
  })

  it('opens the same database after an approved migration and an independent process start', async () => {
    await seedLegacyJson()
    await update(store, 101)
    const before = await stat(legacy)
    const originalLock = await stat(legacy + '.lock')
    const marker = await readFile(legacy + '.sqlite-identity', 'utf8')
    await expect(store.hasLegacyDatabaseName()).resolves.toBe(true)

    await store.migrateDatabaseName()

    expect((await stat(canonical)).ino).toBe(before.ino)
    expect((await stat(canonical)).nlink).toBe(1)
    expect((await stat(legacy + '.lock')).ino).toBe(originalLock.ino)
    await expect(readFile(legacy + '.sqlite-identity', 'utf8')).resolves.toBe(marker)
    await expect(store.hasLegacyDatabaseName()).resolves.toBe(false)
    await expect(store.migrateDatabaseName()).resolves.toBeUndefined()
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { DatabaseSync } from 'node:sqlite';
      const database = new DatabaseSync(process.argv[1], { readOnly: true });
      console.log(JSON.stringify(database.prepare("SELECT id, json_extract(json, '$.run.runId') AS runId FROM sessions").get()));
      database.close();
    `, legacy], { encoding: 'utf8' })
    expect(child.status, child.stderr).toBe(0)
    expect(JSON.parse(child.stdout)).toEqual({ id: 'session-1', runId: 'run-1' })
    const reopened = new AgentMuxFileAgentSessionStore(legacy)
    await update(reopened, 102)
    await expect(reopened.loadMetadata()).resolves.toEqual([expect.objectContaining({ updatedAt: 102 })])
  })

  it('resumes a same-inode publication interrupted before replacing the legacy directory entry', async () => {
    await seedLegacyJson()
    await update(store, 101)
    await link(legacy, canonical)
    await store.migrateDatabaseName()
    await expect(readlink(legacy)).resolves.toBe('agent-sessions.sqlite')
    expect((await stat(canonical)).nlink).toBe(1)
    await expect(store.loadMetadata()).resolves.toHaveLength(1)
  })

  it('keeps both files when the canonical name contains a different original', async () => {
    await seedLegacyJson()
    const original = await readFile(legacy)
    await writeFile(canonical, 'different original', { mode: 0o600 })
    await expect(store.migrateDatabaseName()).rejects.toThrow('Both Session filenames')
    await expect(readFile(legacy)).resolves.toEqual(original)
    await expect(readFile(canonical, 'utf8')).resolves.toBe('different original')
  })

  it('restores an older manifest target through the alias when the canonical database is missing', async () => {
    await seedLegacyJson()
    await update(store, 101)
    const backup = await store.captureRecovery(join(root, 'backup'))
    const member = backup.members.find(item => item.id === 'database')!
    expect(member.target).toBe(legacy)
    const sha256 = createHash('sha256').update(await readFile(member.file)).digest('hex')

    await store.migrateDatabaseName()
    await unlink(canonical)
    await expect(store.restoreRecoveryMember({ ...member, sha256, operationId: 'restore-1' })).resolves.toBe('restored')

    await expect(readlink(legacy)).resolves.toBe('agent-sessions.sqlite')
    await expect(new AgentMuxFileAgentSessionStore(legacy).loadMetadata()).resolves.toHaveLength(1)
  })

  it('preserves the canonical original when only the old pathname goes missing', async () => {
    await seedLegacyJson()
    await update(store, 101)
    const backup = await store.captureRecovery(join(root, 'backup'))
    const member = backup.members.find(item => item.id === 'database')!
    const sha256 = createHash('sha256').update(await readFile(member.file)).digest('hex')
    await store.migrateDatabaseName()
    await update(store, 102)
    await unlink(legacy)
    const original = await stat(canonical)

    await expect(store.restoreRecoveryMember({ ...member, sha256, operationId: 'restore-1' })).resolves.toBe('conflict')

    await expect(lstat(legacy)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await stat(canonical)).ino).toBe(original.ino)
  })

  it('preserves the original public Session, Run and owner through migration and a real Host restart', async () => {
    const scope = await headlessFixture({ legacySessionStore: true })
    try {
      const client = await scope.client()
      const originalOwner = scope.owner
      const original = await client.createAgent({
        providerId: 'codex', executorId: 'codex', workspacePath: scope.root, injectAgentMuxGuide: false,
        createOperationId: 'session-filename-migration-run',
        commandOverride: resolve(import.meta.dirname, 'fixtures/fake-codex-cli.mjs')
      })
      const originalPath = scope.env.AGENTMUX_AGENT_SESSION_STORE!
      const owner = new AgentMuxFileAgentSessionStore(originalPath)
      await expect(owner.hasLegacyDatabaseName()).resolves.toBe(true)

      await owner.migrateDatabaseName()

      const target = { kind: 'agent-session' as const, agentSessionId: original.agentSessionId }
      if (!client.forwardRpc) throw new Error('The private Host has no public RPC.')
      await expect(client.forwardRpc('agent.inspect', { target })).resolves.toMatchObject({ status: { run: original.run } })
      await scope.restart()
      expect(scope.owner.runtimeId).toBe(originalOwner.runtimeId)
      expect(scope.owner.ownerInstanceId).not.toBe(originalOwner.ownerInstanceId)
      const reconnected = await scope.client()
      if (!reconnected.forwardRpc) throw new Error('The reconnected Host has no public RPC.')
      await expect(reconnected.forwardRpc('agent.inspect', { target })).resolves.toMatchObject({ status: { run: original.run } })
      await expect(reconnected.reattachAgent(original.agentSessionId, 0, 'terminal')).resolves.toMatchObject({
        attachment: { run: original.run }
      })
    } finally { await scope.cleanup() }
  }, 30_000)
})
