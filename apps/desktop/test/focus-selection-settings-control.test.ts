import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
vi.mock('electron', async () => { const { tmpdir } = await import('node:os'); return { app: { getPath: () => tmpdir() } } })
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core'
import { ConfigStore } from '../src/main/config-store'
import { executeSettingsControl } from '../src/main/settings-control'
import { resolveFocusPreferences } from '../src/shared/focus-preferences'
import { configOwnerFixture, deferred } from './helpers/config-owner-fixture'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'

const defaults = { selectionFillPercent: 20, selectionBorderPercent: 35, selectionAccent: 'neutral' } as const
const prefix = 'focus.'
const principal = { transport: 'unix', principal: { kind: 'user', id: 'selection-settings-test' } } as const
const envelope = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'selection-settings' } as const
type Fixture = Awaited<ReturnType<typeof configOwnerFixture>>
const set = (f: Fixture, field: string, value: string) => executeSettingsControl({ ...envelope, operation: 'settings.set', key: prefix + field, value }, f.owner)
const get = (f: Fixture) => executeSettingsControl({ ...envelope, operation: 'settings.get', target: 'focus' }, f.owner)

it('discovers exact selection defaults and ranges without writing unchanged effective defaults', async () => {
  const f = await configOwnerFixture(), before = f.owner.current, bytes = await f.bytes()
  const discovered = await get(f)
  expect(discovered.operation).toBe('settings.get')
  if (discovered.operation !== 'settings.get') throw Error('Original discovery result required')
  const entries = discovered.entries.filter(entry => Object.hasOwn(defaults, entry.key.slice(prefix.length)))
  expect(entries).toHaveLength(3)
  expect(entries).toEqual([
    { key: 'focus.selectionFillPercent', kind: 'number', value: 20, default: 20, enum: Array.from({ length: 31 }, (_, n) => n) },
    { key: 'focus.selectionBorderPercent', kind: 'number', value: 35, default: 35, enum: Array.from({ length: 101 }, (_, n) => n) },
    { key: 'focus.selectionAccent', kind: 'string', value: 'neutral', default: 'neutral', enum: ['neutral', 'accent', 'blue', 'purple'] }
  ])
  for (const [field, value] of Object.entries(defaults)) await set(f, field, String(value))
  expect(f.owner.current).toBe(before); expect(await f.bytes()).toBe(bytes)
  expect(f.save).not.toHaveBeenCalled(); expect(f.publish).not.toHaveBeenCalled(); expect(f.runtime.prepare).not.toHaveBeenCalled()
  expect(resolveFocusPreferences(undefined)).toMatchObject(defaults)
})

it('the strict durable schema and public scalar owner reject malformed selection values without writes', async () => {
  const f = await configOwnerFixture(), before = f.owner.current, bytes = await f.bytes()
  for (const [field, values] of Object.entries({ selectionFillPercent: ['-1', '31', '20.5', '20e0', ' 20', 'NaN'], selectionBorderPercent: ['-1', '101', '35.1'], selectionAccent: ['green', '#fff', 'var(--text)', 'neutral '] })) {
    for (const value of values) await expect(set(f, field, value)).rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
  }
  for (const choice of [{ selectionFillPercent: -1 }, { selectionFillPercent: 31 }, { selectionFillPercent: 20.5 }, { selectionBorderPercent: 101 }, { selectionBorderPercent: '35' }, { selectionAccent: '#fff' }, { selectionCSS: 'background:red' }]) {
    expect(() => f.store.validate({ ...before, focus: { recentActivityHours: 48, ...choice } })).toThrow()
  }
  expect(f.owner.current).toBe(before); expect(await f.bytes()).toBe(bytes)
  expect(f.save).not.toHaveBeenCalled(); expect(f.publish).not.toHaveBeenCalled(); expect(f.runtime.prepare).not.toHaveBeenCalled()
})

it('the first GUI-shaped edit normalizes absent defaults and merges independent authored fields and personal routes', async () => {
  const projects = [{ key: JSON.stringify(['local', 'original-project']), pinned: true, note: 'Original route', color: 'violet' as const, collapsed: false }]
  const zonePresentations = [{ key: JSON.stringify(['project', 'local', 'original-project']), presentation: 'sections' as const }]
  const f = await configOwnerFixture({ focus: { recentActivityHours: 48, projects, zonePresentations } }), base = f.owner.current
  const expected = { ...base, focus: { ...base.focus, ...resolveFocusPreferences(base.focus) } }
  await set(f, 'selectionBorderPercent', '80')
  await expect(f.owner.edit(expected, { ...expected, focus: { ...expected.focus, selectionFillPercent: 27 } })).resolves.toMatchObject({ focus: { selectionFillPercent: 27, selectionBorderPercent: 80 } })
  expect(f.owner.current.focus).toEqual({ recentActivityHours: 48, projects, zonePresentations, selectionBorderPercent: 80, selectionFillPercent: 27 })
  await f.owner.edit(expected, { ...expected, focus: { ...expected.focus, selectionAccent: 'purple' } })
  expect(f.owner.current.focus).toEqual({ recentActivityHours: 48, projects, zonePresentations, selectionBorderPercent: 80, selectionFillPercent: 27, selectionAccent: 'purple' })
  const calls = f.save.mock.calls.length
  await f.owner.edit(expected, { ...expected, focus: { ...expected.focus, selectionFillPercent: 27 } })
  expect(f.save).toHaveBeenCalledTimes(calls)
  await expect(f.owner.edit(expected, { ...expected, focus: { ...expected.focus, selectionFillPercent: 12 } })).rejects.toMatchObject({ code: 'CONFIG_CONFLICT' })
  expect(f.owner.current.focus?.selectionFillPercent).toBe(27)
  expect(expected.focus.selectionFillPercent).toBe(20)
  expect((await f.disk()).focus).toEqual(f.owner.current.focus)
})

it('serializes later choices behind an admitted save and keeps independent fields and original configuration', async () => {
  const f = await configOwnerFixture(), before = f.owner.current, release = deferred<void>()
  const save = f.save.getMockImplementation()!
  f.save.mockImplementationOnce(async next => { await release.promise; return save(next) })
  const first = set(f, 'selectionFillPercent', '0')
  await vi.waitFor(() => expect(f.save).toHaveBeenCalledOnce())
  const later = set(f, 'selectionBorderPercent', '100')
  expect(f.owner.current).toBe(before)
  release.resolve(); await first; await later
  expect(f.owner.current.focus).toEqual({ recentActivityHours: 48, selectionFillPercent: 0, selectionBorderPercent: 100 })
  for (const key of ['hosts', 'executors', 'workspaces', 'appearance'] as const) expect(f.owner.current[key]).toEqual(before[key])
})

it('a real private filesystem failure returns no public success or publication and keeps the original bytes', async () => {
  const f = await configOwnerFixture(), before = f.owner.current, bytes = await f.bytes(), backup = f.store.filePath + '.original'
  await rename(f.store.filePath, backup); await mkdir(f.store.filePath)
  try {
    await expect(set(f, 'selectionAccent', 'blue')).rejects.toMatchObject({ code: 'EISDIR' })
    expect(f.owner.current).toBe(before); expect(f.publish).not.toHaveBeenCalled(); expect(f.runtime.commit).not.toHaveBeenCalled()
    expect(f.runtime.discard).toHaveBeenCalledOnce()
  } finally { await rm(f.store.filePath, { recursive: true, force: true }); await rename(backup, f.store.filePath) }
  expect(await f.bytes()).toBe(bytes)
})

it('actual public SDK and executable CLI socket calls save and reopen all three exact selection choices', async () => {
  const f = await configOwnerFixture(), rpc = new AgentMuxRpcService({ execute: request => {
    if (request.operation !== 'settings.get' && request.operation !== 'settings.set') throw Error('Original settings owner required')
    return executeSettingsControl(request, f.owner)
  } })
  const discovered = await rpc.call('settings.inspect', { target: 'focus.selectionAccent' }, principal)
  expect(discovered.entries).toEqual([{ key: 'focus.selectionAccent', kind: 'string', value: 'neutral', default: 'neutral', enum: ['neutral', 'accent', 'blue', 'purple'] }])
  for (const [field, values] of Object.entries({ selectionFillPercent: [0, 30, 24], selectionBorderPercent: [0, 100, 72], selectionAccent: ['accent', 'blue', 'purple', 'neutral'] })) {
    for (const value of values) {
      const result = await rpc.call('settings.set', { key: prefix + field, value: String(value) }, principal)
      expect(result.entry).toMatchObject({ key: prefix + field, value })
      expect((await f.disk()).focus?.[field as keyof typeof defaults]).toBe(value)
    }
  }
  const directory = await mkdtemp(fixturePath('tmp/selection-settings-'))
  const server = new AgentMuxControlServer({ execute: request => {
    if (request.operation !== 'settings.get' && request.operation !== 'settings.set') throw Error('Original settings owner required')
    return executeSettingsControl(request, f.owner)
  } }, join(directory, 'control.sock'))
  try {
    await server.start()
    const call = promisify(execFile), args = [resolve('packages/core/bin/amux'), '--endpoint', `unix:${server.path}`, 'settings']
    const options = { timeout: 10000, env: { ...process.env, AGENTMUX_ENV: undefined, AGENTMUX_AGENT_SESSION_ID: undefined, AGENTMUX_AGENT_CAPABILITY: undefined } }
    for (const [field, value] of Object.entries({ selectionFillPercent: 18, selectionBorderPercent: 44, selectionAccent: 'blue' })) {
      const inspected = JSON.parse((await call(process.execPath, [...args, 'inspect', prefix + field], options)).stdout).result
      expect(inspected.entries).toHaveLength(1); expect(inspected.entries[0].key).toBe(prefix + field)
      const changed = JSON.parse((await call(process.execPath, [...args, 'set', prefix + field, String(value)], options)).stdout).result
      expect(changed.entry).toMatchObject({ key: prefix + field, value })
      expect((await f.disk()).focus?.[field as keyof typeof defaults]).toBe(value)
    }
    const bytes = await f.bytes()
    await expect(call(process.execPath, [...args, 'set', 'focus.selectionFillPercent', '31'], options)).rejects.toMatchObject({ code: 1 })
    expect(await f.bytes()).toBe(bytes)
  } finally { await server.stop(); await rm(directory, { recursive: true, force: true }) }
  expect((await new ConfigStore(f.store.filePath).get()).focus).toMatchObject({ selectionFillPercent: 18, selectionBorderPercent: 44, selectionAccent: 'blue' })
})
