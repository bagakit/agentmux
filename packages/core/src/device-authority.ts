import { exportPublicKey, importPublicKey } from '@agentmux/relay/e2ee'
import { mintObjectId } from './object-id.js'
import { createHash } from 'node:crypto'
import { mkdir, open, readFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { AgentMuxError } from './errors.js'
import { durableWriteFile } from './durable-write.js'
import { DEVICE_OPERATION_WINDOW, parseDeviceConnection, type TrustedDevice, type DeviceConnection, type DeviceOperation } from './public-rpc-device.js'
import type { AgentOperationDevice } from './types.js'

/** Devices that may hold live authorization at once. Revoked records stay to refuse their keys and do not count. */
const MAX_DEVICES = 100

interface DeviceRecord extends TrustedDevice {
  readonly credentialHash: string
  /** Legacy v1 hashes also represented bearer secrets. Only E2EE proves this source. */
  readonly credentialKind?: 'relay-key'
}
type DeviceObservation = Pick<DeviceRecord, 'connection' | 'credentialKind'>
interface AuthorityState {
  readonly schema: 'agentmux.device-authority.v1'
  readonly hostId: string
  readonly devices: readonly DeviceRecord[]
  readonly daemonPublicKeyB64?: string
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }
function connectionFrom(value: unknown): DeviceConnection | undefined {
  try { return value === undefined ? undefined : parseDeviceConnection(value) } catch { return undefined }
}
function publicDevice(device: DeviceRecord): TrustedDevice {
  const connection = connectionFrom(device.connection)
  return { deviceId: device.deviceId, name: device.name, createdAt: device.createdAt,
    ...(device.revokedAt === undefined ? {} : { revokedAt: device.revokedAt }),
    ...(device.credentialKind === 'relay-key' ? { keyFingerprint: `sha256:${device.credentialHash}` } : {}),
    ...(connection ? { connection } : {}) }
}
/** Append-only home of operations that left the device.ls window: one JSON line per record, never rewritten. */
function operationArchivePath(path: string): string { return join(dirname(path), `${basename(path, extname(path))}-operations.jsonl`) }

/** Append whole lines, then flush the file and the directory entry that names it. */
async function appendDurably(path: string, text: string): Promise<void> {
  const handle = await open(path, 'a+', 0o600)
  try {
    const { size } = await handle.stat(), last = Buffer.alloc(1)
    if (size > 0) await handle.read(last, 0, 1, size - 1)
    // A torn earlier append must not glue its fragment onto the first new line.
    await handle.writeFile(size > 0 && last[0] !== 0x0a ? '\n' + text : text)
    await handle.sync()
  } finally { await handle.close() }
  const directory = await open(dirname(path), 'r')
  try { await directory.sync() } finally { await directory.close() }
}
function denied(): AgentMuxError { return new AgentMuxError('Device authorization is unavailable or no longer valid.', 'CONTROL_PERMISSION_DENIED') }
function stateFrom(value: unknown): AuthorityState {
  const state = value as Partial<AuthorityState> | null
  if (!state || state.schema !== 'agentmux.device-authority.v1' || typeof state.hostId !== 'string'
    || !state.hostId || !Array.isArray(state.devices)) {
    throw new AgentMuxError('The durable Host device identity cannot be read. Preserve this file and restore its original identity.', 'CONTROL_PROTOCOL_ERROR')
  }
  if (state.daemonPublicKeyB64 !== undefined && (typeof state.daemonPublicKeyB64 !== 'string' || exportPublicKey(importPublicKey(state.daemonPublicKeyB64)) !== state.daemonPublicKeyB64)) throw new AgentMuxError('The original Host daemon public-key binding is unconfirmed. Preserve its files.', 'CONTROL_PROTOCOL_ERROR')
  const ids = new Set<string>(), hashes = new Set<string>()
  for (const device of state.devices) {
    if (!device || typeof device.deviceId !== 'string' || !device.deviceId || ids.has(device.deviceId)
      || typeof device.name !== 'string' || !device.name || device.name.length > 128
      || typeof device.credentialHash !== 'string' || !/^[a-f0-9]{64}$/u.test(device.credentialHash)
      || hashes.has(device.credentialHash) || !Number.isSafeInteger(device.createdAt) || device.createdAt < 0
      || (device.revokedAt !== undefined && (!Number.isSafeInteger(device.revokedAt) || device.revokedAt < device.createdAt))) {
      throw new AgentMuxError('The durable Host device authorization is invalid. It has not been replaced.', 'CONTROL_PROTOCOL_ERROR')
    }
    ids.add(device.deviceId); hashes.add(device.credentialHash)
  }
  return { schema: state.schema, hostId: state.hostId, devices: state.devices, ...(state.daemonPublicKeyB64 === undefined ? {} : { daemonPublicKeyB64: state.daemonPublicKeyB64 }) }
}

/** Device admission belongs to this original endpoint; it never owns a Session, Run or attachment. */
export class DeviceAuthority {
  private closed = false
  private daemonBindingConfirmed = false
  private readonly activityIssues = new Map<string, string>()
  private readonly connectionIssues = new Map<string, string>()
  /** Latest metadata only: at most one patch per device record, one scheduled writer, no event log. */
  private readonly pendingObservations = new Map<string, DeviceObservation>()
  private observationScheduled = false
  private diskUnconfirmed = false
  private readonly readers = new Map<string, Set<AbortController>>()
  private saveTail: Promise<void> = Promise.resolve()
  private readonly operationArchive: string

  private constructor(private readonly path: string, private state: AuthorityState,
    private readonly now: () => number) {
    this.operationArchive = operationArchivePath(path)
    for (const device of state.devices) if (device.connection !== undefined && !connectionFrom(device.connection)) {
      this.connectionIssues.set(device.deviceId, '设备连接信息无法读取；原身份、授权和连接保留。重新连接可记录当前信息。')
    }
  }

  /** Open only after the original Host endpoint is owned. Invalid state is never regenerated. */
  static async open(path: string, now: () => number = Date.now,
    options: { createIfMissing?: boolean; signal?: AbortSignal; observeMutation?(work: Promise<void>): void } = {}): Promise<DeviceAuthority> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    options.signal?.throwIfAborted()
    let state: AuthorityState
    try { state = stateFrom(JSON.parse(await readFile(path, { encoding: 'utf8', ...(options.signal ? { signal: options.signal } : {}) }))) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || options.createIfMissing === false) throw error
      options.signal?.throwIfAborted()
      state = { schema: 'agentmux.device-authority.v1', hostId: mintObjectId(), devices: [] }
      const mutation = durableWriteFile(path, JSON.stringify(state) + '\n', { requireDirectorySync: true, ...(options.signal ? { signal: options.signal } : {}) })
      options.observeMutation?.(mutation)
      await mutation
    }
    return new DeviceAuthority(path, state, now)
  }

  /** End only this Host instance's device readers; durable devices are not revoked. */
  close(): void {
    if (this.closed) return
    this.closed = true
    for (const readers of this.readers.values()) for (const reader of readers) reader.abort(denied())
    this.readers.clear()
  }

  get hostId(): string { return this.state.hostId }
  get daemonPublicKeyB64(): string | undefined { return this.state.daemonPublicKeyB64 }
  /** This endpoint's public binding belongs to the original device authority;
   * private key material remains exclusively in the original daemon key file. */
  async adoptDaemonPublicKey(publicKey: string): Promise<void> {
    if (this.closed) throw denied()
    if (this.state.daemonPublicKeyB64 === publicKey && this.daemonBindingConfirmed) return
    await this.change(state => {
      if (state.daemonPublicKeyB64 !== undefined && state.daemonPublicKeyB64 !== publicKey) throw new AgentMuxError('The original Host daemon key differs from its retained publication identity. Restore the original key; it was not replaced.', 'CONTROL_PROTOCOL_ERROR')
      if (exportPublicKey(importPublicKey(publicKey)) !== publicKey) throw denied()
      return { ...state, daemonPublicKeyB64: publicKey }
    })
    this.daemonBindingConfirmed = true
  }
  devices(): readonly TrustedDevice[] { return this.state.devices.map(device => ({ ...publicDevice(this.observedDevice(device)),
    online: (this.readers.get(device.deviceId)?.size ?? 0) > 0,
    ...(device.lastSeenAt === undefined ? {} : { lastSeenAt: device.lastSeenAt }), operations: (device.operations ?? []).slice(-DEVICE_OPERATION_WINDOW),
    ...(this.connectionIssues.has(device.deviceId) ? { connectionIssue: this.connectionIssues.get(device.deviceId)! } : {}),
    ...(this.activityIssues.has(device.deviceId) ? { operationIssue: this.activityIssues.get(device.deviceId)! } : {}) })) }

  private observedDevice(device: DeviceRecord): DeviceRecord {
    return { ...device, ...this.pendingObservations.get(device.deviceId) }
  }

  private clearConfirmedConnectionIssues(): void {
    for (const device of this.state.devices) {
      if (device.connection === undefined || connectionFrom(device.connection)) this.connectionIssues.delete(device.deviceId)
    }
  }

  private noteObservation(deviceId: string, update: DeviceObservation): void {
    if (this.closed) return
    this.pendingObservations.set(deviceId, { ...this.pendingObservations.get(deviceId), ...update })
    this.saveObservations()
  }

  private saveObservations(): void {
    if (this.observationScheduled || this.pendingObservations.size === 0) return
    this.observationScheduled = true
    const save = this.saveTail.then(async () => {
      const updates = new Map(this.pendingObservations)
      this.pendingObservations.clear()
      // A failed strong write may already have replaced the file. Never overwrite
      // its unknown authorization outcome with an older in-memory snapshot.
      const canSave = !this.diskUnconfirmed || await this.reconcileDisk()
      // Metadata does not grant permission. Preserve observed facts even if disk ACK fails.
      this.state = { ...this.state, devices: this.state.devices.map(device => ({ ...device, ...updates.get(device.deviceId) })) }
      if (!canSave) {
        for (const deviceId of updates.keys()) this.noteConnectionStorageIssue(deviceId)
        return
      }
      try {
        await durableWriteFile(this.path, JSON.stringify(this.state) + '\n', { requireDirectorySync: true })
        this.clearConfirmedConnectionIssues()
      } catch {
        for (const deviceId of updates.keys()) this.noteConnectionStorageIssue(deviceId)
      }
    }).finally(() => { this.observationScheduled = false; this.saveObservations() })
    this.saveTail = save.catch(() => {})
  }

  private noteConnectionStorageIssue(deviceId: string): void {
    this.connectionIssues.set(deviceId,
      '设备辨认和连接记录保存尚未确认；当前连接与原授权可继续使用。请检查本机存储，重新连接或更新设备名称后再读取状态。')
  }

  /** Read the original file only; it does not replay or certify the failed operation. */
  private async reconcileDisk(): Promise<boolean> {
    try {
      const disk = stateFrom(JSON.parse(await readFile(this.path, 'utf8')))
      if (disk.hostId !== this.state.hostId) return false
      if (this.state.daemonPublicKeyB64 !== undefined && disk.daemonPublicKeyB64 !== this.state.daemonPublicKeyB64) return false
      const retained = new Map(this.state.devices.map(device => [device.deviceId, device]))
      const current = new Map(disk.devices.map(device => [device.deviceId, device]))
      for (const previous of retained.values()) {
        const actual = current.get(previous.deviceId)
        if (!actual || actual.credentialHash !== previous.credentialHash || actual.createdAt !== previous.createdAt
          || previous.revokedAt !== undefined && actual.revokedAt !== previous.revokedAt) return false
      }
      this.state = { ...disk, devices: disk.devices.map(device => {
        const previous = retained.get(device.deviceId)
        if (previous?.credentialHash !== device.credentialHash) return device
        return { ...device,
          ...(previous.credentialKind === 'relay-key' ? { credentialKind: previous.credentialKind } : {}),
          ...(previous.connection ? { connection: previous.connection } : {}) }
      }) }
      // Only an explicit revocation read from this original Authority can end its
      // exact device readers. A failed write/read alone never authorizes this.
      for (const device of disk.devices) if (device.revokedAt !== undefined) {
        const readers = this.readers.get(device.deviceId)
        this.readers.delete(device.deviceId)
        for (const reader of readers ?? []) reader.abort(denied())
      }
      this.diskUnconfirmed = false
      return true
    } catch { return false }
  }

  /** Drain owned metadata on Host shutdown; no retry loop or Runtime lifecycle ownership. */
  async flush(): Promise<void> {
    do { await this.saveTail } while (this.observationScheduled || this.pendingObservations.size > 0)
  }

  operationSource(principal?: { kind: string; id: string }): AgentOperationDevice | undefined {
    if (principal?.kind === 'user') return { hostId: this.hostId, deviceId: 'local', name: '本机用户' }
    if (principal?.kind !== 'device' || !principal.id.startsWith(this.hostId + ':')) return undefined
    const deviceId = principal.id.slice(this.hostId.length + 1)
    const device = this.state.devices.find(d => d.deviceId === deviceId && d.revokedAt === undefined)
    return device ? { hostId: this.hostId, deviceId, name: device.name } : undefined
  }

  noteActivityIssue(deviceId: string): void {
    this.activityIssues.set(deviceId, '设备操作记录保存尚未确认。已执行的操作不会重做；请检查本机存储和原会话结果。')
  }

  async recordOperation(source: AgentOperationDevice, method: string, args: unknown[], result: 'confirmed' | 'failed' | 'unknown', operationId: string): Promise<void> {
    if (source.hostId !== this.hostId || source.deviceId === 'local') return
    const first = args[0]
    const target = first && typeof first === 'object' && 'agentSessionId' in first ? String(first.agentSessionId)
      : first && typeof first === 'object' && 'runId' in first ? String(first.runId)
      : typeof first === 'string' && !/^(write|paste)/.test(method) ? first.slice(0, 160) : 'Host'
    await this.change(async state => {
      const device = state.devices.find(value => value.deviceId === source.deviceId)
      if (!device) return state
      const operations = [...(device.operations ?? [])]
      const operation: DeviceOperation = { id: operationId, method, target, at: this.now(), result }
      const index = operations.findIndex(o => o.id === operationId)
      if (index >= 0) operations[index] = operation; else operations.push(operation)
      let kept = operations
      // A record leaves the device.ls window for the archive only once the archive holds it, so no write
      // deletes one. Moving a whole window at a time keeps the extra flush to one per window of operations;
      // while the archive cannot be written every record stays here and the next operation moves them.
      if (operations.length > 2 * DEVICE_OPERATION_WINDOW) {
        try {
          await appendDurably(this.operationArchive, operations.slice(0, -DEVICE_OPERATION_WINDOW)
            .map(value => JSON.stringify({ deviceId: device.deviceId, ...value }) + '\n').join(''))
          kept = operations.slice(-DEVICE_OPERATION_WINDOW)
        } catch { /* Nothing is lost: the records stay in the authority file. */ }
      }
      return { ...state, devices: state.devices.map(value => value.deviceId === device.deviceId ? { ...value, lastSeenAt: this.now(), operations: kept } : value) }
    })
  }

  /** Admission follows a completed encrypted handshake; never accepts a business-supplied identity. */
  async authorizeKey(publicKey: string): Promise<TrustedDevice> {
    if (this.closed) throw denied()
    if (!/^[A-Za-z0-9+/]{43}=$/.test(publicKey)) throw denied()
    const hash = digest(publicKey)
    const retained = this.state.devices.find(device => device.credentialHash === hash)
    if (retained) {
      if (retained.revokedAt !== undefined) throw denied()
      if (retained.credentialKind !== 'relay-key') this.noteObservation(retained.deviceId, { credentialKind: 'relay-key' })
      return publicDevice(this.observedDevice(retained))
    }
    let admitted: TrustedDevice | undefined
    await this.change(state => {
      const existing = state.devices.find(device => device.credentialHash === hash)
      if (existing) { if (existing.revokedAt !== undefined) throw denied(); admitted = publicDevice(this.observedDevice(existing)); return state }
      if (state.devices.filter(device => device.revokedAt === undefined).length >= MAX_DEVICES) {
        throw new AgentMuxError('Device admission is full. Revoke a device you no longer use to admit a new one; existing Sessions remain available.', 'CONTROL_OWNER_BUSY')
      }
      let deviceId: string
      do { deviceId = mintObjectId() } while (state.devices.some(device => device.deviceId === deviceId))
      const record: DeviceRecord = { deviceId, name: `设备 ${hash.slice(0, 6)}`, createdAt: this.now(), credentialHash: hash, credentialKind: 'relay-key' }
      admitted = publicDevice(record)
      return { ...state, devices: [...state.devices, record] }
    })
    return admitted!
  }

  async hello(deviceId: string, name: string): Promise<TrustedDevice> {
    const trimmed = name.trim()
    if (!trimmed || trimmed.length > 128) throw new AgentMuxError('Device name is invalid.', 'INVALID_CONTROL_REQUEST')
    let device: TrustedDevice | undefined
    await this.change(state => ({ ...state, devices: state.devices.map(record => {
      if (record.deviceId !== deviceId || record.revokedAt !== undefined) return record
      device = publicDevice({ ...record, name: trimmed, lastSeenAt: this.now() })
      return { ...record, name: trimmed, lastSeenAt: this.now() }
    }) }))
    if (!device) throw denied()
    return device
  }

  private async change(update: (state: AuthorityState) => AuthorityState | Promise<AuthorityState>): Promise<void> {
    if (this.closed) throw denied()
    const save = this.saveTail.then(async () => {
      if (this.diskUnconfirmed && !await this.reconcileDisk()) {
        for (const device of this.state.devices) this.noteConnectionStorageIssue(device.deviceId)
        throw new AgentMuxError('The original device file has an unconfirmed write and cannot be read. Existing connections remain available; inspect storage and read the original device state before another write.', 'CONTROL_UNAVAILABLE')
      }
      const next = await update(this.state)
      try { await durableWriteFile(this.path, JSON.stringify(next) + '\n', { requireDirectorySync: true }) }
      catch (error) {
        this.diskUnconfirmed = true
        if (!await this.reconcileDisk()) for (const device of this.state.devices) this.noteConnectionStorageIssue(device.deviceId)
        throw error
      }
      this.state = next
      this.clearConfirmedConnectionIssues()
    })
    this.saveTail = save.catch(() => {})
    await save
  }

  /** Recheck the exact authenticated key; this never registers a key or borrows a Reader. */
  async assertCurrentKey(device: Pick<TrustedDevice, 'deviceId' | 'createdAt'>, publicKey: string): Promise<void> {
    await this.assertCurrentRecord({ ...device, credentialHash: digest(publicKey) })
  }

  /** Only the trusted local forwarding receiver supplies this verified principal.
   * Capture the original record generation/key, independently of a reply reader or grant. */
  async bindForwardedDevice(principal: { kind: string; id: string }): Promise<{ assertCurrent(): Promise<void> }> {
    if (this.closed) throw denied()
    if (principal.kind !== 'device' || !principal.id.startsWith(this.hostId + ':')) throw denied()
    if (this.diskUnconfirmed && !await this.reconcileDisk()) throw new AgentMuxError(
      'The original device authority storage is unconfirmed; the saved input remains waiting.', 'CONTROL_UNAVAILABLE')
    const record = this.state.devices.find(value => value.deviceId === principal.id.slice(this.hostId.length + 1))
    if (!record || record.revokedAt !== undefined) throw denied()
    const original = { deviceId: record.deviceId, createdAt: record.createdAt, credentialHash: record.credentialHash }
    return { assertCurrent: () => this.assertCurrentRecord(original) }
  }

  private async assertCurrentRecord(device: Pick<DeviceRecord, 'deviceId' | 'createdAt' | 'credentialHash'>): Promise<void> {
    if (this.closed) throw denied()
    if (this.diskUnconfirmed && !await this.reconcileDisk()) throw new AgentMuxError(
      'The original device authority storage is unconfirmed; the saved input remains waiting.', 'CONTROL_UNAVAILABLE')
    const current = this.state.devices.find(value => value.deviceId === device.deviceId)
    if (!current || current.createdAt !== device.createdAt || current.credentialHash !== device.credentialHash || current.revokedAt !== undefined) throw denied()
  }

  /** A continuing request/stream observes revocation without affecting any other device or Run. */
  observe(device: TrustedDevice, info?: Pick<DeviceConnection, 'address' | 'userAgent'>): { signal: AbortSignal; dispose(): void } {
    if (this.closed) throw denied()
    const record = this.state.devices.find(value => value.deviceId === device.deviceId && value.revokedAt === undefined)
    if (!record) throw denied()
    const controller = new AbortController()
    let readers = this.readers.get(device.deviceId)
    if (!readers) { readers = new Set(); this.readers.set(device.deviceId, readers) }
    if (readers.size >= 128) throw new AgentMuxError('This device has too many continuing requests.', 'CONTROL_OWNER_BUSY')
    const first = readers.size === 0
    readers.add(controller)
    const previous = connectionFrom(this.observedDevice(record).connection)
    const connectedAt = first ? Math.max(this.now(), record.createdAt) : previous?.connectedAt ?? Math.max(this.now(), record.createdAt)
    const connection: DeviceConnection = { connectedAt, observedAt: Math.max(this.now(), connectedAt),
      ...(info?.address ? { address: info.address } : {}), ...(info?.userAgent ? { userAgent: info.userAgent } : {}) }
    this.noteObservation(device.deviceId, { connection })
    let disposed = false
    return { signal: controller.signal, dispose: () => {
      if (disposed) return; disposed = true
      readers.delete(controller)
      if (readers.size === 0) {
        this.readers.delete(device.deviceId)
        const latest = this.state.devices.find(value => value.deviceId === device.deviceId)
        const current = latest ? connectionFrom(this.observedDevice(latest).connection) : undefined
        if (current) this.noteObservation(device.deviceId, { connection: { ...current,
          disconnectedAt: Math.max(this.now(), current.observedAt ?? current.connectedAt) } })
      }
    } }
  }

  async revoke(deviceId: string): Promise<TrustedDevice> {
    let revoked: TrustedDevice | undefined
    await this.change(state => {
      const index = state.devices.findIndex(value => value.deviceId === deviceId)
      if (index < 0) throw denied()
      const device = state.devices[index]!
      revoked = publicDevice({ ...device, revokedAt: device.revokedAt ?? Math.max(this.now(), device.createdAt) })
      return { ...state, devices: state.devices.map(value => value.deviceId === deviceId ? { ...value, ...revoked } : value) }
    })
    const readers = this.readers.get(deviceId)
    this.readers.delete(deviceId)
    for (const reader of readers ?? []) reader.abort(denied())
    return revoked!
  }
}
