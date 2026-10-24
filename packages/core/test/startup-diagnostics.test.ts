import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import * as files from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore, type AgentMuxAgentSessionStore } from '../src/agent-session-store.js'
import { CoreStartupDiagnosticJournal } from '../src/startup-diagnostic-journal.js'
import { parseStartupDiagnosticRead, type AgentStartupDiagnosticPage, type AgentStartupDiagnosticRecord, type AgentStartupDiagnosticTarget } from '../src/startup-diagnostic.js'
import * as durable from '../src/durable-write.js'
import * as identities from '../src/object-id.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'
import { parseTerminalFrontendObservation, type AgentTerminalFrontendObservation } from '../src/agent-terminal-frontend.js'

// Preserve real filesystem I/O; expose only a configurable fault-injection seam.
vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }))

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { vi.restoreAllMocks(); const errors: unknown[] = []; for (const close of cleanup.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }; if (errors.length) throw new AggregateError(errors) })
const owner = { authority: { kind: 'core-runtime', id: 'original-runtime', lifetime: 'durable' as const }, ownerInstanceId: 'original-owner' }
const recent = { domain: 'agent.startup' as const, hostId: 'local', recent: {} }
const actor = { protocolId: 'fixture-native-v1', actorId: 'original-actor', lifecycleOperationId: 'original-lifecycle', token: 'a'.repeat(64), frontendControl: true as const, initializationControl: true as const, launch: { command: 'PRIVATE_ARGV', args: ['PRIVATE_PROMPT'] } }
const session = (): AgentMuxStoredAgentSession => ({ kind: 'agent', agentSessionId: 'original-session', providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: '/private-workspace', run: { runId: 'original-run' }, nativeActor: actor, hookToken: 'PRIVATE_HOOK', hookBindingId: 'binding', retiredRuns: [], createdAt: 1, updatedAt: 1 })
const observation = (phase: 'unknown' | 'failed' | 'ready' = 'failed', observedAt = 20): AgentTerminalFrontendObservation => ({
  frontendId: 'original-frontend', state: phase === 'ready' ? 'attached' : 'starting', backendState: 'running', source: 'managed-process', observedAt,
  initialization: { lifecycleOperationId: actor.lifecycleOperationId, phase,
    native: phase === 'ready' ? { state: 'confirmed', sessionId: 'original-native' } : { state: 'not-created' },
    ...(phase === 'ready' ? {} : { failure: { step: 'preflight', code: 0, message: 'PRIVATE_FAILURE ' + actor.token + ' PRIVATE_HOOK' } }) }
})
async function directory() { const path = await mkdtemp(join(tmpdir(), 'amux-startup-diagnostic-')); cleanup.push(() => rm(path, { recursive: true, force: true })); return path }
function journalAt(root: string, ownerInstanceId = owner.ownerInstanceId) {
  const journal = new CoreStartupDiagnosticJournal({ ...owner, ownerInstanceId }, root)
  cleanup.push(() => journal.dispose()); return journal
}
async function page(journal: CoreStartupDiagnosticJournal): Promise<AgentStartupDiagnosticPage> { return (await journal.read(recent)).data as AgentStartupDiagnosticPage }
async function settled(journal: CoreStartupDiagnosticJournal, count?: number) {
  let value!: AgentStartupDiagnosticPage
  await vi.waitFor(async () => { value = await page(journal); expect(value.coverage.startup).toBe('ready'); expect(value.coverage.pendingWrites).toBe(0); if (count !== undefined) expect(value.items).toHaveLength(count) }, { timeout: 10_000 })
  return value
}
async function core() {
  class OriginalClient extends AgentMuxClient { constructor(options: { store: AgentMuxAgentSessionStore }) { super({ ...options, diagnosticOwner: owner }) } }
  const h = await rpcOwnerFixture(['recipient'], { AgentMuxClient: OriginalClient, AgentMuxFileAgentSessionStore }); cleanup.push(h.close)
  const original = (await h.store.readMetadata('recipient'))!
  const updated = { ...original, nativeActor: actor }
  await h.store.compareAndSwap(original, updated)
  await (h.client as any).registry.refresh('recipient', updated.run)
  h.inner.kernel.status = vi.fn(async (id: string) => ({ ...h.run(id), pid: process.pid }))
  let emit!: (value: AgentTerminalFrontendObservation) => void
  const provider = h.client.providers.get('codex')
  const reader = vi.fn<NonNullable<typeof provider.observeTerminalFrontend>>(async options => { emit = options.onFrontend; return { dispose() {} } })
  vi.spyOn(provider as typeof provider & { observeTerminalFrontend: NonNullable<typeof provider.observeTerminalFrontend> }, 'observeTerminalFrontend').mockImplementation(reader)
  await (h.client as any).ensureTerminalFrontendObservation(updated)
  const journal = (h.client as any).startupDiagnostics as CoreStartupDiagnosticJournal
  cleanup.push(() => journal.dispose())
  return { ...h, updated, reader, emit: (value: AgentTerminalFrontendObservation) => emit(value), journal }
}

describe('accepted Core startup diagnostics', () => {
  it('records the original accepted unknown/failed/ready facts, zero code and private material without reprojection writes', async () => {
    const h = await core()
    h.emit(observation('unknown')); h.emit(observation('unknown', 21))
    let p = await settled(h.journal, 1)
    const first = p.items[0]!.observation
    expect(first).toMatchObject({ agentSessionId: 'recipient', runId: 'run-recipient', actorId: actor.actorId, lifecycleOperationId: actor.lifecycleOperationId,
      phase: 'unknown', event: 'unconfirmed', failure: { step: 'preflight', code: 0 }, observedAt: 20, ownerInstanceId: owner.ownerInstanceId })
    const target = { domain: 'agent.startup' as const, hostId: 'local', logId: first.logId }
    const safe = await h.client.readAgentStartupDiagnostic({ target })
    expect(safe.raw).toEqual({ retention: 'retained', returned: 'withheld', truncated: false })
    for (const secret of ['PRIVATE_FAILURE', actor.token, 'fixture-token', 'PRIVATE_ARGV', 'PRIVATE_PROMPT']) expect(JSON.stringify(safe)).not.toContain(secret)
    const raw = await h.client.readAgentStartupDiagnostic({ target, includeRaw: true })
    expect((raw.data as AgentStartupDiagnosticRecord).original?.message).toContain('PRIVATE_FAILURE [redacted]')
    expect(JSON.stringify(raw)).not.toContain(actor.token)
    expect(parseStartupDiagnosticRead(raw, target, true)).toEqual(raw)
    expect(() => parseStartupDiagnosticRead(raw, target)).toThrow()
    h.emit(observation('failed', 22)); h.emit(observation('ready', 23))
    p = await settled(h.journal, 3)
    expect(p.items.map(item => item.observation.phase)).toEqual(['ready', 'failed', 'unknown'])
    expect(p.items[0]!.observation.previousLogId).toBe(p.items[1]!.observation.logId)
    expect((await h.client.readAgentStartupDiagnostic({ target })).data).toEqual(safe.data)
    h.emit(observation('failed', 19))
    await settled(h.journal, 3)
    expect(h.reader).toHaveBeenCalledTimes(1); expect(h.inner.kernel.stop).not.toHaveBeenCalled(); expect(h.inner.kernel.input).not.toHaveBeenCalled()
  })
  it('does not record a foreign lifecycle or a late callback after the original Run changed', async () => {
    const h = await core(), wrong = observation()
    wrong.initialization!.lifecycleOperationId = 'other-lifecycle'; h.emit(wrong)
    await settled(h.journal, 0)
    const current = (await h.store.readMetadata('recipient'))!, replacement = { ...current, run: { runId: 'next-run' } }
    await h.store.compareAndSwap(current, replacement); await (h.client as any).registry.refresh('recipient', replacement.run)
    h.emit(observation())
    await settled(h.journal, 0)
  })
  it('preserves the original finite startup observation code while withholding arbitrary string codes', async () => {
    const h = await core(), value = observation('unknown')
    value.initialization!.failure!.code = 'AGENT_NATIVE_INITIALIZATION_OBSERVATION_UNCONFIRMED'
    h.emit(value)
    const first = (await settled(h.journal, 1)).items[0]!.observation
    expect(first.failure?.code).toBe('AGENT_NATIVE_INITIALIZATION_OBSERVATION_UNCONFIRMED')
    const target = { domain: 'agent.startup' as const, hostId: 'local', logId: first.logId }
    const safe = await h.client.readAgentStartupDiagnostic({ target })
    expect((parseStartupDiagnosticRead(safe, target).data as AgentStartupDiagnosticRecord).failure?.code).toBe(first.failure?.code)
    value.observedAt++; value.initialization!.failure!.code = 'PRIVATE_ARBITRARY_CODE'
    h.emit(value)
    const second = (await settled(h.journal, 2)).items[0]!.observation
    expect(second.failure?.code).toBeNull()
    expect(JSON.stringify(await h.client.readAgentStartupDiagnostic({ target: { ...target, logId: second.logId } }))).not.toContain('PRIVATE_ARBITRARY_CODE')
  })
  it('retains an already accepted transition when the source clock moves backwards', async () => {
    const h = await core(), first = observation('unknown', 200)
    first.state = 'unknown'; h.emit(first)
    await settled(h.journal, 1)
    h.emit(observation('ready', 100))
    const p = await settled(h.journal, 2)
    expect(p.items.map(item => [item.observation.phase, item.observation.observedAt])).toEqual([['ready', 100], ['unknown', 200]])
    expect(p.items[0]!.observation.previousLogId).toBe(p.items[1]!.observation.logId)
  })
  it('keeps live Core facts and native calls unchanged when an actual diagnostic publication fails', async () => {
    const h = await core()
    await settled(h.journal, 0)
    await mkdir(join(h.journal.directory!, 'pending.json'))
    h.emit(observation('failed')); h.emit(observation('ready', 21))
    const p = await settled(h.journal, 2)
    expect(p.coverage.writeFailures).toBeGreaterThan(0); expect(p.coverage.persistenceGap).toBe(true)
    expect(h.client.agentSession('recipient').terminalFrontend?.initialization?.phase).toBe('ready')
    expect(h.inner.kernel.stop).not.toHaveBeenCalled(); expect(h.inner.kernel.input).not.toHaveBeenCalled()
  })
  it('releases business ownership while old diagnostic I/O retains its own writer fence', async () => {
    const h = await core()
    let release!: () => void
    const actual = (h.journal as any).publish.bind(h.journal)
    const blocked = vi.spyOn(h.journal as any, 'publish').mockImplementationOnce(async record => {
      await new Promise<void>(resolve => { release = resolve }); await actual(record)
    })
    cleanup.push(async () => { release?.() })
    h.emit(observation())
    await vi.waitFor(() => expect(blocked).toHaveBeenCalledTimes(1))
    const original = (await page(h.journal)).items[0]!.observation
    let disposed = false
    void h.client.dispose().then(() => { disposed = true })
    await vi.waitFor(() => expect(disposed).toBe(true))
    const second = journalAt(h.journal.directory!, 'second-owner')
    const unavailable = await second.read(recent)
    expect(unavailable.issue?.code).toBe('DIAGNOSTIC_EVIDENCE_SOURCE_BUSY')
    second.observe({ ...session(), agentSessionId: 'second-session' }, observation())
    expect((await page(second)).coverage.pendingWrites).toBe(1)
    expect((await readdir(h.journal.directory!)).filter(name => name === 'pending.json')).toHaveLength(1)
    release(); await h.journal.dispose()
    const recovered = await settled(second, 2)
    expect(recovered.items[1]!.observation).toEqual(original)
    expect(recovered.items[0]!.observation.agentSessionId).toBe('second-session')
    expect(h.inner.kernel.stop).not.toHaveBeenCalled(); expect(h.inner.kernel.input).not.toHaveBeenCalled()
  })
})

describe('bounded original diagnostic journal', () => {
  it('preserves original authority and producer across another owner, with finite discovery and exact constraints', async () => {
    const root = await directory(), first = journalAt(root)
    first.observe(session(), observation('failed')); first.observe(session(), observation('ready', 21))
    const before = await settled(first, 2)
    await first.dispose()
    const second = journalAt(root, 'second-owner')
    const after = await settled(second, 2)
    expect(after.items.map(item => item.observation)).toEqual(before.items.map(item => item.observation))
    const target = { domain: 'agent.startup' as const, hostId: 'local', logId: before.items[1]!.observation.logId, authority: { kind: 'core-runtime', id: owner.authority.id } }
    expect((await second.read(target)).persistence).toBe('observed')
    expect((await second.read({ ...target, authority: { kind: 'core-runtime', id: 'other-owner' } })).issue?.code).toBe('DIAGNOSTIC_EVIDENCE_AUTHORITY_MISMATCH')
    const firstPage = (await second.read({ ...recent, recent: { limit: 1 } })).data as AgentStartupDiagnosticPage
    expect(firstPage.nextCursor).not.toBeNull()
    const next = (await second.read({ ...recent, recent: { limit: 1, cursor: firstPage.nextCursor! } })).data as AgentStartupDiagnosticPage
    expect(next.items[0]!.observation.logId).toBe(before.items[1]!.observation.logId)
    await expect(second.read({ ...recent, recent: { cursor: firstPage.nextCursor!, runId: 'other' } })).rejects.toThrow()
    expect(parseStartupDiagnosticRead(await second.read(recent), recent).data).not.toBeNull()
  })
  it('bounds pending I/O, retains its actual slot, and evicts only diagnostic payloads', async () => {
    const root = await directory(), journal = journalAt(root)
    let release!: () => void
    const publish = vi.spyOn(journal as any, 'publish').mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
    journal.observe(session(), observation())
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1))
    for (let i = 0; i < 80; i++) journal.observe({ ...session(), agentSessionId: 'pending-' + i }, observation('failed', i + 30))
    const pending = await page(journal)
    expect(pending.coverage.pendingWrites).toBeLessThanOrEqual(32); expect(pending.coverage.dropped).toBeGreaterThan(0)
    expect(publish).toHaveBeenCalledTimes(1)
    release(); await settled(journal)
    publish.mockRestore()
    for (let i = 0; i < 140; i++) {
      journal.observe({ ...session(), agentSessionId: 'retained-' + i }, observation('failed', i + 100))
      await settled(journal)
    }
    const final = await page(journal)
    expect(final.coverage.retainedRecords).toBe(128); expect(final.coverage.retainedBytes).toBeLessThanOrEqual(512 * 1024); expect(final.coverage.evicted).toBeGreaterThan(0)
    const files = await readdir(root)
    expect(files.filter(name => /^[1-9A-HJ-NP-Za-km-z]{12}\.json$/u.test(name)).length).toBeLessThanOrEqual(128)
    expect(files).not.toContain('pending.json')
  }, 30_000)
  it('recovers the one real publication after index failure without unbounded orphan growth or changing its original facts', async () => {
    const root = await directory(), first = journalAt(root), actual = durable.durableWriteFile
    const failing = vi.spyOn(durable, 'durableWriteFile').mockImplementation(async (path, content, options) => {
      if (path === join(root, 'index.json')) throw Object.assign(new Error('private index failure'), { code: 'ENOSPC' })
      return actual(path, content, options)
    })
    first.observe(session(), observation())
    const p = await settled(first, 1), original = p.items[0]!.observation
    for (let i = 0; i < 10; i++) first.observe({ ...session(), agentSessionId: 'not-on-disk-' + i }, observation('failed', i + 40))
    await settled(first)
    expect((await readdir(root)).filter(name => /^[1-9A-HJ-NP-Za-km-z]{12}\.json$/u.test(name))).toHaveLength(1)
    expect((await page(first)).coverage.indexFailures).toBe(1)
    failing.mockRestore()
    await first.dispose()
    const second = journalAt(root, 'second-owner')
    const recovered = await settled(second, 1)
    expect(recovered.items[0]!.observation).toEqual(original)
    expect(recovered.coverage.persistenceGap).toBe(true); expect(await readdir(root)).not.toContain('pending.json')
    await second.dispose()
    const third = journalAt(root, 'third-owner')
    expect((await settled(third, 1)).items[0]!.observation).toEqual(original)
  })
  it('keeps exact files readable with a corrupt index; refuses oversize files and reports raw truncation and known credential redaction', async () => {
    const root = await directory(), first = journalAt(root), value = observation()
    value.initialization!.failure!.message = 'PRIVATE_HOOK ' + '界'.repeat(4000)
    first.observe(session(), value)
    const before = await settled(first, 1), logId = before.items[0]!.observation.logId
    const raw = (await first.read({ domain: 'agent.startup', hostId: 'local', logId }, true)).data as AgentStartupDiagnosticRecord
    expect(raw.material).toMatchObject({ truncated: true, redacted: true }); expect(Buffer.byteLength(raw.original!.message)).toBeLessThanOrEqual(4096)
    expect(raw.original!.message).not.toContain('PRIVATE_HOOK')
    await first.dispose()
    await writeFile(join(root, 'index.json'), '{broken')
    const second = journalAt(root, 'next')
    await vi.waitFor(async () => expect((await page(second)).coverage.startup).toBe('unavailable'))
    expect((await second.read({ domain: 'agent.startup', hostId: 'local', logId })).availability).toBe('found')
    await writeFile(join(root, `${logId}.json`), 'x'.repeat(25 * 1024))
    expect((await second.read({ domain: 'agent.startup', hostId: 'local', logId })).availability).toBe('corrupt')
    expect(await readFile(join(root, 'index.json'), 'utf8')).toBe('{broken')
  })
  it('keeps escaped private material within its actual codec budget across the next owner', async () => {
    const root = await directory(), first = journalAt(root)
    for (const [index, message] of ['\\'.repeat(4096), '\0'.repeat(4096)].entries()) {
      const value = observation('failed', 20 + index)
      value.initialization!.failure = { step: 'preflight', code: '\\'.repeat(512), message }
      first.observe({ ...session(), agentSessionId: 'escaped-' + index }, parseTerminalFrontendObservation(value))
    }
    const before = await settled(first, 2)
    expect(before.items.every(item => item.observation.material.truncated)).toBe(true)
    await first.dispose()
    const second = journalAt(root, 'next')
    expect((await settled(second, 2)).items.map(item => item.observation)).toEqual(before.items.map(item => item.observation))
    for (const item of before.items) {
      const target = { domain: 'agent.startup' as const, hostId: 'local', logId: item.observation.logId }
      const read = await second.read(target, true)
      expect(read.availability).toBe('found'); expect(parseStartupDiagnosticRead(read, target, true)).toEqual(read)
      const record = read.data as AgentStartupDiagnosticRecord
      expect(record.material.retainedBytes).toBeLessThanOrEqual(8192)
      expect(Buffer.byteLength(JSON.stringify(record))).toBeLessThanOrEqual(24 * 1024)
    }
  })
  it('retains the one fixed candidate and publication when actual candidate cleanup fails', async () => {
    const root = await directory(), first = journalAt(root), actual = files.unlink
    const failed = vi.spyOn(files, 'unlink').mockImplementation(async path => {
      if (String(path).startsWith(root) && String(path).endsWith('.candidate')) throw Object.assign(new Error('cleanup failed'), { code: 'EACCES' })
      return actual(path)
    })
    first.observe(session(), observation())
    const before = await settled(first, 1), original = before.items[0]!.observation
    expect(before.coverage.cleanupFailures).toBe(1)
    expect((await readdir(root)).filter(name => name.endsWith('.candidate'))).toEqual([original.logId + '.candidate'])
    expect(await readdir(root)).toContain('pending.json')
    await first.dispose(); failed.mockRestore()
    const second = journalAt(root, 'next')
    expect((await settled(second, 1)).items[0]!.observation).toEqual(original)
    expect((await readdir(root)).filter(name => name.endsWith('.candidate'))).toHaveLength(0)
    expect(await readdir(root)).not.toContain('pending.json')
  })
  it('stops expanding a diagnostic namespace after repeated real durable-write cleanup failures', async () => {
    const root = await directory()
    // Unowned remnants are counted, never deleted or read as Agent history.
    for (let i = 0; i < 138; i++) await writeFile(join(root, `unknown-${i}.tmp`), '')
    const rename = files.rename, unlink = files.unlink
    vi.spyOn(files, 'rename').mockImplementation(async (from, to) => {
      if (to === join(root, 'pending.json')) throw Object.assign(new Error('replace failed'), { code: 'ENOSPC' })
      return rename(from, to)
    })
    vi.spyOn(files, 'unlink').mockImplementation(async path => {
      if (String(path).startsWith(join(root, 'pending.json.')) && String(path).endsWith('.tmp')) throw Object.assign(new Error('cleanup failed'), { code: 'EACCES' })
      return unlink(path)
    })
    for (let i = 0; i < 2; i++) {
      const journal = journalAt(root, 'failed-' + i)
      journal.observe(session(), observation())
      const value = await settled(journal, 1)
      expect(value.coverage.writeFailures).toBe(1)
      expect(value.coverage.cleanupFailures).toBe(1)
      await journal.dispose()
    }
    expect((await readdir(root)).filter(name => name.startsWith('pending.json.'))).toHaveLength(2)
    const stopped = journalAt(root, 'stopped')
    stopped.observe(session(), observation())
    await vi.waitFor(async () => {
      const value = await page(stopped)
      expect(value.coverage.pendingWrites).toBe(0)
      expect(value.coverage).toMatchObject({ startup: 'unavailable', directoryLimitReached: true, examinedEntries: 141, persistenceGap: true })
      expect(value.items).toHaveLength(1)
    })
    expect((await readdir(root)).filter(name => name.startsWith('pending.json.'))).toHaveLength(2)
    expect(await readFile(join(root, 'unknown-0.tmp'), 'utf8')).toBe('')
  })
  it('does not shadow or overwrite an original log ID, even when its index is absent', async () => {
    const root = await directory(), first = journalAt(root)
    vi.spyOn(identities, 'mintObjectId').mockReturnValue('111111111111')
    first.observe(session(), observation()); first.observe(session(), observation('unknown', 21))
    const queued = await settled(first, 1), original = queued.items[0]!.observation
    expect(queued.coverage.dropped).toBe(1); expect(original.phase).toBe('failed')
    const path = join(root, original.logId + '.json'), bytes = await readFile(path, 'utf8')
    const target = { domain: 'agent.startup' as const, hostId: 'local', logId: original.logId }
    first.observe(session(), observation('unknown', 22))
    expect((await settled(first, 1)).coverage.dropped).toBe(2)
    expect((await first.read(target)).data).toEqual({ ...original, original: null })
    expect((await first.read(target, true)).data).toEqual(JSON.parse(bytes))
    await first.dispose(); await rm(join(root, 'index.json'))
    const unlink = files.unlink
    const failedCleanup = vi.spyOn(files, 'unlink').mockImplementation(async path => {
      if (String(path).startsWith(root) && String(path).endsWith('.candidate')) throw Object.assign(new Error('conflicting candidate cleanup failed'), { code: 'EACCES' })
      return unlink(path)
    })
    const second = journalAt(root, 'second-owner')
    second.observe(session(), observation('unknown', 23))
    expect((await settled(second, 0)).coverage.writeFailures).toBe(1)
    expect((await second.read(target)).data).toEqual({ ...original, original: null })
    expect((await second.read(target, true)).data).toEqual(JSON.parse(bytes))
    expect(await readFile(path, 'utf8')).toBe(bytes)
    await second.dispose(); failedCleanup.mockRestore()
    const third = journalAt(root, 'third-owner')
    await vi.waitFor(async () => expect((await page(third)).coverage.startup).toBe('unavailable'))
    expect((await third.read(target)).data).toEqual({ ...original, original: null })
    expect((await third.read(target, true)).data).toEqual(JSON.parse(bytes))
    expect(await readFile(path, 'utf8')).toBe(bytes)
  })
})
