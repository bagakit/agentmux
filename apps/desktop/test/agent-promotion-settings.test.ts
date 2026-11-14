import { expect, it, vi } from 'vitest'
vi.mock('electron', async () => { const { tmpdir } = await import('node:os'); return { app: { getPath: () => tmpdir() } } })
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service.js'
import { settingsCliCommand } from '../../../packages/core/test/helpers/settings-command.js'
import { executeSettingsControl } from '../src/main/settings-control.js'
import { configOwnerFixture } from './helpers/config-owner-fixture.js'
const principal = { transport: 'unix', principal: { kind: 'user', id: 'promotion-settings-test' } } as const
it('public Settings CLI discovers and persists promotion.enabled through the same real ConfigOwner', async () => {
  const f = await configOwnerFixture()
  const rpc = new AgentMuxRpcService({ execute: async request => {
    if (request.operation !== 'settings.get' && request.operation !== 'settings.set') throw Error('Unexpected owner operation')
    return executeSettingsControl(request, f.owner)
  } })
  async function call(args: string[]) { const command = await settingsCliCommand(args); return rpc.call(command.method, command.params, principal) }
  expect(await call(['inspect', 'promotion.enabled'])).toMatchObject({ entries: [{ key: 'promotion.enabled', kind: 'boolean', value: true, default: true }] })
  const before = await f.disk()
  expect(await call(['set', 'promotion.enabled', 'false'])).toMatchObject({ entry: { key: 'promotion.enabled', value: false } })
  expect((await f.disk()).promotion).toEqual({ enabled: false })
  for (const key of ['workspaces', 'executors', 'hosts'] as const) expect((await f.disk())[key]).toEqual(before[key])
  expect(await call(['inspect', 'promotion'])).toMatchObject({ entries: [{ key: 'promotion.enabled', value: false }] })
})
it('invalid Promotion values are refused before a configuration write while healthy Agent policy stays intact', async () => {
  const f = await configOwnerFixture({ promotion: { enabled: false } }), bytes = await f.bytes()
  for (const value of ['TRUE', '1', '', 'on']) {
    await expect(executeSettingsControl({ schemaVersion: 1, requestId: 'invalid-promotion', operation: 'settings.set', key: 'promotion.enabled', value }, f.owner)).rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
  }
  expect(await f.bytes()).toBe(bytes); expect(f.publish).not.toHaveBeenCalled(); expect(f.runtime.prepare).not.toHaveBeenCalled()
})
