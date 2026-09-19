import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runtimeStorageUsage } from '../src/runtime-storage-usage.js'

const roots: string[] = []
const originalDirectory = process.env.AGENTMUX_STATE_DIRECTORY
afterEach(async () => {
  if (originalDirectory === undefined) delete process.env.AGENTMUX_STATE_DIRECTORY
  else process.env.AGENTMUX_STATE_DIRECTORY = originalDirectory
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amx-storage-owner-'))
  roots.push(root)
  const selected = join(root, 'selected')
  const sibling = join(root, 'amx-501-aaaaaaaaaaaaaaaaaaaaaaaa')
  await mkdir(join(selected, 'state'), { recursive: true })
  await mkdir(sibling)
  await writeFile(join(selected, 'checkpoint'), 'x'.repeat(11))
  await writeFile(join(selected, 'state', 'state.sqlite3'), 'x'.repeat(2048))
  await writeFile(join(sibling, 'preserved'), 'x'.repeat(4096))
  return { root, selected, sibling }
}

describe('selected Runtime disk observation', () => {
  it('measures nested files only in the selected directory and leaves neighboring state untouched', async () => {
    const { selected, sibling } = await fixture()
    expect(await runtimeStorageUsage(selected)).toEqual({ path: selected, bytes: 2059 })
    expect((await readFile(join(sibling, 'preserved'))).byteLength).toBe(4096)
  })

  it('uses the configured Runtime selection, even when its directory has no derived-version name', async () => {
    const { selected } = await fixture()
    process.env.AGENTMUX_STATE_DIRECTORY = selected
    expect(await runtimeStorageUsage()).toEqual({ path: selected, bytes: 2059 })
  })

  it('does not follow file or directory links into another Runtime', async () => {
    const { selected, sibling } = await fixture()
    await symlink(sibling, join(selected, 'other-runtime'))
    await symlink(join(sibling, 'preserved'), join(selected, 'other-file'))
    expect(await runtimeStorageUsage(selected)).toEqual({ path: selected, bytes: 2059 })
  })

  it('reports a missing directory as unavailable rather than returning a zero reading', async () => {
    const { root } = await fixture()
    await expect(runtimeStorageUsage(join(root, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
