import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { ClientDeliveryDiagnostics, deliveryLogNotice, startDeliveryAttempt } from '../src/lib/delivery-diagnostics'
import type { DeliveryAttempt, DeliveryAttemptLookup } from '@agentmux/core/delivery-attempt'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DeliveryAttemptStore } from '../../core/src/delivery-attempt-store'
import { AgentMuxControlServer } from '../../core/src/public-rpc-server'
import { connectAgentMuxRpc } from '../../core/src/public-rpc-client'

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear() })
const seed = () => startDeliveryAttempt({ agentSessionId: 'original-session', operationId: 'original-operation', hostId: 'local' })
const failure = () => Object.assign(new Error('original submission refusal'), { code: 'ORIGINAL_REFUSAL',
  detail: 'original transport stage', cause: new Error('original source unavailable'),
  controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const result = (record: DeliveryAttempt, issue: string | null = null): DeliveryAttemptLookup => ({
  logId: record.logId, availability: 'found', record: structuredClone(record), persistence: 'confirmed', issue })
const within = async <T,>(promise: Promise<T>, milliseconds: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<'still-pending'>(resolve => { timer = setTimeout(() => resolve('still-pending'), milliseconds) })]) }
  finally { clearTimeout(timer) }
}

it('publishes the original immutable failure without waiting for optional digest completion', async () => {
  const digest = deferred<ArrayBuffer>(), nativeCrypto = globalThis.crypto
  vi.stubGlobal('crypto', { getRandomValues: nativeCrypto.getRandomValues.bind(nativeCrypto), randomUUID: nativeCrypto.randomUUID.bind(nativeCrypto), subtle: { digest: () => digest.promise } })
  const journal = new ClientDeliveryDiagnostics(), click = startDeliveryAttempt({ agentSessionId: 'original-session', operationId: 'original-operation', hostId: 'local', prompt: 'original body' })
  const failed = journal.failed(click, failure(), 'core-submit', 'original-owner')
  try {
    const log = await within(failed, 50)
    expect(log, 'optional digest must not retain the original send failure').not.toBe('still-pending')
    if (log === 'still-pending') return
    expect(log.record).toMatchObject({ logId: click.logId, promptDigest: null, stage: 'core-submit', error: {
      message: 'original submission refusal', code: 'ORIGINAL_REFUSAL', cause: { message: 'original source unavailable' } } })
    digest.resolve(new ArrayBuffer(32)); await digest.promise; await Promise.resolve()
    expect(journal.get(click.logId)?.record).toEqual(log.record)
  } finally { digest.resolve(new ArrayBuffer(32)); await failed }
})

it('isolates a throwing observer and still notifies the remaining actual subscriber', async () => {
  const journal = new ClientDeliveryDiagnostics(), notified = vi.fn(), click = seed()
  journal.subscribe(() => { throw new Error('diagnostic subscriber failed') })
  journal.subscribe(notified)
  const published = journal.failed(click, failure(), 'core-submit', 'original-owner')
  await expect(published).resolves.toMatchObject({ record: { logId: click.logId } })
  const log = await published
  expect(log).toMatchObject({ record: { logId: click.logId, error: { code: 'ORIGINAL_REFUSAL' } } })
  expect(deliveryLogNotice(log)).toContain('diagnostic subscriber failed')
  expect(notified).toHaveBeenCalledOnce()
})

it('keeps the first same-click cause even for concurrent failures and a later diagnostic exception', async () => {
  const journal = new ClientDeliveryDiagnostics(), click = seed()
  const [first, next] = await Promise.all([journal.failed(click, failure(), 'core-submit', 'original-owner'),
    journal.failed(click, new Error('secondary diagnostic failure'), 'wrong-stage', 'different-owner')])
  expect(next).toEqual(first)
  expect(await journal.failed(click, new Error('later listener error'), 'wrong-stage', null)).toEqual(first)
  expect(journal.get(click.logId)?.record.error.message).toBe('original submission refusal')
})

it('retains concrete independent local persistence failure and retries saving after recovery', async () => {
  let unavailable = true
  const backing = new Map<string, string>()
  const storage = { getItem: (key: string) => backing.get(key) ?? null, key: (index: number) => [...backing.keys()][index] ?? null,
    get length() { return backing.size }, setItem: (key: string, value: string) => {
      if (unavailable) throw Object.assign(new Error('diagnostic disk is full'), { code: 'ENOSPC' })
      backing.set(key, value)
    } }
  const journal = new ClientDeliveryDiagnostics(() => storage), click = seed()
  const first = await journal.failed(click, failure(), 'core-submit', 'original-owner')
  expect(first.localSaved).toBe(false)
  expect(deliveryLogNotice(first)).toContain('ENOSPC')
  expect(deliveryLogNotice(first)).toContain('diagnostic disk is full')
  expect(first.record.error.code).toBe('ORIGINAL_REFUSAL')
  unavailable = false
  await journal.sync('original-owner', async record => result(record))
  expect(journal.get(click.logId)?.localSaved).toBe(true)
  expect(journal.get(click.logId)?.record).toEqual(first.record)
  expect(new ClientDeliveryDiagnostics(() => storage).get(click.logId)?.record).toEqual(first.record)
})

it('bounds an unreturned report, permits the next immutable report and ignores its late predecessor result', async () => {
  const journal = new ClientDeliveryDiagnostics(), click = seed(), gate = deferred<DeliveryAttemptLookup>()
  const first = await journal.failed(click, failure(), 'core-submit', 'original-owner')
  const reports = vi.fn().mockReturnValueOnce(gate.promise).mockImplementation(async (record: DeliveryAttempt) => result(record, 'new confirmed response'))
  const pending = journal.sync('original-owner', reports)
  try {
    expect(await within(pending, 750), 'diagnostic upload must release its own reporting owner').not.toBe('still-pending')
    expect(journal.get(click.logId)?.reportIssue).toContain('pending')
    await journal.sync('original-owner', reports)
    expect(reports).toHaveBeenCalledTimes(2)
    expect(reports.mock.calls.map(call => call[0])).toEqual([first.record, first.record])
    gate.resolve(result(first.record, 'late obsolete response')); await gate.promise; await Promise.resolve()
    expect(journal.get(click.logId)?.remote?.issue).toBe('new confirmed response')
  } finally { gate.resolve(result(first.record)); await pending }
})

it('retries local saving even if the original Host already confirmed the immutable record', async () => {
  let unavailable = true
  const storage = { getItem: () => null, key: () => null, length: 0, setItem: () => { if (unavailable) throw new Error('read-only storage') } }
  const journal = new ClientDeliveryDiagnostics(() => storage), click = seed(), reports = vi.fn(async (record: DeliveryAttempt) => result(record))
  await journal.failed(click, failure(), 'core-submit', 'original-owner')
  await journal.sync('original-owner', reports)
  expect(journal.get(click.logId)?.localSaved).toBe(false)
  unavailable = false
  await journal.sync('original-owner', reports)
  expect(journal.get(click.logId)?.localSaved).toBe(true)
  expect(reports).toHaveBeenCalledOnce()
})

it('reports the original client record through the actual SDK Unix RPC owner and inspects the same immutable ID', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-client-diagnostic-')), endpoint = join(root, 'owner.sock')
  const store = new DeliveryAttemptStore(join(root, 'logs'))
  const server = new AgentMuxControlServer({ socketPath: endpoint, coreClients: () => [],
    deliveryAttempts: { hostId: 'original-host', store }, execute: async () => { throw new Error('No Input operation is permitted in this diagnostic test.') } })
  let rpc: Awaited<ReturnType<typeof connectAgentMuxRpc>> | undefined
  try {
    await server.start()
    rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: endpoint } })
    const journal = new ClientDeliveryDiagnostics(), click = seed()
    const first = await journal.failed(click, failure(), 'core-submit', 'original-owner')
    const report = (record: DeliveryAttempt) => rpc!.call('message.delivery.report', { hostId: 'original-host', record })
    await journal.sync('original-owner', report)
    expect(journal.get(click.logId)?.remote).toMatchObject({ availability: 'found', persistence: 'confirmed',
      record: { ...first.record, reporter: { kind: 'user', routeHostId: 'original-host' } } })
    const inspected = await rpc.call('message.delivery.inspect', { hostId: 'original-host', logId: click.logId })
    expect(inspected.record).toEqual(journal.get(click.logId)?.remote?.record)
    const duplicate = await rpc.call('message.delivery.report', { hostId: 'original-host', record: first.record })
    expect(duplicate.record).toEqual(inspected.record)
    expect(journal.get(click.logId)?.record).toEqual(first.record)
    const denied = await rpc.call('message.delivery.inspect', { hostId: 'other-host', logId: click.logId })
    expect(denied).toMatchObject({ availability: 'unavailable', record: null })
    if (process.env.AGENTMUX_T046_PUBLIC_EVIDENCE) await writeFile(process.env.AGENTMUX_T046_PUBLIC_EVIDENCE,
      JSON.stringify({ endpoint, record: first.record, reported: journal.get(click.logId)?.remote, inspected, duplicate, denied,
        actualUnixRpc: true, actualCoreJournal: true, inputOperations: 0 }, null, 2))
  } finally {
    await rpc?.dispose(); await server.stop(); await rm(root, { recursive: true, force: true })
  }
})
