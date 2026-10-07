import { mkdir, rename, rm } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
vi.mock('electron', async () => ({ app: { getPath: (await import('node:os')).tmpdir } }))
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service.js'
import { ObjectCliProbe } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { ConfigStore } from '../src/main/config-store.js'
import { executeSettingsControl } from '../src/main/settings-control.js'
import type { AppConfig } from '../src/shared/contracts.js'
import { configOwnerFixture } from './helpers/config-owner-fixture.js'

const key = 'startup.skipAgentAvailabilityCheckWait'
const entry = { key, kind: 'boolean', value: false, default: false }
const principal = { transport: 'unix', principal: { kind: 'user', id: 'startup-settings-test' } } as const

it('the compiled public CLI discovers startup, leaves its default absent, and persists through the original RPC/ConfigOwner', async () => {
  const f = await configOwnerFixture(), original = f.owner.current, before = await f.bytes()
  const rpc = new AgentMuxRpcService({ execute: request => executeSettingsControl(request, f.owner) })
  const probe = new ObjectCliProbe(request => rpc.call(request.method as never, request.params as never, principal))
  await probe.start()
  async function call(...args: string[]) {
    const result = await probe.run(['settings', ...args])
    expect(result.code, result.stderr).toBe(0)
    return JSON.parse(result.stdout).result
  }
  try {
    const skill = await probe.run(['settings', '--skill'])
    expect(skill.code).toBe(0)
    expect(skill.stdout).toContain('settings set startup.skipAgentAvailabilityCheckWait true')
    expect(skill.stdout).toContain('applies on the next startup')
    expect(await call('inspect', 'startup')).toEqual({ entries: [entry], partial: true })
    expect(await call('inspect', key)).toEqual({ entries: [entry], partial: true })
    expect((await call('inspect')).entries).toContainEqual(entry)
    expect(await call('set', key, 'false')).toEqual({ entry })
    expect(await f.bytes()).toBe(before)
    expect(f.owner.current).toBe(original)
    expect(f.owner.current.startup).toBeUndefined()
    expect(f.save).not.toHaveBeenCalled()
    expect(await call('set', key, 'true')).toEqual({ entry: { ...entry, value: true } })
    expect((await new ConfigStore(f.store.filePath).get()).startup).toEqual({ skipAgentAvailabilityCheckWait: true })
    expect(f.owner.current.workspaces).toEqual(original.workspaces)
    expect(f.owner.current.executors).toEqual(original.executors)
    expect(f.owner.current.appearance).toEqual(original.appearance)
    expect(f.publish).toHaveBeenCalledOnce()
    expect(vi.mocked(f.runtime.commit).mock.invocationCallOrder[0]).toBeLessThan(f.publish.mock.invocationCallOrder[0]!)
    const saved = await f.bytes()
    await call('set', key, 'true')
    for (const value of ['TRUE', '1', '', 'yes']) {
      const result = await probe.run(['settings', 'set', key, value])
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('INVALID_SETTING_VALUE')
    }
    expect(await f.bytes()).toBe(saved)
    expect(f.publish).toHaveBeenCalledOnce()
    expect(await call('set', key, 'false')).toEqual({ entry })
    expect((await new ConfigStore(f.store.filePath).get()).startup).toEqual({ skipAgentAvailabilityCheckWait: false })
    expect(probe.requests.some(request => request.method === 'settings.inspect' && request.params.target === 'startup')).toBe(true)
    expect(probe.requests.some(request => request.method === 'settings.set' && request.params.key === key)).toBe(true)
  } finally { await probe.stop() }
})

it('the durable schema rejects non-booleans and undeclared startup procedures before writing', async () => {
  const f = await configOwnerFixture(), bytes = await f.bytes(), current = f.owner.current
  for (const startup of [null, [], { skipAgentAvailabilityCheckWait: 'true' }, { skipAgentAvailabilityCheckWait: 1 }, { unknownCheck: true }]) {
    await expect(f.store.save({ ...current, startup } as unknown as AppConfig)).rejects.toThrow()
  }
  expect(await f.bytes()).toBe(bytes)
  expect((await new ConfigStore(f.store.filePath).get()).startup).toBeUndefined()
})

it.each([undefined, {}])('a first General edit uses the effective unchecked default and preserves concurrent fields (%j)', async startup => {
  const f = await configOwnerFixture(startup ? { startup } : {}), original = f.owner.current
  const before = { ...original, startup: { skipAgentAvailabilityCheckWait: false } }
  await f.owner.edit(original, before)
  expect(f.owner.current).toBe(original)
  expect(f.save).not.toHaveBeenCalled()
  await f.owner.update(current => ({ ...current, copyPathsAsAbsolute: true, notes: { fontSize: 18 } }))
  const saved = await f.owner.edit(before, { ...before, startup: { skipAgentAvailabilityCheckWait: true } })
  expect(saved.startup).toEqual({ skipAgentAvailabilityCheckWait: true })
  expect(saved.copyPathsAsAbsolute).toBe(true)
  expect(saved.notes).toEqual({ fontSize: 18 })
  const bytes = await f.bytes()
  await f.owner.edit(before, { ...before, startup: { skipAgentAvailabilityCheckWait: true } })
  expect(await f.bytes()).toBe(bytes)
  expect((await new ConfigStore(f.store.filePath).get()).startup).toEqual(saved.startup)
})

it('a failed startup preference save leaves original config and runtime publication intact', async () => {
  const f = await configOwnerFixture(), current = f.owner.current, bytes = await f.bytes(), backup = f.store.filePath + '.original'
  await rename(f.store.filePath, backup)
  await mkdir(f.store.filePath)
  try {
    await expect(f.owner.edit(current, { ...current, startup: { skipAgentAvailabilityCheckWait: true } })).rejects.toMatchObject({ code: 'EISDIR' })
    expect(f.owner.current).toBe(current)
    expect(f.publish).not.toHaveBeenCalled()
    expect(f.runtime.commit).not.toHaveBeenCalled()
  } finally { await rm(f.store.filePath, { recursive: true }); await rename(backup, f.store.filePath) }
  expect(await f.bytes()).toBe(bytes)
})
