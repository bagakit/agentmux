import { afterEach, expect, it } from 'vitest'
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pruneCrashDumps } from '../src/main/crash-dump-retention'

/**
 * Native crash dumps are written locally and never uploaded, so nothing ever consumes and removes
 * them; a crash loop otherwise grows the directory without limit. The pruner keeps the newest dumps
 * in each Crashpad report directory and removes only older `.dmp` files there.
 */
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function dumps(directory: string, count: number, startSeconds = 1_000_000) {
  await mkdir(directory, { recursive: true })
  for (let index = 0; index < count; index++) {
    const file = join(directory, `dump-${index}.dmp`)
    await writeFile(file, 'x')
    const at = new Date((startSeconds + index) * 1000)
    await utimes(file, at, at)
  }
}

it('keeps the newest dumps in each report directory and removes the older ones', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amx-crash-dumps-')); roots.push(root)
  await dumps(join(root, 'pending'), 30)
  await dumps(join(root, 'completed'), 4)
  const removed = await pruneCrashDumps(root, 10)
  expect(removed).toBe(20)
  const pending = (await readdir(join(root, 'pending'))).sort()
  expect(pending).toHaveLength(10)
  // The newest ten by modification time stay: dump-20 … dump-29.
  expect(pending).toEqual(Array.from({ length: 10 }, (_, index) => `dump-${index + 20}.dmp`).sort())
  expect(await readdir(join(root, 'completed'))).toHaveLength(4)
})

it('touches nothing but dump files, and a missing directory is not an error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amx-crash-dumps-')); roots.push(root)
  await dumps(join(root, 'pending'), 3)
  await writeFile(join(root, 'settings.dat'), 'settings')
  await mkdir(join(root, 'attachments', 'dump-0'), { recursive: true })
  await writeFile(join(root, 'pending', 'notes.txt'), 'keep me')
  expect(await pruneCrashDumps(root, 1)).toBe(2)
  expect((await readdir(join(root, 'pending'))).sort()).toEqual(['dump-2.dmp', 'notes.txt'])
  expect(await readdir(root)).toEqual(expect.arrayContaining(['settings.dat', 'attachments']))
  expect(await pruneCrashDumps(join(root, 'absent'), 1)).toBe(0)
})
