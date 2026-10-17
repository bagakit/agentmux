import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
vi.mock('electron', async () => { const { tmpdir } = await import('node:os'); return { app: { getPath: () => tmpdir() } } })
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server.js'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service.js'
import { parseSettingsCommand } from '../../../packages/core/src/settings-cli.js'
import { executeSettingsControl } from '../src/main/settings-control.js'
import { ConfigStore } from '../src/main/config-store.js'
import { configOwnerFixture } from './helpers/config-owner-fixture.js'
import { A2A_NOTIFICATION_IDS, a2aNotificationPresentation } from '../src/shared/a2a-preferences.js'

const principal = { transport: 'unix', principal: { kind: 'user', id: 'a2a-settings-proof' } } as const
it('public settings discover and persist the original A2A preference with strict schema and effective-default CAS', async () => {
  const f = await configOwnerFixture(), before = structuredClone(f.owner.current), bytes = await f.bytes()
  const rpc = new AgentMuxRpcService({ execute: request => executeSettingsControl(request as never, f.owner) })
  const call = async (args: string[]) => { const command = await parseSettingsCommand(args); return rpc.call(command.method, command.params, principal) }
  expect((await call(['inspect', 'a2a'])).entries).toEqual([{ key: 'a2a.notifications', kind: 'string', value: 'follow-global', default: 'follow-global', enum: [...A2A_NOTIFICATION_IDS] }])
  await call(['set', 'a2a.notifications', 'follow-global'])
  expect(await f.bytes()).toBe(bytes); expect(f.owner.current.a2a).toBeUndefined(); expect(f.publish).not.toHaveBeenCalled()
  for (const notifications of ['silent', 'notify'] as const) {
    expect((await call(['set', 'a2a.notifications', notifications])).entry.value).toBe(notifications)
    expect((await new ConfigStore(f.store.filePath).get()).a2a).toEqual({ notifications })
  }
  const saved = await f.bytes()
  await expect(f.owner.edit({ ...before, a2a: { notifications: 'follow-global' } }, { ...before, a2a: { notifications: 'silent' } })).rejects.toMatchObject({ code: 'CONFIG_CONFLICT', field: 'a2a.notifications' })
  for (const a2a of [{ notifications: 'loud' }, { notifications: true }, { unknown: 'silent' }]) expect(() => f.store.validate({ ...f.owner.current, a2a } as never)).toThrow()
  await expect(call(['set', 'a2a.notifications', 'loud'])).rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
  expect(await f.bytes()).toBe(saved)
})

it('the executable CLI reads and writes A2A through the actual public socket and Main ConfigOwner', async () => {
  const f = await configOwnerFixture(), server = new AgentMuxControlServer({ execute: request => executeSettingsControl(request as never, f.owner) }, join(f.store.filePath, '..', 'control.sock'))
  await server.start()
  try {
    const call = async (parts: string[]) => JSON.parse((await promisify(execFile)(process.execPath,
      [fileURLToPath(new URL('../../../packages/core/bin/amux', import.meta.url)), '--endpoint', `unix:${server.path}`, 'settings', ...parts],
      { timeout: 10000, env: { ...process.env, AGENTMUX_AGENT_SESSION_ID: undefined, AGENTMUX_AGENT_CAPABILITY: undefined, AGENTMUX_ENV: undefined } })).stdout).result
    expect((await call(['inspect', 'a2a'])).entries[0].default).toBe('follow-global')
    for (const value of ['silent', 'notify', 'follow-global']) {
      expect((await call(['set', 'a2a.notifications', value])).entry.value).toBe(value)
      expect((await call(['inspect', 'a2a.notifications'])).entries[0].value).toBe(value)
      expect((await new ConfigStore(f.store.filePath).get()).a2a?.notifications).toBe(value)
    }
  } finally { await server.stop() }
}, 45000)

it('resolves all banner preferences against the single global dwell and sound owner', () => {
  for (const sound of [false, true]) {
    for (const mode of ['off', 'brief', 'standard', 'patient', 'until-acknowledged'] as const) {
      expect(a2aNotificationPresentation({ a2a: { notifications: 'silent' }, notifications: { mode, sound } })).toBeNull()
      expect(a2aNotificationPresentation({ a2a: { notifications: 'follow-global' }, notifications: { mode, sound } })).toEqual(mode === 'off' ? null : { mode, sound })
      expect(a2aNotificationPresentation({ a2a: { notifications: 'notify' }, notifications: { mode, sound } })).toEqual({ mode: mode === 'off' ? 'standard' : mode, sound })
    }
  }
})
