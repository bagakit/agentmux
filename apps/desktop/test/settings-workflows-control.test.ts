import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { mkdir, rename, rm } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => _hygiene_fixturePath("tmp") } }))
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service.js'
import { parseSettingsCommand } from '../../../packages/core/src/settings-cli.js'
import { executeSettingsControl } from '../src/main/settings-control.js'
import { ConfigStore } from '../src/main/config-store.js'
import { configOwnerFixture } from './helpers/config-owner-fixture.js'

const principal = { transport: 'unix', principal: { kind: 'user', id: 'workflows-test' } } as const
function settings(f: Awaited<ReturnType<typeof configOwnerFixture>>) {
  const rpc = new AgentMuxRpcService({ execute: async request => {
    if (request.operation !== 'settings.get' && request.operation !== 'settings.set') throw new Error('Wrong settings owner')
    return executeSettingsControl(request, f.owner)
  } })
  return async (args: string[]) => {
    const command = await parseSettingsCommand(args)
    return rpc.call(command.method, command.params, principal)
  }
}

it('real CLI/RPC discover Goals defaults without materializing the directory and save through the durable owner', async () => {
  const f = await configOwnerFixture(), call = settings(f), before = await f.bytes()
  const entry = { key: 'goalsCommonActions.collapsed', kind: 'boolean', value: false, default: false }
  expect((await call(['inspect', 'goalsCommonActions'])).entries).toEqual([entry])
  expect((await call(['inspect', entry.key])).entries).toEqual([entry])
  await call(['set', entry.key, 'false'])
  expect(f.owner.current.goalsCommonActions).toBeUndefined()
  expect(await f.bytes()).toBe(before)
  expect(f.save).not.toHaveBeenCalled()
  const result = await call(['set', entry.key, 'true'])
  expect(result.entry).toEqual({ ...entry, value: true })
  expect(f.owner.current.goalsCommonActions).toEqual({ items: [{ kind: 'builtin', id: 'understand' }, { kind: 'builtin', id: 'ideas' }, { kind: 'builtin', id: 'next' }], collapsed: true })
  expect((await new ConfigStore(f.store.filePath).get()).goalsCommonActions).toEqual(f.owner.current.goalsCommonActions)
  expect(f.runtime.commit.mock.invocationCallOrder[0]).toBeLessThan(f.publish.mock.invocationCallOrder[0]!)
  expect((await call(['inspect', 'goalsCommonActions'])).entries).toEqual([{ ...entry, value: true }])
})

it('CLI changes preserve an explicitly empty directory and original Prompt/Host/Executor identities', async () => {
  const f = await configOwnerFixture({ goalsCommonActions: { items: [], collapsed: false } }), call = settings(f)
  const original = structuredClone(f.owner.current)
  for (const value of ['true', 'false']) {
    await call(['set', 'goalsCommonActions.collapsed', value])
    expect((await f.disk()).goalsCommonActions).toEqual({ items: [], collapsed: value === 'true' })
    expect(f.owner.current.composerShortcuts).toEqual(original.composerShortcuts)
    expect(f.owner.current.workspaces).toEqual(original.workspaces)
    expect(f.owner.current.executors).toEqual(original.executors)
    expect(f.owner.current.hosts).toEqual(original.hosts)
  }
  const before = await f.bytes()
  for (const value of ['TRUE', '1', 'yes', '']) await expect(call(['set', 'goalsCommonActions.collapsed', value])).rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
  await expect(call(['set', 'goalsCommonActions.items', '[]'])).rejects.toMatchObject({ code: 'UNSUPPORTED_SETTING' })
  expect(await f.bytes()).toBe(before)
})

it('authored collapsed edits preserve concurrent first items creation and Space effective defaults', async () => {
  const f = await configOwnerFixture(), before = structuredClone(f.owner.current)
  const items = [{ kind: 'builtin' as const, id: 'next' as const }]
  await f.owner.update(current => ({ ...current, goalsCommonActions: { items, collapsed: false }, copyPathsAsAbsolute: true }))
  const requested = { ...before, goalsCommonActions: { items: [{ kind: 'builtin' as const, id: 'understand' as const }, { kind: 'builtin' as const, id: 'ideas' as const }, { kind: 'builtin' as const, id: 'next' as const }], collapsed: true } }
  await expect(f.owner.edit(before, requested)).resolves.toMatchObject({ goalsCommonActions: { items, collapsed: true } })
  expect((await f.disk()).goalsCommonActions).toEqual({ items, collapsed: true })
  expect(f.owner.current.copyPathsAsAbsolute).toBe(true)
  await f.owner.edit({ ...f.owner.current, projectRailDensity: 'default' }, { ...f.owner.current, projectRailDensity: 'dense' })
  expect((await f.disk()).projectRailDensity).toBe('dense')
})

it('failed real durable write never replies success or publishes collapsed preference', async () => {
  const f = await configOwnerFixture(), call = settings(f), original = f.owner.current, bytes = await f.bytes()
  const backup = f.store.filePath + '.original'
  await rename(f.store.filePath, backup); await mkdir(f.store.filePath)
  try {
    await expect(call(['set', 'goalsCommonActions.collapsed', 'true'])).rejects.toMatchObject({ code: 'EISDIR' })
    expect(f.owner.current).toBe(original)
    expect(f.publish).not.toHaveBeenCalled()
    expect(f.runtime.commit).not.toHaveBeenCalled()
  } finally { await rm(f.store.filePath, { recursive: true, force: true }); await rename(backup, f.store.filePath) }
  expect(await f.bytes()).toBe(bytes)
})
