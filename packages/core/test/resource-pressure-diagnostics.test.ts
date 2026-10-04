import { fixturePath } from './helpers/fixture-values.js'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeliveryAttemptStore } from '../src/delivery-attempt-store.js'
import { deliveryFailure, newDeliveryLogId, type DeliveryAttempt } from '../src/delivery-attempt.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { durableWriteFile, DurableWriteError } from '../src/durable-write.js'

const faults = vi.hoisted(() => ({
  write: null as Error | null, link: null as Error | null, rename: null as Error | null, directorySyncAt: null as number | null, close: null as Error | null, unlink: null as Error | null,
  fileSync: null as Error | null, directorySync: null as Error | null,
  closeAfterSync: null as 'file' | 'directory' | null, closeAfterSyncError: null as Error | null,
  writes: 0, fileSyncs: 0, directorySyncs: 0
}))
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual,
    link: async (...args: Parameters<typeof actual.link>) => { if (faults.link) throw faults.link; return actual.link(...args) },
    rename: async (...args: Parameters<typeof actual.rename>) => { if (faults.rename) throw faults.rename; return actual.rename(...args) },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args), temporary = String(args[0]).endsWith('.tmp')
      const directory = (await handle.stat()).isDirectory()
      let syncAttempted = false
      const write = handle.writeFile.bind(handle), sync = handle.sync.bind(handle), close = handle.close.bind(handle)
      if (temporary) handle.writeFile = (async (...input: Parameters<typeof write>) => {
        faults.writes++; if (faults.write) throw faults.write
        return write(...input)
      }) as typeof handle.writeFile
      handle.sync = async () => {
        syncAttempted = true
        if (directory) { faults.directorySyncs++; if (faults.directorySync && (faults.directorySyncAt === null || faults.directorySyncAt === faults.directorySyncs)) throw faults.directorySync }
        else { faults.fileSyncs++; if (faults.fileSync) throw faults.fileSync }
        return sync()
      }
      handle.close = async () => {
        await close()
        if (temporary && faults.close) throw faults.close
        if (!temporary && syncAttempted && faults.closeAfterSync === (directory ? 'directory' : 'file') && faults.closeAfterSyncError) throw faults.closeAfterSyncError
      }
      return handle
    },
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      if (String(args[0]).endsWith('.tmp') && faults.unlink) throw faults.unlink
      return actual.unlink(...args)
    }
  }
})
const roots: string[] = []
afterEach(async () => {
  Object.assign(faults, { write: null, link: null, rename: null, directorySyncAt: null, close: null, unlink: null, fileSync: null, directorySync: null,
    writes: 0, fileSyncs: 0, directorySyncs: 0, closeAfterSync: null, closeAfterSyncError: null })
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const errno = (code: string) => Object.assign(new Error(`injected ${code}`), { code })
async function directory() { const root = await mkdtemp(fixturePath("tmp/amux-resource-diagnostic-")); roots.push(root); return root }
function record(): DeliveryAttempt {
  return { logId: newDeliveryLogId(), source: 'core', agentSessionId: 'kept-session', operationId: 'kept-operation',
    hostId: 'kept-host', expectedRunId: 'kept-run', afterSubmissionId: null, conditionAvailable: true,
    promptDigest: null, execution: 'immediate', startedAt: 1, failedAt: 2, stage: 'submission-store',
    error: { name: 'Error', code: 'ENOSPC', message: 'Original input persistence failed.',
      controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } } }
}

describe('resource-pressure diagnostics retain the original failure and recover', () => {
  it.each(['ENOSPC', 'EACCES', 'EIO'])('retries the same immutable log after %s is removed', async code => {
    const root = await directory(), store = new DeliveryAttemptStore(root), original = record()
    faults.write = errno(code)
    const failed = await store.record(original)
    expect(faults.writes).toBe(1)
    expect(failed).toMatchObject({ availability: 'found', persistence: 'unconfirmed', record: original })
    expect(failed.issue).toContain(code)
    faults.write = null
    const retried = await store.record(original)
    expect(retried).toMatchObject({ availability: 'found', persistence: 'confirmed', record: original, issue: null })
    expect(faults.writes).toBe(2)
    expect((await new DeliveryAttemptStore(root).read(original.logId)).record).toEqual(original)
    if (code === 'ENOSPC') {
      const bytes = execFileSync(process.execPath, ['--input-type=module', '-e',
        'import { readFileSync } from "node:fs"; process.stdout.write(readFileSync(process.argv[1]))', join(root, `${original.logId}.json`)], { encoding: 'utf8' })
      expect(JSON.parse(bytes)).toEqual(original)
    }
  })
  it('exposes the diagnostic first cause and secondary cleanup in the existing public issue field', async () => {
    const store = new DeliveryAttemptStore(await directory()), original = record()
    faults.write = errno('ENOSPC'); faults.close = errno('EACCES')
    const failed = await store.record(original)
    expect(failed.record).toEqual(original)
    expect(failed.issue).toContain('ENOSPC'); expect(failed.issue).toContain('before-replace')
    expect(failed.issue).toContain('close'); expect(failed.issue).toContain('EACCES')
    faults.write = null; faults.close = null
    expect((await store.record(original)).persistence).toBe('confirmed')
  })
  it.each(['fileSync', 'link', 'rename'] as const)('recovers the same log after %s fails without substituting its contents', async operation => {
    const root = await directory(), store = new DeliveryAttemptStore(root), original = record()
    faults[operation] = errno('EIO')
    const failed = await store.record(original)
    expect(failed).toMatchObject({ persistence: 'unconfirmed', record: original })
    expect(failed.issue).toContain('EIO')
    faults[operation] = null
    expect(await store.record(original)).toMatchObject({ persistence: 'confirmed', record: original })
    expect((await new DeliveryAttemptStore(root).read(original.logId)).record).toEqual(original)
  })
  it('reconfirms a published original after its parent directory ACK fails, without writing it again', async () => {
    const root = await directory(), store = new DeliveryAttemptStore(root), original = record()
    faults.directorySync = errno('EIO'); faults.directorySyncAt = 2
    const failed = await store.record(original)
    expect(faults.directorySyncs).toBe(2)
    expect(failed).toMatchObject({ persistence: 'unconfirmed', record: original })
    expect(failed.issue).toContain('EIO')
    expect((await new DeliveryAttemptStore(root).read(original.logId)).record).toEqual(original)
    faults.directorySync = null
    expect(await store.record(original)).toMatchObject({ persistence: 'confirmed', record: original })
    expect(faults.writes).toBe(1)
  })
  it.each(['unix', 'http'] as const)('recovers the original report through actual %s RPC without admitting Input', async transport => {
    const root = await directory(), store = new DeliveryAttemptStore(join(root, 'reports')), original = record()
    original.source = 'client'
    const server = new AgentMuxControlServer({ socketPath: join(root, 'owner.sock'), coreClients: () => [],
      deliveryAttempts: { hostId: 'original-owner', store }, http: { host: '127.0.0.1', port: 0, token: 'private-test-token' } })
    await server.start()
    const rpc = await connectAgentMuxRpc({ endpoint: transport === 'unix' ? { transport, path: join(root, 'owner.sock') }
      : { transport, url: `http://127.0.0.1:${server.httpAddress!.port}/`, token: 'private-test-token' } })
    try {
      faults.write = errno('ENOSPC')
      const failed = await rpc.call('message.delivery.report', { hostId: 'original-owner', record: original })
      expect(failed.persistence).toBe('unconfirmed'); expect(failed.issue).toContain('ENOSPC')
      expect(failed.record).toMatchObject(original)
      faults.write = null
      const recovered = await rpc.call('message.delivery.report', { hostId: 'original-owner', record: original })
      expect(recovered.persistence).toBe('confirmed'); expect(recovered.record).toEqual(failed.record)
      expect((await rpc.call('message.delivery.inspect', { hostId: 'original-owner', logId: original.logId })).record).toEqual(failed.record)
    } finally { rpc.dispose(); await server.stop() }
  })
  it('reconfirms an existing original file rather than claiming that a read is a durable ACK', async () => {
    const root = await directory(), original = record(), store = new DeliveryAttemptStore(root)
    await writeFile(join(root, `${original.logId}.json`), JSON.stringify(original) + '\n')
    expect((await store.read(original.logId)).persistence).toBe('observed')
    faults.directorySync = errno('EIO')
    const unconfirmed = await store.record(original)
    expect(unconfirmed.persistence).toBe('unconfirmed')
    expect(unconfirmed.issue).toContain('EIO')
    faults.directorySync = null
    expect((await store.record(original)).persistence).toBe('confirmed')
    expect(faults.fileSyncs).toBeGreaterThanOrEqual(2)
    expect(faults.directorySyncs).toBe(2)
    expect(faults.writes).toBe(0)
    expect(JSON.parse(await readFile(join(root, `${original.logId}.json`), 'utf8'))).toEqual(original)
  })
  it.each(['file', 'directory'] as const)('keeps the first %s confirmation failure when close also fails', async kind => {
    const root = await directory(), store = new DeliveryAttemptStore(root), original = record()
    await writeFile(join(root, `${original.logId}.json`), JSON.stringify(original) + '\n')
    faults[kind === 'file' ? 'fileSync' : 'directorySync'] = errno('EIO')
    faults.closeAfterSync = kind; faults.closeAfterSyncError = errno('EACCES')
    const failed = await store.record(original)
    expect(failed.persistence).toBe('unconfirmed')
    expect(failed.issue).toMatch(/\[EIO\]/u)
    expect(failed.issue).toContain('after-replace'); expect(failed.issue).toContain(`${kind}-close`)
    expect(failed.issue).toContain('EACCES'); expect(failed.record).toEqual(original)
    faults.fileSync = null; faults.directorySync = null; faults.closeAfterSyncError = null
    expect((await store.record(original)).persistence).toBe('confirmed')
    expect(faults.writes).toBe(0)
  })
  it('keeps first reporter receiving time and refuses a changed immutable failure after recovery', async () => {
    const root = await directory(), store = new DeliveryAttemptStore(root), original = record()
    original.source = 'client'
    original.reporter = { kind: 'user', id: 'original-reporter', routeHostId: 'local', receivedAt: 10 }
    faults.write = errno('ENOSPC'); await store.record(original); faults.write = null
    const recovered = await store.record({ ...original, reporter: { ...original.reporter, receivedAt: 20 } })
    expect(recovered.persistence).toBe('confirmed'); expect(recovered.record?.reporter?.receivedAt).toBe(10)
    await expect(store.record({ ...original, error: { ...original.error, message: 'replacement failure' } }))
      .rejects.toMatchObject({ code: 'DELIVERY_LOG_CONFLICT' })
    expect((await new DeliveryAttemptStore(root).read(original.logId)).record).toEqual(original)
  })
  it.each(['close', 'unlink'] as const)('keeps ENOSPC as the first cause when temporary %s also fails', async operation => {
    const root = await directory(), target = join(root, 'kept.json'), original = errno('ENOSPC'), cleanup = errno('EACCES')
    await writeFile(target, 'original-complete-bytes')
    faults.write = original; faults[operation] = cleanup
    const failure = await durableWriteFile(target, 'replacement').catch(error => error)
    expect(faults.writes).toBe(1)
    expect(failure).toBeInstanceOf(DurableWriteError)
    expect(failure).toMatchObject({ code: 'ENOSPC', phase: 'before-replace', cause: original })
    const projected = deliveryFailure(failure)
    expect(projected.code).toBe('ENOSPC'); expect(projected.cause?.code).toBe('ENOSPC')
    expect(projected.detail).toContain(operation); expect(projected.detail).toContain('EACCES')
    expect(await readFile(target, 'utf8')).toBe('original-complete-bytes')
    faults.write = null; faults[operation] = null
    await durableWriteFile(target, 'recovered')
    expect(await readFile(target, 'utf8')).toBe('recovered')
  })
  it('preserves after-replace uncertainty and the original bytes when directory sync fails', async () => {
    const root = await directory(), target = join(root, 'state.json')
    faults.directorySync = errno('EIO')
    const failure = await durableWriteFile(target, 'published', { requireDirectorySync: true }).catch(error => error)
    expect(failure).toMatchObject({ code: 'EIO', phase: 'after-replace' })
    expect(deliveryFailure(failure).detail).toContain('after-replace')
    expect(await readFile(target, 'utf8')).toBe('published')
  })
})
