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

  it('merges into a shared config, preserving foreign keys through install and uninstall', async () => {
    const { installer, existingPath } = await fixture()
    // A shared ~/.gemini-style file the real CLI also writes into.
    await writeFile(existingPath, `${JSON.stringify({ 'user-hooks': { Stop: ['keep-me'] } }, null, 2)}\n`)
    const preview = await installer.preview({
      providerId: 'antigravity',
      mutations: [{
        path: existingPath,
        content: `${JSON.stringify({ 'agentmux-status': { PreToolUse: [{ command: 'agentmux-hook.js' }] } })}\n`,
        merge: { kind: 'json-owned-key', key: 'agentmux-status' }
      }]
    })
    expect(preview.changes[0]?.action).toBe('replace')

    const receipt = await installer.install(preview.id)
    const installed = JSON.parse(await readFile(existingPath, 'utf8'))
    expect(installed['user-hooks']).toEqual({ Stop: ['keep-me'] })
    expect(installed['agentmux-status']).toBeDefined()

    await installer.uninstall(receipt)
    // Uninstall restores the exact pre-install file — the foreign key is intact, our key is gone.
    const restored = JSON.parse(await readFile(existingPath, 'utf8'))
    expect(restored['user-hooks']).toEqual({ Stop: ['keep-me'] })
    expect(restored['agentmux-status']).toBeUndefined()
  })

  it('is idempotent on reinstall over an already-merged shared config', async () => {
    const { installer, existingPath } = await fixture()
    await writeFile(existingPath, `${JSON.stringify({ other: 1 }, null, 2)}\n`)
    const mutation = {
      path: existingPath,
      content: `${JSON.stringify({ 'agentmux-status': { PreToolUse: [{ command: 'agentmux-hook.js' }] } })}\n`,
      merge: { kind: 'json-owned-key', key: 'agentmux-status' } as const
    }
    await installer.install((await installer.preview({ providerId: 'antigravity', mutations: [mutation] })).id)
    const afterFirst = await readFile(existingPath, 'utf8')
    // Second preview over the already-merged file must report unchanged (no accumulation, no rewrite).
    const secondPreview = await installer.preview({ providerId: 'antigravity', mutations: [mutation] })
    expect(secondPreview.changes[0]?.action).toBe('unchanged')
    await installer.install(secondPreview.id)
    expect(await readFile(existingPath, 'utf8')).toBe(afterFirst)
  })

  it('ensure() installs once then no-ops on relaunch (install-and-leave)', async () => {
    const { installer, existingPath } = await fixture()
    await writeFile(existingPath, `${JSON.stringify({ other: 1 }, null, 2)}\n`)
    const plan = {
      providerId: 'antigravity' as const,
      mutations: [{
        path: existingPath,
        content: `${JSON.stringify({ 'agentmux-status': { PreToolUse: [{ command: 'agentmux-hook.js' }] } })}\n`,
        merge: { kind: 'json-owned-key', key: 'agentmux-status' } as const
      }]
    }
    // First launch: a write happens, so a receipt is returned and the foreign key is preserved.
    const firstReceipt = await installer.ensure(plan)
    expect(firstReceipt).not.toBeNull()
    const installed = JSON.parse(await readFile(existingPath, 'utf8'))
    expect(installed['other']).toBe(1)
    expect(installed['agentmux-status']).toBeDefined()
    const afterFirst = await readFile(existingPath, 'utf8')
    // Every subsequent launch: nothing to do, so ensure() returns null and never touches disk.
    expect(await installer.ensure(plan)).toBeNull()
    expect(await installer.ensure(plan)).toBeNull()
    expect(await readFile(existingPath, 'utf8')).toBe(afterFirst)
  })
})
