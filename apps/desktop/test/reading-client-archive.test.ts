import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { durableWriteFile } from '@agentmux/core'
import { mintObjectId } from '@agentmux/core/object-id'
import { parseClientIncidentReport, type AgentMuxClientIncidentReport, type AgentMuxClientIncidentPage } from '@agentmux/core/client-incident'
import { parseReadingDiagnosticRecord, type ReadingDiagnosticRecord } from '@agentmux/core/reading-diagnostic'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc'
import { parseDiagnosticEvidenceResult } from '../../../packages/core/src/diagnostic-evidence-codec'
import { ClientIncidentArchive, CLIENT_INCIDENT_LIMITS } from '@agentmux/host/client-incident-archive'
import { readingClientIncident } from '../src/renderer/src/lib/reading-client-incident'

const paths: string[] = [], services: AgentMuxRpcService[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(services.splice(0).map(service => service.dispose()))
  await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
async function archive() {
  const path = await mkdtemp(join(tmpdir(), 'reading-incidents-')); paths.push(path)
  const owner = new ClientIncidentArchive(path); await owner.flush(); return owner
}
const producer = (id = 'original-producer') => ({ kind: 'renderer' as const, appInstanceId: 'original-app',
  producerInstanceId: id, windowId: 'original-window', documentGeneration: 'original-document', buildId: null })
const bounds = () => ({ signal: new AbortController().signal, maxBytes: 128 * 1024 })
function record(trigger: ReadingDiagnosticRecord['trigger'] = 'progress'): ReadingDiagnosticRecord {
  return { version: 'reading-diagnostic.v1', logId: mintObjectId(), previousLogId: null,
    scope: { hostId: 'execution-host', agentSessionId: 'original-session', runId: 'original-run', sourceHostId: null,
      owner: 'renderer', ownerInstanceId: 'original-clock', producerBuildId: null, consumerId: 'original-consumer', consumerKind: 'conversation-pane' },
    trigger, startedAt: 1, endedAt: null,
    events: [{ sequence: 1, wallMs: 1, monoMs: 1, phase: 'read-started', attemptId: 'original-attempt' }],
    coverage: { firstSequence: 1, lastSequence: 1, overwritten: 0, rejected: 0, publicationFailures: 0 } }
}
function terminal(): AgentMuxClientIncidentReport {
  return { occurrenceId: mintObjectId(), attemptId: 'terminal-attempt', relatedOccurrenceId: null, hostId: 'execution-host',
    regionId: null, kind: 'terminal-attach-failed', stage: 'attach-failed', code: 'EIO', agentSessionId: 'terminal-session',
    runId: 'terminal-run', observedAt: 1, elapsedMs: 1, metadata: {}, stages: [], references: [] }
}

describe('reading evidence in the sole client incident archive', () => {
  it('detaches the accepted report before the caller can mutate queued metadata', async () => {
    const owner = await archive(), report = readingClientIncident(record('held'), 0)
    const original = structuredClone(report)
    const receipt = owner.enqueue(report, producer())
    expect(receipt.accepted).toBe(true)
    report.agentSessionId = 'changed-after-admission'
    report.reading.scope.agentSessionId = 'changed-after-admission'
    report.reading.coverage.rejected = 1
    await owner.flush()
    expect(await owner.read({ domain: 'client.incident', hostId: 'local', logId: receipt.logId! }, bounds()))
      .toMatchObject({ availability: 'found', persistence: 'confirmed', data: { report: original } })
  })

  it('preserves the original ID and rejects a conflicting producer without overwriting the original', async () => {
    const owner = await archive(), original = record('held'), report = readingClientIncident(original, 0)
    expect(owner.enqueue(report, producer())).toEqual({ accepted: true, logId: original.logId })
    await owner.flush()
    expect(owner.enqueue(report, producer())).toEqual({ accepted: true, logId: original.logId })
    expect(owner.enqueue(report, producer('other-producer'))).toEqual({ accepted: false })
    const exact = await owner.read({ domain: 'client.incident', hostId: 'local', logId: original.logId }, bounds())
    expect(exact).toMatchObject({ availability: 'found', persistence: 'confirmed',
      recordRef: { logId: original.logId }, data: { report: { reading: original }, producer: producer() } })
    const restarted = new ClientIncidentArchive(owner.directory); await restarted.flush()
    expect(await restarted.read({ domain: 'client.incident', hostId: 'local', logId: original.logId,
      authority: { kind: exact.recordRef!.authority!.kind, id: exact.recordRef!.authority!.id } }, bounds()))
      .toMatchObject({ availability: 'found', persistence: 'observed', data: exact.data })
  })

  it('discovers and reads original metadata through the real public service after its producer disappears', async () => {
    const owner = await archive(), original = record('held')
    owner.enqueue(readingClientIncident(original, 0), producer()); await owner.flush()
    const service = new AgentMuxRpcService({ clientIncidents: () => owner, coreClients: () => [] }); services.push(service)
    const query = { target: { domain: 'client.incident' as const, hostId: 'local', recent: { kind: 'conversation-reading-held' as const } } }
    const found = parseDiagnosticEvidenceResult(await service.call('system.diagnostics.inspect', query), query)
    const page = found.reads[0]!.data as AgentMuxClientIncidentPage
    expect(page.items).toHaveLength(1)
    const reference = page.items[0]!.recordRef
    const target = { domain: 'client.incident' as const, hostId: reference.routeHostId!, logId: reference.logId,
      authority: { kind: reference.authority!.kind, id: reference.authority!.id } }
    expect(parseDiagnosticEvidenceResult(await service.call('system.diagnostics.inspect', { target }), { target }).reads[0])
      .toMatchObject({ availability: 'found', data: { report: { reading: original } } })
  })

  it('reopens original reading evidence in a real process and consumes the same archive through the compiled CLI', async () => {
    const owner = await archive(), original = record('held')
    owner.enqueue(readingClientIncident(original, 0), producer()); await owner.flush()
    const before = await owner.read({ domain: 'client.incident', hostId: 'local', logId: original.logId }, bounds())
    const entry = process.env.AGENTMUX_TEST_READING_ARCHIVE_ENTRY ?? new URL('../../host/src/client-incident-archive.ts', import.meta.url).href
    const script = `import {ClientIncidentArchive} from ${JSON.stringify(entry)};
      const owner=new ClientIncidentArchive(process.argv[1]); await owner.flush();
      const bounds={signal:new AbortController().signal,maxBytes:131072};
      const page=await owner.read({domain:'client.incident',hostId:'local',recent:{kind:'conversation-reading-held'}},bounds);
      const exact=await owner.read({domain:'client.incident',hostId:'local',logId:process.argv[2]},bounds);
      console.log(JSON.stringify({page,exact}));`
    const child = await promisify(execFile)(process.execPath,
      ['--experimental-transform-types', '--input-type=module', '-e', script, owner.directory, original.logId],
      { env: objectCliEnvironment(owner.directory), timeout: 15_000 })
    const reopened = JSON.parse(child.stdout)
    expect(reopened.exact).toMatchObject({ availability: 'found', persistence: 'observed', authorityStatus: 'verified',
      recordRef: before.recordRef, data: before.data })
    expect(reopened.page.data.coverage).toMatchObject({ startup: 'ready', pendingWrites: 0, retainedCount: 1 })
    expect(reopened.page.data.items[0].recordRef).toEqual(before.recordRef)

    const reader = new ClientIncidentArchive(owner.directory); await reader.flush()
    const socketPath = join(owner.directory, 'query.sock')
    const server = new AgentMuxControlServer({ socketPath, coreClients: () => [], clientIncidents: () => reader })
    await server.start()
    try {
      const prefix = ['--endpoint', `unix://${socketPath}`, 'system', 'diagnostics', 'inspect']
      const env = objectCliEnvironment(owner.directory)
      const recent = await runCompiledObjectCli([...prefix, '--domain', 'client.incident', '--host-id', 'local', '--recent',
        '--kind', 'conversation-reading-held', '--limit', '1'], env)
      expect(recent.code, recent.stderr).toBe(0)
      const summary = JSON.parse(recent.stdout).result.reads[0].data.items[0]
      expect(summary.recordRef).toEqual(before.recordRef)
      const exact = await runCompiledObjectCli([...prefix, '--domain', 'client.incident', '--host-id', 'local',
        '--logid', summary.recordRef.logId, '--authority', summary.recordRef.authority.id], env)
      expect(exact.code, exact.stderr).toBe(0)
      expect(JSON.parse(exact.stdout).result.reads[0]).toMatchObject({ availability: 'found', persistence: 'observed',
        authorityStatus: 'verified', data: { report: { reading: original }, producer: producer() } })
    } finally { await server.stop() }
  })

  it('reclaims queued progress for critical evidence without releasing or replacing the actual blocked writer', async () => {
    let entered!: () => void, release!: () => void, active = 0, peak = 0, writes = 0
    const started = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const path = await mkdtemp(join(tmpdir(), 'reading-priority-')); paths.push(path)
    const owner = new ClientIncidentArchive(path, { write: async (file, content, options) => {
      if (file.endsWith('.candidate')) { writes++; active++; peak = Math.max(peak, active); entered(); await gate; active-- }
      return durableWriteFile(file, content, options)
    } })
    await owner.flush()
    const first = record()
    owner.enqueue(readingClientIncident(first, 0), producer()); await started
    for (let index = 0; index < CLIENT_INCIDENT_LIMITS.readingProducerQueue - 1; index++) {
      const independent = record(); independent.scope.consumerId = `consumer-${index}`
      expect(owner.enqueue(readingClientIncident(independent, 0), producer()).accepted).toBe(true)
    }
    const localFailure = record('failure')
    expect(owner.enqueue(readingClientIncident(localFailure, 0), producer()).accepted).toBe(true)
    expect(owner.enqueue(readingClientIncident(first, 0), producer())).toEqual({ accepted: true, logId: first.logId })
    for (let group = 0; group < 3; group++) for (let index = 0; index < 8; index++) {
      expect(owner.enqueue(terminal(), producer(`other-${group}`)).accepted).toBe(true)
    }
    for (let index = 0; index < 4; index++) expect(owner.enqueue(terminal(), producer('extra')).accepted).toBe(true)
    const independentFailure = record('failure')
    expect(owner.enqueue(readingClientIncident(independentFailure, 0), producer('independent')).accepted).toBe(true)
    expect(owner.enqueue(readingClientIncident(first, 0), producer('collision'))).toEqual({ accepted: false })
    const during = (await owner.read({ domain: 'client.incident', hostId: 'local', recent: {} }, bounds())).data as AgentMuxClientIncidentPage
    expect(during.coverage).toMatchObject({ pendingWrites: CLIENT_INCIDENT_LIMITS.queue, dropped: 3 })
    expect(writes).toBe(1); expect(active).toBe(1); expect(peak).toBe(1)
    release(); await owner.flush()
    for (const retained of [first, localFailure, independentFailure]) {
      expect(await owner.read({ domain: 'client.incident', hostId: 'local', logId: retained.logId }, bounds()))
        .toMatchObject({ availability: 'found', persistence: 'confirmed', data: { report: { reading: retained } } })
    }
    expect(writes).toBe(CLIENT_INCIDENT_LIMITS.queue); expect(peak).toBe(1)
  })

  it('bounds healthy progress without immediately evicting an unrelated Terminal fault', async () => {
    const owner = await archive(), failure = owner.enqueue(terminal(), producer('terminal'))
    await owner.flush()
    let latest = ''
    for (let index = 0; index < 64; index++) {
      const original = record(); latest = original.logId
      owner.enqueue(readingClientIncident(original, 0), producer()); await owner.flush()
    }
    const page = (await owner.read({ domain: 'client.incident', hostId: 'local', recent: { limit: 32 } }, bounds())).data as AgentMuxClientIncidentPage
    expect(page.items.filter(item => item.kind === 'conversation-reading-progress')).toHaveLength(CLIENT_INCIDENT_LIMITS.readingProgressRecords)
    expect(page.items.some(item => item.recordRef.logId === failure.logId)).toBe(true)
    expect(page.items.some(item => item.recordRef.logId === latest)).toBe(true)
    expect(page.coverage.evicted).toBe(64 - CLIENT_INCIDENT_LIMITS.readingProgressRecords)
    expect((await readdir(owner.directory)).filter(name => name.endsWith('.json'))).toHaveLength(page.coverage.retainedCount + 1)
  }, 30_000)

  it('keeps the first pending checkpoint and latest tail for one lifetime while its real writer is blocked', async () => {
    let entered!: () => void, release!: () => void, writes = 0
    const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const path = await mkdtemp(join(tmpdir(), 'reading-tail-')); paths.push(path)
    const owner = new ClientIncidentArchive(path, { write: async (file, content, options) => {
      if (file.endsWith('.candidate')) { writes++; entered(); await gate }
      return durableWriteFile(file, content, options)
    } })
    await owner.flush()
    const first = record(), pending = record(), tail: ReadingDiagnosticRecord[] = []
    owner.enqueue(readingClientIncident(first, 0), producer()); await started
    try {
      owner.enqueue(readingClientIncident(pending, 0), producer())
      for (let index = 0; index < 18; index++) {
        const next = record(); tail.push(next)
        expect(owner.enqueue(readingClientIncident(next, 0), producer()).accepted).toBe(true)
      }
      expect(owner.enqueue(readingClientIncident(first, 0), producer())).toEqual({ accepted: true, logId: first.logId })
      expect(owner.enqueue(readingClientIncident(pending, 0), producer())).toEqual({ accepted: true, logId: pending.logId })
      const during = (await owner.read({ domain: 'client.incident', hostId: 'local', recent: {} }, bounds())).data as AgentMuxClientIncidentPage
      expect(during.coverage).toMatchObject({ pendingWrites: 3, dropped: 17 })
      expect(writes).toBe(1)
    } finally { release(); await owner.flush() }
    for (const retained of [first, pending, tail.at(-1)!]) {
      expect(await owner.read({ domain: 'client.incident', hostId: 'local', logId: retained.logId }, bounds()))
        .toMatchObject({ availability: 'found', persistence: 'confirmed', data: { report: { reading: retained } } })
    }
    expect(writes).toBe(3)
  })

  it('does not evict a full archive of faults to admit low-priority reading progress', async () => {
    const owner = await archive()
    let first = ''
    for (let index = 0; index < CLIENT_INCIDENT_LIMITS.records; index++) {
      const receipt = owner.enqueue(terminal(), producer('terminal')); first ||= receipt.logId!
      await owner.flush()
    }
    owner.enqueue(readingClientIncident(record(), 0), producer()); await owner.flush()
    expect(await owner.read({ domain: 'client.incident', hostId: 'local', logId: first }, bounds())).toMatchObject({ availability: 'found' })
    const page = (await owner.read({ domain: 'client.incident', hostId: 'local', recent: {} }, bounds())).data as AgentMuxClientIncidentPage
    expect(page.coverage).toMatchObject({ retainedCount: CLIENT_INCIDENT_LIMITS.records, evicted: 0, dropped: 1 })
  }, 30_000)

  it('accepts a near-limit Unicode record in a detached browser-safe common envelope', () => {
    const original = record()
    for (let sequence = 2; sequence <= 64; sequence++) {
      const events = [...original.events, { sequence, wallMs: 1, monoMs: sequence, phase: 'read-page' as const, attemptId: '\u754c'.repeat(160) }]
      const candidate = { ...original, events, coverage: { ...original.coverage, lastSequence: sequence } }
      if (new TextEncoder().encode(JSON.stringify(candidate)).byteLength > 32 * 1024) break
      Object.assign(original, candidate)
    }
    expect(new TextEncoder().encode(JSON.stringify(original)).byteLength).toBeGreaterThan(31 * 1024)
    const report = Object.freeze(readingClientIncident(parseReadingDiagnosticRecord(original), 0))
    let called = 0
    Object.defineProperty(report.stages, 'toJSON', { value() { called++; throw new Error('untrusted serializer') } })
    Object.defineProperty(report.references, Symbol.iterator, { value() { called++; throw new Error('untrusted iterator') } })
    vi.stubGlobal('Buffer', undefined)
    const parsed = parseClientIncidentReport(report)
    expect(parsed.reading).toEqual(original)
    expect(parsed).not.toBe(report)
    expect(called).toBe(0)
  })
})
