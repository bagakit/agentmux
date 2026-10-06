import { mintObjectId } from '@agentmux/core/object-id'
import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { AgentMuxError, durableWriteFile, parseDeviceConnection, type TrustedDevice, type DeviceConnection, type DeviceOperation, type AgentOperationDevice } from '@agentmux/core'

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
function denied(): AgentMuxError { return new AgentMuxError('Device authorization is unavailable or no longer valid.', 'CONTROL_PERMISSION_DENIED') }
function stateFrom(value: unknown): AuthorityState {
  const state = value as Partial<AuthorityState> | null
  if (!state || state.schema !== 'agentmux.device-authority.v1' || typeof state.hostId !== 'string'
    || !state.hostId || !Array.isArray(state.devices) || state.devices.length > MAX_DEVICES) {
    throw new AgentMuxError('The durable Host device identity cannot be read. Preserve this file and restore its original identity.', 'CONTROL_PROTOCOL_ERROR')
  }
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
  return { schema: state.schema, hostId: state.hostId, devices: state.devices }
}

/** Device admission belongs to the Host; it never owns a Session, Run or attachment. */
export class DeviceAuthority {
  private readonly activityIssues = new Map<string, string>()
  private readonly connectionIssues = new Map<string, string>()
  /** Latest metadata only: at most MAX_DEVICES patches, one scheduled writer, no event log. */
  private readonly pendingObservations = new Map<string, DeviceObservation>()
  private observationScheduled = false
  private diskUnconfirmed = false
  private readonly readers = new Map<string, Set<AbortController>>()
  private saveTail: Promise<void> = Promise.resolve()

  private constructor(private readonly path: string, private state: AuthorityState,
    private readonly now: () => number) {
    for (const device of state.devices) if (device.connection !== undefined && !connectionFrom(device.connection)) {
      this.connectionIssues.set(device.deviceId, '设备连接信息无法读取；原身份、授权和连接保留。重新连接可记录当前信息。')
    }
  }

  /** Open only after the original Host endpoint is owned. Invalid state is never regenerated. */
  static async open(path: string, now: () => number = Date.now): Promise<DeviceAuthority> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    let state: AuthorityState
    try { state = stateFrom(JSON.parse(await readFile(path, 'utf8'))) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      state = { schema: 'agentmux.device-authority.v1', hostId: mintObjectId(), devices: [] }
      await durableWriteFile(path, JSON.stringify(state) + '\n', { requireDirectorySync: true })
    }
    return new DeviceAuthority(path, state, now)
  }

  get hostId(): string { return this.state.hostId }
  devices(): readonly TrustedDevice[] { return this.state.devices.map(device => ({ ...publicDevice(this.observedDevice(device)),
    online: (this.readers.get(device.deviceId)?.size ?? 0) > 0,
    ...(device.lastSeenAt === undefined ? {} : { lastSeenAt: device.lastSeenAt }), operations: device.operations ?? [],
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
    if (principal?.kind === 'user') return { hostId: this.hostId, deviceId: 'local', name: '本机 Mac' }
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
    await this.change(state => ({ ...state, devices: state.devices.map(device => {
      if (device.deviceId !== source.deviceId) return device
      const operations = [...(device.operations ?? [])]
      const id = operationId
      const operation: DeviceOperation = { id, method, target, at: this.now(), result }
      const index = operations.findIndex(o => o.id === id)
      if (index >= 0) operations[index] = operation; else operations.push(operation)
      return { ...device, lastSeenAt: this.now(), operations: operations.slice(-100) }
    }) }))
  }

  /** Admission follows a completed encrypted handshake; never accepts a business-supplied identity. */
  async authorizeKey(publicKey: string): Promise<TrustedDevice> {
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
      if (state.devices.length >= MAX_DEVICES) throw new AgentMuxError('Device admission is full. Existing Sessions remain available.', 'CONTROL_OWNER_BUSY')
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

  private async change(update: (state: AuthorityState) => AuthorityState): Promise<void> {
    const save = this.saveTail.then(async () => {
      if (this.diskUnconfirmed && !await this.reconcileDisk()) {
        for (const device of this.state.devices) this.noteConnectionStorageIssue(device.deviceId)
        throw new AgentMuxError('The original device file has an unconfirmed write and cannot be read. Existing connections remain available; inspect storage and read the original device state before another write.', 'CONTROL_UNAVAILABLE')
      }
      const next = update(this.state)
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
    if (this.diskUnconfirmed && !await this.reconcileDisk()) throw new AgentMuxError(
      'The original device authority storage is unconfirmed; the saved input remains waiting.', 'CONTROL_UNAVAILABLE')
    const current = this.state.devices.find(value => value.deviceId === device.deviceId)
    if (!current || current.createdAt !== device.createdAt || current.credentialHash !== digest(publicKey) || current.revokedAt !== undefined) throw denied()
  }

  /** A continuing request/stream observes revocation without affecting any other device or Run. */
  observe(device: TrustedDevice, info?: Pick<DeviceConnection, 'address' | 'userAgent'>): { signal: AbortSignal; dispose(): void } {
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
