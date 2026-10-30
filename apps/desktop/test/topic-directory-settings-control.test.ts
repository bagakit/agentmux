import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { appendFile, mkdir, rename, rm } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
vi.mock('electron', async () => ({ app: { getPath: (await import('node:os')).tmpdir } }))
import { ObjectCliProbe } from '../../../packages/core/test/helpers/object-cli-rpc'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service'
import { executeSettingsControl } from '../src/main/settings-control'
import { ConfigStore } from '../src/main/config-store'
import { configOwnerFixture } from './helpers/config-owner-fixture'

const principal = { transport: 'unix', principal: { kind: 'user', id: 'topic-settings-test' } } as const
const entry = { key: 'topicDirectoryInitialView', kind: 'string', value: 'topics', default: 'topics', enum: ['topics', 'knowledge'] }

it('the real CLI discovers and persists the scalar and reports invalid values or a durable write failure without publishing', async () => {
  const f = await configOwnerFixture(), original = f.owner.current, before = await f.bytes()
  const rpc = new AgentMuxRpcService({ execute: request => {
    if (request.operation !== 'settings.get' && request.operation !== 'settings.set') throw new Error('Wrong settings owner')
    return executeSettingsControl(request, f.owner)
  } })
  const probe = new ObjectCliProbe(request => rpc.call(request.method as never, request.params as never, principal))
  await probe.start()
  const cli = fileURLToPath(new URL('../../../packages/core/bin/amux', import.meta.url))
  async function run(args: string[], expectedCode = 0) {
    let value: { code: number | string; stdout: string; stderr: string }
    try {
      value = { code: 0, ...await promisify(execFile)(process.execPath, [cli, 'settings', ...args], { env: probe.environment({ NODE_NO_WARNINGS: '1' }), timeout: 10000 }) }
    } catch (cause) {
      const failed = cause as { code: number; stdout: string; stderr: string }
      value = { code: failed.code, stdout: failed.stdout, stderr: failed.stderr }
    }
    if (process.env.AGENTMUX_TOPIC_CLI_RECEIPTS) await appendFile(process.env.AGENTMUX_TOPIC_CLI_RECEIPTS,
      JSON.stringify({ args: ['settings', ...args], ...value }) + '\n')
    expect(value.code).toBe(expectedCode)
    return JSON.parse(expectedCode === 0 ? value.stdout : value.stderr)
  }
  try {
    expect(await run(['inspect', entry.key])).toMatchObject({ ok: true, operation: 'settings.inspect', result: { entries: [entry], partial: true } })
    expect((await run(['inspect'])).result.entries).toContainEqual(entry)
    await run(['set', entry.key, 'topics'])
    expect(await f.bytes()).toBe(before)
    expect(f.save).not.toHaveBeenCalled()
    await run(['set', entry.key, 'knowledge'])
    expect((await new ConfigStore(f.store.filePath).get()).topicDirectoryInitialView).toBe('knowledge')
    expect(f.owner.current.workspaces).toEqual(original.workspaces)
    expect(f.owner.current.executors).toEqual(original.executors)
    expect((await run(['inspect', entry.key])).result.entries).toEqual([{ ...entry, value: 'knowledge' }])
    const bytes = await f.bytes()
    for (const value of ['grid', 'Knowledge', '']) {
      expect(await run(['set', entry.key, value], 1)).toMatchObject({ ok: false, operation: 'settings.set', error: { code: 'INVALID_SETTING_VALUE' } })
    }
    expect(await f.bytes()).toBe(bytes)
    const current = f.owner.current, backup = f.store.filePath + '.original'
    await rename(f.store.filePath, backup)
    await mkdir(f.store.filePath)
    f.publish.mockClear()
    try {
      expect(await run(['set', entry.key, 'topics'], 1)).toMatchObject({ ok: false, operation: 'settings.set' })
      expect(f.owner.current).toBe(current)
      expect(f.publish).not.toHaveBeenCalled()
    } finally {
      await rm(f.store.filePath, { recursive: true })
      await rename(backup, f.store.filePath)
    }
    expect(await f.bytes()).toBe(bytes)
    expect(probe.requests.some(request => request.method === 'settings.inspect')).toBe(true)
    expect(probe.requests.some(request => request.method === 'settings.set')).toBe(true)
  } finally { await probe.stop() }
}, 20000)

it('the original ConfigOwner recognizes the absent default, preserves unrelated edits and joins a concurrent equal choice', async () => {
  const f = await configOwnerFixture(), before = f.owner.current
  expect(before.topicDirectoryInitialView).toBeUndefined()
  await f.owner.update(config => ({ ...config, copyPathsAsAbsolute: true }))
  const expected = { ...before, topicDirectoryInitialView: 'topics' as const }, requested = { ...before, topicDirectoryInitialView: 'knowledge' as const }
  await f.owner.edit(expected, requested)
  expect(f.owner.current.copyPathsAsAbsolute).toBe(true)
  expect(f.owner.current.topicDirectoryInitialView).toBe('knowledge')
  const bytes = await f.bytes(), writes = f.save.mock.calls.length
  await f.owner.edit(expected, requested)
  expect(await f.bytes()).toBe(bytes)
  expect(f.save.mock.calls).toHaveLength(writes)
  for (const topicDirectoryInitialView of ['grid', '', null, 1]) {
    await expect(f.store.save({ ...f.owner.current, topicDirectoryInitialView } as never)).rejects.toThrow()
  }
  expect(await f.bytes()).toBe(bytes)
})
