import * as filesystem from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DEFAULT_MOTE_FACE } from '@agentmux/core/mote-face'
import { MoteAvatarSeriesOwner } from '../src/main/mote-avatar-series'
import { MoteAvatarControl } from '../src/main/mote-avatar-control'
import { controlledNativeImage, imagePng } from './fixtures/mote-identity-image'

const roots: string[] = []
const fault = vi.hoisted(() => ({ readme: false }))
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, open: async (...args: Parameters<typeof original.open>) => {
    if (fault.readme && String(args[0]).endsWith('/README.md')) throw Object.assign(new Error('Private write unavailable'), { code: 'EIO' })
    return original.open(...args)
  } }
})
afterEach(async () => { fault.readme = false; await Promise.all(roots.splice(0).map(root => filesystem.rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await filesystem.realpath(await filesystem.mkdtemp(join(tmpdir(), 'mote-avatar-starter-'))); roots.push(root)
  const userRoot = join(root, 'user'), builtinRoot = join(root, 'builtin')
  await filesystem.mkdir(join(builtinRoot, 'lowpoly'), { recursive: true })
  const sample = imagePng()
  await filesystem.writeFile(join(builtinRoot, 'lowpoly/lowpoly-owl.png'), sample)
  const owner = new MoteAvatarSeriesOwner({ userRoot, builtinRoot }, controlledNativeImage)
  return { root, userRoot, builtinRoot, owner, sample }
}

it('creates a new mixed source without selecting an avatar, and prepares both original entry kinds', async () => {
  const { owner, userRoot, sample } = await fixture()
  const created = await owner.createSeries({ seriesId: 'my-pets', title: 'My pets' })
  expect(created).toEqual({ seriesId: 'my-pets', title: 'My pets', path: join(userRoot, 'my-pets'), files: ['starter.png', 'series.json', 'README.md'], state: 'created' })
  expect(await filesystem.readFile(join(created.path, 'starter.png'))).toEqual(sample)
  expect(await filesystem.readFile(join(created.path, 'README.md'), 'utf8')).toContain('Save avatar is a separate explicit action')
  const catalog = await owner.list(), entry = catalog.series.find(series => series.origin === 'user' && series.seriesId === 'my-pets')!
  expect(entry.entries.map(value => value.definition.kind)).toEqual(['image', 'face2d'])
  expect((await owner.preview({ source: { origin: 'user', seriesId: 'my-pets', entryId: 'face' } })).definition).toEqual({ kind: 'face2d', face: DEFAULT_MOTE_FACE })
  expect((await owner.preview({ source: { origin: 'user', seriesId: 'my-pets', entryId: 'starter' } })).payload.kind).toBe('image')
})

it('validates the actual sample before creating a missing user root', async () => {
  const { owner, userRoot, builtinRoot } = await fixture()
  await filesystem.writeFile(join(builtinRoot, 'lowpoly/lowpoly-owl.png'), 'invalid image')
  await expect(owner.createSeries({ seriesId: 'pets', title: 'Pets' })).rejects.toThrow()
  await expect(filesystem.lstat(userRoot)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('refuses existing paths and linked user roots, while concurrent exact creates admit only one', async () => {
  const { owner, userRoot, root } = await fixture()
  await filesystem.mkdir(join(userRoot, 'existing'), { recursive: true })
  await filesystem.writeFile(join(userRoot, 'existing/kept.txt'), 'original bytes')
  await expect(owner.createSeries({ seriesId: 'existing', title: 'Another title' })).rejects.toMatchObject({ code: 'AVATAR_SERIES_EXISTS' })
  expect(await filesystem.readdir(join(userRoot, 'existing'))).toEqual(['kept.txt'])
  expect(await filesystem.readFile(join(userRoot, 'existing/kept.txt'), 'utf8')).toBe('original bytes')
  await filesystem.symlink(join(userRoot, 'existing'), join(userRoot, 'linked'))
  await expect(owner.createSeries({ seriesId: 'linked', title: 'Linked' })).rejects.toMatchObject({ code: 'AVATAR_SERIES_EXISTS' })
  const raced = await Promise.allSettled([owner.createSeries({ seriesId: 'raced', title: 'First' }), owner.createSeries({ seriesId: 'raced', title: 'Second' })])
  expect(raced.filter(value => value.status === 'fulfilled')).toHaveLength(1)
  expect(raced.filter(value => value.status === 'rejected')).toHaveLength(1)
  const alias = join(root, 'user-alias'); await filesystem.symlink(userRoot, alias)
  const linked = new MoteAvatarSeriesOwner({ userRoot: alias, builtinRoot: join(root, 'builtin') }, controlledNativeImage)
  await expect(linked.createSeries({ seriesId: 'outside', title: 'Outside' })).rejects.toThrow()
  await expect(filesystem.lstat(join(userRoot, 'outside'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('retains partial created files on a later native write failure and never retries or cleans them', async () => {
  const { owner, userRoot, sample } = await fixture()
  fault.readme = true
  await expect(owner.createSeries({ seriesId: 'partial', title: 'Partial' })).rejects.toMatchObject({ code: 'AVATAR_SERIES_CREATE_INCOMPLETE' })
  expect(await filesystem.readFile(join(userRoot, 'partial/starter.png'))).toEqual(sample)
  expect(JSON.parse(await filesystem.readFile(join(userRoot, 'partial/series.json'), 'utf8')).entries).toHaveLength(2)
  await expect(owner.createSeries({ seriesId: 'partial', title: 'Retry' })).rejects.toMatchObject({ code: 'AVATAR_SERIES_EXISTS' })
})

it('opens only the exact regular user series and distinguishes OS request failure from source availability', async () => {
  const { owner, userRoot } = await fixture()
  await owner.createSeries({ seriesId: 'pets', title: 'Pets' })
  const missingPort = new MoteAvatarControl(owner)
  await expect(missingPort.call('space.mote.avatar.series.reveal', { seriesId: 'pets' })).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  expect((await missingPort.call('space.mote.avatar.list', {})).series.some(series => series.seriesId === 'pets')).toBe(true)
  const reveal = vi.fn(async (_path: string) => {})
  const control = new MoteAvatarControl(owner, undefined, reveal)
  expect(await control.call('space.mote.avatar.series.reveal', { seriesId: 'pets' })).toEqual({ seriesId: 'pets', path: join(userRoot, 'pets'), outcome: 'requested' })
  expect(reveal).toHaveBeenCalledOnce(); expect(reveal).toHaveBeenCalledWith(join(userRoot, 'pets'))
  await filesystem.symlink(join(userRoot, 'pets'), join(userRoot, 'linked'))
  await expect(control.call('space.mote.avatar.series.reveal', { seriesId: 'linked' })).rejects.toThrow()
  expect(reveal).toHaveBeenCalledOnce()
  reveal.mockRejectedValueOnce(new Error('Private OS port refused'))
  await expect(control.call('space.mote.avatar.series.reveal', { seriesId: 'pets' })).rejects.toThrow('Private OS port refused')
  expect((await control.call('space.mote.avatar.list', {})).series.some(series => series.seriesId === 'pets')).toBe(true)
})
