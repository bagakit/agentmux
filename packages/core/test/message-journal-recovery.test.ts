import { afterEach, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, copyFile, lstat, rm, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const control = vi.hoisted(() => ({ beforeBackup: undefined as undefined | ((target: string) => Promise<void>),
  afterStat: undefined as undefined | ((path: string) => void), directoryFailure: '' }))
vi.mock('node:sqlite', async original => {
  const sqlite = await original<typeof import('node:sqlite')>()
  return { ...sqlite, backup: async (db: any, target: string, ...args: any[]) => { await control.beforeBackup?.(target); return (sqlite.backup as any)(db, target, ...args) } }
})
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, lstat: async (path: any, ...args: any[]) => { const result = await (fs.lstat as any)(path, ...args); control.afterStat?.(String(path)); return result },
    open: async (path: any, ...args: any[]) => { const handle = await (fs.open as any)(path, ...args)
      if (String(path) === control.directoryFailure && (await handle.stat()).isDirectory()) handle.sync = async () => { throw Object.assign(Error('controlled directory EIO'), { code: 'EIO' }) }
      return handle } }
})
import { DatabaseSync } from 'node:sqlite'
import { DurableAgentMuxMessageQueue, type AgentMuxMessageAppendInput } from '../src/agent-global-message-queue.js'

const roots: string[] = []
afterEach(async () => { control.beforeBackup = undefined; control.afterStat = undefined; control.directoryFailure = ''; vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() { const root = await mkdtemp('/tmp/amux-journal-recovery-'); roots.push(root)
  return { root, queue: new DurableAgentMuxMessageQueue(join(root, 'messages.ndjson')) } }
function input(id = 'original-message'): AgentMuxMessageAppendInput { return { messageId: id, operationId: 'operation-' + id, createdAt: 1,
  sender: { kind: 'agent-session', agentSessionId: 'sender' }, recipient: { kind: 'agent-session', agentSessionId: 'reader' },
  senderSessionId: 'sender', senderRunId: 'sender-run', recipientSessionId: 'reader', recipientRunId: null,
  threadId: id, correlationId: id, replyTo: null, workspaceId: null, body: 'synthetic original body ' + id } }
async function child(mode: 'append' | 'read', path: string) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(AGENTMUX_|CTXMUX_)/u.test(name)))
  if (process.env.AGENTMUX_TEST_RECEIPT_SOURCE_LOADS) env.AGENTMUX_TEST_RECEIPT_SOURCE_LOADS = process.env.AGENTMUX_TEST_RECEIPT_SOURCE_LOADS
  return await new Promise<any>((resolve, reject) => {
    const processChild = spawn(process.execPath, ['--no-warnings', '--experimental-loader', fileURLToPath(new URL('./helpers/prompt-receipt-source-loader.mjs', import.meta.url)),
      fileURLToPath(new URL('./helpers/message-journal-recovery-worker.mjs', import.meta.url)), mode, path], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', errors = ''
    const timer = setTimeout(() => processChild.kill('SIGKILL'), 15_000)
    processChild.stdout.on('data', value => { output += value }); processChild.stderr.on('data', value => { errors += value })
    processChild.once('error', error => { clearTimeout(timer); reject(error) }); processChild.once('close', code => {
      clearTimeout(timer); code === 0 ? resolve(JSON.parse(output)) : reject(Error('Source child exited ' + code + ': ' + errors)) })
  })
}

it('backs up complete original main/mutex private tables and immutable legacy archives, then reopens the same owner in a second process', async () => {
  const f = await fixture(); await f.queue.append(input())
  const db = new DatabaseSync(f.queue.path), mutex = new DatabaseSync(f.queue.path + '.mutex.sqlite')
  const privateJson = JSON.stringify({ privateCredential: 'synthetic-only', originalAck: { range: [3, 7], operation: 'original-operation' } })
  const privateRows = [{ id: 'original', json: privateJson }]
  db.exec('CREATE TABLE preservation_probe(id TEXT PRIMARY KEY, json TEXT NOT NULL)'); db.prepare('INSERT INTO preservation_probe VALUES (?,?)').run('original', privateJson)
  mutex.exec('CREATE TABLE mutex_preservation_probe(id TEXT PRIMARY KEY, json TEXT NOT NULL)'); mutex.prepare('INSERT INTO mutex_preservation_probe VALUES (?,?)').run('original', privateJson)
  const incarnation = db.prepare('SELECT incarnation FROM metadata').get()!.incarnation
  db.close(); mutex.close()
  const legacy = 'synthetic immutable original archive', hash = createHash('sha256').update(legacy).digest('hex'), archive = f.queue.path + '.original-' + hash
  await writeFile(archive, legacy, { mode: 0o600 })
  const source = f.queue.storageRecoverySource(), result = await source.capture(join(f.root, 'capture'))
  expect(result.gaps).toEqual([]); expect(result.members.map(member => member.id)).toEqual(['mutex', 'journal', 'original-' + hash])
  expect(source.ownedPaths).toEqual(expect.arrayContaining([f.queue.path, f.queue.path + '.mutex.sqlite', f.queue.path + '-journal', archive]))
  expect(await readFile(result.members[2]!.file, 'utf8')).toBe(legacy)
  for (const member of result.members.slice(0, 2)) { expect((await lstat(member.file)).mode & 0o077).toBe(0); await copyFile(member.file, member.target) }
  const cold = await child('read', f.queue.path)
  expect(cold.pid).not.toBe(process.pid); expect(cold.queueId).toBe(f.queue.queueId)
  expect(cold).toMatchObject({ messages: ['original-message'], incarnation, marker: incarnation, privateRows, privateMutexRows: privateRows })
})

it('lets a second real source process save while online backup is paused without holding the original mutex or a read transaction', async () => {
  const f = await fixture(); await f.queue.append(input())
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve }), held = new Promise<void>(resolve => { release = resolve })
  control.beforeBackup = async () => { enter(); await held }
  const pending = f.queue.storageRecoverySource().capture(join(f.root, 'capture'))
  try {
    await entered
    const outcome = await child('append', f.queue.path).then(value => ({ value }), error => ({ error }))
    expect(outcome).not.toHaveProperty('error')
    expect('value' in outcome && outcome.value.messages).toEqual(['original-message', 'second-process'])
  } finally { release() }
  const captured = await pending
  expect(captured.gaps).toEqual([])
  const journal = new DatabaseSync(captured.members.find(member => member.id === 'journal')!.file, { readOnly: true })
  try { expect(journal.prepare("SELECT count(*) AS n FROM records WHERE json_extract(json,'$.kind')='message'").get()?.n).toBe(2) } finally { journal.close() }
}, 25_000)

it('never turns spilled uncommitted SQLite pages into a retained message receipt', async () => {
  const f = await fixture(); await f.queue.append(input())
  const writer = new DatabaseSync(f.queue.path)
  writer.exec('PRAGMA cache_size=3; CREATE TABLE spill_probe(id INTEGER PRIMARY KEY, body TEXT); BEGIN')
  const insert = writer.prepare('INSERT INTO spill_probe(body) VALUES (?)')
  for (let index = 0; index < 64; index++) insert.run('A'.repeat(8192))
  writer.exec('COMMIT')
  let enter!: () => void, release!: () => void, stats = 0
  const entered = new Promise<void>(resolve => { enter = resolve }), held = new Promise<void>(resolve => { release = resolve })
  control.beforeBackup = async target => { if (target.endsWith('mutex.sqlite')) { enter(); await held }
    else if (writer.isTransaction) writer.exec('ROLLBACK') }
  // A raw-copy regression sees a stable uncommitted image before rollback. The
  // online-backup path instead reaches its own committed read after rollback.
  control.afterStat = path => { if (path === f.queue.path && ++stats === 3 && writer.isTransaction) writer.exec('ROLLBACK') }
  const pending = f.queue.storageRecoverySource().capture(join(f.root, 'capture'))
  try {
    await entered; writer.exec('BEGIN IMMEDIATE'); writer.prepare('UPDATE spill_probe SET body=?').run('B'.repeat(8192)); release()
    const captured = await pending
    const member = captured.members.find(member => member.id === 'journal')
    if (member) {
      const snapshot = new DatabaseSync(member.file, { readOnly: true })
      try { expect(snapshot.prepare('SELECT substr(body,1,1) AS value FROM spill_probe LIMIT 1').get()?.value).toBe('A') }
      finally { snapshot.close() }
    } else expect(captured.gaps.some(gap => gap.memberId === 'journal')).toBe(true)
    if (writer.isTransaction) writer.exec('ROLLBACK')
    expect(writer.prepare('SELECT substr(body,1,1) AS value FROM spill_probe LIMIT 1').get()?.value).toBe('A')
  } finally { release(); if (writer.isTransaction) writer.exec('ROLLBACK'); writer.close(); await pending.catch(() => {}) }
})

it.each(['journal', 'mutex'] as const)('retains the available original when %s is absent without initializing either lost file', async missing => {
  const f = await fixture(); await f.queue.append(input())
  const removed = f.queue.path + (missing === 'mutex' ? '.mutex.sqlite' : '')
  await unlink(removed)
  const capture = await f.queue.storageRecoverySource().capture(join(f.root, 'capture'))
  expect(capture.gaps).toEqual(expect.arrayContaining([expect.objectContaining({ memberId: missing })]))
  expect(capture.members.map(member => member.id)).toEqual([missing === 'journal' ? 'mutex' : 'journal'])
  await expect(lstat(removed)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('keeps first-launch missing namespaces absent and refuses wrong app/schema and contradictory incarnations', async () => {
  const f = await fixture(), source = f.queue.storageRecoverySource()
  expect((await source.capture(join(f.root, 'missing'))).members).toEqual([])
  await expect(lstat(f.queue.path)).rejects.toMatchObject({ code: 'ENOENT' }); await expect(lstat(f.queue.path + '.mutex.sqlite')).rejects.toMatchObject({ code: 'ENOENT' })
  await f.queue.append(input())
  const mutex = new DatabaseSync(f.queue.path + '.mutex.sqlite'); mutex.prepare('UPDATE journal_format SET incarnation=?').run('foreign-incarnation'); mutex.close()
  const conflict = await source.capture(join(f.root, 'conflict'))
  expect(conflict.members).toEqual([]); expect(conflict.gaps).toEqual([{ sourceId: source.id, code: 'RECOVERY_MESSAGE_IDENTITY_CONFLICT' }])
  const db = new DatabaseSync(f.queue.path); db.exec('PRAGMA application_id=0'); db.close()
  const invalid = await source.capture(join(f.root, 'invalid'))
  expect(invalid.members.some(member => member.id === 'journal')).toBe(false)
  expect(invalid.gaps.some(gap => gap.memberId === 'journal')).toBe(true)
})

it('reports an altered archive and directory sync failure without changing healthy original queue work', async () => {
  const f = await fixture(); await f.queue.append(input())
  const archive = f.queue.path + '.original-' + 'a'.repeat(64)
  await writeFile(archive, 'unqualified archive bytes', { mode: 0o600 })
  const output = join(f.root, 'capture'); await mkdir(output)
  control.directoryFailure = output
  const capture = await f.queue.storageRecoverySource().capture(output)
  expect(capture.gaps.length).toBeGreaterThan(0)
  expect(capture.members).toEqual([])
  await expect(f.queue.append(input('healthy-next'))).resolves.toHaveProperty('messageId', 'healthy-next')
  expect(await readFile(archive, 'utf8')).toBe('unqualified archive bytes')
})

it('observes only its exact namespace and discovers a normally created queue without initializing it', async () => {
  const f = await fixture(), queue = new DurableAgentMuxMessageQueue(join(f.root, 'not-created', 'messages.ndjson'))
  const source = queue.storageRecoverySource(), changed = vi.fn(), unsubscribe = source.subscribe!(changed)
  try {
    await expect(lstat(queue.path)).rejects.toMatchObject({ code: 'ENOENT' })
    await writeFile(join(f.root, 'unrelated'), 'unrelated')
    await new Promise(resolve => setTimeout(resolve, 50)); expect(changed).not.toHaveBeenCalled()
    await queue.append(input())
    await expect.poll(() => changed.mock.calls.length).toBeGreaterThan(0)
    expect((await source.capture(join(f.root, 'capture'))).gaps).toEqual([])
  } finally { unsubscribe() }
})
