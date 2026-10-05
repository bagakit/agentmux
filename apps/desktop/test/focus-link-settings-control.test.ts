import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { configOwnerFixture } from './helpers/config-owner-fixture'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { executeSettingsControl } from '../src/main/settings-control'
import { ConfigStore } from '../src/main/config-store'

it.each([undefined, { recentActivityHours: 48 as const }])('the actual durable owner accepts the first GUI default edit without manufacturing a conflict (%j)', async focus => {
  const f = await configOwnerFixture(focus ? { focus } : {}), current = f.owner.current
  const before = { ...current, focus: { ...current.focus, recentActivityHours: 48 as const, linkDestination: 'region' as const } }
  const after = { ...before, focus: { ...before.focus, linkDestination: 'tab' as const } }
  const saved = await f.owner.edit(before, after)
  expect(saved.focus?.linkDestination).toBe('tab'); expect((await f.disk()).focus?.linkDestination).toBe('tab')
  expect(saved.workspaces).toEqual(current.workspaces); expect(saved.executors).toEqual(current.executors)
  expect(f.publish).toHaveBeenCalledOnce()
  expect(vi.mocked(f.runtime.commit).mock.invocationCallOrder[0]).toBeLessThan(f.publish.mock.invocationCallOrder[0]!)
  expect((await new ConfigStore(f.store.filePath).get()).focus?.linkDestination).toBe('tab')
})

it('actual public CLI discovers the destination, saves it through the only owner, and rejects invalid values without writes', async () => {
  const f = await configOwnerFixture(), directory = await mkdtemp(_hygiene_fixturePath("tmp/amux-focus-links-"))
  const server = new AgentMuxControlServer({ execute: request => {
    if (request.operation !== 'settings.get' && request.operation !== 'settings.set') throw new Error('Wrong owner')
    return executeSettingsControl(request, f.owner)
  } }, join(directory, 'control.sock'))
  await server.start()
  const args = [resolve('packages/core/bin/amux'), '--endpoint', `unix:${server.path}`, 'settings']
  const call = promisify(execFile), options = { timeout: 5000, env: { ...process.env, AGENTMUX_ENV: undefined, AGENTMUX_AGENT_SESSION_ID: undefined, AGENTMUX_AGENT_CAPABILITY: undefined } }
  try {
    const inspect = JSON.parse((await call(process.execPath, [...args, 'inspect', 'focus.linkDestination'], options)).stdout).result
    expect(inspect.entries).toEqual([{ key: 'focus.linkDestination', kind: 'string', value: 'region', default: 'region', enum: ['region', 'tab'] }])
    const bytes = await f.bytes()
    await call(process.execPath, [...args, 'set', 'focus.linkDestination', 'region'], options)
    expect(await f.bytes()).toBe(bytes); expect(f.save).not.toHaveBeenCalled()
    const result = JSON.parse((await call(process.execPath, [...args, 'set', 'focus.linkDestination', 'tab'], options)).stdout).result
    expect(result.entry.value).toBe('tab'); expect((await f.disk()).focus?.linkDestination).toBe('tab')
    const saved = await f.bytes()
    await expect(call(process.execPath, [...args, 'set', 'focus.linkDestination', 'right'], options)).rejects.toMatchObject({ code: 1 })
    expect(await f.bytes()).toBe(saved); expect(f.publish).toHaveBeenCalledOnce()
    expect((await new ConfigStore(f.store.filePath).get()).focus?.linkDestination).toBe('tab')
  } finally { await server.stop(); await rm(directory, { recursive: true, force: true }) }
})

it('a real failed file save keeps the original default, config and publish state', async () => {
  const f = await configOwnerFixture(), current = f.owner.current, backup = f.store.filePath + '.original'
  const before = { ...current, focus: { recentActivityHours: 48 as const, linkDestination: 'region' as const } }
  const after = { ...before, focus: { ...before.focus, linkDestination: 'tab' as const } }
  await rename(f.store.filePath, backup); await mkdir(f.store.filePath)
  try {
    await expect(f.owner.edit(before, after)).rejects.toMatchObject({ code: 'EISDIR' })
    expect(f.owner.current).toBe(current); expect(f.publish).not.toHaveBeenCalled()
  } finally { await rm(f.store.filePath, { recursive: true }); await rename(backup, f.store.filePath) }
})
