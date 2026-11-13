import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxFileAgentSessionStore, loadSessionHistorySources } from '../src/agent-session-store.js'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxError } from '../src/errors.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { objectCliEnvironment } from './helpers/object-cli-rpc.js'
import { runSourceObjectCli } from './helpers/source-object-cli.js'
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
    hookToken: 'original-token', nativeHandle: { kind: 'provider', providerId: 'fixture', sessionId: 'original-native' }, createdAt: 1, updatedAt }
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

it('a writer that starts committing after the read opened still yields the committed snapshot', async () => {
  const { root, store } = await fixture()
  let writer: ReturnType<typeof committingWriter> | undefined
  const exec = DatabaseSync.prototype.exec
  // Take the commit lock in the gap between the reader's validated open and its read transaction.
  vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
    if (sql === 'BEGIN' && !writer) { writer = committingWriter(store.path); setTimeout(() => writer!.release(), 60) }
    return exec.call(this, sql)
  })
  try {
    expect(await store.readMetadata('original')).toEqual(session())
    expect(writer, 'the writer took the lock inside the read').toBeDefined()
  } finally { writer?.release(); await rm(root, { recursive: true, force: true }) }
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

it('does not replay a failed initial conversion write as a read retry', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'amx-read-conversion-')))
  const path = join(root, 'sessions.json'), store = new AgentMuxFileAgentSessionStore(path)
  const original = JSON.stringify({ version: 5, sessions: [session()], reservations: [], retiredRuns: [], retiredAgentSessions: [] })
  await writeFile(path, original)
  const busy = Object.assign(new Error('Original candidate commit failed'), { errcode: 5 })
  const execute = DatabaseSync.prototype.exec
  let candidateCommits = 0
  const spy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
    if (sql === 'COMMIT' && this.prepare('PRAGMA database_list').all().some(row => String(row.file).startsWith(path + '.'))) {
      candidateCommits += 1
      if (candidateCommits === 1) throw busy
    }
    return execute.call(this, sql)
  })
  try {
    const error = await store.readMetadata('original').catch(error => error)
    expect(error).toMatchObject({ code: 'AGENT_SESSION_STORE_UNAVAILABLE', cause: busy })
    expect(JSON.parse(error.detail)).toMatchObject({ stage: 'open', cause: { errcode: 5 } })
    expect(candidateCommits).toBe(1)
    expect(await readFile(path, 'utf8')).toBe(original)
    spy.mockRestore()
    expect(await store.readMetadata('original')).toEqual(session())
    const loader = new URL('../../../apps/desktop/scripts/fixtures/performance-failure-evidence/source-loader.mjs', import.meta.url)
    const register = `import { register } from 'node:module'; register(${JSON.stringify(loader.href)}, ${JSON.stringify(import.meta.url)});`
    const child = await promisify(execFile)(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(register), '--input-type=module', '-e',
      `import { AgentMuxFileAgentSessionStore } from ${JSON.stringify(new URL('../src/agent-session-store.ts', import.meta.url).href)};
       const store = new AgentMuxFileAgentSessionStore(process.env.PRIVATE_STORE_PATH);
       console.log(JSON.stringify(await store.readMetadata('original')));`
    ], { env: { ...process.env, PRIVATE_STORE_PATH: path } })
    expect(JSON.parse(child.stdout)).toEqual(session())
  } finally { spy.mockRestore(); await rm(root, { recursive: true, force: true }) }
})

it('keeps the primary read failure and ends the reader when rollback also fails', async () => {
  const { root, store } = await fixture()
  const primary = Object.assign(new Error('Original read failed'), { errcode: 5 })
  const cleanup = Object.assign(new Error('Original rollback failed'), { errcode: 5 })
  const execute = DatabaseSync.prototype.exec
  let begins = 0
  const spy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
    if (sql === 'BEGIN') { begins += 1; execute.call(this, sql); throw primary }
    if (sql === 'ROLLBACK') throw cleanup
    return execute.call(this, sql)
  })
  const closed = vi.spyOn(DatabaseSync.prototype, 'close')
  try {
    const error = await store.readMetadata('original').catch(error => error)
    expect(error).toMatchObject({ code: 'AGENT_SESSION_STORE_UNAVAILABLE', cause: primary, cleanup: [cleanup] })
    expect(begins).toBe(1)
    expect(closed).toHaveBeenCalledTimes(1)
    spy.mockRestore()
    expect(await store.readMetadata('original')).toEqual(session())
  } finally { spy.mockRestore(); await rm(root, { recursive: true, force: true }) }
})

it('does not hide a failed reader close behind a subsequent successful open', async () => {
  const { root, store } = await fixture()
  const primary = Object.assign(new Error('Original validation failed'), { errcode: 5 })
  const cleanup = new Error('Original reader close failed')
  const prepare = DatabaseSync.prototype.prepare, close = DatabaseSync.prototype.close
  let reader: DatabaseSync | undefined, closeFailed = false, validations = 0
  const validation = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql: string) {
    if (sql === 'PRAGMA application_id') {
      validations += 1
      if (!reader) { reader = this; throw primary }
    }
    return prepare.call(this, sql)
  })
  const closing = vi.spyOn(DatabaseSync.prototype, 'close').mockImplementation(function (this: DatabaseSync) {
    if (this === reader && !closeFailed) { closeFailed = true; throw cleanup }
    return close.call(this)
  })
  try {
    const error = await store.readMetadata('original').catch(error => error)
    expect(error).toMatchObject({ code: 'AGENT_SESSION_STORE_UNAVAILABLE', cause: primary })
    expect(error.cause.cleanup).toEqual([cleanup])
    expect(validations).toBe(1)
    expect(closeFailed).toBe(true)
    validation.mockRestore(); closing.mockRestore()
    expect(await store.readMetadata('original')).toEqual(session())
  } finally {
    validation.mockRestore(); closing.mockRestore()
    if (reader) close.call(reader)
    await rm(root, { recursive: true, force: true })
  }
})

it('retains both rollback and close failures on the original primary read error', async () => {
  const { root, store } = await fixture()
  const cause = new Error('Original decoder failure')
  const primary = Object.assign(new AgentMuxError('Original read failed', 'INVALID_AGENT_SESSION_STORE', 'original detail'), { cause })
  const rollback = new Error('Original rollback failed'), closing = new Error('Original close failed')
  const execute = DatabaseSync.prototype.exec, close = DatabaseSync.prototype.close
  let reader: DatabaseSync | undefined, begins = 0
  const execution = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
    if (sql === 'BEGIN') { reader = this; begins += 1; execute.call(this, sql); throw primary }
    if (sql === 'ROLLBACK' && this === reader) throw rollback
    return execute.call(this, sql)
  })
  const closure = vi.spyOn(DatabaseSync.prototype, 'close').mockImplementation(function (this: DatabaseSync) {
    if (this === reader) throw closing
    return close.call(this)
  })
  try {
    const error = await store.readMetadata('original').catch(error => error)
    expect(error).toBe(primary)
    expect(error).toMatchObject({ code: 'INVALID_AGENT_SESSION_STORE', detail: 'original detail', cause })
    expect(error.cleanup, 'Both cleanup failures remain in occurrence order').toEqual([rollback, closing])
    expect(begins).toBe(1)
    execution.mockRestore(); closure.mockRestore()
    expect(await store.readMetadata('original')).toEqual(session())
  } finally {
    execution.mockRestore(); closure.mockRestore()
    if (reader) close.call(reader)
    await rm(root, { recursive: true, force: true })
  }
})

it('public exact Session and history catalogue consumers wait for the same committed identity', async () => {
  const { root, store } = await fixture(), client = new AgentMuxClient({ store })
  const writer = committingWriter(store.path)
  try {
    const released = new Promise<void>(done => setTimeout(() => { writer.release(); done() }, 60))
    const [exact, catalogue] = await Promise.all([
      client.readAgentSession('original'), loadSessionHistorySources(store), released
    ])
    expect(exact).toMatchObject({ agentSessionId: 'original', hostId: 'local', run: { runId: 'original-run' } })
    expect(catalogue).toMatchObject([{ agentSessionId: 'original', hostId: 'local', state: 'active', history: { nativeHandle: session().nativeHandle } }])
    expect(catalogue).toHaveLength(1)
  } finally { writer.release(); await client.dispose(); await rm(root, { recursive: true, force: true }) }
})

it('RPC and the actual CLI read the original Session while its committed reader meets a writer', async () => {
  const h = await rpcOwnerFixture(), path = join(h.root, 'read.sock')
  const server = new AgentMuxControlServer({ socketPath: path, coreClients: h.coreClients })
  await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } })
  try {
    for (const producer of ['rpc', 'cli'] as const) {
      const writer = committingWriter(h.store.path)
      const read = h.store.readMetadata.bind(h.store)
      let entered = 0
      const observe = vi.spyOn(h.store, 'readMetadata').mockImplementation(async id => {
        entered += 1
        // CLI startup does not consume the contention interval. Release only after its actual
        // server-side FileStore consumer has entered the original read implementation.
        const pending = read(id)
        setTimeout(() => writer.release(), 60)
        return await pending
      })
      try {
        const result = producer === 'rpc'
          ? await rpc.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: 'recipient' } })
          : await (async () => {
            const output = await runSourceObjectCli(['--endpoint', 'unix://' + path, 'agent', 'inspect', '--session', 'recipient'], objectCliEnvironment(h.root))
            expect(output.code, output.stderr).toBe(0)
            return JSON.parse(output.stdout).result
          })()
        expect(result.session).toMatchObject({ agentSessionId: 'recipient', run: { runId: 'run-recipient' } })
        expect(entered).toBeGreaterThan(0)
      } finally { observe.mockRestore(); writer.release() }
    }
  } finally { await rpc.dispose(); await server.stop(); await h.close() }
})
