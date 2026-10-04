import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { mkdir, rename, rm } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => _hygiene_fixturePath("tmp") } }))
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service.js'
import { parseSettingsCommand } from '../../../packages/core/src/settings-cli.js'
import { executeSettingsControl } from '../src/main/settings-control.js'
import { ConfigStore } from '../src/main/config-store.js'
import { configOwnerFixture } from './helpers/config-owner-fixture.js'

const principal = { transport: 'unix', principal: { kind: 'user', id: 'directory-test' } } as const
function consumer(f: Awaited<ReturnType<typeof configOwnerFixture>>) {
  const rpc = new AgentMuxRpcService({ execute: request => {
    if (request.operation !== 'settings.get' && request.operation !== 'settings.set') throw Error('Wrong owner')
    return executeSettingsControl(request, f.owner)
  } })
  return async (args: string[]) => {
    const command = await parseSettingsCommand(args)
    if (command.method === 'settings.inspect') return rpc.call('settings.inspect', command.params, principal)
    if (command.method === 'settings.set' && typeof command.params.key === 'string' && typeof command.params.value === 'string')
      return rpc.call('settings.set', { key: command.params.key, value: command.params.value }, principal)
    throw Error('Unexpected parsed settings operation')
  }
}
it('actual public CLI/RPC discover absent collaborator default without write, persist list and reload the same owner', async () => {
  const f = await configOwnerFixture(), call = consumer(f), before = await f.bytes(), original = f.owner.current
  const entry = { key: 'moteDirectoryView', kind: 'string', value: 'collaborators', default: 'collaborators', enum: ['collaborators', 'list'] }
  expect(await call(['inspect', entry.key])).toMatchObject({ entries: [entry] })
  await call(['set', entry.key, 'collaborators'])
  expect(await f.bytes()).toBe(before); expect(f.owner.current).toBe(original)
  expect(f.save).not.toHaveBeenCalled()
  expect(await call(['set', entry.key, 'list'])).toMatchObject({ entry: { ...entry, value: 'list' } })
  expect((await new ConfigStore(f.store.filePath).get()).moteDirectoryView).toBe('list')
  expect(f.owner.current.workspaces).toEqual(original.workspaces)
  expect(f.owner.current.executors).toEqual(original.executors)
  const bytes = await f.bytes()
  for (const value of ['grid', '', 'LIST']) await expect(call(['set', entry.key, value])).rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
  expect(await f.bytes()).toBe(bytes)
})
it('original config edit accepts effective absent default, preserves concurrent other changes and joins an already saved choice', async () => {
  const f = await configOwnerFixture(), before = f.owner.current
  await f.owner.update(c => ({ ...c, copyPathsAsAbsolute: true }))
  await f.owner.edit({ ...before, moteDirectoryView: 'collaborators' }, { ...before, moteDirectoryView: 'list' })
  expect(f.owner.current.copyPathsAsAbsolute).toBe(true)
  const bytes = await f.bytes()
  await expect(f.owner.edit({ ...before, moteDirectoryView: 'list' }, { ...before, moteDirectoryView: 'collaborators' })).resolves.toMatchObject({ moteDirectoryView: 'collaborators' })
  await expect(f.owner.edit({ ...before, moteDirectoryView: 'list' }, { ...before, moteDirectoryView: 'collaborators' })).resolves.toBe(f.owner.current)
  expect(bytes).not.toBe(await f.bytes())
})
it('failed durable write keeps original choice and all resources unpublished', async () => {
  const f = await configOwnerFixture(), call = consumer(f), original = f.owner.current, bytes = await f.bytes()
  const backup = f.store.filePath + '.original'
  await rename(f.store.filePath, backup); await mkdir(f.store.filePath)
  try {
    await expect(call(['set', 'moteDirectoryView', 'list'])).rejects.toMatchObject({ code: 'EISDIR' })
    expect(f.owner.current).toBe(original); expect(f.publish).not.toHaveBeenCalled()
  } finally { await rm(f.store.filePath, { recursive: true, force: true }); await rename(backup, f.store.filePath) }
  expect(await f.bytes()).toBe(bytes)
})
