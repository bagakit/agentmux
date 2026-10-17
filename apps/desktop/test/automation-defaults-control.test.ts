import { fixtureEpoch as _batchFixtureEpoch } from "../../../test/fixture-values.mjs"
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service.js'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server.js'
import { parseSettingsCommand } from '../../../packages/core/src/settings-cli.js'
import { executeSettingsControl } from '../src/main/settings-control.js'
import { ConfigStore } from '../src/main/config-store.js'
import { DEFAULT_AUTOMATION_PREFERENCES as defaults } from '../src/shared/automation-preferences.js'
import { configOwnerFixture, deferred } from './helpers/config-owner-fixture.js'
import type { AppConfig } from '../src/shared/contracts.js'

function settings(f: Awaited<ReturnType<typeof configOwnerFixture>>) {
  const service = new AgentMuxRpcService({ execute: request => {
    if (request.operation !== 'settings.get' && request.operation !== 'settings.set') throw new Error('Settings must not create or change a task')
    return executeSettingsControl(request, f.owner)
  } })
  return async (args: string[]) => { const parsed = await parseSettingsCommand(args); return service.call(parsed.method, parsed.params,
    { transport: 'unix', principal: { kind: 'user', id: 'automation-settings-test' } }) }
}
it('discovers eight effective automation scalars without authoring absent defaults', async () => {
  const f = await configOwnerFixture(), call = settings(f), before = await f.bytes()
  const inspection = call(['inspect', 'automation'])
  await expect(inspection).resolves.toMatchObject({ partial: true })
  const result = await inspection
  expect(result.partial).toBe(true)
  expect(Object.fromEntries(result.entries.map(entry => [entry.key.slice('automation.'.length), entry.value]))).toEqual(defaults)
  expect(result.entries).toHaveLength(8)
  for (const entry of result.entries) await call(['set', entry.key, String(entry.value)])
  expect(f.owner.current.automation).toBeUndefined(); expect(await f.bytes()).toBe(before)
  expect(f.save).not.toHaveBeenCalled(); expect(f.runtime.prepare).not.toHaveBeenCalled()
})
it('strict validation reuses the actual calendar and quiet policy while keeping original config', async () => {
  const f = await configOwnerFixture(), call = settings(f), before = await f.bytes()
  for (const automation of [{ unknown: true }, { calendarTimezone: 'not/an-IANA-zone' }, { checkInQuietStart: new Date(_batchFixtureEpoch(0, 8 * 60 * 60 + 0 * 60)).toISOString().slice(11, 16) },
    { checkInQuietEnd: '24:00' }, { checkInSilenceMs: 299999 }, { checkInMinIntervalMs: 30 * 86400000 + 1 },
    { checkInDailyBudget: 4 }, { checkInDailyBudget: 1.5 }, { progressIntervalMs: 59999 }]) {
    expect(() => f.store.validate({ ...f.owner.current, automation: automation as AppConfig['automation'] })).toThrow()
  }
  for (const [key, value] of [['calendarTimezone', 'not/an-IANA-zone'], ['checkInQuietStart', new Date(_batchFixtureEpoch(0, 8 * 60 * 60 + 0 * 60)).toISOString().slice(11, 16)],
    ['checkInDailyBudget', '4'], ['progressIntervalMs', 'Infinity']])
    await expect(call(['set', 'automation.' + key, value!])).rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
  await expect(call(['set', 'automation.unknown', 'true'])).rejects.toMatchObject({ code: 'UNSUPPORTED_SETTING' })
  expect(await f.bytes()).toBe(before); expect(f.publish).not.toHaveBeenCalled()
})
it('merges concurrent first authored defaults and retains conflicting drafts and unrelated policy', async () => {
  const continuity = { continuationEnabled: false, reminderAppend: 'Retain original historical input.' }
  const f = await configOwnerFixture({ continuity }), before = structuredClone(f.owner.current)
  await Promise.all([
    f.owner.edit({ ...before, automation: { ...defaults } }, { ...before, automation: { ...defaults, progressPrompt: 'My original periodic instruction' } }),
    f.owner.edit({ ...before, automation: { ...defaults } }, { ...before, automation: { ...defaults, calendarTimezone: 'Europe/Berlin' } })
  ])
  expect(f.owner.current.automation).toEqual({ progressPrompt: 'My original periodic instruction', calendarTimezone: 'Europe/Berlin' })
  expect(f.owner.current.continuity).toEqual(continuity)
  const bytes = await f.bytes()
  await expect(f.owner.edit({ ...before, automation: { ...defaults } }, { ...before, automation: { ...defaults, progressPrompt: 'Stale replacement' } }))
    .rejects.toMatchObject({ code: 'CONFIG_CONFLICT', field: 'automation.progressPrompt' })
  expect(await f.bytes()).toBe(bytes)
})
it('waits for durable save before returning a settings receipt and never dispatches a task action', async () => {
  const f = await configOwnerFixture(), call = settings(f), gate = deferred<void>(), save = f.save.getMockImplementation()!
  f.save.mockImplementationOnce(async next => { await gate.promise; return save(next) })
  let replied = false
  const pending = call(['set', 'automation.progressPrompt', 'A later task instruction']).then(result => { replied = true; return result })
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(f.save).toHaveBeenCalledOnce(); expect(replied).toBe(false); expect(f.publish).not.toHaveBeenCalled()
  gate.resolve(); expect((await pending).entry.value).toBe('A later task instruction')
  expect((await f.disk()).automation).toEqual({ progressPrompt: 'A later task instruction' })
})
it('actual CLI persists all default types through the public socket and original ConfigOwner', async () => {
  const f = await configOwnerFixture(), directory = await mkdtemp(join(tmpdir(), 'amux-automation-cli-'))
  const server = new AgentMuxControlServer({ execute: request => {
    if (request.operation !== 'settings.get' && request.operation !== 'settings.set') throw new Error('Unexpected task action')
    return executeSettingsControl(request, f.owner)
  } }, join(directory, 'control.sock'))
  const run = promisify(execFile), args = [fileURLToPath(new URL('../../../packages/core/bin/amux', import.meta.url)), '--endpoint', `unix:${server.path}`, 'settings']
  const custom = { progressIntervalMs: 420000, progressPrompt: 'Continue the precise unfinished task.\nKeep original decisions.', calendarTimezone: 'Europe/Berlin',
    checkInSilenceMs: 7200000, checkInMinIntervalMs: 10800000, checkInDailyBudget: 2, checkInQuietStart: new Date(_batchFixtureEpoch(0, 23 * 60 * 60 + 15 * 60)).toISOString().slice(11, 16), checkInQuietEnd: new Date(_batchFixtureEpoch(0, 7 * 60 * 60 + 45 * 60)).toISOString().slice(11, 16) }
  await server.start()
  try {
    const command = async (parts: string[]) => JSON.parse((await run(process.execPath, [...args, ...parts], {
      timeout: 8000, env: { ...process.env, AGENTMUX_ENV: undefined, AGENTMUX_AGENT_SESSION_ID: undefined, AGENTMUX_AGENT_CAPABILITY: undefined }
    })).stdout).result
    expect((await command(['inspect', 'automation'])).entries).toHaveLength(8)
    for (const [key, value] of Object.entries(custom)) expect((await command(['set', `automation.${key}`, String(value)])).entry.value).toBe(value)
    expect(Object.fromEntries((await command(['inspect', 'automation'])).entries.map((entry: { key: string; value: unknown }) => [entry.key.slice('automation.'.length), entry.value]))).toEqual(custom)
    expect((await new ConfigStore(f.store.filePath).get()).automation).toEqual(custom)
    await command(['set', 'automation.calendarTimezone', ''])
    expect((await new ConfigStore(f.store.filePath).get()).automation?.calendarTimezone).toBe('')
  } finally { await server.stop(); await rm(directory, { recursive: true, force: true }) }
}, 60000)
