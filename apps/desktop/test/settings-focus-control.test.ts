import { fixturePath as _hygiene_fixturePath, fixtureYear as _hygiene_fixtureYear } from "../scripts/lib/fixture-values.mjs"
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it, vi } from 'vitest'
import { configOwnerFixture } from './helpers/config-owner-fixture.js'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service.js'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server.js'
import { parseSettingsCommand } from '../../../packages/core/src/settings-cli.js'
import { executeSettingsControl } from '../src/main/settings-control.js'
import { ConfigStore } from '../src/main/config-store.js'
import { agentStartupRecoveryDecision } from '../src/renderer/src/lib/idle-agent-restore-policy.js'

const principal = { transport: 'unix', principal: { kind: 'user', id: 'focus-test' } } as const
function publicSettings(f: Awaited<ReturnType<typeof configOwnerFixture>>) {
  return new AgentMuxRpcService({ execute: async request => {
    if (request.operation !== 'settings.get' && request.operation !== 'settings.set') throw new Error('Wrong owner')
    return executeSettingsControl(request, f.owner)
  } })
}
async function inspect(rpc: AgentMuxRpcService, target: string) {
  const command = await parseSettingsCommand(['inspect', target])
  expect(command.method).toBe('settings.inspect')
  return rpc.call('settings.inspect', { target: String(command.params.target) }, principal)
}
async function set(rpc: AgentMuxRpcService, key: string, value: string) {
  const command = await parseSettingsCommand(['set', key, value])
  expect(command.method).toBe('settings.set')
  return rpc.call('settings.set', { key: String(command.params.key), value: String(command.params.value) }, principal)
}

it('real CLI and public RPC discover numeric Focus defaults and persist 12/72 through commit then publish', async () => {
  const f = await configOwnerFixture({ profile: { displayName: 'Keep my name', about: 'Keep my background', shareWithAgents: true, avatar: '' } })
  const rpc = publicSettings(f), initial = structuredClone(f.owner.current)
  const entry = { key: 'focus.recentActivityHours', kind: 'number', value: 48, default: 48, enum: [12, 24, 48, 72, 168] }
  expect((await inspect(rpc, 'focus')).entries.find(value => value.key === entry.key)).toEqual(entry)
  expect((await inspect(rpc, 'focus.recentActivityHours')).entries).toEqual([entry])
  expect(f.owner.current.focus).toBeUndefined()
  const before = await f.bytes()
  await set(rpc, 'focus.recentActivityHours', '48')
  expect(await f.bytes()).toBe(before)
  expect(f.save).not.toHaveBeenCalled()
  expect(f.publish).not.toHaveBeenCalled()
  for (const [index, hours] of [12, 72].entries()) {
    const result = await set(rpc, 'focus.recentActivityHours', String(hours))
    expect(result.entry).toEqual({ ...entry, value: hours })
    expect(f.owner.current.focus?.recentActivityHours).toBe(hours)
    expect((await f.disk()).focus?.recentActivityHours).toBe(hours)
    expect(f.publish).toHaveBeenCalledTimes(index + 1)
    expect(vi.mocked(f.runtime.commit).mock.invocationCallOrder[index]).toBeLessThan(f.publish.mock.invocationCallOrder[index]!)
    expect((await inspect(rpc, 'focus')).entries.find(value => value.key === entry.key)).toEqual({ ...entry, value: hours })
    expect(f.owner.current.profile).toEqual(initial.profile)
    expect(f.owner.current.hosts).toEqual(initial.hosts)
    expect(f.owner.current.workspaces).toEqual(initial.workspaces)
    expect(f.owner.current.executors).toEqual(initial.executors)
  }
  const reopened = await new ConfigStore(f.store.filePath).get()
  expect(reopened.focus?.recentActivityHours).toBe(72)
  expect(reopened.profile).toEqual(initial.profile)
})

it('actual CLI discovers 48, sets it through the private public socket and durable owner, and preserves the saved value on invalid input', async () => {
  const f = await configOwnerFixture({ focus: { recentActivityHours: 24 } })
  const socketDirectory = await mkdtemp(_hygiene_fixturePath("tmp/amux-focus-rpc-"))
  const server = new AgentMuxControlServer({ execute: request => {
    if (request.operation !== 'settings.get' && request.operation !== 'settings.set') throw new Error('Wrong business owner')
    return executeSettingsControl(request, f.owner)
  } }, join(socketDirectory, 'control.sock'))
  await server.start()
  const cli = promisify(execFile), args = [resolve('packages/core/bin/amux'), '--endpoint', `unix:${server.path}`, 'settings']
  const options = { timeout: 5000, env: { ...process.env, AGENTMUX_ENV: undefined, AGENTMUX_AGENT_SESSION_ID: undefined, AGENTMUX_AGENT_CAPABILITY: undefined } }
  try {
    const found = JSON.parse((await cli(process.execPath, [...args, 'inspect', 'focus.recentActivityHours'], options)).stdout).result
    expect(found.entries).toEqual([{ key: 'focus.recentActivityHours', kind: 'number', value: 24, default: 48, enum: [12, 24, 48, 72, 168] }])
    const receipt = JSON.parse((await cli(process.execPath, [...args, 'set', 'focus.recentActivityHours', '48'], options)).stdout).result
    expect(receipt.entry.value).toBe(48); expect(f.owner.current.focus?.recentActivityHours).toBe(48)
    expect((await f.disk()).focus?.recentActivityHours).toBe(48)
    expect(f.publish).toHaveBeenCalledTimes(1)
    expect(vi.mocked(f.runtime.commit).mock.invocationCallOrder[0]).toBeLessThan(f.publish.mock.invocationCallOrder[0]!)
    const before = await f.bytes()
    await expect(cli(process.execPath, [...args, 'set', 'focus.recentActivityHours', '49'], options)).rejects.toMatchObject({ code: 1 })
    expect(await f.bytes()).toBe(before); expect(f.publish).toHaveBeenCalledTimes(1)
    const reopened = await new ConfigStore(f.store.filePath).get(); expect(reopened.focus?.recentActivityHours).toBe(48)
  } finally { await server.stop(); await rm(socketDirectory, { recursive: true, force: true }) }
})

it('real public nochange and invalid/unknown values perform no writes or Runtime preparation', async () => {
  const f = await configOwnerFixture({ focus: { recentActivityHours: 72 } }), rpc = publicSettings(f)
  const before = await f.bytes(), current = f.owner.current
  const unchanged = await set(rpc, 'focus.recentActivityHours', '72')
  expect(unchanged.entry.value).toBe(72)
  for (const value of ['13', '0', '24.0', '7.2e1', ' 12', 'NaN', '']) {
    await expect(set(rpc, 'focus.recentActivityHours', value)).rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
  }
  await expect(set(rpc, 'focus.unknown', '12')).rejects.toMatchObject({ code: 'UNSUPPORTED_SETTING' })
  await expect(inspect(rpc, 'focus.unknown')).rejects.toMatchObject({ code: 'UNSUPPORTED_SETTING' })
  expect(await f.bytes()).toBe(before)
  expect(f.owner.current).toBe(current)
  expect(f.save).not.toHaveBeenCalled()
  expect(f.publish).not.toHaveBeenCalled()
  expect(f.runtime.prepare).not.toHaveBeenCalled()
  expect(f.runtime.commit).not.toHaveBeenCalled()
})

it('actual private filesystem save failure cannot produce public success or publish a new window', async () => {
  const f = await configOwnerFixture({ focus: { recentActivityHours: 12 } }), rpc = publicSettings(f)
  const before = await f.bytes(), current = f.owner.current
  const backup = f.store.filePath + '.original'
  // Replace only this private fixture's destination with a directory; the real ConfigStore write fails.
  await rename(f.store.filePath, backup)
  await mkdir(f.store.filePath)
  try {
    await expect(set(rpc, 'focus.recentActivityHours', '72')).rejects.toMatchObject({ code: 'EISDIR' })
    expect(f.owner.current).toBe(current)
    expect(f.owner.current.focus?.recentActivityHours).toBe(12)
    expect(f.publish).not.toHaveBeenCalled()
    expect(f.runtime.commit).not.toHaveBeenCalled()
    expect(f.runtime.discard).toHaveBeenCalledTimes(1)
  } finally {
    await rm(f.store.filePath, { recursive: true, force: true })
    await rename(backup, f.store.filePath)
  }
  expect(await f.bytes()).toBe(before)
})

it('public Focus changes leave the independent 24 hour idle recovery policy intact', async () => {
  const f = await configOwnerFixture(), rpc = publicSettings(f), now = Date.UTC(_hygiene_fixtureYear, 9, 8), hour = 3_600_000
  const decision = (hours: number) => agentStartupRecoveryDecision({ runState: 'missing', canonical: true, now,
    semanticStatus: { state: 'done', source: 'native-hook', observedAt: now, stateEnteredAt: now - hours * hour } })
  for (const value of ['12', '168']) {
    await set(rpc, 'focus.recentActivityHours', value)
    expect(decision(18)).toEqual({ kind: 'resume' })
    expect(decision(24)).toEqual({ kind: 'resume' })
    expect(decision(30)).toEqual({ kind: 'pending', reason: 'idle-over-day' })
  }
})
