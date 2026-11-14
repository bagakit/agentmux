import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxControlServer, connectAgentMuxRpc } from '../../../packages/core/src/control-host.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { configOwnerFixture } from './helpers/config-owner-fixture.js'
import { executeSettingsControl } from '../src/main/settings-control.js'
import { ConfigStore } from '../src/main/config-store.js'
import { themeObservation } from '../../host/src/theme-observation.js'
import { CONVERSATION_DETAIL_LEVELS, resolveConversationDetailLevel } from '@agentmux/client-ui/conversation-detail-level'

it('discovers, writes, observes and reopens the same reading choice through the public service and CLI', async () => {
  const f = await configOwnerFixture(), directory = await mkdtemp(join(tmpdir(), 'detail-cli-'))
  const operations: string[] = [], snapshots: any[] = []
  const server = new AgentMuxControlServer({ socketPath: join(directory, 'control.sock'), coreClients: () => [],
    appearance: themeObservation(f.owner), execute: input => {
      operations.push(input.operation)
      if (input.operation !== 'settings.get' && input.operation !== 'settings.set') throw Error('Unexpected write')
      return executeSettingsControl(input, f.owner)
    } })
  await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  const cli = (args: string[]) => runCompiledObjectCli(['settings', ...args], objectCliEnvironment(directory))
  const reader = await rpc.subscribe('settings.appearance.watch', {}, {
    onInitial: value => snapshots.push(value.observation), onEvent: event => { if (event.type === 'snapshot') snapshots.push(event.data) }
  })
  try {
    const original = await f.bytes()
    const found = await cli(['inspect', 'appearance.conversationDetailLevel'])
    expect(found.code, found.stderr).toBe(0)
    expect(JSON.parse(found.stdout).result.entries).toEqual([expect.objectContaining({ key: 'appearance.conversationDetailLevel',
      value: 'simple', default: 'simple', enum: [...CONVERSATION_DETAIL_LEVELS] })])
    await rpc.call('settings.set', { key: 'appearance.conversationDetailLevel', value: 'simple' })
    expect(await f.bytes()).toBe(original)
    for (const value of CONVERSATION_DETAIL_LEVELS.slice(1)) {
      const result = await cli(['set', 'appearance.conversationDetailLevel', value])
      expect(result.code, result.stderr || result.stdout).toBe(0)
      expect(JSON.parse(result.stdout).result.entry.value).toBe(value)
      expect((await new ConfigStore(f.store.filePath).get()).appearance.conversationDetailLevel).toBe(value)
      for (let i = 0; i < 100 && snapshots.at(-1)?.values.conversationDetailLevel !== value; i++) await new Promise(done => setTimeout(done, 5))
      expect(snapshots.at(-1)?.values.conversationDetailLevel, 'actual-appearance-reader-follows-detail-only-edits').toBe(value)
    }
    const bytes = await f.bytes()
    expect((await cli(['set', 'appearance.conversationDetailLevel', 'title-impostor'])).code).not.toBe(0)
    expect(await f.bytes()).toBe(bytes)
    expect(new Set(operations)).toEqual(new Set(['settings.get', 'settings.set']))
  } finally { await reader.dispose(); rpc.dispose(); await server.stop(); await rm(directory, { recursive: true, force: true }) }
}, 30_000)

it('merges an authored reading edit with unrelated work, rejects the exact conflict and preserves unsupported saved JSON', async () => {
  const f = await configOwnerFixture(), before = structuredClone(f.owner.current)
  await f.owner.update(config => ({ ...config, copyPathsAsAbsolute: true, appearance: { ...config.appearance, terminalFontSize: 21 } }))
  await f.owner.edit(before, { ...before, appearance: { ...before.appearance, conversationDetailLevel: 'snapshots' } })
  expect(f.owner.current).toMatchObject({ copyPathsAsAbsolute: true, appearance: { terminalFontSize: 21, conversationDetailLevel: 'snapshots' } })
  await expect(f.owner.edit(before, { ...before, appearance: { ...before.appearance, conversationDetailLevel: 'system' } })).rejects.toMatchObject({ code: 'CONFIG_CONFLICT', field: 'appearance.conversationDetailLevel' })
  expect((await f.disk()).appearance.conversationDetailLevel).toBe('snapshots')
  const unsupported = { future: ['unrecognized'] }
  await f.owner.update(config => ({ ...config, appearance: { ...config.appearance, conversationDetailLevel: unsupported } }))
  const reopened = await new ConfigStore(f.store.filePath).get()
  expect(reopened.appearance.conversationDetailLevel).toEqual(unsupported)
  expect(resolveConversationDetailLevel(reopened.appearance.conversationDetailLevel)).toBe('system')
  const reader = await themeObservation(f.owner).subscribe(() => {}, () => {}, new AbortController().signal)
  expect(reader.initial.values.conversationDetailLevel).toBeNull()
  expect(reader.initial.issues.some(issue => issue.id === 'conversation-detail-level')).toBe(true)
  expect(reopened.copyPathsAsAbsolute).toBe(true)
  reader.dispose()
})
