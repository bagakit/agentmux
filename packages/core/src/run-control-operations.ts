import { createHash } from 'node:crypto'
import { lstat, mkdir, open, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { durableWriteFile } from './durable-write.js'
import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { mintObjectId } from './object-id.js'
import { parsePostureSet, parsePostureSetResult, type PostureSet, type PostureReceipt } from './agent-posture.js'
import { parseTerminalControl, parseTerminalControlResult, terminalInputDescriptor, type TerminalControlRequest, type TerminalControlReceipt } from './terminal-control.js'
import type { RunControlActor } from './run-control-context.js'
import type { AgentMuxCreationRuntime } from './terminal-creation-retirement.js'

type ControlRequest = PostureSet | TerminalControlRequest
type ControlReceipt = PostureReceipt | TerminalControlReceipt
type ReceiptFor<R extends ControlRequest> = R extends PostureSet ? PostureReceipt : TerminalControlReceipt
type Record = { schemaVersion: 1; request: ControlRequest; requestDigest: string; receipt: ControlReceipt }
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
  private async readRecord(id: string, newAdmission = false, diskOnly = false): Promise<Record | null> {
    if (!diskOnly && this.observed.has(id)) return structuredClone(this.observed.get(id)!)
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
    const action = rpcRecord(p.receipt).action
    const request = action === 'agent-posture' ? parsePostureSet(p.request) : parseTerminalControl(p.request)
    const receipt = 'action' in request ? parseTerminalControlResult(p.receipt, request) : parsePostureSetResult(p.receipt, request)
    if (p.schemaVersion !== 1 || request.operationId !== id || receipt.operationId !== id || typeof p.requestDigest !== 'string')
      throw new AgentMuxError('The original native control record is unconfirmed; no replacement was created.', 'RUN_CONTROL_RECORD_UNCONFIRMED')
    if (digest({ request, actor: receipt.actor }) !== p.requestDigest) throw conflict()
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
  private same(record: Record, request: ControlRequest, actor: RunControlActor): void { if (record.requestDigest !== digest({ request, actor })) throw conflict() }
  async inspect(operationId: string): Promise<ControlReceipt | null> { return (await this.readRecord(operationId))?.receipt ?? null }
  async original<R extends ControlRequest>(request: R, actor: RunControlActor): Promise<ReceiptFor<R> | null> {
    const previous = await this.readRecord(request.operationId)
    if (!previous) return null
    this.same(previous, request, actor); return previous.receipt as ReceiptFor<R>
  }
  async prepare<R extends ControlRequest>(request: R, actor: RunControlActor, runtime: AgentMuxCreationRuntime): Promise<ReceiptFor<R>> {
    return this.locked(request.operationId, async newAdmission => {
      const prior = await this.readRecord(request.operationId, newAdmission)
      if (prior) { this.same(prior, request, actor); return prior.receipt as ReceiptFor<R> }
      const common = { operationId: request.operationId, target: request.target, actor, runtime,
        phase: 'prepared' as const, outcome: 'not-dispatched' as const, acknowledgement: null, diskDurability: 'confirmed' as const }
      const receipt: ControlReceipt = 'action' in request
        ? { ...common, target: request.target, action: request.action, ownerInstanceId: request.ownerInstanceId,
          ...(request.action === 'terminal-input' ? { input: terminalInputDescriptor(request) } : {}),
          nativeOperationId: request.action === 'terminal-interrupt' || request.action === 'terminal-input' && terminalInputDescriptor(request).bytes === 0 ? null : mintObjectId() }
        : { ...common, target: request.target, action: 'agent-posture', controlId: request.controlId, modeId: request.modeId, nativeOperationId: mintObjectId() }
      const record: Record = { schemaVersion: 1, request, requestDigest: digest({ request, actor }), receipt }
      await this.save(record); return structuredClone(receipt) as ReceiptFor<R>
    })
  }
  async claim<R extends ControlRequest>(request: R, actor: RunControlActor): Promise<{ receipt: ReceiptFor<R>; dispatched: boolean }> {
    return this.locked(request.operationId, async () => {
      const record = await this.readRecord(request.operationId)
      if (!record) throw new AgentMuxError('The original native operation preparation is unavailable.', 'RUN_CONTROL_RECORD_UNCONFIRMED')
      this.same(record, request, actor)
      if (record.receipt.phase !== 'prepared') return { receipt: record.receipt as ReceiptFor<R>, dispatched: false }
      record.receipt = { ...record.receipt, phase: 'dispatching', outcome: 'unknown' }
      await this.save(record); return { receipt: record.receipt as ReceiptFor<R>, dispatched: true }
    })
  }
  async settle<R extends ControlRequest>(request: R, actor: RunControlActor, dispatched: ReceiptFor<R>, update: Pick<ReceiptFor<R>, 'outcome' | 'acknowledgement'> & { issue?: string }): Promise<ReceiptFor<R>> {
    // The caller already holds this acknowledged dispatch claim. Reading its
    // file again must not be a prerequisite for retaining a later native ACK.
    const receipt = 'action' in request ? parseTerminalControlResult(dispatched, request) : parsePostureSetResult(dispatched, request)
    if (receipt.phase !== 'dispatching' || digest(receipt.actor) !== digest(actor)) throw conflict()
    const record: Record = { schemaVersion: 1, request, requestDigest: digest({ request, actor }), receipt }
    record.receipt = { ...record.receipt, ...update, phase: 'settled', diskDurability: 'unconfirmed' } as ControlReceipt
    // Retain the observed ACK even if admission to the receipt writer fails.
    // The durable dispatch claim already prevents any later reinput.
    this.observed.set(request.operationId, structuredClone(record))
    try {
      await this.locked(request.operationId, async () => {
        // A missing or replaced disk member is not permission to reconstruct or
        // overwrite it. Keep only the obtained ACK in this original live owner.
        const prior = await this.readRecord(request.operationId, false, true)
        if (!prior || prior.requestDigest !== record.requestDigest || prior.receipt.phase !== 'dispatching' ||
          prior.receipt.nativeOperationId !== dispatched.nativeOperationId || digest(prior.receipt.runtime) !== digest(dispatched.runtime)) throw conflict()
        const durable = { ...record, receipt: { ...record.receipt, diskDurability: 'confirmed' as const } }
        await this.save(durable); record.receipt = durable.receipt; this.observed.delete(request.operationId)
      })
    } catch (error) {
      record.receipt.issue = 'The original native receipt was observed; receipt persistence or writer release reported an error. ' + String(error)
      this.observed.set(request.operationId, structuredClone(record))
    }
    return structuredClone(record.receipt) as ReceiptFor<R>
  }
}
