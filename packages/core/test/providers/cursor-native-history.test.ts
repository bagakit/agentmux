import { fixturePath } from '../helpers/fixture-values.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { proto3, ScalarType } from '@bufbuild/protobuf'
import { AgentMuxClient, AgentMuxFileAgentSessionStore } from '../../src/index.js'
import { NativeSqliteHistoryReader } from '../../src/native-sqlite-history-reader.js'
import { projectConversationRecords } from '../../../client-ui/src/lib/conversation-records.js'
import type { CtxmuxRunAdapter } from '../../src/ctxmux-run-adapter.js'
import { observeCursorSessionHistory, readCursorSessionHistoryPage, resolveCursorStorePath } from '../../src/providers/cursor-native-history.js'
import { discoverCursorNativeSession } from '../../src/providers/cursor-native-session.js'
import { createCursorProvider } from '../../src/providers/cursor.js'
import { defineAgentProvider } from '../../src/agent-provider.js'
import fixture from '../fixtures/cursor-canonical-history.json' with { type: 'json' }

const dispose: Array<() => Promise<void>> = []
afterEach(async () => { while (dispose.length) await dispose.pop()!(); vi.unstubAllEnvs(); vi.restoreAllMocks() })
// Independent producer tags verified in the installed first-party generated schema.
const Root = proto3.makeMessageType('fixture.CursorCanonicalRoot', () => [{ no: 8, name: 'turns', kind: 'scalar', T: ScalarType.BYTES, repeated: true }])
const AgentTurn = proto3.makeMessageType('fixture.CursorAgentTurn', () => [{ no: 1, name: 'user_message', kind: 'scalar', T: ScalarType.BYTES }])
const Turn = proto3.makeMessageType('fixture.CursorTurn', () => [{ no: 1, name: 'agent_conversation_turn', kind: 'message', T: AgentTurn }])
const User = proto3.makeMessageType('fixture.CursorUser', () => [{ no: 1, name: 'text', kind: 'scalar', T: ScalarType.STRING }, { no: 18, name: 'text_blob_id', kind: 'scalar', T: ScalarType.BYTES }, { no: 19, name: 'rich_text_blob_id', kind: 'scalar', T: ScalarType.BYTES, opt: true }])
function nextChange(expected = 'invalidated') {
  let resolve!: (change: { kind: string; code?: string }) => void
  const promise = new Promise<{ kind: string; code?: string }>(done => { resolve = done })
  const timer = setTimeout(() => resolve({ kind: 'test-timeout' }), 3000)
  return { promise: promise.finally(() => clearTimeout(timer)), resolve: (change: { kind: string; code?: string }) => {
    if (change.kind === expected || change.code === 'AGENT_SESSION_HISTORY_SOURCE_CHANGED') resolve(change)
  } }
}

async function nativeFixture(rootId = fixture.rootId) {
  const root = await mkdtemp(join(tmpdir(), 'amux-cursor-canonical-'))
  const workspace = join(root, 'workspace'), env = { CURSOR_CONFIG_DIR: join(root, 'config') }
  await mkdir(workspace)
  const source = { providerId: 'cursor', nativeSessionId: '019ff166-9788-4ace-b9eb-9a71a42f0af9' }
  const path = resolveCursorStorePath(workspace, source.nativeSessionId, env)
  await mkdir(join(path, '..'), { recursive: true })
  const writer = new DatabaseSync(path)
  writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE blobs(id TEXT PRIMARY KEY,data BLOB); CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT)')
  for (const [id, base64] of Object.entries(fixture.blobs)) writer.prepare('INSERT INTO blobs VALUES (?,?)').run(id, Buffer.from(base64, 'base64'))
  const metadata = (id: string, agentId = source.nativeSessionId) => writer.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)')
    .run('0', Buffer.from(JSON.stringify({ agentId, latestRootBlobId: id })).toString('hex'))
  metadata(rootId)
  writer.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  dispose.push(async () => { writer.close(); await rm(root, { recursive: true, force: true }) })
  const blob = (bytes: Uint8Array) => {
    const id = createHash('sha256').update(bytes).digest()
    writer.prepare('INSERT OR IGNORE INTO blobs VALUES (?,?)').run(id.toString('hex'), bytes)
    return id
  }
  return { root, workspace, env, path, writer, source, metadata, blob, read: (limit = 30, cursor?: string) => readCursorSessionHistoryPage({ source, workspacePath: workspace,
    command: 'cursor-agent', args: [], env, signal: new AbortController().signal, limit, ...(cursor ? { cursor } : {}) }) }
}
async function nativeWriter(paths: string[]) {
  const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e',
    `import { DatabaseSync } from 'node:sqlite'; const dbs = ${JSON.stringify(paths)}.map(path => new DatabaseSync(path)); for (const db of dbs) db.prepare('SELECT value FROM meta WHERE key=?').get('0'); console.log('ready'); setInterval(() => {}, 10000)`],
  { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  await new Promise<void>((resolve, reject) => {
    process.stdout.once('data', data => data.toString().includes('ready') ? resolve() : reject(new Error('Native writer omitted ready')))
    process.once('error', reject); process.once('exit', () => reject(new Error('Native writer exited before ready')))
  })
  dispose.push(async () => { if (process.exitCode !== null) return; const ended = once(process, 'exit'); process.kill('SIGTERM'); await ended })
  return process.pid!
}

describe('Cursor first-party encoded canonical turns', () => {
  it('reads original user/assistant/reasoning/tool records when the prompt projection is empty', async () => {
    const f = await nativeFixture(), before = await readFile(f.path), page = await f.read()
    expect(page.items.map(item => item.kind)).toEqual(['user-message', 'assistant-message', 'activity', 'assistant-message'])
    expect(page.items.map(item => item.contentParts.filter(part => part.kind === 'text' || part.kind === 'reasoning').map(part => part.text).join('')))
      .toEqual(['original user', 'original thought', '', 'original answer'])
    expect(page.items[0]!.contentParts).toEqual([
      { kind: 'text', text: 'original user' },
      { kind: 'resource', resourceType: 'image', reference: '/native/image.png' },
      { kind: 'resource', resourceType: 'file', reference: '/native/file.ts' }
    ])
    expect(page.items[2]!.contentParts).toEqual([
      { kind: 'tool-call', name: 'shell', callId: 'native-call', input: "{\"command\":\"printf native\",\"workingDirectory\":\"/native\"}" },
      { kind: 'tool-result', name: 'shell', callId: 'native-call', output: '{"stdout":"native result"}', failed: false }
    ])
    expect(page.items.map(item => [item.startedAt, item.completedAt])).toEqual([[1000, undefined], [1100, 1200], [1300, undefined], [1500, 1600]])
    expect(await readFile(f.path)).toEqual(before)
  })
  it('keeps canonical positions and opaque older pages exact', async () => {
    const f = await nativeFixture(), first = await f.read(2), older = await f.read(2, first.nextCursor!)
    expect(first.items).toHaveLength(2); expect(older.items).toHaveLength(2)
    expect(older.nextCursor).toBeNull()
    expect([...older.items, ...first.items]).toEqual((await f.read()).items)
    expect(new Set([...older.items, ...first.items].map(item => item.id)).size).toBe(4)
  })
  it('preserves the original rich input protobuf locator alongside plain text without inventing referenced rich body', async () => {
    const f = await nativeFixture(), locator = Buffer.from('d'.repeat(64), 'hex')
    const bytes = new User({ text: 'original plain input', richTextBlobId: locator }).toBinary()
    const user = f.blob(bytes), turn = f.blob(new Turn({ agentConversationTurn: { userMessage: user } }).toBinary())
    f.metadata(f.blob(new Root({ turns: [turn] }).toBinary()).toString('hex'))
    const page = await f.read()
    expect(page.items[0]!.contentParts).toEqual([
      { kind: 'text', text: 'original plain input' },
      { kind: 'resource', resourceType: 'other', reference: 'data:application/x-protobuf;base64,' + Buffer.from(bytes).toString('base64'), label: 'Original Cursor rich input' }
    ])
    expect(f.writer.prepare('SELECT data FROM blobs WHERE id=?').get(locator.toString('hex'))).toBeUndefined()
  })
  it.each(['wal', 'checkpoint'])('pins the old canonical root during a %s tail rewrite and updates the same tail position on refresh', async mode => {
    const f = await nativeFixture(), first = await f.read(2)
    f.metadata(fixture.grownRootId)
    if (mode === 'checkpoint') f.writer.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    const older = await f.read(2, first.nextCursor!), fresh = await f.read()
    expect([...older.items, ...first.items].map(item => item.id)).toEqual(fresh.items.map(item => item.id))
    expect(first.items.at(-1)!.contentParts).toEqual([{ kind: 'text', text: 'original answer' }])
    expect(fresh.items.at(-1)!.contentParts).toEqual([{ kind: 'text', text: 'original answer extended' }])
    expect(fresh.items.at(-1)!.completedAt).toBe(1800)
  })
  it('preserves equal canonical occurrences and crosses a turn boundary without a guessed count', async () => {
    const f = await nativeFixture(fixture.repeatedRootId), items = []
    let cursor: string | undefined
    do { const page = await f.read(3, cursor); items.unshift(...page.items); cursor = page.nextCursor ?? undefined } while (cursor)
    expect(items).toEqual((await f.read()).items)
    expect(items).toHaveLength(8)
    expect(new Set(items.map(item => item.id)).size).toBe(8)
    expect(items[0]!.contentParts).toEqual(items[4]!.contentParts)
    expect(items[0]!.id).not.toBe(items[4]!.id)
  })
  it('keeps simulated input neutral, missing native times absent, and unknown protobuf bytes complete', async () => {
    const f = await nativeFixture(fixture.neutralRootId), page = await f.read()
    expect(page.items.map(item => [item.kind, item.startedAt, item.completedAt])).toEqual([
      ['activity', undefined, undefined], ['activity', undefined, undefined]
    ])
    expect(page.items[0]!.contentParts).toEqual([{ kind: 'text', text: 'simulated native input' }])
    const unknown = page.items[1]!.contentParts[0]!
    expect(unknown.kind).toBe('resource')
    if (unknown.kind !== 'resource') throw new Error('Expected preserved native wire resource')
    expect(unknown.reference).toBe('data:application/x-protobuf;base64,' + fixture.blobs[fixture.unknownStepId as keyof typeof fixture.blobs])
  })
  it.each(['wrong-meta', 'missing-user', 'changed-step', 'broken-root'])('rejects %s without a partial or empty successful page', async mode => {
    const f = await nativeFixture()
    if (mode === 'wrong-meta') f.metadata(fixture.rootId, 'foreign-native-id')
    if (mode === 'missing-user') f.writer.prepare('DELETE FROM blobs WHERE id=?').run(fixture.userId)
    if (mode === 'changed-step') f.writer.prepare('UPDATE blobs SET data=? WHERE id=?').run(Buffer.from('wrong bytes'), fixture.stepIds[0]!)
    if (mode === 'broken-root') {
      const bytes = Buffer.from([255]), id = createHash('sha256').update(bytes).digest('hex')
      f.writer.prepare('INSERT INTO blobs VALUES (?,?)').run(id, bytes); f.metadata(id)
    }
    await expect(f.read()).rejects.toMatchObject({ code: mode === 'broken-root' ? 'AGENT_SESSION_HISTORY_INVALID_TRANSCRIPT' : 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  })
  it('rejects a main DB replacement while the old cursor retains its original source identity', async () => {
    const f = await nativeFixture(), first = await f.read(2), bytes = await readFile(f.path)
    await rename(f.path, `${f.path}.previous`); await writeFile(f.path, bytes)
    await expect(f.read(2, first.nextCursor!)).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  })
  it('rejects a committed source change during selected record reading', async () => {
    const f = await nativeFixture(), get = NativeSqliteHistoryReader.prototype.get
    let changed = false
    vi.spyOn(NativeSqliteHistoryReader.prototype, 'get').mockImplementation(async function (this: NativeSqliteHistoryReader, sql, parameters) {
      const result = await get.call(this, sql, parameters)
      if (!changed && sql === 'SELECT data FROM blobs WHERE id = ?' && parameters?.[0] === fixture.userId) {
        changed = true; f.metadata(fixture.grownRootId)
      }
      return result
    })
    await expect(f.read()).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SNAPSHOT_CHANGED' })
    expect(changed).toBe(true)
  })
  it('enforces the independent materialized page budget when equal large native turns share one blob', async () => {
    const f = await nativeFixture(), user = f.blob(new User({ text: 'x'.repeat(256 * 1024) }).toBinary())
    const turn = f.blob(new Turn({ agentConversationTurn: { userMessage: user } }).toBinary())
    f.metadata(f.blob(new Root({ turns: Array.from({ length: 20 }, () => turn) }).toBinary()).toString('hex'))
    await expect(f.read()).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_TOO_LARGE' })
    expect((await f.read(1)).items[0]!.contentParts).toEqual([{ kind: 'text', text: 'x'.repeat(256 * 1024) }])
  })
  it('keeps invalid UTF-8 native text bytes intact and rejects malformed opaque continuation bounds', async () => {
    const f = await nativeFixture(), invalidText = f.blob(Buffer.from([0xff]))
    const user = f.blob(new User({ textBlobId: invalidText }).toBinary())
    const turn = f.blob(new Turn({ agentConversationTurn: { userMessage: user } }).toBinary())
    f.metadata(f.blob(new Root({ turns: [turn] }).toBinary()).toString('hex'))
    await expect(f.read()).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_INVALID_TRANSCRIPT' })
    expect(Buffer.from(f.writer.prepare('SELECT data FROM blobs WHERE id=?').get(invalidText.toString('hex'))!.data as Uint8Array)).toEqual(Buffer.from([0xff]))
    f.metadata(fixture.rootId)
    const page = await f.read(1), cursor = JSON.parse(Buffer.from(page.nextCursor!, 'base64url').toString('utf8'))
    cursor.beforeRecord = 99
    await expect(f.read(1, Buffer.from(JSON.stringify(cursor)).toString('base64url'))).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_INVALID_CURSOR' })
  })
  it('observes committed WAL root changes with metadata probes, keeps pinned pages, and stops after abort', async () => {
    const f = await nativeFixture(), first = await f.read(2), controller = new AbortController(), changes: string[] = []
    const ready = nextChange(), get = vi.spyOn(NativeSqliteHistoryReader.prototype, 'get')
    const handle = await observeCursorSessionHistory({ source: f.source, workspacePath: f.workspace, command: 'cursor-agent', args: [], env: f.env,
      transcriptPath: f.path, signal: controller.signal, onChange: change => { changes.push(change.kind); ready.resolve(change) } })
    dispose.push(async () => handle.dispose())
    f.writer.exec('BEGIN'); f.metadata(fixture.grownRootId); f.writer.exec('COMMIT')
    expect(await ready.promise).toMatchObject({ kind: 'invalidated' })
    expect(get.mock.calls.some(([sql]) => sql === 'SELECT value FROM meta WHERE key = ?')).toBe(true)
    expect(get.mock.calls.every(([sql]) => sql === 'SELECT value FROM meta WHERE key = ?' || sql === 'PRAGMA locking_mode=EXCLUSIVE')).toBe(true)
    expect((await f.read(2, first.nextCursor!)).items).toEqual((await f.read()).items.slice(0, 2))
    expect(first.items.at(-1)!.contentParts).toEqual([{ kind: 'text', text: 'original answer' }])
    expect((await f.read()).items.at(-1)!.contentParts).toEqual([{ kind: 'text', text: 'original answer extended' }])
    controller.abort(); const count = changes.length
    f.metadata(fixture.rootId); await new Promise(resolve => setTimeout(resolve, 80))
    expect(changes).toHaveLength(count)
  })
  it('feeds the production public Client and shared conversation projector after a client restart without Run controls or store writes', async () => {
    const f = await nativeFixture(), storePath = join(f.root, 'sessions.json'), store = new AgentMuxFileAgentSessionStore(storePath)
    vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(f.root, 'runtime')); vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(f.root, 'state'))
    vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(f.root, 'messages.ndjson'))
    await store.compareAndSwap(null, { kind: 'agent', agentSessionId: 'private-cursor-session', providerId: 'cursor', executorId: 'cursor',
      hostId: 'local', workspacePath: f.workspace, run: { runId: 'private-original-run' }, retiredRuns: [], createdAt: 1, updatedAt: 1,
      hookBindingId: 'b'.repeat(43), hookToken: 't'.repeat(43), nativeHandle: { kind: 'provider', providerId: 'cursor', sessionId: f.source.nativeSessionId, transcriptPath: f.path } })
    const before = await readFile(storePath), clients: AgentMuxClient[] = [], controls: Array<() => void> = []
    const client = () => {
      const value = new AgentMuxClient({ store }); clients.push(value)
      const adapter = (value as unknown as { kernel: CtxmuxRunAdapter }).kernel
      for (const method of ['start', 'input', 'resize', 'stop', 'attach', 'status'] as const) {
        const observed = vi.spyOn(adapter, method); controls.push(() => expect(observed).not.toHaveBeenCalled())
      }
      return value
    }
    dispose.push(async () => { await Promise.all(clients.map(value => value.dispose())) })
    const page = await client().sessionHistoryPage('private-cursor-session', { env: f.env })
    expect(page.items).toHaveLength(4)
    expect(await client().sessionHistoryPage('private-cursor-session', { env: f.env })).toEqual(page)
    const records = projectConversationRecords({ agentSessionId: 'private-cursor-session', historyPage: page })
    expect(records.map(item => item.kind)).toEqual(['user-message', 'assistant-message', 'activity', 'assistant-message'])
    expect(records[1]!.contentParts).toEqual([{ kind: 'reasoning', text: 'original thought' }])
    expect(records[0]!.input?.author).toEqual({ kind: 'unknown' })
    const observing = clients[0]!
    expect(createCursorProvider(defineAgentProvider).observeSessionHistory).toBeTypeOf('function')
    let changed = nextChange()
    const observer = await observing.observeSessionHistory('private-cursor-session', change => changed.resolve(change), { env: f.env })
    dispose.push(async () => observer.dispose())
    f.metadata(fixture.grownRootId)
    expect(await changed.promise).toMatchObject({ kind: 'invalidated' })
    const refreshed = await observing.sessionHistoryPage('private-cursor-session', { env: f.env })
    expect(projectConversationRecords({ agentSessionId: 'private-cursor-session', historyPage: refreshed }).at(-1)!.contentParts)
      .toEqual([{ kind: 'text', text: 'original answer extended' }])
    const originalGet = NativeSqliteHistoryReader.prototype.get
    let failNextProbe = true
    vi.spyOn(NativeSqliteHistoryReader.prototype, 'get').mockImplementation(async function (this: NativeSqliteHistoryReader, sql, parameters) {
      if (failNextProbe && sql === 'SELECT value FROM meta WHERE key = ?') {
        failNextProbe = false
        throw new Error('Private transient SQLite read failure')
      }
      return originalGet.call(this, sql, parameters)
    })
    changed = nextChange('unavailable'); f.metadata(fixture.rootId)
    expect(await changed.promise).toMatchObject({ kind: 'unavailable' })
    expect(failNextProbe).toBe(false)
    changed = nextChange(); f.metadata(fixture.repeatedRootId)
    expect(await changed.promise).toMatchObject({ kind: 'invalidated' })
    expect((await observing.sessionHistoryPage('private-cursor-session', { env: f.env })).items).toHaveLength(8)
    expect(await readFile(storePath)).toEqual(before)
    expect(controls).toHaveLength(12); controls.forEach(check => check())
  })
  it('discovers the real writable exact main DB and excludes proven child metadata in the same process group', async () => {
    const f = await nativeFixture(), childId = '019ff166-9788-4ace-b9eb-9a71a42f0afb', childPath = resolveCursorStorePath(f.workspace, childId, f.env)
    await mkdir(join(childPath, '..'), { recursive: true })
    const child = new DatabaseSync(childPath)
    child.exec('CREATE TABLE blobs(id TEXT PRIMARY KEY,data BLOB); CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT)')
    child.prepare('INSERT INTO meta VALUES (?,?)').run('0', Buffer.from(JSON.stringify({ agentId: childId, latestRootBlobId: '',
      subagentInfo: { parentAgentId: f.source.nativeSessionId, rootParentAgentId: f.source.nativeSessionId, toolCallId: 'child-call', typeName: 'native-child' } })).toString('hex'))
    child.close()
    const pid = await nativeWriter([f.path, childPath]), context = { processId: pid, command: 'cursor-agent', args: [], env: f.env, workspacePath: f.workspace, signal: new AbortController().signal }
    const discovering = discoverCursorNativeSession(context)
    await expect(discovering).resolves.toEqual({ handle: { kind: 'provider', providerId: 'cursor', sessionId: f.source.nativeSessionId, transcriptPath: f.path },
      childSessionIds: [childId], assertCurrent: expect.any(Function) })
    const result = await discovering
    await result!.assertCurrent()
    await rename(f.path, `${f.path}.previous`); await writeFile(f.path, await readFile(`${f.path}.previous`))
    await expect(result!.assertCurrent()).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE' })
  })
  it('refuses two writable main Sessions rather than choosing a recent filename', async () => {
    const f = await nativeFixture(), otherId = '019ff166-9788-4ace-b9eb-9a71a42f0afb', otherPath = resolveCursorStorePath(f.workspace, otherId, f.env)
    await mkdir(join(otherPath, '..'), { recursive: true })
    const other = new DatabaseSync(otherPath)
    other.exec('CREATE TABLE blobs(id TEXT PRIMARY KEY,data BLOB); CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT)')
    other.prepare('INSERT INTO meta VALUES (?,?)').run('0', Buffer.from(JSON.stringify({ agentId: otherId, latestRootBlobId: '' })).toString('hex')); other.close()
    const pid = await nativeWriter([f.path, otherPath])
    await expect(discoverCursorNativeSession({ processId: pid, command: 'cursor-agent', args: [], env: f.env, workspacePath: f.workspace,
      signal: new AbortController().signal })).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE' })
    expect((await f.read()).items).toHaveLength(4)
  })
})
