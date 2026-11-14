import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { BinaryWriter } from '@bufbuild/protobuf'
const person = vi.hoisted(() => ({ show: vi.fn() }))
vi.mock('electron', () => ({ dialog: { showMessageBox: person.show }, app: { getPath: () => '/unused-private-fixture' }, BrowserWindow: class {} }))
import { confirmProfileStorage } from '../src/main/browser-profile-storage-confirmation.js'
import { BrowserProfileStorage } from '../src/main/browser-profile-storage.js'
import type { BrowserProfileStorageClearInput, BrowserProfileStorageReceipt } from '@agentmux/core/control'

const profile = { id: 'original-profile-uuid', revision: 'original-revision', label: 'Personal' }
const origins = ['https://docs.example.test', 'https://mail.example.test', 'http://localhost:8123', 'https://media.example.test', 'https://assets.example.test']
const input: BrowserProfileStorageClearInput = { profileId: profile.id, expectedRevision: profile.revision, operationId: 'original-clear-operation', sites: origins.map(origin => ({ origin, storageKeys: [origin + '/'] })) }
const window = { isDestroyed: () => false }
afterEach(() => { person.show.mockReset() })

it('presents a short ordinary question with the exact Profile and five complete sites, keeping Cancel default', async () => {
  person.show.mockResolvedValue({ response: 0 })
  const before = structuredClone(input)
  expect(await confirmProfileStorage(input, window as never, profile)).toBe(false)
  expect(person.show).toHaveBeenCalledTimes(1)
  const [originalWindow, options] = person.show.mock.calls[0]!
  expect(originalWindow).toBe(window)
  expect(options).toMatchObject({ type: 'question', message: 'Clear offline cache?', buttons: ['Cancel', 'Clear offline cache'], defaultId: 0, cancelId: 0 })
  expect(options.detail).toBe(`5 sites in “Personal”. Your sign-in data will be kept.\n\nOffline copies and unsynced content may be lost.\n\nSites:\n${origins.join('\n')}`)
  expect(options.detail).not.toMatch(/uuid|revision|operation|partition|bucket|storageKey|Cache API|guaranteed|unrecognized/iu)
  expect(input).toEqual(before)
})
it('uses singular site copy without exposing original machine identities', async () => {
  person.show.mockResolvedValue({ response: 0 })
  await confirmProfileStorage({ ...input, sites: input.sites.slice(0, 1) }, window as never, profile)
  expect(person.show.mock.calls[0]![1].detail).toContain('1 site in “Personal”.')
})
it('only the native affirmative response grants confirmation', async () => {
  for (const response of [0, 2, -1, 1]) {
    person.show.mockResolvedValueOnce({ response })
    expect(await confirmProfileStorage(input, window as never, profile)).toBe(response === 1)
  }
})
it('does not ask for a different original Profile or revision, unavailable Profile, or destroyed window', async () => {
  person.show.mockResolvedValue({ response: 1 })
  expect(await confirmProfileStorage(input, window as never, { ...profile, id: 'different-profile' })).toBe(false)
  expect(await confirmProfileStorage(input, window as never, { ...profile, revision: 'different-revision' })).toBe(false)
  expect(await confirmProfileStorage(input, window as never, undefined)).toBe(false)
  expect(await confirmProfileStorage(input, { isDestroyed: () => true } as never, profile)).toBe(false)
  expect(person.show).not.toHaveBeenCalled()
})
it('the actual storage owner consumes native Cancel once, preserving the frozen request and dispatching nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amux-confirmation-owner-'))
  try {
    const site = input.sites[0]!, url = new URL(site.origin), hash = createHash('sha1').update(`${url.protocol.slice(0, -1)}_${url.hostname}_${url.port || '0'}`).digest('hex')
    const directory = join(root, 'Service Worker', 'CacheStorage', hash)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'index.txt'), new BinaryWriter().tag(2, 2).string(site.origin + '/').tag(3, 2).string(site.storageKeys[0]!).tag(4, 0).int64(1).tag(5, 0).bool(true).finish())
    const receipts: BrowserProfileStorageReceipt[] = [], native = vi.fn()
    const owner = new BrowserProfileStorage({ root: () => root, read: async () => ({ revision: profile.revision, receipts }),
      change: async (_id, run) => run(), native, save: async (_id, value) => { receipts.splice(0, receipts.length, structuredClone(value)) } })
    owner.setConfirmationHandler(request => confirmProfileStorage(request, window as never, profile))
    person.show.mockImplementation(async () => { expect(receipts[0]?.status).toBe('awaiting-confirmation'); return { response: 0 } })
    const selected = { ...input, sites: [site] }, result = await owner.clear(selected)
    expect(result).toMatchObject({ ...selected, status: 'cancelled', results: [{ storageKey: site.storageKeys[0], status: 'not-dispatched' }] })
    expect(person.show).toHaveBeenCalledTimes(1)
    expect(native).not.toHaveBeenCalled()
    expect((await owner.clear(selected)).status).toBe('cancelled')
    expect(person.show).toHaveBeenCalledTimes(1)
  } finally { await rm(root, { recursive: true, force: true }) }
})
