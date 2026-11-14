import { objectAvatarRequest, objectAvatarRequestKey, type ObjectAvatarAssetRequest, type ObjectAvatarRequestRecord } from '../shared/object-avatar-request.js'
import { avatarSeriesCanonical } from '@agentmux/core/mote-avatar-series'
import type { SpaceObjectImageTarget } from '@agentmux/core/object-avatar'
import { createHash } from 'node:crypto'
import { mkdir, open, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { durableWriteFile, DurableWriteError, restoreMissingRecoveryFile } from '@agentmux/core'
import type { RecoverySource, RecoveryRestoreMember } from '@agentmux/core'
import { captureWorkbenchRecoveryFiles, inspectWorkbenchRecoveryFiles } from './workbench-recovery-source.js'
import { confirmExistingWorkbenchRecoveryMember, holdRecoveredWorkbenchDocument, prepareWorkbenchRecoveryMembers, readWorkbenchRecoveryMember, recoveryUnavailable } from './workbench-recovery-restore.js'

import type { WorkbenchUserStateFailure, WorkbenchUserStateReceipt, WorkbenchUserStateObservation } from '../shared/workbench-user-state.js'
import type { WorkbenchUserStateWrite, WorkbenchUserStateWriteReceipt } from '../shared/workbench-user-state.js'
export type { WorkbenchUserStateFailure, WorkbenchUserStateReceipt, WorkbenchUserStateObservation } from '../shared/workbench-user-state.js'
import { captureFileViewReadingOwner, encodeFileViewReading, fileViewReadingOwnerKey, isFileViewReadingPosition, type FileViewReadingOwner, type FileViewReadingRecord, type FileViewReadingReceipt } from '../shared/workbench-user-state.js'

type UserStateIo = {
  read?: (path: string, encoding: 'utf8') => Promise<string>
  write?: typeof durableWriteFile
  syncDirectory?: (path: string) => Promise<void>
}

function invalid(): Error & { code: string } {
  return Object.assign(new Error('Desktop user state must be a JSON object containing an object state and numeric version. Original data is retained.'),
    { code: 'WORKBENCH_USER_STATE_INVALID' })
}

/** Validate the existing Zustand envelope without interpreting or removing user fields. */
function validate(value: unknown): asserts value is string {
  if (typeof value !== 'string') throw invalid()
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { throw invalid() }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalid()
  const envelope = parsed as Record<string, unknown>
  if (!envelope.state || typeof envelope.state !== 'object' || Array.isArray(envelope.state) ||
    typeof envelope.version !== 'number' || !Number.isFinite(envelope.version)) throw invalid()
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const size = (value: string) => Buffer.byteLength(value)
async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, 'r')
  try { await directory.sync() } finally { await directory.close() }
}

/**
 * One Main-owned document for the Desktop's existing persisted user projection.
 * Reads join admitted writes. No browser API, Session lifecycle or second layout owner lives here.
 */
export class WorkbenchUserStateStore {
  private tail: Promise<void> = Promise.resolve()
  private rootOpened = false
  private readonly openedAuxiliary = new Set<string>()
  private readonly recoveryGaps = new Map<string, string>()
  private rendererWriter: object | null = null
  private rendererRevision = 0
  private rendererValue: string | null = null
  private rendererFlight: Promise<WorkbenchUserStateWriteReceipt> | null = null
  private rendererDrain: Promise<void> | null = null
  private rendererPending: { writer: object; request: WorkbenchUserStateWrite; current(): boolean;
    resolve(receipt: WorkbenchUserStateWriteReceipt): void; reject(error: unknown): void } | null = null
  private readonly avatarRequestTails = new Map<string, Promise<void>>()
  private readonly readingTails = new Map<string, Promise<void>>()
  private readonly readingReady = new Set<string>()
  private readonly readingFailures = new Map<string, unknown>()
  private diagnosticRead = false
  private diagnosticReading: Promise<void> | null = null
  private diagnosticWrite: Promise<void> | null = null
  private pendingDiagnostic: WorkbenchUserStateFailure | null = null
  private observation: WorkbenchUserStateObservation

  constructor(readonly path: string, private readonly io: UserStateIo = {}) {
    if (!isAbsolute(path)) throw new Error('Desktop user state requires an absolute host-owned path.')
    this.observation = { path, availability: 'unconfirmed', contentDigest: null, sizeBytes: null,
      diskDurability: 'unconfirmed', confirmedAt: null, lastConfirmedWrite: null, lastFailure: null }
  }

  observe(): WorkbenchUserStateObservation { return structuredClone(this.observation) }

  retainRecoveryGaps(memberIds: readonly string[], reason: string): void {
    for (const id of memberIds) if (id === 'document' || /^(?:object-avatar-requests|file-view-reading)\/[a-f0-9]{64}\.json$/u.test(id)) this.recoveryGaps.set(id, reason)
  }

  recoverySource(): RecoverySource & { inspect(): Promise<string> } {
    const id = 'desktop.user-state'
    const files = [{ id: 'document', target: this.path }], namespaces = [
      { id: 'object-avatar-requests', directory: this.path + '.object-avatar-requests', accepts: (name: string) => /^[a-f0-9]{64}\.json$/u.test(name) },
      { id: 'file-view-reading', directory: this.path + '.file-view-reading', accepts: (name: string) => /^[a-f0-9]{64}\.json$/u.test(name) }
    ]
    return { id, ownedPaths: [this.path, ...namespaces.map(value => value.directory)], inspect: () => inspectWorkbenchRecoveryFiles(files, namespaces), capture: async directory => {
      await this.queue(async () => {})
      const root = await captureWorkbenchRecoveryFiles(id, directory, files)
      // Independent atomic members have their own cuts; a stalled auxiliary
      // request must never hold the original root document's writer queue.
      const auxiliary = await captureWorkbenchRecoveryFiles(id, directory, [], namespaces)
      return { revision: digest(root.revision + auxiliary.revision), members: [...root.members, ...auxiliary.members], gaps: [...root.gaps, ...auxiliary.gaps] }
    }, prepareRestore: (members, directory) => prepareWorkbenchRecoveryMembers(members, directory, member => this.prepareRecoveryMember(member)),
    restoreMissing: member => this.restoreRecoveryMember(member) }
  }

  private recoveryTarget(member: RecoveryRestoreMember): string {
    if (member.id === 'document') return this.path
    if (!/^(?:object-avatar-requests|file-view-reading)\/[a-f0-9]{64}\.json$/u.test(member.id)) throw recoveryUnavailable('DESKTOP_RECOVERY_MEMBER_MISMATCH')
    const [kind, name] = member.id.split('/')
    return join(this.path + '.' + kind, name!)
  }
  private async prepareRecoveryMember(member: RecoveryRestoreMember, protectCurrent = true): Promise<string> {
    if (protectCurrent && (member.id === 'document' ? this.rootOpened : this.openedAuxiliary.has(member.id))) throw recoveryUnavailable('DESKTOP_DOCUMENT_ALREADY_OPEN')
    const raw = await readWorkbenchRecoveryMember(member, this.recoveryTarget(member))
    let value = raw
    if (member.id === 'document') value = holdRecoveredWorkbenchDocument(raw)
    else if (member.id.startsWith('file-view-reading/')) {
      const record = JSON.parse(raw), key = fileViewReadingOwnerKey(record?.owner)
      if (record?.schema !== 'agentmux.file-view-reading.v1' || !isFileViewReadingPosition(record.position) || member.id !== 'file-view-reading/' + digest(key) + '.json') throw recoveryUnavailable('DESKTOP_RECOVERY_MEMBER_MISMATCH')
    } else {
      const records: unknown = JSON.parse(raw)
      if (!Array.isArray(records)) throw recoveryUnavailable('DESKTOP_RECOVERY_MEMBER_MISMATCH')
      const operations = new Set<string>()
      for (const item of records) {
        const request = objectAvatarRequest(item?.request)
        if (member.id !== 'object-avatar-requests/' + digest(objectAvatarRequestKey(request.target)) + '.json' ||
          !Number.isSafeInteger(item?.createdAt) || item.createdAt < 0 || Object.keys(item).some(key => !['request', 'createdAt'].includes(key)) || operations.has(request.operationId)) throw recoveryUnavailable('DESKTOP_RECOVERY_MEMBER_MISMATCH')
        operations.add(request.operationId)
      }
    }
    if (protectCurrent && (member.id === 'document' ? this.rootOpened : this.openedAuxiliary.has(member.id))) throw recoveryUnavailable('DESKTOP_DOCUMENT_ALREADY_OPEN')
    return value
  }
  private async restoreRecoveryMember(member: RecoveryRestoreMember): Promise<'restored' | 'same' | 'conflict'> {
    // Re-check inside this original member's queue; preparation does not reserve
    // user input or grant permission to overwrite a later admitted image.
    const restore = async () => {
      const prepared = await this.prepareRecoveryMember(member, false)
      if (prepared !== await readWorkbenchRecoveryMember(member, this.recoveryTarget(member))) throw recoveryUnavailable('DESKTOP_RECOVERY_PREPARATION_REQUIRED')
      const existing = await confirmExistingWorkbenchRecoveryMember(member, this.recoveryTarget(member))
      if (existing) return existing
      if (member.id === 'document' ? this.rootOpened : this.openedAuxiliary.has(member.id)) throw recoveryUnavailable('DESKTOP_DOCUMENT_ALREADY_OPEN')
      return await restoreMissingRecoveryFile(member.file, this.recoveryTarget(member), member.sha256)
    }
    if (member.id === 'document') return await this.queue(restore)
    const hash = member.id.slice(member.id.indexOf('/') + 1, -'.json'.length)
    return member.id.startsWith('object-avatar-requests/') ? await this.avatarMemberQueue(hash, restore) : await this.readingMemberQueue(hash, restore)
  }

  private avatarRequestQueue<T>(key: string, action: () => Promise<T>): Promise<T> {
    return this.avatarMemberQueue(digest(key), action)
  }
  private avatarMemberQueue<T>(key: string, action: () => Promise<T>): Promise<T> {
    const result = (this.avatarRequestTails.get(key) ?? Promise.resolve()).then(action)
    const settled = result.then(() => {}, () => {})
    this.avatarRequestTails.set(key, settled)
    void settled.then(() => { if (this.avatarRequestTails.get(key) === settled) this.avatarRequestTails.delete(key) })
    return result
  }
  private avatarRequestsPath(key: string): string { return join(this.path + '.object-avatar-requests', digest(key) + '.json') }
  private async readAvatarRequests(key: string): Promise<ObjectAvatarRequestRecord[]> {
    let raw: string
    try { raw = await (this.io.read ?? readFile)(this.avatarRequestsPath(key), 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { if (this.recoveryGaps.has('object-avatar-requests/' + digest(key) + '.json')) throw recoveryUnavailable('DESKTOP_RECOVERY_SOURCE_UNCONFIRMED'); return [] }; throw error }
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) throw new Error('The original avatar save requests are unreadable. Their bytes and current draft are retained.')
    const records = value.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['request', 'createdAt'].includes(key))) throw new Error('An original avatar request record is invalid.')
      const request = objectAvatarRequest(item.request)
      if (objectAvatarRequestKey(request.target) !== key || !Number.isSafeInteger(item.createdAt) || item.createdAt < 0) throw new Error('An original avatar request belongs to another object.')
      return { request, createdAt: item.createdAt as number }
    })
    if (new Set(records.map(value => value.request.operationId)).size !== records.length) throw new Error('An original avatar request operation is ambiguous.')
    return records
  }
  /** Exact avatar request member; ordinary root/draft writes never encode PNG bodies. */
  async readObjectAvatarRequests(target: SpaceObjectImageTarget): Promise<ObjectAvatarRequestRecord[]> {
    const key = objectAvatarRequestKey(target)
    this.openedAuxiliary.add('object-avatar-requests/' + digest(key) + '.json')
    return this.avatarRequestQueue(key, () => this.readAvatarRequests(key))
  }
  private async writeAvatarRequests(key: string, records: ObjectAvatarRequestRecord[]) {
    const path = this.avatarRequestsPath(key)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await (this.io.syncDirectory ?? syncDirectory)(dirname(dirname(path)))
    await (this.io.write ?? durableWriteFile)(path, JSON.stringify(records) + '\n', { requireDirectorySync: true })
  }
  async keepObjectAvatarRequest(raw: ObjectAvatarAssetRequest): Promise<void> {
    const request = objectAvatarRequest(raw), key = objectAvatarRequestKey(request.target)
    this.openedAuxiliary.add('object-avatar-requests/' + digest(key) + '.json')
    await this.avatarRequestQueue(key, async () => {
      const records = await this.readAvatarRequests(key), original = records.find(value => value.request.operationId === request.operationId)
      if (original) {
        if (avatarSeriesCanonical(original.request) !== avatarSeriesCanonical(request)) throw new Error('This saved avatar operation belongs to another original request. Its bytes are retained.')
        return
      }
      await this.writeAvatarRequests(key, [...records, { request, createdAt: Date.now() }])
    })
  }
  async retireObjectAvatarRequest(raw: ObjectAvatarAssetRequest): Promise<void> {
    const request = objectAvatarRequest(raw), key = objectAvatarRequestKey(request.target)
    this.openedAuxiliary.add('object-avatar-requests/' + digest(key) + '.json')
    await this.avatarRequestQueue(key, async () => {
      const records = await this.readAvatarRequests(key), original = records.find(value => value.request.operationId === request.operationId)
      if (!original) return
      if (avatarSeriesCanonical(original.request) !== avatarSeriesCanonical(request)) throw new Error('The original avatar request differs. Its bytes are retained.')
      await this.writeAvatarRequests(key, records.filter(value => value !== original))
    })
  }

  private readingPath(owner: FileViewReadingOwner): string {
    return join(this.path + '.file-view-reading', digest(fileViewReadingOwnerKey(owner)) + '.json')
  }

  private async readReadingCurrent(captured: FileViewReadingOwner): Promise<FileViewReadingRecord | null> {
    const key = fileViewReadingOwnerKey(captured)
    try {
      let raw: string
      try { raw = await (this.io.read ?? readFile)(this.readingPath(captured), 'utf8') }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { if (this.recoveryGaps.has('file-view-reading/' + digest(key) + '.json')) throw recoveryUnavailable('DESKTOP_RECOVERY_SOURCE_UNCONFIRMED'); this.readingReady.add(key); return null }; throw error }
      const value = JSON.parse(raw)
      if (value?.schema !== 'agentmux.file-view-reading.v1' || fileViewReadingOwnerKey(value.owner) !== key || !isFileViewReadingPosition(value.position)) throw new Error('The saved reading preference could not be confirmed. Its original bytes are retained.')
      this.readingReady.add(key)
      return { owner: captured, position: { ...value.position } }
    } catch (error) { this.readingReady.delete(key); throw error }
  }

  /** One physical member: neither the root document nor unrelated drafts are read or encoded. */
  async readFileViewReading(owner: FileViewReadingOwner): Promise<FileViewReadingRecord | null> {
    const captured = captureFileViewReadingOwner(owner)
    this.openedAuxiliary.add('file-view-reading/' + digest(fileViewReadingOwnerKey(captured)) + '.json')
    return this.readingQueue(fileViewReadingOwnerKey(captured), () => this.readReadingCurrent(captured))
  }

  /** Same native owner/ordered queue and durable receipt, with an exact-member write boundary. */
  async writeFileViewReading(record: FileViewReadingRecord): Promise<FileViewReadingReceipt> {
    const encoded = encodeFileViewReading(record), owner = captureFileViewReadingOwner(record.owner)
    this.openedAuxiliary.add('file-view-reading/' + digest(fileViewReadingOwnerKey(owner)) + '.json')
    return this.readingQueue(fileViewReadingOwnerKey(owner), async () => {
      const path = this.readingPath(owner)
      try {
        if (!this.readingReady.has(fileViewReadingOwnerKey(owner))) throw Object.assign(new Error('The original reading preference has not been read. Its bytes and current position are retained; retry reading it first.'), { code: 'FILE_VIEW_READING_READ_UNCONFIRMED' })
        await this.readReadingCurrent(owner)
        // The App user-state root already exists. Confirm the namespace's directory entry too;
        // syncing only the new member's immediate parent does not make that entry durable.
        await mkdir(dirname(path), { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
        await (this.io.syncDirectory ?? syncDirectory)(dirname(dirname(path)))
        await (this.io.write ?? durableWriteFile)(path, encoded, { requireDirectorySync: true })
        this.readingFailures.delete(fileViewReadingOwnerKey(owner))
        return { owner, path, contentDigest: digest(encoded), sizeBytes: size(encoded), diskDurability: 'confirmed', confirmedAt: Date.now() }
      } catch (error) { this.readingFailures.set(fileViewReadingOwnerKey(owner), error); throw error }
    })
  }


  /** Only an explicit reading checkpoint consumes this frontier; root-message fences stay independent. */
  async flushFileViewReadings(): Promise<void> {
    await Promise.all(this.readingTails.values())
    if (this.readingFailures.size) throw Object.assign(new Error('A reading position has no confirmed writer acknowledgement. Its current position and original bytes are retained; retry saving that position.'), { code: 'FILE_VIEW_READING_SAVE_UNCONFIRMED' })
  }

  private readingQueue<T>(key: string, action: () => Promise<T>): Promise<T> {
    return this.readingMemberQueue(digest(key), action)
  }
  private readingMemberQueue<T>(key: string, action: () => Promise<T>): Promise<T> {
    const result = (this.readingTails.get(key) ?? Promise.resolve()).then(action)
    const tail = result.then(() => {}, () => {}).finally(() => { if (this.readingTails.get(key) === tail) this.readingTails.delete(key) })
    this.readingTails.set(key, tail)
    return result
  }

  private queue<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action)
    // An unsuccessful request must not poison later explicit saves or reads.
    this.tail = result.then(() => {}, () => {})
    return result
  }

  private async readDiagnostic(): Promise<void> {
    if (this.diagnosticRead) return
    this.diagnosticRead = true
    if (this.observation.lastFailure) return
    try {
      const value = JSON.parse(await (this.io.read ?? readFile)(this.path + '.failure.json', 'utf8'))
      const failure = value?.schema === 'agentmux.workbench-user-state-failure.v1' ? value.failure : null
      if (!this.observation.lastFailure && failure && ['read', 'write'].includes(failure.operation) &&
        [null, 'request', 'before-replace', 'after-replace'].includes(failure.phase) &&
        (failure.code === null || typeof failure.code === 'string' && failure.code.length <= 128) &&
        typeof failure.observedAt === 'number' && Number.isFinite(failure.observedAt)) {
        this.observation.lastFailure = { operation: failure.operation, phase: failure.phase,
          code: failure.code, observedAt: failure.observedAt }
      }
    } catch { /* Diagnostic availability never gates the original user data. */ }
  }

  private failed(operation: WorkbenchUserStateFailure['operation'], error: unknown, request = false): void {
    const rawCode = error && typeof error === 'object' && 'code' in error ? error.code : null
    const failure: WorkbenchUserStateFailure = { operation,
      phase: request ? 'request' : error instanceof DurableWriteError ? error.phase : null,
      code: typeof rawCode === 'string' ? rawCode.slice(0, 128) : null, observedAt: Date.now() }
    if (!request) {
      Object.assign(this.observation, { availability: 'unconfirmed', contentDigest: null, sizeBytes: null,
        diskDurability: 'unconfirmed', confirmedAt: null })
    }
    this.observation.lastFailure = failure
    this.pendingDiagnostic = failure
    this.publishDiagnostic()
  }

  private publishDiagnostic(): void {
    if (this.diagnosticWrite || !this.pendingDiagnostic) return
    const failure = this.pendingDiagnostic
    this.pendingDiagnostic = null
    // Keep at most one auxiliary write and the latest pending metadata. This
    // observation is deliberately outside the user-data request queue.
    this.diagnosticWrite = Promise.resolve().then(async () => {
      try {
        await (this.io.write ?? durableWriteFile)(this.path + '.failure.json',
          JSON.stringify({ schema: 'agentmux.workbench-user-state-failure.v1', failure }) + '\n', { requireDirectorySync: true })
      } catch { /* Diagnostic persistence never masks or delays the original business request. */ }
    }).finally(() => { this.diagnosticWrite = null; this.publishDiagnostic() })
  }

  /** Diagnostic observers may await this; user saving and ordinary exit must not depend on it. */
  async flushDiagnostics(): Promise<void> {
    await this.diagnosticReading
    while (this.diagnosticWrite) await this.diagnosticWrite
  }

  private async readCurrent(): Promise<string | null> {
    // Historical diagnostics must never delay the original user document.
    if (!this.diagnosticRead) this.diagnosticReading = this.readDiagnostic()
    let value: string
    try { value = await (this.io.read ?? readFile)(this.path, 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (this.recoveryGaps.has('document')) throw recoveryUnavailable('DESKTOP_RECOVERY_SOURCE_UNCONFIRMED')
      Object.assign(this.observation, { availability: 'missing', contentDigest: null, sizeBytes: null,
        diskDurability: 'unconfirmed', confirmedAt: null })
      return null
    }
    validate(value)
    const contentDigest = digest(value)
    // Equal bytes do not establish that this path still names the file confirmed
    // by an earlier write. Retain that receipt as history, separate from this read.
    Object.assign(this.observation, { availability: 'present', contentDigest, sizeBytes: size(value),
      diskDurability: 'unconfirmed', confirmedAt: null })
    return value
  }

  read(): Promise<string | null> {
    this.rootOpened = true
    return this.queue(async () => {
      try { return await this.readCurrent() }
      catch (error) { await this.failed('read', error); throw error }
    })
  }

  private async writeCurrent(value: string): Promise<WorkbenchUserStateReceipt> {
    try {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      // Explicit saves always obtain a writer ACK, including identical bytes
      // after replacement or a previous unknown directory sync. User-change
      // coalescing belongs to the existing Renderer batch writer.
      await (this.io.write ?? durableWriteFile)(this.path, value, { requireDirectorySync: true })
      const receipt: WorkbenchUserStateReceipt = { path: this.path, contentDigest: digest(value), sizeBytes: size(value),
        diskDurability: 'confirmed', confirmedAt: Date.now() }
      Object.assign(this.observation, { availability: 'present', ...receipt, lastConfirmedWrite: receipt })
      return structuredClone(receipt)
    } catch (error) { this.failed('write', error); throw error }
  }

  /** The native absence check and first import are one owner-serialized operation. */
  importIfAbsent(value: string): Promise<string> {
    this.rootOpened = true
    return this.queue(async () => {
      let current: string | null
      try { current = await this.readCurrent() }
      catch (error) { this.failed('read', error); throw error }
      if (current !== null) {
        // A concurrent native winner must be acknowledged too: the importer
        // may remove equal legacy bytes only after this exact writer confirms.
        await this.writeCurrent(current)
        return current
      }
      try { validate(value) }
      catch (error) { this.failed('write', error, true); throw error }
      await this.writeCurrent(value)
      return value
    })
  }

  write(value: string): Promise<WorkbenchUserStateReceipt> {
    this.rootOpened = true
    return this.queue(async () => {
      try { validate(value) }
      catch (error) { await this.failed('write', error, true); throw error }
      try { await this.readCurrent() }
      catch (error) { await this.failed('read', error); throw error }
      return this.writeCurrent(value)
    })
  }

  /** Admit before joining IO. A delayed old IPC cannot overwrite a newer admitted document.
   * One physical writer and one latest pending image remain bounded even when IO is stuck. */
  writeFromRenderer(writer: object, request: WorkbenchUserStateWrite, current: () => boolean): Promise<WorkbenchUserStateWriteReceipt> {
    this.rootOpened = true
    const superseded = () => Object.assign(new Error('A newer original Desktop input replaced this save request. Current input is retained.'),
      { code: 'WORKBENCH_USER_STATE_SUPERSEDED' })
    if (!current() || !request || !Number.isSafeInteger(request.writeRevision) || request.writeRevision < 1) return Promise.reject(superseded())
    try { validate(request.value) } catch (error) { return Promise.reject(error) }
    if (this.rendererWriter !== writer) {
      this.rendererWriter = writer; this.rendererRevision = 0; this.rendererValue = null; this.rendererFlight = null
    }
    if (request.writeRevision < this.rendererRevision) return Promise.reject(superseded())
    if (request.writeRevision === this.rendererRevision) {
      if (request.value !== this.rendererValue) return Promise.reject(superseded())
      return this.rendererFlight!
    }
    const captured = { value: request.value, writeRevision: request.writeRevision }
    this.rendererRevision = captured.writeRevision; this.rendererValue = captured.value
    this.rendererPending?.reject(superseded())
    const flight = new Promise<WorkbenchUserStateWriteReceipt>((resolve, reject) => {
      this.rendererPending = { writer, request: captured, current, resolve, reject }
    })
    // The IPC consumer observes its own rejection; retaining custody must not create an unhandled promise.
    void flight.catch(() => {})
    this.rendererFlight = flight
    this.drainRendererWrites()
    return flight
  }

  private drainRendererWrites(): void {
    if (this.rendererDrain) return
    this.rendererDrain = this.queue(async () => {
      while (this.rendererPending) {
        const input = this.rendererPending; this.rendererPending = null
        try {
          if (input.writer !== this.rendererWriter || !input.current()) throw new Error('The original Desktop writer changed. Its newer input is retained.')
          try { await this.readCurrent() }
          catch (error) { this.failed('read', error); throw error }
          // Never cancel an admitted filesystem effect or let another rename pass it.
          const receipt = await this.writeCurrent(input.request.value)
          input.resolve({ ...receipt, writeRevision: input.request.writeRevision })
        } catch (error) { input.reject(error) }
      }
    }).finally(() => {
      this.rendererDrain = null
      if (this.rendererPending) this.drainRendererWrites()
    })
  }
}
