import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'

/**
 * The Session database uses a rollback journal and `busy_timeout = 0`. While another process
 * commits, it holds the lock that refuses every new reader, from the first validation PRAGMA.
 * A read waits that writer out and returns the committed snapshot instead of reporting the
 * Session store as unavailable; anything other than SQLITE_BUSY still fails on the first try.
 */
afterEach(() => { vi.restoreAllMocks() })

function session(updatedAt = 1): AgentMuxStoredAgentSession {
  return { kind: 'agent', agentSessionId: 'original', providerId: 'fixture', executorId: 'fixture', hostId: 'local',
    workspacePath: tmpdir(), run: { runId: 'original-run' }, retiredRuns: [], hookBindingId: 'original-hook',
    hookToken: 'original-token', createdAt: 1, updatedAt }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amx-read-contention-'))
  const store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
  await store.compareAndSwap(null, session())
  return { root, store }
}

/** Another connection that holds the lock a committing rollback-journal writer holds. */
function committingWriter(path: string) {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE')
  db.prepare("UPDATE sessions SET id = id").run()
  let open = true
  return { release: () => { if (!open) return; open = false; if (db.isTransaction) db.exec('COMMIT'); db.close() } }
}

it('a read that meets a committing writer returns the committed snapshot once the writer finishes', async () => {
  const { root, store } = await fixture()
  const writer = committingWriter(store.path)
  try {
    const released = new Promise<void>(done => setTimeout(() => { writer.release(); done() }, 60))
    // Both the exact-Session read and the catalogue read take the committed-snapshot path.
    const [exact, catalogue] = await Promise.all([store.readMetadata('original'), store.loadMetadata(), released])
    expect(exact).toEqual(session())
    expect(catalogue).toEqual([session()])
  } finally { writer.release(); await rm(root, { recursive: true, force: true }) }
})

it('a writer that never finishes exhausts the same wait budget and keeps the SQLite cause', async () => {
  const { root, store } = await fixture()
  vi.spyOn(Math, 'random').mockReturnValue(0)
  const writer = committingWriter(store.path)
  try {
    const error = await store.readMetadata('original').catch(error => error)
    expect(error).toMatchObject({ code: 'AGENT_SESSION_STORE_UNAVAILABLE', cause: { errcode: 5 } })
    expect(JSON.parse(error.detail)).toMatchObject({ stage: 'read', cause: { errcode: 5 } })
    writer.release()
    expect(await store.readMetadata('original')).toEqual(session())
  } finally { writer.release(); await rm(root, { recursive: true, force: true }) }
})

it('cancelling a read that waits on a writer rejects with the original reason', async () => {
  const { root, store } = await fixture()
  const writer = committingWriter(store.path), controller = new AbortController(), reason = new Error('original reader cancelled')
  try {
    setTimeout(() => controller.abort(reason), 30)
    await expect(store.loadMetadata(controller.signal)).rejects.toBe(reason)
  } finally { writer.release(); await rm(root, { recursive: true, force: true }) }
})

it('a failure that is not SQLITE_BUSY is reported on the first attempt', async () => {
  const { root, store } = await fixture()
  await writeFile(`${store.path}.sqlite-identity`, 'another-incarnation', { mode: 0o600 })
  const exec = vi.spyOn(DatabaseSync.prototype, 'exec')
  try {
    await expect(store.readMetadata('original')).rejects.toMatchObject({ code: 'AGENT_SESSION_STORE_UNAVAILABLE' })
    expect(exec.mock.calls.filter(([sql]) => sql === 'PRAGMA busy_timeout = 0')).toHaveLength(1)
  } finally { await rm(root, { recursive: true, force: true }) }
})
