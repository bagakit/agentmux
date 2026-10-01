import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { AgentMuxError, durableWriteFile, type TrustedDevice } from '@agentmux/core'

const INVITATION_LIFETIME_MS = 5 * 60_000
const PENDING_LIFETIME_MS = 5 * 60_000
const MAX_INVITATIONS = 16
const MAX_PENDING = 32
const MAX_DEVICES = 100

interface DeviceRecord extends TrustedDevice { readonly credentialHash: string }
interface AuthorityState {
  readonly schema: 'agentmux.device-authority.v1'
  readonly hostId: string
  readonly devices: readonly DeviceRecord[]
}

interface PendingDevice {
  readonly device: TrustedDevice
  readonly claimHash: string
  readonly confirmationCode: string
  readonly expiresAt: number
  state: 'waiting' | 'approving' | 'approved' | 'denied'
  credential?: string
}

export interface DevicePairingRequest {
  readonly hostId: string
  readonly deviceId: string
  readonly confirmationCode: string
  readonly claim: string
  readonly expiresAt: number
}

function secret(): string { return randomBytes(32).toString('base64url') }
function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }
function equalDigest(a: string, b: string): boolean {
  return /^[a-f0-9]{64}$/u.test(a) && /^[a-f0-9]{64}$/u.test(b)
    && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
}
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
  private readonly invitations = new Map<string, number>()
  private readonly pending = new Map<string, PendingDevice>()
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
  devices(): readonly TrustedDevice[] { return this.state.devices.map(publicDevice) }

  private prune(): void {
    const time = this.now()
    for (const [key, expiresAt] of this.invitations) if (expiresAt <= time) this.invitations.delete(key)
    for (const [id, pending] of this.pending) if (pending.expiresAt <= time) this.pending.delete(id)
  }

  /** Local Host approval UI/CLI only. An invitation is not a device credential. */
  invite(): { hostId: string; invitation: string; expiresAt: number } {
    this.prune()
    if (this.invitations.size >= MAX_INVITATIONS) throw new AgentMuxError('Too many active device invitations.', 'CONTROL_OWNER_BUSY')
    const invitation = secret(), expiresAt = this.now() + INVITATION_LIFETIME_MS
    this.invitations.set(digest(invitation), expiresAt)
    return { hostId: this.hostId, invitation, expiresAt }
  }

  begin(hostId: string, invitation: string, name: string): DevicePairingRequest {
    this.prune()
    if (hostId !== this.hostId || typeof invitation !== 'string' || invitation.length !== 43) throw denied()
    const hash = digest(invitation), expiresAt = this.invitations.get(hash)
    if (!expiresAt || expiresAt <= this.now()) throw denied()
    if (this.pending.size >= MAX_PENDING || this.state.devices.length >= MAX_DEVICES) {
      throw new AgentMuxError('Device admission is full. The original trusted devices are retained.', 'CONTROL_OWNER_BUSY')
    }
    const trimmed = typeof name === 'string' ? name.trim() : ''
    if (!trimmed || trimmed.length > 128) throw new AgentMuxError('Give this device a name of 1 to 128 characters.', 'INVALID_CONTROL_REQUEST')
    // Consume synchronously before publishing a request; a second exchange cannot race it.
    this.invitations.delete(hash)
    const claim = secret(), deviceId = randomUUID(), confirmationCode = randomBytes(4).readUInt32BE() % 1_000_000
    const pending: PendingDevice = { device: { deviceId, name: trimmed, createdAt: this.now() },
      claimHash: digest(claim), confirmationCode: String(confirmationCode).padStart(6, '0'),
      expiresAt: this.now() + PENDING_LIFETIME_MS, state: 'waiting' }
    this.pending.set(deviceId, pending)
    return { hostId: this.hostId, deviceId, claim, confirmationCode: pending.confirmationCode, expiresAt: pending.expiresAt }
  }

  requests(): readonly { device: TrustedDevice; confirmationCode: string; expiresAt: number }[] {
    this.prune()
    return [...this.pending.values()].filter(value => value.state === 'waiting').map(value => ({
      device: publicDevice(value.device), confirmationCode: value.confirmationCode, expiresAt: value.expiresAt }))
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

  /** A local user confirms the code displayed on both devices. There is no remote approve port. */
  async approve(deviceId: string, confirmationCode: string): Promise<TrustedDevice> {
    this.prune()
    const pending = this.pending.get(deviceId)
    if (!pending || pending.state !== 'waiting' || pending.confirmationCode !== confirmationCode) throw denied()
    pending.state = 'approving'
    const credential = secret()
    try {
      await this.change(state => {
        if (pending.expiresAt <= this.now() || pending.state !== 'approving') throw denied()
        if (state.devices.length >= MAX_DEVICES) {
          throw new AgentMuxError('Device admission is full. The original trusted devices are retained.', 'CONTROL_OWNER_BUSY')
        }
        return { ...state, devices: [...state.devices, { ...pending.device, credentialHash: digest(credential) }] }
      })
      pending.credential = credential; pending.state = 'approved'
      return publicDevice(pending.device)
    } catch (error) { if (pending.state === 'approving') pending.state = 'waiting'; throw error }
  }

  reject(deviceId: string): void {
    const pending = this.pending.get(deviceId)
    if (pending?.state === 'approving') {
      throw new AgentMuxError('Device approval is being saved. Wait for its result, then revoke the device if approved.', 'CONTROL_OWNER_BUSY')
    }
    if (pending?.state === 'approved') {
      throw new AgentMuxError('This device is already approved. Revoke its authorization to disconnect it.', 'CONTROL_OWNER_BUSY')
    }
    if (pending) pending.state = 'denied'
  }

  /** The transport consumes this once into HttpOnly Cookie or the native secret bridge, never Renderer JSON. */
  claim(hostId: string, deviceId: string, claim: string):
    { state: 'waiting' } | { state: 'approved'; device: TrustedDevice; credential: string } {
    this.prune()
    const pending = this.pending.get(deviceId)
    if (hostId !== this.hostId || !pending || !equalDigest(pending.claimHash, digest(claim)) || pending.state === 'denied') throw denied()
    if (pending.state !== 'approved') return { state: 'waiting' }
    if (!pending.credential || !this.state.devices.some(device => device.deviceId === deviceId && device.revokedAt === undefined)) throw denied()
    const credential = pending.credential
    this.pending.delete(deviceId)
    return { state: 'approved', device: publicDevice(pending.device), credential }
  }

  authenticate(hostId: string, credential: string): TrustedDevice {
    if (hostId !== this.hostId || typeof credential !== 'string' || credential.length !== 43) throw denied()
    const hash = digest(credential)
    const device = this.state.devices.find(device => device.revokedAt === undefined && equalDigest(device.credentialHash, hash))
    if (!device) throw denied()
    return publicDevice(device)
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
    this.pending.delete(deviceId)
    const readers = this.readers.get(deviceId)
    this.readers.delete(deviceId)
    for (const reader of readers ?? []) reader.abort(denied())
    return revoked!
  }
}
