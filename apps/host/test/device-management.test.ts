import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProcessRunner } from '@agentmux/core'
import { DeviceAuthority } from '../src/device-authority.js'
import { DeviceManagement, type DeviceManagementContext } from '../src/device-management.js'
import { createMacDeviceConfirmation } from '../src/mac-device-confirmation.js'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function failure(operation: Promise<unknown>): Promise<unknown> { return await operation.then(value => value, (error: unknown) => error) }
const context: DeviceManagementContext = { transport: 'unix', principal: { kind: 'user', id: 'local-user:fixture' } }
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'agentmux-device-management-')); directories.push(directory)
  const path = join(directory, 'devices.json'); let now = 10_000
  const authority = await DeviceAuthority.open(path, () => now)
  const run = vi.fn<ProcessRunner>(async (_cmd, args) => ({ stdout: `${args.at(-1)}:confirmed\n`, stderr: '', exitCode: 0 }))
  const manager = new DeviceManagement(authority, createMacDeviceConfirmation({ run, platform: 'darwin' }))
  const begin = (name = 'iPhone') => { const invitation = authority.invite(); return authority.begin(invitation.hostId, invitation.invitation, name) }
  return { authority, path, run, manager, begin, advance: () => { now += 300_001 } }
}

describe('Original Host DeviceAuthority management preparation', () => {
  it('derives all five results from one original Authority; revoke ends only the exact device readers', async () => {
    const f = await fixture()
    const invite = await f.manager.invite({}, context)
    const pending = f.authority.begin(invite.hostId, invite.invitation, 'iPhone')
    expect((await f.manager.ls({}, context)).requests).toEqual([{ device: { deviceId: pending.deviceId, name: 'iPhone', createdAt: 10_000 }, confirmationCode: pending.confirmationCode, expiresAt: pending.expiresAt }])
    const approved = await f.manager.approve({ deviceId: pending.deviceId, confirmationCode: pending.confirmationCode }, context)
    expect(approved).toEqual({ hostId: f.authority.hostId, device: { deviceId: pending.deviceId, name: 'iPhone', createdAt: 10_000 } })
    expect(JSON.stringify(approved)).not.toMatch(/credential|claim/u)
    const claimed = f.authority.claim(pending.hostId, pending.deviceId, pending.claim)
    if (claimed.state !== 'approved') throw new Error('Original approval did not close')
    const readers = [f.authority.observe(claimed.device), f.authority.observe(claimed.device)]
    const other = f.begin('Android'); await f.authority.approve(other.deviceId, other.confirmationCode)
    const otherClaim = f.authority.claim(other.hostId, other.deviceId, other.claim)
    if (otherClaim.state !== 'approved') throw new Error('Second actual device missing')
    const otherReader = f.authority.observe(otherClaim.device)
    const rejected = f.begin('unapproved')
    expect(await f.manager.reject({ deviceId: rejected.deviceId }, context)).toEqual({ hostId: f.authority.hostId, deviceId: rejected.deviceId, state: 'denied' })
    expect(() => f.authority.claim(rejected.hostId, rejected.deviceId, rejected.claim)).toThrow()
    const revoked = await f.manager.revoke({ deviceId: claimed.device.deviceId }, context)
    expect(revoked.device.revokedAt).toBe(10_000)
    expect(readers.map(value => value.signal.aborted)).toEqual([true, true]); expect(otherReader.signal.aborted).toBe(false)
    expect(f.authority.authenticate(other.hostId, otherClaim.credential)).toEqual(otherClaim.device)
    expect(f.run.mock.calls.map(value => value[1][3])).toEqual(['invite', 'approve', 'reject', 'revoke'])
    expect(JSON.parse(await readFile(f.path, 'utf8')).devices).toHaveLength(2)
    for (const reader of [...readers, otherReader]) reader.dispose()
  })
  it('refuses managed, device, HTTP bearer, missing transport and forged params before the native port', async () => {
    const f = await fixture(), pending = f.begin()
    const forbidden: DeviceManagementContext[] = [{ ...context, caller: { capability: 'managed' } },
      { transport: 'unix', principal: { kind: 'device', id: 'approved-device' } }, { ...context, transport: 'http' },
      { principal: context.principal! }, { ...context, transport: 'stdio' }, { transport: 'unix' }]
    expect(forbidden).toHaveLength(6); expect(f.authority.requests()).toHaveLength(1)
    for (const caller of forbidden) {
      await expect(await failure(f.manager.ls({}, caller))).toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
      await expect(await failure(f.manager.invite({}, caller))).toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
      await expect(await failure(f.manager.approve({ deviceId: pending.deviceId, confirmationCode: pending.confirmationCode }, caller))).toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
      await expect(await failure(f.manager.reject({ deviceId: pending.deviceId }, caller))).toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
      await expect(await failure(f.manager.revoke({ deviceId: pending.deviceId }, caller))).toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
    }
    await expect(await failure(f.manager.invite({ user: true } as never, context))).toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
    await expect(await failure(f.manager.approve({ deviceId: pending.deviceId, confirmationCode: pending.confirmationCode, confirmed: true } as never, context))).toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
    expect(f.run).not.toHaveBeenCalled(); expect(f.authority.devices()).toEqual([])
  })
  it('preserves pending and durable originals on native cancel or unknown; never resubmits by itself', async () => {
    const f = await fixture(), pending = f.begin(), original = await readFile(f.path)
    f.run.mockImplementationOnce(async (_cmd, args) => ({ stdout: `${args.at(-1)}:cancelled\n`, stderr: '', exitCode: 0 }))
    await expect(await failure(f.manager.approve({ deviceId: pending.deviceId, confirmationCode: pending.confirmationCode }, context))).toMatchObject({ code: 'DEVICE_CONFIRMATION_CANCELLED' })
    f.run.mockImplementationOnce(async () => ({ stdout: 'unknown', stderr: '', exitCode: 0 }))
    await expect(await failure(f.manager.reject({ deviceId: pending.deviceId }, context))).toMatchObject({ code: 'DEVICE_CONFIRMATION_UNCONFIRMED' })
    expect(f.run).toHaveBeenCalledTimes(2); expect(await readFile(f.path)).toEqual(original)
    expect(f.authority.requests()).toHaveLength(1); expect(f.authority.claim(pending.hostId, pending.deviceId, pending.claim)).toEqual({ state: 'waiting' })
  })
  it('requires the original exact code and rechecks expiry after a real confirmation result', async () => {
    const f = await fixture(), pending = f.begin()
    const wrong = pending.confirmationCode === '000000' ? '999999' : '000000'
    await expect(await failure(f.manager.approve({ deviceId: pending.deviceId, confirmationCode: wrong }, context))).toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
    expect(f.run).not.toHaveBeenCalled()
    f.run.mockImplementationOnce(async (_cmd, args) => { f.advance(); return { stdout: `${args.at(-1)}:confirmed\n`, stderr: '', exitCode: 0 } })
    await expect(await failure(f.manager.approve({ deviceId: pending.deviceId, confirmationCode: pending.confirmationCode }, context))).toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
    expect(f.authority.devices()).toEqual([]); expect(f.run).toHaveBeenCalledOnce()
  })
  it('keeps the original target while busy and refuses a lost-response duplicate approval', async () => {
    const f = await fixture(), pending = f.begin()
    let release!: () => void
    f.run.mockImplementationOnce(async (_cmd, args) => { await new Promise<void>(resolve => { release = resolve }); return { stdout: `${args.at(-1)}:confirmed\n`, stderr: '', exitCode: 0 } })
    const first = f.manager.approve({ deviceId: pending.deviceId, confirmationCode: pending.confirmationCode }, context)
    await expect(await failure(f.manager.reject({ deviceId: pending.deviceId }, context))).toMatchObject({ code: 'CONTROL_OWNER_BUSY' })
    release(); await first
    await expect(await failure(f.manager.approve({ deviceId: pending.deviceId, confirmationCode: pending.confirmationCode }, context))).toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
    expect(f.run).toHaveBeenCalledOnce(); expect((await f.manager.ls({}, context)).devices.map(value => value.deviceId)).toEqual([pending.deviceId])
  })
  it('does not commit a late confirmation after request cancellation or reject a changed pending target as success', async () => {
    const f = await fixture(), pending = f.begin(), controller = new AbortController()
    f.run.mockImplementationOnce(async (_cmd, args) => { controller.abort(); return { stdout: `${args.at(-1)}:confirmed\n`, stderr: '', exitCode: 0 } })
    await expect(await failure(f.manager.approve({ deviceId: pending.deviceId, confirmationCode: pending.confirmationCode }, { ...context, signal: controller.signal }))).toMatchObject({ code: 'DEVICE_CONFIRMATION_UNCONFIRMED' })
    f.run.mockImplementationOnce(async (_cmd, args) => { await f.authority.approve(pending.deviceId, pending.confirmationCode); return { stdout: `${args.at(-1)}:confirmed\n`, stderr: '', exitCode: 0 } })
    await expect(await failure(f.manager.reject({ deviceId: pending.deviceId }, context))).toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
    expect(f.authority.devices().map(value => value.deviceId)).toEqual([pending.deviceId])
  })
})
