import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { DeviceAuthority } from '../src/device-authority.js'

const savePause = vi.hoisted(() => ({ next: undefined as undefined | { started(): void; resume: Promise<void> } }))
vi.mock('@agentmux/core', async importOriginal => {
  const actual = await importOriginal<typeof import('@agentmux/core')>()
  return { ...actual, durableWriteFile: async (...args: Parameters<typeof actual.durableWriteFile>) => {
    const pause = savePause.next
    if (pause) { savePause.next = undefined; pause.started(); await pause.resume }
    return actual.durableWriteFile(...args)
  } }
})

const temporary: string[] = []
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-device-authority-'))
  temporary.push(root)
  let now = 10_000
  const path = join(root, 'devices.json')
  const authority = await DeviceAuthority.open(path, () => now)
  return { authority, path, advance: (milliseconds: number) => { now += milliseconds } }
}

async function approve(authority: DeviceAuthority, name: string) {
  const invite = authority.invite()
  const pending = authority.begin(invite.hostId, invite.invitation, name)
  await authority.approve(pending.deviceId, pending.confirmationCode)
  const claimed = authority.claim(pending.hostId, pending.deviceId, pending.claim)
  expect(claimed.state).toBe('approved')
  if (claimed.state !== 'approved') throw new Error('Expected a confirmed device credential.')
  return { ...claimed, invite, pending }
}

describe('Host device authority', () => {
  it('requires local confirmation and consumes invitation and claim exactly once', async () => {
    const { authority } = await fixture()
    const invitation = authority.invite()
    const pending = authority.begin(invitation.hostId, invitation.invitation, 'iPhone')
    expect(authority.requests()).toEqual([{ device: { deviceId: pending.deviceId, name: 'iPhone', createdAt: 10_000 },
      confirmationCode: pending.confirmationCode, expiresAt: pending.expiresAt }])
    expect(authority.claim(pending.hostId, pending.deviceId, pending.claim)).toEqual({ state: 'waiting' })
    expect(() => authority.begin(invitation.hostId, invitation.invitation, 'Replay')).toThrow()
    await expect(authority.approve(pending.deviceId, 'incorrect-code')).rejects.toThrow()
    expect(authority.devices()).toMatchObject([])
    await authority.approve(pending.deviceId, pending.confirmationCode)
    const claimed = authority.claim(pending.hostId, pending.deviceId, pending.claim)
    expect(claimed.state).toBe('approved')
    expect(() => authority.claim(pending.hostId, pending.deviceId, pending.claim)).toThrow()
    await expect(authority.approve(pending.deviceId, pending.confirmationCode)).rejects.toThrow()
  })

  it('rejects expired invitations, wrong Host identity and rejected requests', async () => {
    const { authority, advance } = await fixture()
    const invitation = authority.invite()
    expect(() => authority.begin('different-host', invitation.invitation, 'Wrong Host')).toThrow()
    advance(5 * 60_000)
    expect(() => authority.begin(invitation.hostId, invitation.invitation, 'Expired')).toThrow()
    const fresh = authority.invite()
    const pending = authority.begin(fresh.hostId, fresh.invitation, 'Rejected')
    authority.reject(pending.deviceId)
    await expect(authority.approve(pending.deviceId, pending.confirmationCode)).rejects.toThrow()
    expect(() => authority.claim(pending.hostId, pending.deviceId, pending.claim)).toThrow()
    expect(authority.devices()).toMatchObject([])
  })

  it('persists stable Host and separate device identities without persisting any raw secret', async () => {
    const { authority, path } = await fixture()
    const iphone = await approve(authority, 'iPhone')
    const android = await approve(authority, 'Android')
    const source = await readFile(path, 'utf8')
    for (const value of [iphone.credential, android.credential, iphone.invite.invitation, android.invite.invitation,
      iphone.pending.claim, android.pending.claim]) expect(source).not.toContain(value)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    const reopened = await DeviceAuthority.open(path)
    expect(reopened.hostId).toBe(authority.hostId)
    expect(reopened.devices()).toMatchObject([iphone.device, android.device])
    expect(reopened.authenticate(reopened.hostId, iphone.credential)).toEqual(iphone.device)
    expect(reopened.authenticate(reopened.hostId, android.credential)).toEqual(android.device)
    expect(iphone.credential).not.toBe(android.credential)
    expect(() => reopened.authenticate('other-host', iphone.credential)).toThrow()
    expect(() => reopened.authenticate(reopened.hostId, iphone.invite.invitation)).toThrow()
  })

  it('revokes only the selected device and all its continuing requests after durable save', async () => {
    const { authority, path } = await fixture()
    const iphone = await approve(authority, 'iPhone')
    const android = await approve(authority, 'Android')
    const first = authority.observe(iphone.device), second = authority.observe(iphone.device)
    const other = authority.observe(android.device)
    await authority.revoke(iphone.device.deviceId)
    expect([first.signal.aborted, second.signal.aborted, other.signal.aborted]).toEqual([true, true, false])
    expect(() => authority.authenticate(authority.hostId, iphone.credential)).toThrow()
    expect(() => authority.observe(iphone.device)).toThrow()
    expect(authority.authenticate(authority.hostId, android.credential)).toEqual(android.device)
    const reopened = await DeviceAuthority.open(path)
    expect(() => reopened.authenticate(authority.hostId, iphone.credential)).toThrow()
    expect(reopened.authenticate(authority.hostId, android.credential)).toEqual(android.device)
    first.dispose(); second.dispose(); other.dispose()
  })

  it('serializes concurrent approvals and revocation without losing an independent device', async () => {
    const { authority, path } = await fixture()
    const invites = [authority.invite(), authority.invite()]
    const pending = invites.map((invite, index) => authority.begin(invite.hostId, invite.invitation, `Phone ${index}`))
    await Promise.all(pending.map(value => authority.approve(value.deviceId, value.confirmationCode)))
    await Promise.all(pending.map(value => authority.revoke(value.deviceId)))
    const reopened = await DeviceAuthority.open(path)
    expect(reopened.devices()).toMatchObject(pending.map(value => ({ deviceId: value.deviceId, name: authority.devices()
      .find(device => device.deviceId === value.deviceId)!.name, createdAt: 10_000, revokedAt: 10_000 })))
    for (const value of pending) expect(() => authority.claim(value.hostId, value.deviceId, value.claim)).toThrow()
  })

  it('keeps an unconfirmed device untrusted when its pending claim expires', async () => {
    const { authority, advance } = await fixture()
    const invitation = authority.invite()
    const pending = authority.begin(invitation.hostId, invitation.invitation, 'iPhone')
    advance(5 * 60_000)
    await expect(authority.approve(pending.deviceId, pending.confirmationCode)).rejects.toThrow()
    expect(() => authority.claim(pending.hostId, pending.deviceId, pending.claim)).toThrow()
    expect(authority.requests()).toEqual([])
    expect(authority.devices()).toMatchObject([])
  })

  it('admits only one remaining durable slot when two confirmed requests race', async () => {
    const { authority: initial, path } = await fixture()
    const existing = Array.from({ length: 99 }, (_, index) => ({ deviceId: randomUUID(), name: `Original ${index}`,
      createdAt: 1, credentialHash: createHash('sha256').update(randomBytes(32)).digest('hex') }))
    await writeFile(path, JSON.stringify({ schema: 'agentmux.device-authority.v1', hostId: initial.hostId, devices: existing }))
    const authority = await DeviceAuthority.open(path)
    const requests = ['iPhone', 'Android'].map(name => {
      const invitation = authority.invite()
      return authority.begin(invitation.hostId, invitation.invitation, name)
    })
    const outcomes = await Promise.allSettled(requests.map(request => authority.approve(request.deviceId, request.confirmationCode)))
    expect(outcomes.map(value => value.status)).toEqual(['fulfilled', 'rejected'])
    const reopened = await DeviceAuthority.open(path)
    expect(reopened.devices()).toHaveLength(100)
    expect(reopened.devices().slice(0, 99)).toMatchObject(existing.map(({ credentialHash: _hash, ...device }) => device))
    expect(reopened.devices()[99]?.deviceId).toBe(requests[0]!.deviceId)
  })

  it('reports an already admitted approval honestly when rejection races its durable save', async () => {
    const { authority, path } = await fixture()
    const invitation = authority.invite()
    const pending = authority.begin(invitation.hostId, invitation.invitation, 'iPhone')
    let saving!: () => void, resume!: () => void
    const started = new Promise<void>(resolve => { saving = resolve })
    savePause.next = { started: saving, resume: new Promise<void>(resolve => { resume = resolve }) }
    const approving = authority.approve(pending.deviceId, pending.confirmationCode)
    await started
    try {
      expect(() => authority.reject(pending.deviceId)).toThrow('Device approval is being saved')
      expect(authority.claim(pending.hostId, pending.deviceId, pending.claim)).toEqual({ state: 'waiting' })
      expect(authority.devices()).toMatchObject([])
    } finally { resume() }
    await approving
    expect(() => authority.reject(pending.deviceId)).toThrow('already approved')
    await authority.revoke(pending.deviceId)
    expect(() => authority.claim(pending.hostId, pending.deviceId, pending.claim)).toThrow()
    expect((await DeviceAuthority.open(path)).devices()).toMatchObject([{ deviceId: pending.deviceId, name: 'iPhone',
      createdAt: 10_000, revokedAt: 10_000 }])
  })

  it('preserves malformed durable identity rather than silently issuing a different Host', async () => {
    const { path } = await fixture()
    const damaged = '{"schema":"unexpected","hostId":"original-host","devices":[]}'
    await writeFile(path, damaged)
    await expect(DeviceAuthority.open(path)).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe(damaged)
  })
})

it('keeps device activity durable, deduplicates online readers and bounds related activity without recording prompt text', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentmux-link-activity-'))
  try {
    const path = join(directory, 'devices.json'), owner = await DeviceAuthority.open(path)
    const link = owner.connectionLink('https://127.0.0.1:7443')
    const admitted = await owner.exchangeLink(new URL(link.url).hash.slice(9), 'iPhone')
    const first = owner.observe(admitted.device), second = owner.observe(admitted.device)
    expect(owner.devices().filter(device => device.online)).toHaveLength(1)
    first.dispose(); expect(owner.devices()[0]!.online).toBe(true)
    second.dispose(); expect(owner.devices()[0]!.online).toBe(false)
    const source = owner.operationSource({ kind: 'device', id: owner.hostId + ':' + admitted.device.deviceId })!
    await owner.recordOperation(source, 'submitAgentPrompt', [{ agentSessionId: 'a123456789012345', prompt: 'private body' }], 'unknown', 'original-op')
    await owner.recordOperation(source, 'submitAgentPrompt', [{ agentSessionId: 'a123456789012345' }], 'confirmed', 'original-op')
    expect(owner.devices()[0]!.operations).toHaveLength(1)
    const reopened = await DeviceAuthority.open(path)
    expect(reopened.hostId).toBe(owner.hostId)
    expect(reopened.authenticate(owner.hostId, admitted.credential).deviceId).toBe(admitted.device.deviceId)
    expect(reopened.devices()[0]!.operations?.[0]).toMatchObject({ id: 'original-op', target: 'a123456789012345', result: 'confirmed' })
    expect(await readFile(path, 'utf8')).not.toContain('private body')
    for (let i = 0; i < 103; i++) await owner.recordOperation(source, 'writeAgent', [{ agentSessionId: 'a123456789012345', data: 'secret' }], 'confirmed', `op-${i}`)
    expect(owner.devices()[0]!.operations).toHaveLength(100)
    expect(await readFile(path, 'utf8')).not.toContain('secret')
  } finally { await rm(directory, { recursive: true, force: true }) }
})
