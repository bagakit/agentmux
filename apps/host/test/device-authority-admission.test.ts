import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { exportPublicKey, generateKeyPair } from '@agentmux/relay/e2ee'
import { DeviceAuthority } from '../src/device-authority.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

const newKey = () => exportPublicKey(generateKeyPair().publicKey)
const digest = (key: string) => createHash('sha256').update(key).digest('hex')

/** A durable registry whose devices carry real relay public keys, the given number of them revoked. */
async function registry(total: number, revoked: number) {
  const root = await mkdtemp(join(tmpdir(), 'amx-device-admission-')); roots.push(root)
  const path = join(root, 'agentmux-devices.json'), keys = Array.from({ length: total }, newKey)
  const devices = keys.map((key, index) => ({ deviceId: `device-${index}`, name: `设备 ${index}`, createdAt: 1000 + index,
    credentialHash: digest(key), credentialKind: 'relay-key', ...(index < revoked ? { revokedAt: 5000 + index } : {}) }))
  await writeFile(path, JSON.stringify({ schema: 'agentmux.device-authority.v1', hostId: 'original-host', devices }) + '\n')
  return { path, keys }
}

it('admits a new device once revoked history fills the registry, and keeps every original record', async () => {
  const { path, keys } = await registry(100, 99)
  const owner = await DeviceAuthority.open(path)
  const admitted = await owner.authorizeKey(newKey())
  expect(admitted.revokedAt).toBeUndefined()
  await owner.flush()
  // Reopening reads all 101 records: history no longer counts as a damaged file.
  const reopened = await DeviceAuthority.open(path)
  expect(reopened.hostId).toBe('original-host')
  expect(reopened.devices()).toHaveLength(101)
  expect(reopened.devices().filter(device => device.revokedAt !== undefined)).toHaveLength(99)
  expect(JSON.parse(await readFile(path, 'utf8')).devices).toHaveLength(101)
  // A revoked key stays refused, and a known key is not registered twice.
  await expect(reopened.authorizeKey(keys[0]!)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect((await reopened.authorizeKey(keys[99]!)).deviceId).toBe('device-99')
  expect(reopened.devices()).toHaveLength(101)
})

it('still refuses a new device while 100 devices hold live authorization', async () => {
  const { path } = await registry(100, 0)
  const owner = await DeviceAuthority.open(path)
  await expect(owner.authorizeKey(newKey())).rejects.toMatchObject({ code: 'CONTROL_OWNER_BUSY' })
  expect(owner.devices()).toHaveLength(100)
})

it('frees a place when a live device is revoked', async () => {
  const { path } = await registry(100, 0)
  const owner = await DeviceAuthority.open(path)
  await owner.revoke('device-0')
  expect((await owner.authorizeKey(newKey())).revokedAt).toBeUndefined()
  expect(owner.devices()).toHaveLength(101)
})
