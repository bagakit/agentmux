import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
import { DEFAULT_AGENT_CONTINUITY_POLICY } from '@agentmux/core'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service.js'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server.js'
import { parseSettingsCommand } from '../../../packages/core/src/settings-cli.js'
import { executeSettingsControl } from '../src/main/settings-control.js'
import { ConfigStore } from '../src/main/config-store.js'
import { configOwnerFixture, deferred } from './helpers/config-owner-fixture.js'

const principal = { transport: 'unix', principal: { kind: 'user', id: 'continuity-settings-test' } } as const
function settings(f: Awaited<ReturnType<typeof configOwnerFixture>>) {
  const rpc = new AgentMuxRpcService({ execute: async request => {
    if (request.operation !== 'settings.get' && request.operation !== 'settings.set') throw new Error('Settings must not execute a session action')
    return executeSettingsControl(request, f.owner)
  } })
  return async (args: string[]) => { const command = await parseSettingsCommand(args); return rpc.call(command.method, command.params, principal) }
}
const defaults = DEFAULT_AGENT_CONTINUITY_POLICY
it('public RPC discovers the complete Core policy and keeps absent effective defaults absent', async () => {
  const f = await configOwnerFixture(), call = settings(f), bytes = await f.bytes()
  const inspection = call(['inspect', 'continuity'])
  await expect(inspection).resolves.toMatchObject({ partial: true })
  const result = await inspection
  expect(result.partial).toBe(true)
  expect(Object.fromEntries(result.entries.map(entry => [entry.key.slice('continuity.'.length), entry.value]))).toEqual(defaults)
  expect(result.entries.length).toBeGreaterThan(0)
  for (const entry of result.entries) await call(['set', entry.key, String(entry.value)])
  expect(f.owner.current.continuity).toBeUndefined(); expect(await f.bytes()).toBe(bytes); expect(f.publish).not.toHaveBeenCalled()
})
it('all declared scalar types persist through the original owner with strict target and schema validation', async () => {
  const f = await configOwnerFixture(), call = settings(f)
  const choices = { activeRecovery: 'manual', activeRecoveryDelayMs: 1234, confirmedIdleWindowMs: 7200000, resumeAfterExit: false,
    recheckIntervalMs: 250, recheckMaxAttempts: 9, retryInitialDelayMs: 2000, retryMaxDelayMs: 45000, retryMaxAttempts: 8, reminderMode: 'default-plus-custom', reminderAppend: 'Keep the original constraints.\nDo not repeat unknown input.',
    continuationEnabled: false, continuationPrompt: 'Continue only the interrupted request.' }
  for (const [key, value] of Object.entries(choices)) {
    expect((await call(['set', `continuity.${key}`, String(value)])).entry.value).toBe(value)
    expect((await call(['inspect', `continuity.${key}`])).entries[0].value).toBe(value)
  }
  expect((await new ConfigStore(f.store.filePath).get()).continuity).toEqual(choices)
  const bytes = await f.bytes()
  for (const value of ['-1', '1.5', 'NaN', 'Infinity', '', '0x10', '1e3', String(Number.MAX_SAFE_INTEGER + 1)]) {
    await expect(call(['set', 'continuity.activeRecoveryDelayMs', value])).rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
  }
  for (const [key, value] of [['activeRecovery', 'AUTO'], ['reminderMode', 'custom-only'], ['continuationEnabled', 'TRUE']]) {
    await expect(call(['set', `continuity.${key}`, value!])).rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
  }
  await expect(call(['set', 'continuity.arbitrary.path', 'true'])).rejects.toMatchObject({ code: 'UNSUPPORTED_SETTING' })
  for (const continuity of [{ arbitrary: true }, { activeRecoveryDelayMs: -1 }, { recheckMaxAttempts: 1.5 }, { continuationEnabled: 'true' }]) {
    expect(() => f.store.validate({ ...f.owner.current, continuity } as never)).toThrow()
  }
  expect(await f.bytes()).toBe(bytes)
  await call(['set', 'continuity.activeRecoveryDelayMs', String(Number.MAX_SAFE_INTEGER)])
  const long = 'A retained recovery instruction.\n'.repeat(10000)
  await call(['set', 'continuity.reminderAppend', long]); expect((await f.disk()).continuity?.reminderAppend).toBe(long)
})
it('retry settings reject invalid complete policies and preserve unrelated authored data', async () => {
  const f = await configOwnerFixture({ copyPathsAsAbsolute: true }), call = settings(f), bytes = await f.bytes()
  for (const continuity of [{ retryInitialDelayMs: 31000 }, { retryMaxDelayMs: 999 }, { retryMaxAttempts: 1.5 },
    { retryInitialDelayMs: -1 }, { retryMaxDelayMs: Number.MAX_SAFE_INTEGER + 1 }]) {
    expect(() => f.store.validate({ ...f.owner.current, continuity })).toThrow()
  }
  await expect(call(['set', 'continuity.retryInitialDelayMs', '31000'])).rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
  await expect(call(['set', 'continuity.retryMaxDelayMs', '999'])).rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
  for (const value of ['-1', '1.5', 'NaN', 'Infinity', '', '1e3', String(Number.MAX_SAFE_INTEGER + 1)]) {
    await expect(call(['set', 'continuity.retryMaxAttempts', value])).rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
  }
  expect(await f.bytes()).toBe(bytes); expect(f.publish).not.toHaveBeenCalled()
  await call(['set', 'continuity.retryMaxDelayMs', String(Number.MAX_SAFE_INTEGER)])
  await call(['set', 'continuity.retryInitialDelayMs', String(Number.MAX_SAFE_INTEGER)])
  await call(['set', 'continuity.retryMaxAttempts', '0'])
  expect((await f.disk()).continuity).toEqual({ retryMaxDelayMs: Number.MAX_SAFE_INTEGER, retryInitialDelayMs: Number.MAX_SAFE_INTEGER, retryMaxAttempts: 0 })
  await call(['set', 'continuity.retryInitialDelayMs', '0']); await call(['set', 'continuity.retryMaxDelayMs', '0'])
  expect((await f.disk()).continuity).toEqual({ retryMaxDelayMs: 0, retryInitialDelayMs: 0, retryMaxAttempts: 0 })
  expect(f.owner.current.copyPathsAsAbsolute).toBe(true)
})

it('concurrent first authored fields merge without materializing untouched defaults and conflicts keep disk intact', async () => {
  const f = await configOwnerFixture(), before = structuredClone(f.owner.current)
  const edits = Promise.all([
    f.owner.edit({ ...before, continuity: { ...defaults } }, { ...before, continuity: { ...defaults, activeRecoveryDelayMs: 1000 } }),
    f.owner.edit({ ...before, continuity: { ...defaults } }, { ...before, continuity: { ...defaults, reminderMode: 'off' } })
  ])
  await expect(edits).resolves.toBeDefined()
  expect(f.owner.current.continuity).toEqual({ activeRecoveryDelayMs: 1000, reminderMode: 'off' })
  const bytes = await f.bytes()
  await expect(f.owner.edit({ ...before, continuity: { ...defaults } }, { ...before, continuity: { ...defaults, activeRecoveryDelayMs: 2000 } })).rejects.toMatchObject({ code: 'CONFIG_CONFLICT', field: 'continuity.activeRecoveryDelayMs' })
  expect(await f.bytes()).toBe(bytes)
})
it('RPC success waits for durable save and publication without issuing recovery or message side effects', async () => {
  const f = await configOwnerFixture(), call = settings(f), gate = deferred<void>(), original = f.save.getMockImplementation()!
  f.save.mockImplementationOnce(async next => { await gate.promise; return original(next) })
  let replied = false
  const pending = call(['set', 'continuity.continuationEnabled', 'false']).then(result => { replied = true; return result })
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(f.save).toHaveBeenCalledOnce(); expect(replied).toBe(false); expect(f.publish).not.toHaveBeenCalled()
  gate.resolve(); expect((await pending).entry.value).toBe(false)
  expect((await f.disk()).continuity).toEqual({ continuationEnabled: false })
})
it('actual CLI executable writes and reads continuity through the owned public socket and durable Main handler', async () => {
  const f = await configOwnerFixture(), directory = await mkdtemp(join(tmpdir(), 'amux-continuity-cli-'))
  const server = new AgentMuxControlServer({ execute: request => {
    if (request.operation !== 'settings.get' && request.operation !== 'settings.set') throw new Error('Unexpected session side effect')
    return executeSettingsControl(request, f.owner)
  } }, join(directory, 'control.sock'))
  const cli = promisify(execFile), args = [fileURLToPath(new URL('../../../packages/core/bin/amux', import.meta.url)), '--endpoint', `unix:${server.path}`, 'settings']
  const options = { timeout: 8000, env: { ...process.env, AGENTMUX_ENV: undefined, AGENTMUX_AGENT_SESSION_ID: undefined, AGENTMUX_AGENT_CAPABILITY: undefined } }
  await server.start()
  try {
    const command = async (parts: string[]) => JSON.parse((await cli(process.execPath, [...args, ...parts], options)).stdout).result
    expect((await command(['inspect', 'continuity'])).entries).toHaveLength(Object.keys(defaults).length)
    expect((await command(['set', 'continuity.reminderMode', 'default-plus-custom'])).entry.value).toBe('default-plus-custom')
    expect((await command(['set', 'continuity.reminderAppend', 'Keep the prior decisions.\nDo not replay unknown input.'])).entry.value).toContain('prior decisions')
    expect((await command(['set', 'continuity.activeRecoveryDelayMs', '1200'])).entry.value).toBe(1200)
    expect((await command(['set', 'continuity.retryMaxDelayMs', '45000'])).entry.value).toBe(45000)
    expect((await command(['set', 'continuity.retryInitialDelayMs', '2125'])).entry.value).toBe(2125)
    expect((await command(['set', 'continuity.retryMaxAttempts', '0'])).entry.value).toBe(0)
    expect((await command(['set', 'continuity.continuationEnabled', 'false'])).entry.value).toBe(false)
    expect((await command(['inspect', 'continuity.activeRecoveryDelayMs'])).entries[0].value).toBe(1200)
    expect((await new ConfigStore(f.store.filePath).get()).continuity).toEqual({ reminderMode: 'default-plus-custom', reminderAppend: 'Keep the prior decisions.\nDo not replay unknown input.', activeRecoveryDelayMs: 1200, retryMaxDelayMs: 45000, retryInitialDelayMs: 2125, retryMaxAttempts: 0, continuationEnabled: false })
    await expect(command(['set', 'continuity.recheckMaxAttempts', '-1'])).rejects.toBeDefined()
    await expect(command(['set', 'continuity.unknown', 'value'])).rejects.toBeDefined()
  } finally { await server.stop(); await rm(directory, { recursive: true, force: true }) }
}, 60000)
