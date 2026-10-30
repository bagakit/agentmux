// @vitest-environment happy-dom
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { configOwnerFixture, deferred } from './helpers/config-owner-fixture'
import { ConfigStore } from '../src/main/config-store'
import { executeSettingsControl } from '../src/main/settings-control'
import { resolveFocusPreferences, resolveFocusTopicPresentation } from '../src/shared/focus-preferences'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'

const key = 'focus.topicPresentation'
const inspect = (owner: Awaited<ReturnType<typeof configOwnerFixture>>['owner']) => executeSettingsControl({ schemaVersion: 5, requestId: 'read-topic-presentation', operation: 'settings.get', target: key }, owner)
const set = (owner: Awaited<ReturnType<typeof configOwnerFixture>>['owner'], value: string) => executeSettingsControl({ schemaVersion: 5, requestId: 'set-topic-presentation-' + value, operation: 'settings.set', key, value }, owner)

it('uses the shared cards default without writing it, then accepts the first GUI edit through the real durable owner', async () => {
  const f = await configOwnerFixture(), before = f.owner.current, bytes = await f.bytes()
  expect(resolveFocusTopicPresentation(undefined)).toBe('cards')
  expect(resolveFocusTopicPresentation('invalid')).toBe('cards')
  expect(resolveFocusPreferences(undefined).topicPresentation).toBe('cards')
  expect(await inspect(f.owner)).toMatchObject({ entries: [{ key, kind: 'string', value: 'cards', default: 'cards', enum: ['cards', 'sections'] }] })
  await set(f.owner, 'cards')
  expect(f.owner.current).toBe(before); expect(await f.bytes()).toBe(bytes); expect(f.save).not.toHaveBeenCalled()
  const effective = { ...before, focus: resolveFocusPreferences(undefined) }
  await f.owner.edit(effective, { ...effective, focus: { ...effective.focus, topicPresentation: 'sections' } })
  expect(f.owner.current.focus).toEqual({ recentActivityHours: 48, topicPresentation: 'sections' })
  expect((await f.disk()).focus).toEqual(f.owner.current.focus)
  expect((await new ConfigStore(f.store.filePath).get()).focus?.topicPresentation).toBe('sections')
  for (const field of ['hosts', 'executors', 'workspaces', 'appearance'] as const) expect(f.owner.current[field]).toEqual(before[field])
})

it('merges unrelated authored choices and treats a concurrent same-value choice as idempotent', async () => {
  const f = await configOwnerFixture(), before = { ...f.owner.current, focus: resolveFocusPreferences(undefined) }
  await executeSettingsControl({ schemaVersion: 5, requestId: 'change-other-focus-field', operation: 'settings.set', key: 'focus.replyLines', value: '3' }, f.owner)
  const request = { ...before, focus: { ...before.focus, topicPresentation: 'sections' as const } }
  await f.owner.edit(before, request)
  expect(f.owner.current.focus).toEqual({ recentActivityHours: 48, replyLines: 3, topicPresentation: 'sections' })
  const calls = f.save.mock.calls.length
  await f.owner.edit(before, request)
  expect(f.save).toHaveBeenCalledTimes(calls)
})

it('does not publish an invalid value or a failed durable write, and keeps queued later choices', async () => {
  const f = await configOwnerFixture(), before = f.owner.current, bytes = await f.bytes()
  for (const value of ['section', 'Cards', 'sections ', 'unknown']) {
    await expect(set(f.owner, value)).rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
    expect(() => f.store.validate({ ...before, focus: { recentActivityHours: 48, topicPresentation: value } })).toThrow()
  }
  expect(await f.bytes()).toBe(bytes); expect(f.publish).not.toHaveBeenCalled()
  f.save.mockRejectedValueOnce(Object.assign(new Error('Private original config write failed'), { code: 'EIO' }))
  await expect(set(f.owner, 'sections')).rejects.toMatchObject({ code: 'EIO' })
  expect(f.owner.current).toBe(before); expect(await f.bytes()).toBe(bytes); expect(f.publish).not.toHaveBeenCalled()
  const gate = deferred<void>(), save = f.save.getMockImplementation()!
  f.save.mockImplementationOnce(async next => { await gate.promise; return save(next) })
  const sections = set(f.owner, 'sections'), cards = set(f.owner, 'cards')
  gate.resolve(); await sections; await cards
  expect(f.owner.current.focus?.topicPresentation).toBe('cards')
  expect((await f.disk()).focus?.topicPresentation).toBe('cards')
})

it('discovers and saves the exact enum with the real public CLI socket and retains bytes after invalid input', async () => {
  const f = await configOwnerFixture(), directory = await mkdtemp(fixturePath('tmp/amux-topic-settings-'))
  const server = new AgentMuxControlServer({ execute: request => {
    if (request.operation !== 'settings.get' && request.operation !== 'settings.set') throw new Error('Original settings owner required')
    return executeSettingsControl(request, f.owner)
  } }, join(directory, 'control.sock'))
  await server.start()
  const call = promisify(execFile), args = [resolve('packages/core/bin/amux'), '--endpoint', `unix:${server.path}`, 'settings']
  const options = { timeout: 10000, env: { ...process.env, AGENTMUX_ENV: undefined, AGENTMUX_AGENT_SESSION_ID: undefined, AGENTMUX_AGENT_CAPABILITY: undefined } }
  try {
    const found = JSON.parse((await call(process.execPath, [...args, 'inspect', key], options)).stdout).result
    expect(found.entries).toEqual([{ key, kind: 'string', value: 'cards', default: 'cards', enum: ['cards', 'sections'] }])
    for (const value of ['sections', 'cards', 'sections']) {
      const result = JSON.parse((await call(process.execPath, [...args, 'set', key, value], options)).stdout).result
      expect(result.entry.value).toBe(value); expect(f.owner.current.focus?.topicPresentation).toBe(value)
      expect((await f.disk()).focus?.topicPresentation).toBe(value)
    }
    const bytes = await f.bytes()
    await expect(call(process.execPath, [...args, 'set', key, 'compact'], options)).rejects.toMatchObject({ code: 1 })
    expect(await f.bytes()).toBe(bytes)
  } finally { await server.stop(); await rm(directory, { recursive: true, force: true }) }
})
