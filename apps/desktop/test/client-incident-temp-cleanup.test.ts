// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AgentMuxClientIncidentPage, AgentMuxClientIncidentReport } from '@agentmux/core'

const failure = vi.hoisted(() => ({ enabled: false, cleanupFails: true, stage: 'candidate' as 'candidate' | 'index', creates: 0 }))
const owned = (path: unknown) => typeof path === 'string' && path.endsWith('.tmp') &&
  (failure.stage === 'candidate' ? path.includes('.candidate.') : path.includes('index.json.'))
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  const fails = (path: unknown) => failure.enabled && owned(path)
  return { ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      if (String(args[1]) === 'wx' && owned(args[0])) failure.creates++
      return actual.open(...args)
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (fails(args[0])) throw Object.assign(new Error('Original diagnostic publication failed.'), { code: 'EIO' })
      return actual.rename(...args)
    },
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      if (failure.cleanupFails && fails(args[0])) throw Object.assign(new Error('Original diagnostic temporary cleanup failed.'), { code: 'EACCES' })
      return actual.unlink(...args)
    }
  }
})
// Use the actual durable-write owner under controlled filesystem failures. Its failure type and
// getter are the same source compiled into the package; no hand-made cleanup receipt drives this test.
vi.mock('@agentmux/core', async original => {
  const actual = await original<typeof import('@agentmux/core')>()
  const source = await import('../../../packages/core/src/durable-write')
  return { ...actual, durableWriteFile: source.durableWriteFile, DurableWriteError: source.DurableWriteError }
})
import { durableWriteFile, DurableWriteError } from '../../../packages/core/src/durable-write'
const { ClientIncidentArchive }: typeof import('@agentmux/host/client-incident-archive') = process.env.AGENTMUX_TEST_INCIDENT_ARCHIVE_ENTRY
  ? await import(process.env.AGENTMUX_TEST_INCIDENT_ARCHIVE_ENTRY)
  : await import('@agentmux/host/client-incident-archive')

const directories: string[] = []
afterEach(async () => { failure.enabled = false; failure.cleanupFails = true; failure.creates = 0; await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const report = (): AgentMuxClientIncidentReport => ({ occurrenceId: randomUUID(), attemptId: 'attempt', relatedOccurrenceId: null,
  hostId: 'local', regionId: null, kind: 'terminal-attach-failed', stage: 'attach-failed', code: 'EIO',
  agentSessionId: 'agent', runId: 'run', observedAt: 1, elapsedMs: 0, metadata: {}, stages: [], references: [] })
const producer = { kind: 'main' as const, appInstanceId: 'application', producerInstanceId: 'producer', windowId: null, documentGeneration: null, buildId: null }
const bounds = () => ({ signal: new AbortController().signal, maxBytes: 256 * 1024 })

it('recovers original UUID temporary names while preserving files outside the durable writer format', async () => {
  const path = await mkdtemp(join(tmpdir(), 'client-incident-cleanup-')); directories.push(path)
  const legacy = '00000000-0000-4000-8000-000000000000'
  const owned = [`index.json.123.${legacy}.tmp`, `111111111111.candidate.123.${legacy}.tmp`]
  const foreign = ['index.json.123.000000000000.tmp', 'foreign.123.111111111111.tmp', 'index.json.123.unknown.tmp']
  for (const name of [...owned, ...foreign]) await writeFile(join(path, name), 'retained')
  const archive = new ClientIncidentArchive(path); await archive.flush()
  expect((await readdir(path)).sort()).toEqual(foreign.sort())
})

it.each(['candidate', 'index'] as const)('bounds original helper temporary-file cleanup failure at the %s write across restart', async stage => {
  failure.stage = stage
  const path = await mkdtemp(join(tmpdir(), 'client-incident-cleanup-')); directories.push(path)
  const failures: DurableWriteError[] = []
  const archive = new ClientIncidentArchive(path, { write: async (...args) => {
    try { return await durableWriteFile(...args) }
    catch (error) { failures.push(error as DurableWriteError); throw error }
  } })
  await archive.flush()
  const original = archive.enqueue(report(), producer); await archive.flush()
  expect(original.accepted).toBe(true)
  expect(await archive.read({ domain: 'client.incident', hostId: 'local', logId: original.logId! }, bounds())).toMatchObject({ availability: 'found' })
  failure.enabled = true
  archive.enqueue(report(), producer); await archive.flush()
  expect(failures.at(-1)).toBeInstanceOf(DurableWriteError)
  expect(failures.at(-1)).toMatchObject({ phase: 'before-replace', cleanupIncomplete: true })
  const creates = failure.creates
  for (let i = 0; i < 20; i++) { archive.enqueue(report(), producer); await archive.flush() }
  expect(failure.creates).toBe(creates)
  expect((await readdir(path)).filter(name => name.endsWith('.tmp'))).toHaveLength(1)
  expect(await archive.read({ domain: 'client.incident', hostId: 'local', logId: original.logId! }, bounds())).toMatchObject({ availability: 'found' })
  const restarted = new ClientIncidentArchive(path); await restarted.flush()
  const page = (await restarted.read({ domain: 'client.incident', hostId: 'local', recent: {} }, bounds())).data as AgentMuxClientIncidentPage
  expect(page.coverage).toMatchObject({ startup: 'ready', cleanupFailures: expect.any(Number) })
  expect(page.coverage.cleanupFailures).toBeGreaterThan(0)
  restarted.enqueue(report(), producer); await restarted.flush()
  expect(failure.creates).toBe(creates)
  expect((await readdir(path)).filter(name => name.endsWith('.tmp'))).toHaveLength(1)
  expect(await restarted.read({ domain: 'client.incident', hostId: 'local', logId: original.logId! }, bounds())).toMatchObject({ availability: 'found' })
  failure.enabled = false
  const recovered = new ClientIncidentArchive(path); await recovered.flush()
  expect((await readdir(path)).filter(name => name.endsWith('.tmp'))).toHaveLength(0)
  const accepted = recovered.enqueue(report(), producer); await recovered.flush()
  expect(await recovered.read({ domain: 'client.incident', hostId: 'local', logId: accepted.logId! }, bounds())).toMatchObject({ availability: 'found', persistence: 'confirmed' })
})


it('continues diagnostic publication after the original helper confirms temporary cleanup', async () => {
  failure.stage = 'candidate'; failure.cleanupFails = false
  const path = await mkdtemp(join(tmpdir(), 'client-incident-cleanup-')); directories.push(path)
  const failures: DurableWriteError[] = []
  const archive = new ClientIncidentArchive(path, { write: async (...args) => {
    try { return await durableWriteFile(...args) }
    catch (error) { failures.push(error as DurableWriteError); throw error }
  } })
  await archive.flush(); failure.enabled = true
  archive.enqueue(report(), producer); await archive.flush()
  expect(failures.at(-1)).toMatchObject({ phase: 'before-replace', cleanupIncomplete: false })
  expect((await readdir(path)).filter(name => name.endsWith('.tmp'))).toHaveLength(0)
  failure.enabled = false
  const next = archive.enqueue(report(), producer); await archive.flush()
  expect(await archive.read({ domain: 'client.incident', hostId: 'local', logId: next.logId! }, bounds()))
    .toMatchObject({ availability: 'found', persistence: 'confirmed' })
})
