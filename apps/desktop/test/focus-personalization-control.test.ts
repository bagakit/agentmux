import { configOwnerFixture } from './helpers/config-owner-fixture.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join, resolve } from 'node:path'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server.js'
import { expect, it } from 'vitest'
import { ConfigStore } from '../src/main/config-store.js'
import { resolveFocusPreferences } from '../src/shared/focus-preferences.js'
import { applyConfigEdit } from '../src/shared/config-edit.js'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service.js'
import { parseSettingsCommand } from '../../../packages/core/src/settings-cli.js'
import { executeSettingsControl } from '../src/main/settings-control.js'

const principal = { transport: 'unix', principal: { kind: 'user', id: 'focus-preferences-test' } } as const
it('discovers, applies and durably reopens each Focus presentation choice through the original CLI parser and public RPC owner', async () => {
  const f = await configOwnerFixture({ copyPathsAsAbsolute: true })
  const rpc = new AgentMuxRpcService({ execute: request => executeSettingsControl(request, f.owner) })
  const inspect = await rpc.call('settings.inspect', { target: 'focus' }, principal)
  const choices = [
    ['focus.replyLines', [1, 2, 3], 2],
    ['focus.recentInputs', [3, 6, 10], 6],
    ['focus.previewTrigger', ['quick', 'deliberate', 'keyboard'], 'quick']
  ] as const
  for (const [key, values, defaultValue] of choices) {
    expect(inspect.entries.find(entry => entry.key === key)).toMatchObject({ key, value: defaultValue, default: defaultValue, enum: [...values] })
    for (const value of values) {
      const command = await parseSettingsCommand(['set', key, String(value)])
      const receipt = await rpc.call('settings.set', command.params, principal)
      expect(receipt.entry.value).toBe(value)
      const field = key.slice('focus.'.length) as 'replyLines' | 'recentInputs' | 'previewTrigger'
      expect(resolveFocusPreferences(f.owner.current.focus)[field]).toBe(value)
      expect(resolveFocusPreferences((await new ConfigStore(f.store.filePath).get()).focus)[field]).toBe(value)
      expect(f.owner.current.copyPathsAsAbsolute).toBe(true)
    }
  }
  const before = await f.bytes(), writes = f.save.mock.calls.length
  await rpc.call('settings.set', { key: 'focus.replyLines', value: '3' }, principal)
  for (const [key, value] of [['focus.replyLines', '0'], ['focus.replyLines', '3.0'], ['focus.recentInputs', '1000'], ['focus.previewTrigger', 'never']]) {
    await expect(rpc.call('settings.set', { key, value }, principal)).rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
  }
  expect(f.save.mock.calls.length).toBe(writes)
  expect(await f.bytes()).toBe(before)
  const server = new AgentMuxControlServer({ execute: request => executeSettingsControl(request, f.owner) }, join(dirname(f.store.filePath), 'control.sock'))
  await server.start()
  try {
    const cli = promisify(execFile), args = [resolve('packages/core/bin/amux'), '--endpoint', `unix:${server.path}`, 'settings']
    const options = { timeout: 5000, env: { ...process.env, AGENTMUX_ENV: undefined, AGENTMUX_AGENT_SESSION_ID: undefined, AGENTMUX_AGENT_CAPABILITY: undefined } }
    const result = await cli(process.execPath, [...args, 'inspect', 'focus.previewTrigger'], options)
    expect(JSON.parse(result.stdout).result.entries[0]).toMatchObject({ key: 'focus.previewTrigger', value: 'keyboard' })
    const changed = await cli(process.execPath, [...args, 'set', 'focus.replyLines', '1'], options)
    expect(JSON.parse(changed.stdout).result.entry.value).toBe(1)
    expect((await new ConfigStore(f.store.filePath).get()).focus?.replyLines).toBe(1)
  } finally { await server.stop() }

})

it('normalizes effective defaults during a GUI edit and preserves unrelated concurrent choices while refusing a same-field conflict', async () => {
  const f = await configOwnerFixture(), base = f.owner.current
  const next = { ...base, focus: { recentActivityHours: 48 as const, replyLines: 3 as const } }
  const expected = { ...base, focus: { recentActivityHours: 48 as const, replyLines: 2 as const } }
  const external = { ...base, focus: { recentActivityHours: 48 as const, previewTrigger: 'keyboard' as const } }
  const merged = applyConfigEdit(external, expected, next)
  expect(merged.focus).toEqual({ recentActivityHours: 48, replyLines: 3, previewTrigger: 'keyboard' })
  expect(() => applyConfigEdit({ ...external, focus: { ...external.focus, replyLines: 1 } }, expected, next)).toThrow('focus.replyLines')
  for (const invalid of [{ replyLines: 0 }, { recentInputs: 7 }, { previewTrigger: 'hover' }]) {
    expect(() => f.store.validate({ ...base, focus: { recentActivityHours: 48, ...invalid } })).toThrow()
  }
})
