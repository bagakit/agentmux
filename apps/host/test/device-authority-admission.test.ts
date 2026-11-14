import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { exportPublicKey, generateKeyPair } from '@agentmux/relay/e2ee'
import { DeviceAuthority } from '@agentmux/core/device-access'

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

const source = (deviceId: string) => ({ hostId: 'original-host', deviceId, name: '设备 0' })
const record = (owner: DeviceAuthority, index: number, result: 'confirmed' | 'failed' | 'unknown' = 'confirmed') =>
  owner.recordOperation(source('device-0'), 'submitAgentPrompt', [{ agentSessionId: `session-${index}` }], result, `operation-${index}`)
/** Every record the Host device owner holds for one device: archived lines first, then the authority file. */
async function heldOperations(path: string, deviceId: string) {
  const archive = path.replace(/\.json$/u, '-operations.jsonl')
  const lines = await readFile(archive, 'utf8').then(text => text.split('\n').filter(Boolean), (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const archived = lines.map(line => JSON.parse(line)).filter(value => value.deviceId === deviceId).map(({ deviceId: _, ...value }) => value)
  const device = JSON.parse(await readFile(path, 'utf8')).devices.find((value: { deviceId: string }) => value.deviceId === deviceId)
  return [...archived, ...(device.operations ?? [])] as Array<{ id: string; result: string }>
}

// Each operation is a real durable write of the authority file; 305 of them take seconds on a busy machine.
it('keeps every device operation, and device.ls shows only the newest window', async () => {
  const { path } = await registry(2, 0)
  const owner = await DeviceAuthority.open(path)
  for (let index = 0; index < 305; index++) await record(owner, index, index % 3 === 0 ? 'unknown' : index % 3 === 1 ? 'failed' : 'confirmed')
  // The same operation updates its record in place; nothing else moves.
  await record(owner, 304, 'confirmed')
  const window = owner.devices()[0]!.operations!
  expect(window).toHaveLength(100)
  expect(window[0]!.id).toBe('operation-205'); expect(window.at(-1)).toMatchObject({ id: 'operation-304', result: 'confirmed' })
  expect(owner.devices()[1]!.operations).toEqual([])
  const reopened = await DeviceAuthority.open(path)
  expect(reopened.devices()[0]!.operations).toEqual(window)
  const held = await heldOperations(path, 'device-0')
  expect(held.map(value => value.id)).toEqual(Array.from({ length: 305 }, (_, index) => `operation-${index}`))
  expect(held.slice(0, 3).map(value => value.result)).toEqual(['unknown', 'failed', 'confirmed'])
  expect(await heldOperations(path, 'device-1')).toEqual([])
  // The authority file keeps at most two windows per device, so its rewrite cost stays bounded.
  expect(JSON.parse(await readFile(path, 'utf8')).devices[0].operations.length).toBeLessThanOrEqual(200)
}, 60_000)

it('keeps operations in the authority file while their archive cannot be written', async () => {
  const { path } = await registry(1, 0)
  const archive = path.replace(/\.json$/u, '-operations.jsonl')
  await mkdir(archive)
  const owner = await DeviceAuthority.open(path)
  for (let index = 0; index < 250; index++) await record(owner, index)
  expect(owner.devices()[0]!.operations).toHaveLength(100)
  await expect(readFile(archive, 'utf8')).rejects.toMatchObject({ code: 'EISDIR' })
  const device = JSON.parse(await readFile(path, 'utf8')).devices[0]
  expect(device.operations.map((value: { id: string }) => value.id)).toEqual(Array.from({ length: 250 }, (_, index) => `operation-${index}`))
  // Once the archive is writable the next operation moves everything older than the window.
  await rm(archive, { recursive: true })
  await record(owner, 250)
  expect((await heldOperations(path, 'device-0')).map(value => value.id)).toEqual(Array.from({ length: 251 }, (_, index) => `operation-${index}`))
  expect(JSON.parse(await readFile(path, 'utf8')).devices[0].operations).toHaveLength(100)
}, 60_000)
