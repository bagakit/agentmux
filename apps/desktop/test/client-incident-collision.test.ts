import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AgentMuxClientIncidentPage, AgentMuxClientIncidentReport } from '@agentmux/core'

const identity = vi.hoisted(() => ({ forced: '111111111111', mints: 0, raceOriginal: null as string | null }))
vi.mock('@agentmux/core/object-id', async original => ({ ...await original<typeof import('@agentmux/core/object-id')>(),
  mintObjectId: () => { identity.mints++; return identity.forced } }))
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, link: async (...args: Parameters<typeof actual.link>) => {
    if (identity.raceOriginal && String(args[1]).endsWith('.json')) {
      await actual.writeFile(args[1], identity.raceOriginal, { flag: 'wx' }); identity.raceOriginal = null
    }
    return actual.link(...args)
  } }
})
const { ClientIncidentArchive }: typeof import('@agentmux/host/client-incident-archive') = await import(
  process.env.AGENTMUX_TEST_INCIDENT_ARCHIVE_ENTRY ?? new URL('@agentmux/host/client-incident-archive', import.meta.url).href)
const directories: string[] = []
afterEach(async () => { identity.mints = 0; identity.raceOriginal = null; await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const report = (): AgentMuxClientIncidentReport => ({ occurrenceId: randomUUID(), attemptId: 'attempt', relatedOccurrenceId: null,
  hostId: 'local', regionId: null, kind: 'terminal-attach-failed', stage: 'attach-failed', code: 'EIO',
  agentSessionId: 'agent', runId: 'run', observedAt: 1, elapsedMs: 0, metadata: {}, stages: [], references: [] })
const producer = { kind: 'main' as const, appInstanceId: 'application', producerInstanceId: 'producer', windowId: null, documentGeneration: null, buildId: null }
const bounds = () => ({ signal: new AbortController().signal, maxBytes: 256 * 1024 })
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), 'client-incident-collision-')); directories.push(path)
  return { path, archive: new ClientIncidentArchive(path) }
}

it('rejects a queued or retained random ID collision without minting another identity or replacing the original', async () => {
  const { path, archive } = await fixture(), original = report()
  expect(archive.enqueue(original, producer)).toEqual({ accepted: true })
  expect(archive.enqueue(report(), producer)).toEqual({ accepted: false })
  expect(identity.mints).toBe(2)
  await archive.flush()
  const bytes = await readFile(join(path, identity.forced + '.json'), 'utf8')
  expect(archive.enqueue(report(), producer)).toEqual({ accepted: false })
  expect(identity.mints).toBe(3)
  expect(await archive.read({ domain: 'client.incident', hostId: 'local', logId: identity.forced }, bounds()))
    .toMatchObject({ availability: 'found', data: { report: original } })
  expect(await readFile(join(path, identity.forced + '.json'), 'utf8')).toBe(bytes)
})

it.each(['existing', 'publication-race'] as const)('preserves an unindexed original for an %s random ID collision', async mode => {
  const { path, archive } = await fixture(); await archive.flush()
  const original = report(); archive.enqueue(original, producer); await archive.flush()
  const recordPath = join(path, identity.forced + '.json'), bytes = await readFile(recordPath, 'utf8')
  const indexPath = join(path, 'index.json'), index = JSON.parse(await readFile(indexPath, 'utf8'))
  index.entries = []; await writeFile(indexPath, JSON.stringify(index))
  if (mode === 'publication-race') { await rm(recordPath); identity.raceOriginal = bytes }
  const restarted = new ClientIncidentArchive(path); await restarted.flush()
  const other = report(); restarted.enqueue(other, producer); await restarted.flush()
  expect(await readFile(recordPath, 'utf8')).toBe(bytes)
  const exact = await restarted.read({ domain: 'client.incident', hostId: 'local', logId: identity.forced }, bounds())
  expect(JSON.stringify(exact.data)).not.toContain(other.occurrenceId)
  const page = (await restarted.read({ domain: 'client.incident', hostId: 'local', recent: {} }, bounds())).data as AgentMuxClientIncidentPage
  expect(page.items).toHaveLength(0); expect(page.coverage.dropped).toBeGreaterThan(0)
  const afterRestart = new ClientIncidentArchive(path); await afterRestart.flush()
  expect((await afterRestart.read({ domain: 'client.incident', hostId: 'local', recent: {} }, bounds())).data)
    .toMatchObject({ coverage: { startup: 'ready' } })
})
