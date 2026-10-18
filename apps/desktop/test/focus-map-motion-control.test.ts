import { configOwnerFixture } from './helpers/config-owner-fixture'
import { dirname, join } from 'node:path'
import { mkdir, rename, rm } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { runSourceObjectCli } from '../../../packages/core/test/helpers/source-object-cli'
import { ConfigStore } from '../src/main/config-store'
import { executeSettingsControl } from '../src/main/settings-control'
import type { AppConfig } from '../src/shared/contracts'

it('discovers and durably saves every map motion choice through the actual source CLI and sole configuration owner', async () => {
  const f = await configOwnerFixture({ copyPathsAsAbsolute: true })
  const server = new AgentMuxControlServer({ execute: request => {
    if (request.operation !== 'settings.get' && request.operation !== 'settings.set') throw new Error('Only the original settings owner participates in this fixture')
    return executeSettingsControl(request, f.owner)
  } }, join(dirname(f.store.filePath), 'control.sock'))
  await server.start()
  const env = { ...process.env, AGENTMUX_ENV: undefined, AGENTMUX_AGENT_SESSION_ID: undefined, AGENTMUX_AGENT_CAPABILITY: undefined }
  const call = (args: string[]) => runSourceObjectCli(['--endpoint', `unix:${server.path}`, 'settings', ...args], env)
  try {
    const inspected = await call(['inspect', 'focus.mapMotion'])
    expect(inspected.code, inspected.stderr).toBe(0)
    const entry = { key: 'focus.mapMotion', kind: 'string', value: 'system', default: 'system', enum: ['system', 'on', 'off'] }
    expect(JSON.parse(inspected.stdout).result.entries).toEqual([entry])
    const bytes = await f.bytes()
    expect((await call(['set', 'focus.mapMotion', 'system'])).code).toBe(0)
    expect(await f.bytes()).toBe(bytes); expect(f.save).not.toHaveBeenCalled()
    for (const value of ['off', 'on', 'system']) {
      const changed = await call(['set', 'focus.mapMotion', value])
      expect(changed.code, changed.stderr).toBe(0)
      expect(JSON.parse(changed.stdout).result.entry).toEqual({ ...entry, value })
      expect((await new ConfigStore(f.store.filePath).get()).focus?.mapMotion).toBe(value)
      expect(f.owner.current.copyPathsAsAbsolute).toBe(true)
    }
    const savedBytes = await f.bytes(), writes = f.save.mock.calls.length
    for (const invalid of ['true', 'auto', 'ON', '']) {
      const refused = await call(['set', 'focus.mapMotion', invalid])
      expect(refused.code).toBe(1)
      expect(refused.stderr).toContain('"code":"INVALID_SETTING_VALUE"')
    }
    expect(await f.bytes()).toBe(savedBytes); expect(f.save).toHaveBeenCalledTimes(writes)
    expect(vi.mocked(f.runtime.commit).mock.invocationCallOrder[0]).toBeLessThan(f.publish.mock.invocationCallOrder[0]!)
  } finally { await server.stop() }
}, 30000)

it('merges a first GUI motion edit with a concurrent first Focus edit without writing other defaults', async () => {
  const f = await configOwnerFixture(), original = f.owner.current
  const before = { ...original, focus: { recentActivityHours: 48 as const, mapMotion: 'system' as const } }
  const next = { ...before, focus: { ...before.focus, mapMotion: 'off' as const } }
  await f.owner.edit(original, { ...original, focus: { recentActivityHours: 72, replyLines: 3 }, copyPathsAsAbsolute: true })
  const result = await f.owner.edit(before, next).catch(cause => cause)
  expect(result).toMatchObject({ focus: { mapMotion: 'off' } })
  const saved = f.owner.current
  expect(saved.focus).toEqual({ recentActivityHours: 72, replyLines: 3, mapMotion: 'off' })
  expect(saved.copyPathsAsAbsolute).toBe(true)
  expect((await new ConfigStore(f.store.filePath).get()).focus).toEqual(saved.focus)
  await expect(f.owner.edit(before, { ...next, focus: { ...next.focus, mapMotion: 'on' } })).rejects.toThrow('focus.mapMotion')
})

it('validates persisted motion values and retains original truth after a genuine file save failure', async () => {
  const f = await configOwnerFixture(), original = f.owner.current
  for (const value of ['auto', true, null, 0, {}, ['off']]) {
    expect(() => f.store.validate({ ...original, focus: { recentActivityHours: 48, mapMotion: value } } as unknown as AppConfig)).toThrow()
  }
  const before = { ...original, focus: { recentActivityHours: 48 as const, mapMotion: 'system' as const } }
  const next = { ...before, focus: { ...before.focus, mapMotion: 'off' as const } }
  const backup = f.store.filePath + '.original'
  await rename(f.store.filePath, backup); await mkdir(f.store.filePath)
  try {
    await expect(f.owner.edit(before, next)).rejects.toMatchObject({ code: 'EISDIR' })
    expect(f.owner.current).toBe(original); expect(f.publish).not.toHaveBeenCalled(); expect(f.runtime.commit).not.toHaveBeenCalled()
  } finally { await rm(f.store.filePath, { recursive: true }); await rename(backup, f.store.filePath) }
  expect((await f.owner.edit(before, next)).focus?.mapMotion).toBe('off')
  expect((await new ConfigStore(f.store.filePath).get()).focus?.mapMotion).toBe('off')
})
