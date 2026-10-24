// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { afterEach, expect, it } from 'vitest'
import type { AgentMuxClientIncidentPage, AgentMuxClientIncidentRecord, AgentMuxClientIncidentReport } from '@agentmux/core'
const { ClientIncidentArchive }: typeof import('@agentmux/host/client-incident-archive') = await import(
  process.env.AGENTMUX_TEST_INCIDENT_ARCHIVE_ENTRY ?? new URL('../../host/src/client-incident-archive.ts', import.meta.url).href)
const { ClientIncidentIpcOwner }: typeof import('../src/main/client-incident-ipc') = await import(
  process.env.AGENTMUX_TEST_INCIDENT_IPC_ENTRY ?? new URL('../src/main/client-incident-ipc.ts', import.meta.url).href)

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const report = (): AgentMuxClientIncidentReport => ({ occurrenceId: 'original-occurrence', attemptId: 'original-attempt', relatedOccurrenceId: null,
  hostId: 'original-execution-host', regionId: 'original-region', kind: 'terminal-attach-failed', stage: 'attach-failed', code: 'EIO',
  agentSessionId: 'original-session', runId: 'original-run', observedAt: 1, elapsedMs: 0,
  metadata: {}, stages: [], references: [] })
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), 'client-incident-ipc-')); directories.push(path)
  const archive = new ClientIncidentArchive(path), frame = {}, contents = { mainFrame: frame, isDestroyed: () => false } as unknown as WebContents
  await archive.flush()
  let generation: number | null = 1
  const owner = new ClientIncidentIpcOwner({ archive, contents, windowId: 7, generation: () => generation, buildId: () => 'loaded-main-build', rendererBuildId: () => 'loaded-renderer-build' })
  const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent
  return { owner, archive, contents, event, navigate: () => { generation = (generation ?? 0) + 1 }, unavailable: () => { generation = null } }
}
const bounds = () => ({ signal: new AbortController().signal, maxBytes: 256 * 1024 })

it('stamps the actual trusted Main and document producer, independently from the execution Host', async () => {
  const { owner, archive, event } = await fixture()
  const opened = owner.open(event)!
  expect(owner.open(event)).toEqual(opened)
  const receipt = owner.report(event, opened.token, report())
  expect(receipt.accepted).toBe(true)
  await archive.flush()
  const exact = await archive.read({ domain: 'client.incident', hostId: 'local', logId: receipt.logId! }, bounds())
  const record = exact.data as AgentMuxClientIncidentRecord
  expect(record.producer).toMatchObject({ kind: 'renderer', appInstanceId: archive.appInstanceId, windowId: '7', documentGeneration: '1', buildId: 'loaded-renderer-build' })
  expect(record.report.hostId).toBe('original-execution-host')
  expect(record.receivedAt).toBeGreaterThan(record.report.observedAt)
  expect(record.authority.id).not.toBe(archive.appInstanceId)
  expect(record.producer.producerInstanceId).not.toBe(opened.token)
})

it('rejects a different sender, embedded frame, unknown generation and stale producer token', async () => {
  const { owner, archive, event, contents, navigate, unavailable } = await fixture(), opened = owner.open(event)!
  const foreign = { ...event, sender: {} } as IpcMainInvokeEvent
  const embedded = { ...event, senderFrame: {} } as IpcMainInvokeEvent
  expect(owner.open(foreign)).toBeNull(); expect(owner.open(embedded)).toBeNull()
  expect(owner.report(embedded, opened.token, report())).toEqual({ accepted: false })
  navigate()
  expect(owner.report(event, opened.token, report())).toEqual({ accepted: false })
  const current = owner.open(event)!
  expect(current.token).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
  expect(archive.appInstanceId).toMatch(/^[1-9A-HJ-NP-Za-km-z]{12}$/)
  expect(current.token).not.toBe(opened.token)
  expect(owner.report(event, current.token, report()).accepted).toBe(true)
  unavailable()
  expect(owner.open(event)).toBeNull()
  expect(owner.report(event, current.token, report())).toEqual({ accepted: false })
  await archive.flush()
  const page = (await archive.read({ domain: 'client.incident', hostId: 'local', recent: {} }, bounds())).data as AgentMuxClientIncidentPage
  expect(page.items).toHaveLength(1)
  expect(contents.mainFrame).toBe(event.senderFrame)
})

it('refuses payload authority, free error text and arbitrary machine codes without storing them', async () => {
  const { owner, archive, event } = await fixture(), token = owner.open(event)!.token
  for (const unsafe of [
    { ...report(), producer: { kind: 'main' } },
    { ...report(), authority: { kind: 'core-runtime', id: 'claimed-runtime' } },
    { ...report(), message: 'private-terminal-output' },
    { ...report(), code: 'PRIVATE_TERMINAL_TEXT' },
    { ...report(), metadata: { cwd: 'private-directory' } }
  ]) expect(owner.report(event, token, unsafe)).toEqual({ accepted: false })
  await archive.flush()
  const page = (await archive.read({ domain: 'client.incident', hostId: 'local', recent: {} }, bounds())).data as AgentMuxClientIncidentPage
  expect(page.items).toEqual([]); expect(page.coverage.invalid).toBe(5)
})

it('uses the same archive for an original Main probe without claiming a Renderer document', async () => {
  const { owner, archive } = await fixture()
  const receipt = archive.enqueue({ ...report(), kind: 'capability-probe-failed', stage: 'probe-failed' }, owner.mainProducer())
  await archive.flush()
  const exact = await archive.read({ domain: 'client.incident', hostId: 'local', logId: receipt.logId! }, bounds())
  expect(exact).toMatchObject({ availability: 'found', data: { producer: { kind: 'main', windowId: null, documentGeneration: null },
    report: { kind: 'capability-probe-failed', stage: 'probe-failed' } } })
})
