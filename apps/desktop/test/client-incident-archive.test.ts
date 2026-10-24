import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { durableWriteFile, type AgentMuxClientIncidentReport, type AgentMuxClientIncidentProducer,
  type AgentMuxClientIncidentPage } from '@agentmux/core'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service'
import { parseDiagnosticEvidenceResult } from '../../../packages/core/src/diagnostic-evidence-codec'
const { ClientIncidentArchive, CLIENT_INCIDENT_LIMITS }: typeof import('@agentmux/host/client-incident-archive') = await import(
  process.env.AGENTMUX_TEST_INCIDENT_ARCHIVE_ENTRY ?? new URL('@agentmux/host/client-incident-archive', import.meta.url).href)
type ClientIncidentArchive = import('@agentmux/host/client-incident-archive').ClientIncidentArchive

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })
async function directory() { const path = await mkdtemp(join(tmpdir(), 'client-incidents-')); directories.push(path); return path }
const producer = (id = 'producer'): AgentMuxClientIncidentProducer => ({ kind: 'renderer', appInstanceId: 'application', producerInstanceId: id,
  windowId: 'window', documentGeneration: 'document', buildId: 'build' })
const report = (overrides: Partial<AgentMuxClientIncidentReport> = {}): AgentMuxClientIncidentReport => ({ occurrenceId: randomUUID(), attemptId: 'attempt',
  relatedOccurrenceId: null, hostId: 'execution-host', regionId: 'region', kind: 'terminal-attach-failed', stage: 'attach-failed', code: 'EIO',
  agentSessionId: 'agent', runId: 'run', observedAt: 1, elapsedMs: 2, metadata: { cursorBytes: 0, visible: true },
  stages: [{ stage: 'attach-requested', elapsedMs: 0, metadata: {} }], references: [], ...overrides })
const bounds = () => ({ signal: new AbortController().signal, maxBytes: 256 * 1024 })
async function page(archive: ClientIncidentArchive, recent = {}) {
  return (await archive.read({ domain: 'client.incident', hostId: 'local', recent }, bounds())).data as AgentMuxClientIncidentPage
}

it('preserves the first failure and a separately correlated refresh receipt with durable exact references', async () => {
  const archive = new ClientIncidentArchive(await directory())
  await archive.flush()
  const failed = report(), first = archive.enqueue(failed, producer())
  const refresh = report({ kind: 'terminal-refresh', stage: 'refresh-completed', relatedOccurrenceId: failed.occurrenceId })
  const second = archive.enqueue(refresh, producer())
  expect(first.accepted).toBe(true); expect(second.logId).not.toBe(first.logId)
  await archive.flush()
  const found = await archive.read({ domain: 'client.incident', hostId: 'local', logId: first.logId! }, bounds())
  expect(found).toMatchObject({ availability: 'found', persistence: 'confirmed', observedAt: expect.any(Number),
    data: { report: { kind: 'terminal-attach-failed', code: 'EIO' }, producer: producer() } })
  const discovered = await page(archive)
  expect(discovered.items).toHaveLength(2)
  expect(discovered.coverage).toMatchObject({ startup: 'ready', pendingWrites: 0, dropped: 0 })
  expect(discovered.items.every(item => item.recordRef.authority?.kind === 'client-incident-archive')).toBe(true)
  expect(JSON.stringify(found)).not.toContain('execution-host/')
})

it('keeps exact immutable originals and the same namespace readable in another real process', async () => {
  const path = await directory(), archive = new ClientIncidentArchive(path)
  await archive.flush()
  const receipt = archive.enqueue(report(), producer())
  await archive.flush()
  const before = await archive.read({ domain: 'client.incident', hostId: 'local', logId: receipt.logId! }, bounds())
  const moduleUrl = new URL('@agentmux/host/client-incident-archive', import.meta.url).href
  const script = `import {ClientIncidentArchive} from ${JSON.stringify(moduleUrl)}; const a=new ClientIncidentArchive(process.argv[1]);await a.flush();const p=await a.read({domain:'client.incident',hostId:'local',recent:{}},{signal:new AbortController().signal,maxBytes:262144});const r=await a.read({domain:'client.incident',hostId:'local',logId:process.argv[2]},{signal:new AbortController().signal,maxBytes:262144});console.log(JSON.stringify({p,r}));`
  const child = await promisify(execFile)(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', script, path, receipt.logId!])
  const { p, r } = JSON.parse(child.stdout)
  expect(p.data.items[0].recordRef).toEqual(before.recordRef)
  expect(r).toMatchObject({ availability: 'found', persistence: 'observed', data: before.data })
})

it('deduplicates the same original occurrence and rejects conflicts and unsafe payload fields', async () => {
  const archive = new ClientIncidentArchive(await directory()), original = report()
  await archive.flush()
  const first = archive.enqueue(original, producer())
  expect(archive.enqueue(original, producer())).toEqual(first)
  expect(archive.enqueue({ ...original, code: 'ENOSPC' }, producer())).toEqual({ accepted: false })
  expect(archive.enqueue({ ...report(), message: 'private-terminal-text' } as never, producer())).toEqual({ accepted: false })
  await archive.flush()
  expect((await page(archive)).coverage).toMatchObject({ duplicates: 1, invalid: 2, retainedCount: 1 })
  const serialized = await readFile(join(archive.directory, first.logId + '.json'), 'utf8')
  expect(serialized).not.toContain('private-terminal-text')
})

it('bounds a real pending writer and preserves admission capacity for another producer', async () => {
  let release!: () => void, entered!: () => void, active = 0, peak = 0, recordWrites = 0
  const gate = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  const archive = new ClientIncidentArchive(await directory(), { write: async (path, content, options) => {
    if (path.endsWith('.candidate')) { recordWrites++; active++; peak = Math.max(peak, active); entered(); await gate; active-- }
    return durableWriteFile(path, content, options)
  } })
  await archive.flush()
  const receipts = Array.from({ length: 80 }, () => archive.enqueue(report(), producer()))
  expect(receipts.filter(receipt => receipt.accepted).length).toBeLessThanOrEqual(8)
  const independent = report()
  expect(archive.enqueue(independent, producer('independent'))).toMatchObject({ accepted: true })
  await started
  const during = await page(archive)
  expect(during.coverage.pendingWrites).toBeLessThanOrEqual(CLIENT_INCIDENT_LIMITS.queue)
  expect(during.coverage.dropped).toBeGreaterThan(0)
  expect(recordWrites).toBe(1); expect(peak).toBe(1)
  release(); await archive.flush()
  expect((await page(archive)).items.some(item => item.occurrenceId === independent.occurrenceId)).toBe(true)
})

it('reports write and index failure while original diagnostic admission remains finite', async () => {
  let failIndex = false
  const archive = new ClientIncidentArchive(await directory(), { write: async (path, content, options) => {
    if (failIndex && path.endsWith('index.json')) throw Object.assign(new Error('private path and error text'), { code: 'ENOSPC' })
    return durableWriteFile(path, content, options)
  } })
  await archive.flush(); failIndex = true
  const receipt = archive.enqueue(report(), producer())
  expect(receipt.accepted).toBe(true)
  await archive.flush()
  const discovered = await page(archive)
  expect(discovered.coverage.indexFailures).toBeGreaterThan(0)
  expect(discovered.items[0]!.persistence).toBe('unconfirmed')
  expect(JSON.stringify(discovered)).not.toContain('private path')
  const exact = await archive.read({ domain: 'client.incident', hostId: 'local', logId: receipt.logId! }, bounds())
  expect(exact).toMatchObject({ availability: 'found', persistence: 'unconfirmed' })
})

it('isolates one corrupt record and refuses to reset a corrupt durable namespace', async () => {
  const path = await directory(), archive = new ClientIncidentArchive(path)
  await archive.flush()
  const first = archive.enqueue(report(), producer()), second = archive.enqueue(report(), producer())
  await archive.flush()
  await writeFile(join(path, first.logId + '.json'), '{broken')
  const restarted = new ClientIncidentArchive(path); await restarted.flush()
  expect(await restarted.read({ domain: 'client.incident', hostId: 'local', logId: first.logId! }, bounds())).toMatchObject({ availability: 'corrupt' })
  expect(await restarted.read({ domain: 'client.incident', hostId: 'local', logId: second.logId! }, bounds())).toMatchObject({ availability: 'found' })
  expect((await page(restarted)).coverage.corrupt).toBe(1)
  await writeFile(join(path, 'index.json'), '{broken-index')
  const broken = new ClientIncidentArchive(path); await broken.flush()
  expect((await page(broken)).coverage.startup).toBe('unavailable')
  expect(broken.enqueue(report(), producer())).toEqual({ accepted: false })
  expect(await broken.read({ domain: 'client.incident', hostId: 'local', logId: second.logId! }, bounds()))
    .toMatchObject({ availability: 'found', completeness: 'partial', readAuthority: null, authorityStatus: 'unavailable' })
  expect((await broken.read({ domain: 'client.incident', hostId: 'local', logId: second.logId!,
    authority: { kind: 'client-incident-archive', id: 'original-archive' } }, bounds())).issue?.code)
    .toBe('DIAGNOSTIC_EVIDENCE_AUTHORITY_UNAVAILABLE')
  expect(await readFile(join(path, 'index.json'), 'utf8')).toBe('{broken-index')
})

it('binds pagination to its archive and filters without dropping records with the same receive time', async () => {
  const archive = new ClientIncidentArchive(await directory(), { now: () => 100 })
  await archive.flush()
  for (let i = 0; i < 5; i++) archive.enqueue(report(), producer())
  await archive.flush()
  const first = await page(archive, { limit: 2 }), second = await page(archive, { limit: 2, cursor: first.nextCursor! }),
    third = await page(archive, { limit: 2, cursor: second.nextCursor! })
  expect(new Set([...first.items, ...second.items, ...third.items].map(item => item.recordRef.logId)).size).toBe(5)
  expect(third.nextCursor).toBeNull()
  const wrongScope = await archive.read({ domain: 'client.incident', hostId: 'local', recent: { limit: 2, kind: 'terminal-refresh', cursor: first.nextCursor! } }, bounds())
  expect(wrongScope.issue?.code).toBe('DIAGNOSTIC_EVIDENCE_AUTHORITY_MISMATCH')
  const wrongHost = await archive.read({ domain: 'client.incident', hostId: 'another-host', recent: {} }, bounds())
  expect(wrongHost.availability).toBe('forbidden')
})

it('holds actual read slots after a caller observation times out', async () => {
  const path = await directory(), writer = new ClientIncidentArchive(path)
  await writer.flush()
  const receipt = writer.enqueue(report(), producer())
  await writer.flush()
  let release!: () => void, active = 0
  const gate = new Promise<void>(resolve => { release = resolve })
  const reader = new ClientIncidentArchive(path, { beforeRead: async file => {
    if (!file.endsWith('index.json')) { active++; await gate; active-- }
  } })
  await reader.flush()
  const target = { domain: 'client.incident' as const, hostId: 'local', logId: receipt.logId! }
  await Promise.all(Array.from({ length: CLIENT_INCIDENT_LIMITS.readers }, () => reader.read(target, bounds())))
  expect(active).toBe(CLIENT_INCIDENT_LIMITS.readers)
  expect((await reader.read(target, bounds())).issue?.code).toBe('DIAGNOSTIC_EVIDENCE_SOURCE_BUSY')
  release(); await new Promise(resolve => setTimeout(resolve, 30))
  expect((await reader.read(target, bounds())).availability).toBe('found')
})

it('bounds durable records and reports eviction without touching other original files', async () => {
  const path = await directory(), archive = new ClientIncidentArchive(path)
  await archive.flush()
  let first = ''
  for (let i = 0; i < CLIENT_INCIDENT_LIMITS.records + 3; i++) {
    const receipt = archive.enqueue(report(), producer()); first ||= receipt.logId!
    await archive.flush()
  }
  const discovered = await page(archive)
  expect(discovered.coverage.retainedCount).toBe(CLIENT_INCIDENT_LIMITS.records)
  expect(discovered.coverage.evicted).toBe(3)
  expect((await readdir(path)).filter(name => name.endsWith('.json'))).toHaveLength(CLIENT_INCIDENT_LIMITS.records + 1)
  expect(await archive.read({ domain: 'client.incident', hostId: 'local', logId: first }, bounds())).toMatchObject({ availability: 'evicted' })
}, 30_000)


it('serves actual archive discovery and exact reads through the public service and strict wire parser', async () => {
  const archive = new ClientIncidentArchive(await directory())
  await archive.flush()
  const receipt = archive.enqueue(report(), producer())
  await archive.flush()
  const service = new AgentMuxRpcService({ coreClients: () => [], clientIncidents: archive })
  try {
    const recent = { target: { domain: 'client.incident' as const, hostId: 'local', recent: {} } }
    const discovered = parseDiagnosticEvidenceResult(await service.call('system.diagnostics.inspect', recent), recent)
    const page = discovered.reads[0]!.data as AgentMuxClientIncidentPage
    expect(page.items[0]!.recordRef.logId).toBe(receipt.logId)
    const ref = page.items[0]!.recordRef
    const exact = { target: { domain: 'client.incident' as const, hostId: 'local', logId: ref.logId,
      authority: { kind: ref.authority!.kind, id: ref.authority!.id } } }
    expect(parseDiagnosticEvidenceResult(await service.call('system.diagnostics.inspect', exact), exact).reads[0])
      .toMatchObject({ availability: 'found', recordRef: ref, data: { report: { kind: 'terminal-attach-failed' } } })
  } finally { await service.dispose() }
})

it('retains early reports without advertising a provisional ID and deduplicates after the durable index loads', async () => {
  const path = await directory(), original = report(), archive = new ClientIncidentArchive(path)
  await archive.flush()
  const receipt = archive.enqueue(original, producer()); await archive.flush()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const restarted = new ClientIncidentArchive(path, { beforeRead: file => file.endsWith('index.json') ? gate : Promise.resolve() })
  expect(restarted.enqueue(original, producer())).toEqual({ accepted: true })
  expect(restarted.enqueue({ ...report(), message: 'private' } as never, producer())).toEqual({ accepted: false })
  release(); await restarted.flush()
  const discovered = await page(restarted)
  expect(discovered.items).toHaveLength(1)
  expect(discovered.items[0]!.recordRef.logId).toBe(receipt.logId)
  expect(discovered.coverage).toMatchObject({ duplicates: 1, invalid: 1 })
})

it('preserves an unconfirmed reservation when its original publishing process exits', async () => {
  const path = await directory(), moduleUrl = new URL('@agentmux/host/client-incident-archive', import.meta.url).href
  const script = `import {ClientIncidentArchive} from ${JSON.stringify(moduleUrl)};import {durableWriteFile} from ${JSON.stringify(new URL('../../../packages/core/dist/index.js', import.meta.url).href)};const a=new ClientIncidentArchive(process.argv[1],{write:async(p,c,o)=>{if(p.endsWith('.candidate'))process.exit(0);await durableWriteFile(p,c,o)}});await a.flush();console.log(JSON.stringify(a.enqueue(JSON.parse(process.argv[2]),JSON.parse(process.argv[3]))));await a.flush();`
  const child = await promisify(execFile)(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', script, path, JSON.stringify(report()), JSON.stringify(producer())])
  const receipt = JSON.parse(child.stdout), restarted = new ClientIncidentArchive(path)
  await restarted.flush()
  const discovered = await page(restarted)
  expect(discovered.items[0]).toMatchObject({ persistence: 'unconfirmed', recordRef: { logId: receipt.logId } })
  expect(await restarted.read({ domain: 'client.incident', hostId: 'local', logId: receipt.logId }, bounds()))
    .toMatchObject({ availability: 'unavailable', data: null })
  expect((await page(restarted)).coverage.corrupt).toBe(0)
})

it('bounds failed candidate cleanup across restart and resumes only after that exact cleanup succeeds', async () => {
  const path = await directory()
  let failCleanup = true
  const remove: typeof import('node:fs/promises').unlink = async file => {
    if (failCleanup && String(file).endsWith('.candidate')) throw Object.assign(new Error('private cleanup text'), { code: 'EACCES' })
    const { unlink } = await import('node:fs/promises'); return unlink(file)
  }
  const archive = new ClientIncidentArchive(path, { remove }); await archive.flush()
  const first = archive.enqueue(report(), producer()); await archive.flush()
  archive.enqueue(report(), producer()); await archive.flush()
  expect((await page(archive)).coverage).toMatchObject({ retainedCount: 1, dropped: 1, cleanupFailures: 2 })
  expect((await readdir(path)).filter(name => name.endsWith('.candidate'))).toHaveLength(1)
  const restarted = new ClientIncidentArchive(path, { remove }); await restarted.flush()
  expect((await restarted.read({ domain: 'client.incident', hostId: 'local', logId: first.logId! }, bounds())).availability).toBe('found')
  restarted.enqueue(report(), producer()); await restarted.flush()
  expect((await readdir(path)).filter(name => name.endsWith('.candidate'))).toHaveLength(1)
  failCleanup = false
  restarted.enqueue(report(), producer()); await restarted.flush()
  expect((await readdir(path)).filter(name => name.endsWith('.candidate'))).toHaveLength(0)
  expect((await page(restarted)).coverage.retainedCount).toBe(2)
})

it('keeps a page snapshot stable across same-clock appends and equivalent query property orders', async () => {
  const archive = new ClientIncidentArchive(await directory(), { now: () => 100 }); await archive.flush()
  for (let i = 0; i < 5; i++) { archive.enqueue(report(), producer()); await archive.flush() }
  const first = await page(archive, { limit: 2, runId: 'run' })
  const added = archive.enqueue(report(), producer()); await archive.flush()
  const second = await page(archive, { runId: 'run', cursor: first.nextCursor!, limit: 2 })
  const third = await page(archive, { limit: 2, cursor: second.nextCursor!, runId: 'run' })
  const ids = [...first.items, ...second.items, ...third.items].map(item => item.recordRef.logId)
  expect(ids).toHaveLength(5); expect(new Set(ids).size).toBe(5); expect(ids).not.toContain(added.logId)
})
