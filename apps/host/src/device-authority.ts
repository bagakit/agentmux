import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { AgentMuxError, durableWriteFile, type TrustedDevice, type DeviceOperation, type AgentOperationDevice } from '@agentmux/core'

const MAX_DEVICES = 100

interface DeviceRecord extends TrustedDevice { readonly credentialHash: string }
interface AuthorityState {
  readonly schema: 'agentmux.device-authority.v1'
  readonly hostId: string
  readonly devices: readonly DeviceRecord[]
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }
function publicDevice(device: TrustedDevice): TrustedDevice {
  return { deviceId: device.deviceId, name: device.name, createdAt: device.createdAt,
    ...(device.revokedAt === undefined ? {} : { revokedAt: device.revokedAt }) }
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
  private readonly readers = new Map<string, Set<AbortController>>()
  private saveTail: Promise<void> = Promise.resolve()

  private constructor(private readonly path: string, private state: AuthorityState,
    private readonly now: () => number) {}

  /** Open only after the original Host endpoint is owned. Invalid state is never regenerated. */
  static async open(path: string, now: () => number = Date.now): Promise<DeviceAuthority> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    let state: AuthorityState
    try { state = stateFrom(JSON.parse(await readFile(path, 'utf8'))) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      state = { schema: 'agentmux.device-authority.v1', hostId: randomUUID(), devices: [] }
      await durableWriteFile(path, JSON.stringify(state) + '\n')
    }
    return new DeviceAuthority(path, state, now)
  }

  get hostId(): string { return this.state.hostId }
  devices(): readonly TrustedDevice[] { return this.state.devices.map(device => ({ ...publicDevice(device),
    online: (this.readers.get(device.deviceId)?.size ?? 0) > 0,
    ...(device.lastSeenAt === undefined ? {} : { lastSeenAt: device.lastSeenAt }), operations: device.operations ?? [], ...(this.activityIssues.has(device.deviceId) ? { operationIssue: this.activityIssues.get(device.deviceId)! } : {}) })) }

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
    if (retained) { if (retained.revokedAt !== undefined) throw denied(); return publicDevice(retained) }
    let admitted: TrustedDevice | undefined
    await this.change(state => {
      const existing = state.devices.find(device => device.credentialHash === hash)
      if (existing) { if (existing.revokedAt !== undefined) throw denied(); admitted = publicDevice(existing); return state }
      if (state.devices.length >= MAX_DEVICES) throw new AgentMuxError('Device admission is full. Existing Sessions remain available.', 'CONTROL_OWNER_BUSY')
      admitted = { deviceId: randomUUID(), name: `设备 ${hash.slice(0, 6)}`, createdAt: this.now() }
      return { ...state, devices: [...state.devices, { ...admitted, credentialHash: hash }] }
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
      const next = update(this.state)
      await durableWriteFile(this.path, JSON.stringify(next) + '\n')
      this.state = next
    })
    this.saveTail = save.catch(() => {})
    await save
  }

  /** A continuing request/stream observes revocation without affecting any other device or Run. */
  observe(device: TrustedDevice): { signal: AbortSignal; dispose(): void } {
    const record = this.state.devices.find(value => value.deviceId === device.deviceId && value.revokedAt === undefined)
    if (!record) throw denied()
    const controller = new AbortController()
    let readers = this.readers.get(device.deviceId)
    if (!readers) { readers = new Set(); this.readers.set(device.deviceId, readers) }
    if (readers.size >= 128) throw new AgentMuxError('This device has too many continuing requests.', 'CONTROL_OWNER_BUSY')
    readers.add(controller)
    return { signal: controller.signal, dispose: () => {
      readers.delete(controller)
      if (readers.size === 0) this.readers.delete(device.deviceId)
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
