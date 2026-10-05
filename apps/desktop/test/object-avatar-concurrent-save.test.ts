import { createHash } from 'node:crypto'
import { mkdtemp, realpath, rm, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { saveObjectAvatarFile, readObjectAvatarFile } from '../src/main/object-avatar-files'
import { imagePng } from './fixtures/mote-identity-image'

const fault = vi.hoisted(() => ({
  active: false, claimed: false, fail: true,
  directoryFailure: undefined as undefined | string,
  entered: undefined as undefined | (() => void),
  release: undefined as undefined | Promise<void>
}))
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const file = await fs.open(...args), flags = args[1]
    const creates = flags === 'wx' || typeof flags === 'number' && Boolean(flags & fs.constants.O_EXCL)
    if (fault.active && !fault.claimed && creates && String(args[0]).includes('/.agentmux/avatars/')) {
      fault.claimed = true
      const sync = file.sync.bind(file), release = fault.release!, entered = fault.entered!, fail = fault.fail
      file.sync = async () => {
        entered()
        await release
        if (fail) throw Object.assign(new Error('Injected creator file fsync failure after another saver acknowledged the PNG'), { code: 'EIO' })
        await sync()
      }
    }
    if (String(args[0]) === fault.directoryFailure && !creates)
      file.sync = async () => { throw Object.assign(new Error('Injected parent-directory sync acknowledgement failure'), { code: 'EIO' }) }
    return file
  } }
})

const roots: string[] = []
afterEach(async () => {
  fault.active = false; fault.claimed = false; fault.fail = true
  fault.entered = undefined; fault.release = undefined
  fault.directoryFailure = undefined
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
function barrier() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
async function fixture() {
  const original = await realpath(await mkdtemp(join(tmpdir(), 'avatar-concurrent-save-')))
  roots.push(original)
  const png = imagePng()
  const ref = { kind: 'image' as const, fileName: createHash('sha256').update(png).digest('hex') + '.png' }
  return { original, png, ref, assets: join(original, '.agentmux', 'avatars') }
}
function holdCreatorSync(fail = true) {
  const entered = barrier(), release = barrier()
  Object.assign(fault, { active: true, claimed: false, fail, entered: entered.resolve, release: release.promise })
  return { entered, release }
}

it('retains a real acknowledged immutable PNG when an earlier creator fails its file fsync later', async () => {
  const { original, png, ref, assets } = await fixture(), hold = holdCreatorSync()
  const earlier = saveObjectAvatarFile(original, png).then(() => undefined, error => error)
  await hold.entered.promise
  const acknowledged = await saveObjectAvatarFile(original, png)
  expect(acknowledged).toEqual(ref)
  expect(await readObjectAvatarFile(original, acknowledged)).toEqual(png)
  hold.release.resolve()
  expect(await earlier).toMatchObject({ code: 'EIO' })
  expect(await readObjectAvatarFile(original, acknowledged)).toEqual(png)
  expect(await readdir(assets)).toEqual([ref.fileName])
})

it('does not expose the formal hash file before its creating file bytes have an fsync acknowledgement', async () => {
  const { original, png, ref, assets } = await fixture(), hold = holdCreatorSync(false)
  const pending = saveObjectAvatarFile(original, png)
  await hold.entered.promise
  try { await expect(readObjectAvatarFile(original, ref)).rejects.toMatchObject({ code: 'ENOENT' }) }
  finally { hold.release.resolve() }
  expect(await pending).toEqual(ref)
  expect(await readObjectAvatarFile(original, ref)).toEqual(png)
  expect(await readdir(assets)).toEqual([ref.fileName])
})

it('preserves ordinary immutable image save/read and same-bytes idempotence without leftover temporary files', async () => {
  const { original, png, ref, assets } = await fixture()
  expect(await saveObjectAvatarFile(original, png)).toEqual(ref)
  expect(await saveObjectAvatarFile(original, png)).toEqual(ref)
  expect(await readObjectAvatarFile(original, ref)).toEqual(png)
  expect(await readdir(assets)).toEqual([ref.fileName])
})

it('retains complete formal bytes after a directory-sync acknowledgement fails and can later confirm the same hash', async () => {
  const { original, png, ref, assets } = await fixture()
  fault.directoryFailure = assets
  await expect(saveObjectAvatarFile(original, png)).rejects.toMatchObject({ code: 'EIO' })
  expect(await readObjectAvatarFile(original, ref)).toEqual(png)
  fault.directoryFailure = undefined
  expect(await saveObjectAvatarFile(original, png)).toEqual(ref)
  expect(await readdir(assets)).toEqual([ref.fileName])
})

it('refuses an existing hash path with different bytes without replacing or deleting that original file', async () => {
  const { original, png, ref, assets } = await fixture()
  await saveObjectAvatarFile(original, png)
  const path = join(assets, ref.fileName), unknownBytes = imagePng(256, 256, [194, 20, 10])
  await writeFile(path, unknownBytes)
  await expect(saveObjectAvatarFile(original, png)).rejects.toThrow('do not match')
  expect(await readFile(path)).toEqual(unknownBytes)
  expect(await readdir(assets)).toEqual([ref.fileName])
})
