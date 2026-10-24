import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
vi.mock('electron', async () => { const { tmpdir } = await import('node:os'); return { app: { getPath: () => tmpdir() } } })
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server.js'
import { executeSettingsControl } from '../src/main/settings-control'
import { ConfigOwner } from '../src/main/config-owner'
import { ConfigStore } from '../src/main/config-store'
import { resolveFocusPreferences } from '../src/shared/focus-preferences'
import { focusMapPreset, resolveFocusMapPreferences } from '../src/shared/focus-map-preferences'
import { configOwnerFixture, deferred } from './helpers/config-owner-fixture'
import { scalarSettingsSchemaKeys } from './helpers/settings-schema-keys'

const envelope = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'map-settings' } as const
const get = async (owner: ConfigOwner, target = 'focus.map') => {
  const result = await executeSettingsControl({ ...envelope, operation: 'settings.get', target }, owner)
  if (result.operation !== 'settings.get') throw Error('Original settings discovery required')
  return result.entries
}
const set = (owner: ConfigOwner, key: string, value: string) => executeSettingsControl({ ...envelope, operation: 'settings.set', key, value }, owner)

it('discovers exactly every schema-derived active field for 2/3/4 levels without materializing effective defaults', async () => {
  const f = await configOwnerFixture(), bytes = await f.bytes(), before = f.owner.current
  const initial = await get(f.owner)
  expect(initial.map(entry => entry.key)).toEqual((await scalarSettingsSchemaKeys()).filter(key => key.startsWith('focus.map.')))
  for (const entry of initial) await set(f.owner, entry.key, String(entry.value))
  expect(await f.bytes()).toBe(bytes); expect(f.owner.current).toBe(before)
  expect(f.save).not.toHaveBeenCalled(); expect(f.runtime.prepare).not.toHaveBeenCalled()
  for (const count of [2, 3, 4] as const) {
    await set(f.owner, 'focus.map.levels.count', String(count))
    const entries = await get(f.owner), keys = entries.map(entry => entry.key)
    expect(keys).toEqual((await scalarSettingsSchemaKeys(undefined, count)).filter(key => key.startsWith('focus.map.')))
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).not.toContain('focus.map.levels.1.from'); expect(keys).not.toContain('focus.map.levels.1.to')
    expect((await get(f.owner, 'focus.map.levels')).map(entry => entry.key)).toEqual(keys.filter(key => key.startsWith('focus.map.levels.')))
    for (const entry of entries.filter(entry => entry.enum)) {
      expect(entry.enum).toContain(entry.value); expect(entry.enum).toContain(entry.default)
      if (entry.key.endsWith('.form')) expect(entry.enum).toEqual(['point', 'compact', 'card'])
      if (entry.key.endsWith('.information')) expect(entry.enum).toEqual(['identity', 'status', 'summary'])
    }
  }
  for (const target of ['general', 'focus.map.levels.1.from', 'focus.map.levels.5', 'focus.map.arbitrary']) {
    await expect(get(f.owner, target)).rejects.toMatchObject({ code: 'UNSUPPORTED_SETTING' })
  }
})

it('reads one committed snapshot and resolves removed or newly admitted stage fields inside the original commit queue', async () => {
  const f = await configOwnerFixture({ focus: { recentActivityHours: 72, map: { boundary: 'polygon', levels: focusMapPreset(4) } } })
  const current = f.owner.current
  let reads = 0
  const single = new ConfigOwner({ read: () => { ++reads; return reads === 1 ? current : { ...current, focus: { ...current.focus!, map: { boundary: 'bezier', levels: focusMapPreset(2) } } } }, save: f.save, publish: f.publish })
  expect((await get(single)).map(entry => entry.key)).toContain('focus.map.levels.4.to')
  expect(reads).toBe(1)
  const release = deferred<void>(), realSave = f.save.getMockImplementation()!
  f.save.mockImplementationOnce(async next => { await release.promise; return realSave(next) })
  const shrinking = set(f.owner, 'focus.map.levels.count', '2')
  await vi.waitFor(() => expect(f.save).toHaveBeenCalledTimes(1))
  const removed = set(f.owner, 'focus.map.levels.4.information', 'identity').catch(error => error)
  expect((await get(f.owner)).map(entry => entry.key)).toContain('focus.map.levels.4.to')
  release.resolve(); await shrinking
  expect(await removed).toMatchObject({ code: 'UNSUPPORTED_SETTING' })
  expect(resolveFocusMapPreferences(f.owner.current.focus?.map).levels).toHaveLength(2)

  const nextRelease = deferred<void>(), calls = f.save.mock.calls.length
  f.save.mockImplementationOnce(async next => { await nextRelease.promise; return realSave(next) })
  const growing = set(f.owner, 'focus.map.levels.count', '4')
  await vi.waitFor(() => expect(f.save).toHaveBeenCalledTimes(calls + 1))
  const admitted = set(f.owner, 'focus.map.levels.4.from', '0.75')
  nextRelease.resolve(); await growing
  await expect(admitted).resolves.toMatchObject({ entry: { key: 'focus.map.levels.4.from', value: .75 } })
  expect((await new ConfigStore(f.store.filePath).get()).focus?.map?.levels[3]?.from).toBe(.75)
})

it('keeps invalid aggregate profiles, stale public paths and a failed durable save out of the published configuration', async () => {
  const f = await configOwnerFixture(), bytes = await f.bytes(), current = f.owner.current
  for (const [key, value] of [
    ['focus.map.boundary', 'circle'], ['focus.map.levels.count', '1'], ['focus.map.levels.count', '5'], ['focus.map.levels.count', '3.0'],
    ['focus.map.levels.1.form', 'card'], ['focus.map.levels.2.information', 'summary'],
    ['focus.map.levels.2.to', '0.7'], ['focus.map.levels.2.from', '0.58'], ['focus.map.levels.3.to', '1.41'],
    ...['NaN', 'Infinity', ' 0.4', '4e-1', '.4', '0x1'].map(value => ['focus.map.levels.2.from', value])
  ]) await expect(set(f.owner, key!, value!)).rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
  for (const key of ['focus.map.levels.1.from', 'focus.map.levels.1.to', 'focus.map.levels.4.form', 'focus.map.levels.0.form']) {
    await expect(set(f.owner, key, 'point')).rejects.toMatchObject({ code: 'UNSUPPORTED_SETTING' })
  }
  for (const levels of [focusMapPreset(3).map((level, index) => index === 0 ? { ...level, to: .2 } : level), focusMapPreset(3).map((level, index) => index === 1 ? { ...level, information: 'summary' } : level)]) {
    expect(() => f.store.validate({ ...current, focus: { recentActivityHours: 48, map: { boundary: 'bezier', levels } } })).toThrow()
  }
  expect(await f.bytes()).toBe(bytes); expect(f.owner.current).toBe(current)
  expect(f.publish).not.toHaveBeenCalled(); expect(f.runtime.prepare).not.toHaveBeenCalled()
  f.save.mockRejectedValueOnce(Object.assign(new Error('Private durable write failed'), { code: 'EIO' }))
  await expect(set(f.owner, 'focus.map.boundary', 'polygon')).rejects.toMatchObject({ code: 'EIO' })
  expect(await f.bytes()).toBe(bytes); expect(f.owner.current).toBe(current); expect(f.publish).not.toHaveBeenCalled()
})

it('merges unedited deep Map defaults and other Focus fields but treats the authored stage array as one honest CAS value', async () => {
  const f = await configOwnerFixture(), raw = structuredClone(f.owner.current)
  const before = { ...raw, focus: resolveFocusPreferences(raw.focus) }
  await set(f.owner, 'focus.map.boundary', 'polygon')
  await set(f.owner, 'focus.replyLines', '3')
  await f.owner.edit(before, { ...before, focus: { ...before.focus, map: { ...before.focus.map, levels: focusMapPreset(4) } } })
  expect(f.owner.current.focus).toMatchObject({ replyLines: 3, map: { boundary: 'polygon', levels: focusMapPreset(4) } })
  const baseline = structuredClone(f.owner.current), baselineMap = baseline.focus!.map!
  await set(f.owner, 'focus.map.levels.4.to', '1.1')
  const bytes = await f.bytes()
  await expect(f.owner.edit(baseline, { ...baseline, focus: { ...baseline.focus!, map: { ...baselineMap, levels: baselineMap.levels.map((level, index) => index === 1 ? { ...level, to: .45 } : level) } } })).rejects.toMatchObject({ code: 'CONFIG_CONFLICT', field: 'focus.map.levels' })
  expect(await f.bytes()).toBe(bytes)
  await f.owner.edit(baseline, { ...baseline, focus: { ...baseline.focus!, map: { ...baselineMap, boundary: 'bezier' } } })
  expect(f.owner.current.focus?.map).toMatchObject({ boundary: 'bezier', levels: expect.arrayContaining([expect.objectContaining({ to: 1.1 })]) })
  expect((await new ConfigStore(f.store.filePath).get()).focus).toEqual(f.owner.current.focus)
  const empty = await configOwnerFixture(), effective = { ...empty.owner.current, focus: resolveFocusPreferences(undefined) }
  await empty.owner.edit(effective, structuredClone(effective))
  expect(empty.owner.current.focus).toBeUndefined(); expect(empty.save).not.toHaveBeenCalled()
})

it('the actual CLI discovers, writes and reopens every active Map scalar through the public socket and durable owner', async () => {
  const f = await configOwnerFixture({ focus: { recentActivityHours: 72, replyLines: 3, mapMotion: 'off' } })
  const original = structuredClone(f.owner.current)
  const server = new AgentMuxControlServer({ execute: request => executeSettingsControl(request as never, f.owner) }, join(f.store.filePath, '..', 'map.sock'))
  await server.start()
  const cli = promisify(execFile)
  const call = async (args: string[]) => JSON.parse((await cli(process.execPath, [fileURLToPath(new URL('../../../packages/core/bin/amux', import.meta.url)), '--endpoint', `unix:${server.path}`, 'settings', ...args],
    { timeout: 10000, env: { ...process.env, AGENTMUX_AGENT_SESSION_ID: undefined, AGENTMUX_AGENT_CAPABILITY: undefined, AGENTMUX_ENV: undefined } })).stdout).result
  const written = new Set<string>()
  const write = async (key: string, value: string) => {
    const result = await call(['set', key, value])
    expect(result.entry).toMatchObject({ key, value: key.endsWith('.count') || key.endsWith('.from') || key.endsWith('.to') ? Number(value) : value })
    expect((await new ConfigStore(f.store.filePath).get()).focus?.map).toEqual(f.owner.current.focus?.map)
    written.add(key)
    return result
  }
  try {
    const bytes = await f.bytes()
    expect((await call(['inspect', 'focus.map'])).partial).toBe(true)
    expect(await f.bytes()).toBe(bytes)
    for (const count of [2, 3, 4] as const) {
      await write('focus.map.levels.count', String(count))
      const discovered = (await call(['inspect', 'focus.map'])).entries.map((entry: { key: string }) => entry.key)
      expect(discovered).toEqual((await scalarSettingsSchemaKeys(undefined, count)).filter(key => key.startsWith('focus.map.')))
      await write('focus.map.boundary', count === 3 ? 'bezier' : 'polygon')
      // Reach an all-card identity profile through valid scalar operations, then
      // actually change every form and every information field through the CLI.
      for (let index = 1; index <= count; ++index) await write(`focus.map.levels.${index}.information`, 'identity')
      for (let index = count; index >= 1; --index) await write(`focus.map.levels.${index}.form`, 'card')
      for (let index = 1; index <= count; ++index) await write(`focus.map.levels.${index}.form`, 'compact')
      for (let index = count; index >= 1; --index) await write(`focus.map.levels.${index}.information`, 'status')
      for (let index = 2; index <= count; ++index) {
        const level = f.owner.current.focus!.map!.levels[index - 1]!
        await write(`focus.map.levels.${index}.from`, String(Number((level.from + .01).toFixed(2))))
        await write(`focus.map.levels.${index}.to`, String(Number((level.to - .01).toFixed(2))))
      }
      const custom = structuredClone(f.owner.current.focus!.map!), stable = await f.bytes()
      await call(['set', 'focus.map.levels.count', String(count)])
      expect(await f.bytes()).toBe(stable); expect(f.owner.current.focus!.map).toEqual(custom)
      expect(discovered.every((key: string) => written.has(key))).toBe(true)
      await expect(call(['set', 'focus.map.levels.1.to', '0.1'])).rejects.toMatchObject({ code: 1 })
      await expect(call(['set', `focus.map.levels.${count}.from`, '1.4'])).rejects.toMatchObject({ code: 1 })
      expect(await f.bytes()).toBe(stable)
      expect((await call(['inspect', `focus.map.levels.${count}`])).entries).toHaveLength(4)
    }
    await write('focus.map.levels.4.form', 'card')
    await write('focus.map.levels.4.information', 'summary')
    for (let index = 1; index <= 4; ++index) await write(`focus.map.levels.${index}.information`, 'identity')
    for (let index = 1; index <= 4; ++index) await write(`focus.map.levels.${index}.form`, 'point')
    expect(f.owner.current.focus?.map?.levels.every(level => level.form === 'point' && level.information === 'identity')).toBe(true)
    expect(f.owner.current.focus).toMatchObject({ recentActivityHours: 72, replyLines: 3, mapMotion: 'off' })
    for (const key of ['hosts', 'executors', 'workspaces', 'appearance', 'composerShortcuts'] as const) expect(f.owner.current[key]).toEqual(original[key])
    expect(f.runtime.commit.mock.invocationCallOrder.at(-1)).toBeLessThan(f.publish.mock.invocationCallOrder.at(-1)!)
  } finally { await server.stop() }
}, 120000)
