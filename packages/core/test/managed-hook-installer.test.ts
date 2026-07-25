import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentManagedHookInstaller } from '../src/managed-hook-installer.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => {
    await rm(directory, { recursive: true, force: true })
  }))
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'agentmux-hook-installer-'))
  directories.push(directory)
  const stateDirectory = join(directory, 'state')
  const existingPath = join(directory, 'provider', 'hooks.json')
  const createdPath = join(directory, 'provider', 'agentmux-hook.sh')
  await mkdir(join(directory, 'provider'), { recursive: true })
  await writeFile(existingPath, '{"user":true}\n', { mode: 0o640 })
  return {
    installer: new AgentManagedHookInstaller(stateDirectory),
    existingPath,
    createdPath
  }
}

describe('explicit managed Hook installation', () => {
  it('previews exact files, installs once, and restores the previous generation on uninstall', async () => {
    const { installer, existingPath, createdPath } = await fixture()
    const preview = await installer.preview({
      providerId: 'codex',
      mutations: [
        { path: existingPath, content: '{"user":true,"agentmux":true}\n' },
        { path: createdPath, content: '#!/bin/sh\nexit 0\n', mode: 0o700 }
      ]
    })
    expect(preview.changes).toMatchObject([
      { path: existingPath, action: 'replace' },
      { path: createdPath, action: 'create' }
    ])
    expect(await readFile(existingPath, 'utf8')).toBe('{"user":true}\n')

    const receipt = await installer.install(preview.id)
    expect(await readFile(existingPath, 'utf8')).toBe('{"user":true,"agentmux":true}\n')
    expect((await stat(createdPath)).mode & 0o777).toBe(0o700)
    expect(receipt.entries[0]?.backupPath).not.toBeNull()

    await installer.uninstall(receipt)
    expect(await readFile(existingPath, 'utf8')).toBe('{"user":true}\n')
    await expect(stat(createdPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails closed when a target changes after preview or after install', async () => {
    const { installer, existingPath } = await fixture()
    const stalePreview = await installer.preview({
      providerId: 'claude',
      mutations: [{ path: existingPath, content: '{"agentmux":1}\n' }]
    })
    await writeFile(existingPath, '{"user-edited":1}\n')
    await expect(installer.install(stalePreview.id)).rejects.toMatchObject({ code: 'HOOK_TARGET_CHANGED' })
    expect(await readFile(existingPath, 'utf8')).toBe('{"user-edited":1}\n')

    const currentPreview = await installer.preview({
      providerId: 'claude',
      mutations: [{ path: existingPath, content: '{"agentmux":2}\n' }]
    })
    const receipt = await installer.install(currentPreview.id)
    await writeFile(existingPath, '{"user-edited-after-install":1}\n')
    await expect(installer.uninstall(receipt)).rejects.toMatchObject({ code: 'HOOK_TARGET_CHANGED' })
    expect(await readFile(existingPath, 'utf8')).toBe('{"user-edited-after-install":1}\n')
  })

  it.runIf(process.platform !== 'win32')('rejects a receipt whose backup escapes the state directory through a symlink', async () => {
    const { installer, existingPath } = await fixture()
    const preview = await installer.preview({
      providerId: 'codex',
      mutations: [{ path: existingPath, content: '{"agentmux":true}\n' }]
    })
    const receipt = await installer.install(preview.id)
    const originalBackup = receipt.entries[0]?.backupPath
    if (!originalBackup) throw new Error('fixture did not create a recovery backup')
    const outsideBackup = join(dirname(dirname(dirname(dirname(originalBackup)))), 'outside.backup')
    await writeFile(outsideBackup, '{"user":true}\n')
    await rm(originalBackup)
    await symlink(outsideBackup, originalBackup)

    await expect(installer.uninstall(receipt)).rejects.toMatchObject({ code: 'INVALID_HOOK_RECEIPT' })
    expect(await readFile(existingPath, 'utf8')).toBe('{"agentmux":true}\n')
  })
})
