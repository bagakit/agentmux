import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => _hygiene_fixturePath("tmp") } }))
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service.js'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server.js'
import { parseSettingsCommand } from '../../../packages/core/src/settings-cli.js'
import { executeSettingsControl } from '../src/main/settings-control.js'
import { ConfigStore } from '../src/main/config-store.js'
import { configOwnerFixture, deferred } from './helpers/config-owner-fixture.js'

const principal = { transport: 'unix', principal: { kind: 'user', id: 'work-preferences-test' } } as const
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
const defaults = [
  { key: 'notes.fontSize', kind: 'number', value: 13, default: 13, enum: Array.from({ length: 15 }, (_, index) => index + 10) },
  { key: 'notes.contentWidth', kind: 'string', value: 'standard', default: 'standard', enum: ['standard', 'wide'] },
  { key: 'goals.defaultView', kind: 'string', value: 'list', default: 'list', enum: ['list', 'board'] },
  { key: 'goals.showFinished', kind: 'boolean', value: false, default: false }
] as const

it('CLI/RPC discover each actual Work field and its two domain prefixes without materializing defaults', async () => {
  const f = await configOwnerFixture(), call = settings(f), bytes = await f.bytes()
  for (const target of ['notes', 'goals']) {
    let failure: unknown
    const found = await call(['inspect', target]).catch(error => { failure = error })
    expect(failure, 'Supported domain must resolve through the original Main owner').toBeUndefined()
    expect(found).toMatchObject({ partial: true, entries: defaults.filter(entry => entry.key.startsWith(`${target}.`)) })
  }
  for (const entry of defaults) {
    expect((await call(['inspect', entry.key])).entries).toEqual([entry])
    expect((await call(['set', entry.key, String(entry.value)])).entry).toEqual(entry)
  }
  expect(f.owner.current.notes).toBeUndefined(); expect(f.owner.current.goals).toBeUndefined()
  expect(await f.bytes()).toBe(bytes)
  expect(f.save).not.toHaveBeenCalled(); expect(f.publish).not.toHaveBeenCalled(); expect(f.runtime.prepare).not.toHaveBeenCalled()
})

it('real Store validation accepts each bounded font integer and supported choice then publishes durable facts', async () => {
  const f = await configOwnerFixture({ goalsCommonActions: { items: [], collapsed: true } }), call = settings(f)
  const original = structuredClone(f.owner.current)
  for (const [key, values] of [
    ['notes.fontSize', ['10', '24', '16']], ['notes.contentWidth', ['wide', 'standard']],
    ['goals.defaultView', ['board', 'list']], ['goals.showFinished', ['true', 'false']]
  ] as const) {
    for (const value of values) {
      const receipt = await call(['set', key, value])
      expect(receipt.entry.key).toBe(key)
      expect(receipt.entry.value).toBe(key === 'notes.fontSize' ? Number(value) : key === 'goals.showFinished' ? value === 'true' : value)
      const reopened = await new ConfigStore(f.store.filePath).get()
      expect(reopened.notes).toEqual(f.owner.current.notes); expect(reopened.goals).toEqual(f.owner.current.goals)
      expect(f.runtime.commit.mock.invocationCallOrder.at(-1)).toBeLessThan(f.publish.mock.invocationCallOrder.at(-1)!)
    }
  }
  expect(f.owner.current.goalsCommonActions).toEqual({ items: [], collapsed: true })
  for (const key of ['hosts', 'executors', 'workspaces', 'composerShortcuts'] as const) expect(f.owner.current[key]).toEqual(original[key])
})

it('invalid scalar and schema values cannot silently clamp, round, coerce or publish', async () => {
  const f = await configOwnerFixture(), call = settings(f), bytes = await f.bytes()
  for (const value of ['9', '25', '13.5', 'NaN', 'Infinity', '', '0x10', '1e1', ' 13']) {
    await expect(call(['set', 'notes.fontSize', value])).rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
  }
  for (const [key, value] of [['notes.contentWidth', 'WIDE'], ['goals.defaultView', 'grid'], ['goals.showFinished', '1'], ['goals.showFinished', 'TRUE']]) {
    await expect(call(['set', key!, value!])).rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
  }
  for (const notes of [{ fontSize: 9 }, { fontSize: 25 }, { fontSize: 13.5 }, { contentWidth: 'grid' }, { arbitrary: true }]) expect(() => f.store.validate({ ...f.owner.current, notes })).toThrow()
  for (const goals of [{ defaultView: 'grid' }, { showFinished: 'true' }, { arbitrary: true }]) expect(() => f.store.validate({ ...f.owner.current, goals })).toThrow()
  expect(await f.bytes()).toBe(bytes); expect(f.publish).not.toHaveBeenCalled(); expect(f.runtime.prepare).not.toHaveBeenCalled()
})

it('authored first Notes edit preserves concurrently created width and first Goals edit preserves finished visibility', async () => {
  const f = await configOwnerFixture(), before = structuredClone(f.owner.current)
  await f.owner.update(current => ({ ...current, notes: { contentWidth: 'wide' }, goals: { showFinished: true }, copyPathsAsAbsolute: true }))
  await f.owner.edit({ ...before, notes: { fontSize: 13 }, goals: { defaultView: 'list' } },
    { ...before, notes: { fontSize: 18 }, goals: { defaultView: 'board' } })
  expect(f.owner.current.notes).toEqual({ fontSize: 18, contentWidth: 'wide' })
  expect(f.owner.current.goals).toEqual({ defaultView: 'board', showFinished: true })
  expect(f.owner.current.copyPathsAsAbsolute).toBe(true)
  expect((await f.disk()).notes).toEqual(f.owner.current.notes); expect((await f.disk()).goals).toEqual(f.owner.current.goals)
})

it('same-field authored conflict preserves current durable values and reports the precise field', async () => {
  const f = await configOwnerFixture(), before = structuredClone(f.owner.current)
  await f.owner.update(current => ({ ...current, notes: { fontSize: 16 }, goals: { defaultView: 'board' } }))
  const bytes = await f.bytes(), publishes = f.publish.mock.calls.length
  await expect(f.owner.edit({ ...before, notes: { fontSize: 13 } }, { ...before, notes: { fontSize: 18 } })).rejects.toMatchObject({ code: 'CONFIG_CONFLICT', field: 'notes.fontSize' })
  await expect(f.owner.edit({ ...before, goals: { defaultView: 'list' } }, { ...before, goals: { defaultView: 'list', showFinished: true } })).resolves.toMatchObject({ goals: { defaultView: 'board', showFinished: true } })
  expect(f.owner.current.notes?.fontSize).toBe(16)
  expect(f.publish.mock.calls.length).toBe(publishes + 1)
  expect(bytes).not.toBe(await f.bytes())
})

it('first authored edits in the other direction retain concurrently saved font and Goals view', async () => {
  const f = await configOwnerFixture(), before = structuredClone(f.owner.current)
  await f.owner.update(current => ({ ...current, notes: { fontSize: 18 }, goals: { defaultView: 'board' } }))
  await f.owner.edit({ ...before, notes: { contentWidth: 'standard' }, goals: { showFinished: false } },
    { ...before, notes: { contentWidth: 'wide' }, goals: { showFinished: true } })
  expect(f.owner.current.notes).toEqual({ fontSize: 18, contentWidth: 'wide' })
  expect(f.owner.current.goals).toEqual({ defaultView: 'board', showFinished: true })
})

it('public reply waits for real save then commit then publish, without taking any Agent execution action', async () => {
  const f = await configOwnerFixture(), call = settings(f), release = deferred<void>(), realSave = f.save.getMockImplementation()!
  f.save.mockImplementationOnce(async next => { await release.promise; return realSave(next) })
  let replied = false
  const pending = call(['set', 'notes.fontSize', '20']).then(result => { replied = true; return result })
  await vi.waitFor(() => expect(f.save).toHaveBeenCalledTimes(1))
  expect(replied).toBe(false); expect(f.owner.current.notes).toBeUndefined(); expect(f.publish).not.toHaveBeenCalled()
  release.resolve(); expect((await pending).entry.value).toBe(20)
  expect((await f.disk()).notes?.fontSize).toBe(20)
  expect(f.runtime.commit.mock.invocationCallOrder[0]).toBeLessThan(f.publish.mock.invocationCallOrder[0]!)
})

it('real failed durable write replies failure and preserves current configuration and bytes', async () => {
  const f = await configOwnerFixture(), call = settings(f), original = f.owner.current, bytes = await f.bytes(), backup = f.store.filePath + '.original'
  await rename(f.store.filePath, backup); await mkdir(f.store.filePath)
  try {
    await expect(call(['set', 'goals.showFinished', 'true'])).rejects.toMatchObject({ code: 'EISDIR' })
    expect(f.owner.current).toBe(original); expect(f.publish).not.toHaveBeenCalled(); expect(f.runtime.commit).not.toHaveBeenCalled()
  } finally { await rm(f.store.filePath, { recursive: true, force: true }); await rename(backup, f.store.filePath) }
  expect(await f.bytes()).toBe(bytes)
})

it('ordinary CLI executable consumes Notes/Goals via an owned private public socket and durable Main handler', async () => {
  const f = await configOwnerFixture(), directory = await mkdtemp(join(tmpdir(), 'amux-work-rpc-'))
  const server = new AgentMuxControlServer({ execute: request => {
    if (request.operation !== 'settings.get' && request.operation !== 'settings.set') throw new Error('Wrong settings owner')
    return executeSettingsControl(request, f.owner)
  } }, join(directory, 'control.sock'))
  const cli = promisify(execFile), args = [fileURLToPath(new URL('../../../packages/core/bin/amux', import.meta.url)), '--endpoint', `unix:${server.path}`, 'settings']
  const options = { timeout: 5000, env: { ...process.env, AGENTMUX_ENV: undefined, AGENTMUX_AGENT_SESSION_ID: undefined, AGENTMUX_AGENT_CAPABILITY: undefined } }
  await server.start()
  try {
    const guide = (await cli(process.execPath, [args[0]!, '--skill'], options)).stdout
    expect(guide).toContain('settings set notes.fontSize 16')
    expect(guide).toContain('settings set goals.defaultView board')
    const found = JSON.parse((await cli(process.execPath, [...args, 'inspect', 'notes'], options)).stdout).result
    expect(found.entries).toEqual(defaults.filter(entry => entry.key.startsWith('notes.')))
    const saved = JSON.parse((await cli(process.execPath, [...args, 'set', 'goals.defaultView', 'board'], options)).stdout).result
    expect(saved.entry.value).toBe('board'); expect((await f.disk()).goals?.defaultView).toBe('board')
    await expect(cli(process.execPath, [...args, 'set', 'notes.fontSize', '25'], options)).rejects.toBeDefined()
    expect((await f.disk()).notes).toBeUndefined()
  } finally { await server.stop(); await rm(directory, { recursive: true, force: true }) }
})
