import { expect, it, vi } from 'vitest'
vi.mock('electron', async () => ({ app: { getPath: (await import('node:os')).tmpdir } }))
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service.js'
import { ObjectCliProbe } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { executeSettingsControl } from '../src/main/settings-control.js'
import { ConfigStore } from '../src/main/config-store.js'
import { configOwnerFixture } from './helpers/config-owner-fixture.js'

const key = 'startup.skipAgentAvailabilityCheckWait'
const principal = { transport: 'unix', principal: { kind: 'user', id: 'startup-settings-test' } } as const

it.each([undefined, false, true])('preserves historical preference %s without exposing a writable loading gate', async value => {
  const f = await configOwnerFixture(value === undefined ? {} : { startup: { skipAgentAvailabilityCheckWait: value } })
  const original = f.owner.current, bytes = await f.bytes()
  const rpc = new AgentMuxRpcService({ execute: request => executeSettingsControl(request, f.owner) })
  const probe = new ObjectCliProbe(request => rpc.call(request.method as never, request.params as never, principal))
  await probe.start()
  try {
    const inspect = await probe.run(['settings', 'inspect'])
    expect(inspect.code).toBe(0)
    expect(JSON.parse(inspect.stdout).result.entries.some((entry: { key: string }) => entry.key === key)).toBe(false)
    const skill = await probe.run(['settings', '--skill'])
    expect(skill.code).toBe(0)
    expect(skill.stdout).not.toContain('settings set ' + key)
    const rejected = await probe.run(['settings', 'set', key, 'true'])
    expect(rejected.code).toBe(1)
    expect(rejected.stderr).toContain('UNSUPPORTED_SETTING')
    expect(await f.bytes()).toBe(bytes)
    expect(f.save).not.toHaveBeenCalled()
    expect(new ConfigStore(f.store.filePath).validate(JSON.parse(bytes))).toEqual(original)
    const saved = await probe.run(['settings', 'set', 'copyPathsAsAbsolute', 'true'])
    expect(saved.code, saved.stderr).toBe(0)
    const disk = await f.disk()
    expect(disk.copyPathsAsAbsolute).toBe(true)
    expect(disk.startup).toEqual(original.startup)
    expect(disk.workspaces).toEqual(original.workspaces)
    expect(disk.executors).toEqual(original.executors)
    expect(f.store.validate(disk).startup).toEqual(original.startup)
  } finally { await probe.stop() }
})

it('keeps strict rejection of unrelated unknown configuration and malformed historical data', async () => {
  const f = await configOwnerFixture(), current = f.owner.current, bytes = await f.bytes()
  for (const extra of [{ unrelatedUnknown: true }, { startup: { unknownCheck: true } }, { startup: { skipAgentAvailabilityCheckWait: 'true' } }]) {
    expect(() => f.store.validate({ ...current, ...extra })).toThrow()
  }
  expect(await f.bytes()).toBe(bytes)
})
