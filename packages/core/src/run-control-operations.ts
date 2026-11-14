import { createHash } from 'node:crypto'
import { lstat, mkdir, open, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { durableWriteFile } from './durable-write.js'
import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { mintObjectId } from './object-id.js'
import { parsePostureSet, parsePostureReceipt, type PostureSet, type PostureReceipt, type RunControlActor } from './agent-posture.js'
import type { AgentMuxCreationRuntime } from './terminal-creation-retirement.js'

type Record = { schemaVersion: 1; request: PostureSet; requestDigest: string; receipt: PostureReceipt }
const native = createRequire(import.meta.url)('fs-native-extensions') as { tryLock(fd: number): boolean }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const conflict = () => new AgentMuxError('The original native control operation belongs to another actor or request. Keep its original ID.', 'RUN_CONTROL_OPERATION_CONFLICT')

/** Only explicit native control intents live here, never Runtime state or per-keystroke history. */
export class RunControlOperations {
  private readonly observed = new Map<string, Record>()
  // A readable file cannot testify that its producer received directory-sync ACK.
  // Bind only this live owner's acknowledged write to the exact encoded image.
  private readonly acknowledgedImages = new Map<string, string>()
  constructor(private readonly directory: string) {}
  private path(id: string): string { return join(this.directory, digest(id) + '.json') }
  private async readRecord(id: string, newAdmission = false): Promise<Record | null> {
    if (this.observed.has(id)) return structuredClone(this.observed.get(id)!)
    let raw: string
    try { raw = await readFile(this.path(id), 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (!newAdmission) {
        const marker = await lstat(this.path(id) + '.lock').then(() => true, error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
          throw error
        })
        if (marker || this.acknowledgedImages.has(id)) throw new AgentMuxError(
          'The original admitted control record is missing. Keep its operation ID; no replacement input was authorized.', 'RUN_CONTROL_RECORD_UNCONFIRMED')
      }
      return null
    }
    const p = rpcRecord(JSON.parse(raw), ['schemaVersion', 'request', 'requestDigest', 'receipt'])
    const request = parsePostureSet(p.request), receipt = parsePostureReceipt(p.receipt)
    if (p.schemaVersion !== 1 || request.operationId !== id || typeof p.requestDigest !== 'string' || !receipt ||
      receipt.action !== 'agent-posture' || receipt.operationId !== id || !['prepared', 'dispatching', 'settled'].includes(receipt.phase) ||
      !['not-dispatched', 'not-applied', 'applied', 'unknown'].includes(receipt.outcome)) throw new AgentMuxError('The original native control record is unconfirmed; no replacement was created.', 'RUN_CONTROL_RECORD_UNCONFIRMED')
    const actor = receipt.actor
    if (digest({ request, actor }) !== p.requestDigest || JSON.stringify(receipt.target) !== JSON.stringify(request.target) ||
      receipt.controlId !== request.controlId || receipt.modeId !== request.modeId) throw conflict()
    receipt.diskDurability = this.acknowledgedImages.get(id) === digest(raw) ? 'confirmed' : 'unconfirmed'
    return { schemaVersion: 1, request, requestDigest: p.requestDigest, receipt }
  }
  private async locked<T>(id: string, action: (newAdmission: boolean) => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    // This original per-operation file is also its durable admission marker.
    // Never reclaim it to make missing/unknown request metadata look new.
    let newAdmission = false
    const lock = await open(this.path(id) + '.lock', 'wx+', 0o600).then(handle => { newAdmission = true; return handle }, error => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      return open(this.path(id) + '.lock', 'r+', 0o600)
    })
    try {
      if (!native.tryLock(lock.fd)) throw new AgentMuxError('The original native operation is completing admission. Inspect its same ID; no new effect was authorized.', 'RUN_CONTROL_BUSY')
      const parent = await open(dirname(this.directory), 'r'); try { await parent.sync() } finally { await parent.close() }
      return await action(newAdmission)
    } finally { await lock.close() }
  }
  private async save(record: Record): Promise<void> {
    const id = record.request.operationId
    this.acknowledgedImages.delete(id)
    const image = JSON.stringify({ ...record, receipt: { ...record.receipt, diskDurability: 'confirmed' } }) + '\n'
    await durableWriteFile(this.path(id), image, { mode: 0o600, requireDirectorySync: true })
    this.acknowledgedImages.set(id, digest(image)); record.receipt.diskDurability = 'confirmed'
  }
  private same(record: Record, request: PostureSet, actor: RunControlActor): void { if (record.requestDigest !== digest({ request, actor })) throw conflict() }
  async inspect(operationId: string): Promise<PostureReceipt | null> { return (await this.readRecord(operationId))?.receipt ?? null }
  async original(request: PostureSet, actor: RunControlActor): Promise<PostureReceipt | null> {
    const previous = await this.readRecord(request.operationId)
    if (!previous) return null
    this.same(previous, request, actor); return previous.receipt
  }
  async prepare(request: PostureSet, actor: RunControlActor, runtime: AgentMuxCreationRuntime): Promise<PostureReceipt> {
    return this.locked(request.operationId, async newAdmission => {
      const prior = await this.readRecord(request.operationId, newAdmission)
      if (prior) { this.same(prior, request, actor); return prior.receipt }
      const receipt: PostureReceipt = { action: 'agent-posture', operationId: request.operationId, target: request.target, controlId: request.controlId,
        modeId: request.modeId, actor, runtime, nativeOperationId: mintObjectId(), phase: 'prepared', outcome: 'not-dispatched', acknowledgement: null, diskDurability: 'confirmed' }
      const record: Record = { schemaVersion: 1, request, requestDigest: digest({ request, actor }), receipt }
      await this.save(record); return structuredClone(receipt)
    })
  }
  async claim(request: PostureSet, actor: RunControlActor): Promise<{ receipt: PostureReceipt; dispatched: boolean }> {
    return this.locked(request.operationId, async () => {
      const record = await this.readRecord(request.operationId)
      if (!record) throw new AgentMuxError('The original native operation preparation is unavailable.', 'RUN_CONTROL_RECORD_UNCONFIRMED')
      this.same(record, request, actor)
      if (record.receipt.phase !== 'prepared') return { receipt: record.receipt, dispatched: false }
      record.receipt = { ...record.receipt, phase: 'dispatching', outcome: 'unknown' }
      await this.save(record); return { receipt: record.receipt, dispatched: true }
    })
  }
  async settle(request: PostureSet, actor: RunControlActor, update: Pick<PostureReceipt, 'outcome' | 'acknowledgement'> & { issue?: string }): Promise<PostureReceipt> {
    const record = await this.readRecord(request.operationId)
    if (!record) throw new AgentMuxError('The original dispatched native operation is unavailable.', 'RUN_CONTROL_RECORD_UNCONFIRMED')
    this.same(record, request, actor)
    record.receipt = { ...record.receipt, ...update, phase: 'settled', diskDurability: 'unconfirmed' }
    // Retain the observed ACK even if admission to the receipt writer fails.
    // The durable dispatch claim already prevents any later reinput.
    this.observed.set(request.operationId, structuredClone(record))
    try {
      await this.locked(request.operationId, async () => {
        const durable = { ...record, receipt: { ...record.receipt, diskDurability: 'confirmed' as const } }
        await this.save(durable); record.receipt = durable.receipt; this.observed.delete(request.operationId)
      })
    } catch (error) {
      record.receipt.issue = 'The original native receipt was observed; receipt persistence or writer release reported an error. ' + String(error)
      this.observed.set(request.operationId, structuredClone(record))
    }
    return structuredClone(record.receipt)
  }
}
