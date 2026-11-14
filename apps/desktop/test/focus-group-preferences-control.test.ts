// @vitest-environment node
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core'
import { ConfigStore, DEFAULT_CONFIG } from '../src/main/config-store'
import { ConfigOwner } from '../src/main/config-owner'
import { executeSettingsControl } from '../src/main/settings-control'
import { focusCollectionPreferenceKey, type FocusProjectPreference } from '../src/shared/focus-project-preferences'
import { configOwnerFixture } from './helpers/config-owner-fixture'
import type { AppConfig } from '../src/shared/contracts'

const project: FocusProjectPreference = { key: JSON.stringify(['original-host', 'original-project']), pinned: true, note: 'My original route', color: 'violet', collapsed: false }
const collection: FocusProjectPreference = { key: focusCollectionPreferenceKey('original-host', ['category-a', 'category-b']), pinned: true, note: '', color: 'default', collapsed: null }
const mixed = [collection, project]
const principal = { transport: 'unix', principal: { kind: 'user', id: 'group-preferences-test' } } as const
const envelope = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'group-preferences' } as const

it('the original settings module reader exposes the exact mixed preference contract', async () => {
  const { agentMuxModuleSkill } = await import('../../../packages/core/src/agentmux-cli-module-skills')
  const guide = agentMuxModuleSkill('settings')
  expect(guide).toContain('settings inspect focus.projects')
  expect(guide).toContain('["collection",hostId,[categorySpaceId,...]]')
  expect(guide).toContain('unconfirmed Collection bucket')
  expect(guide).toContain('one shared order for pinned Projects')
})

it('original public SDK and executable CLI preserve mixed identities through the exact focus.projects owner', async () => {
  const f = await configOwnerFixture({ focus: { recentActivityHours: 48, projects: [project] } })
  const execute = (request: Parameters<typeof executeSettingsControl>[0]) => executeSettingsControl(request, f.owner)
  const rpc = new AgentMuxRpcService({ execute: request => {
    if (request.operation !== 'settings.get' && request.operation !== 'settings.set') throw Error('Original settings request required')
    return execute(request)
  } })
  const read = await rpc.call('settings.inspect', { target: 'focus.projects' }, principal)
  expect(read.entries).toEqual([{ key: 'focus.projects', kind: 'string', value: JSON.stringify([project]), default: '[]' }])
  const saved = await rpc.call('settings.set', { key: 'focus.projects', value: JSON.stringify(mixed) }, principal)
  expect(saved.entry).toMatchObject({ key: 'focus.projects', value: JSON.stringify(mixed) })
  expect((await f.disk()).focus?.projects).toEqual(mixed)
  const original = f.owner.current, bytes = await f.bytes()
  await rpc.call('settings.set', { key: 'focus.projects', value: JSON.stringify(mixed) }, principal)
  expect(f.owner.current).toBe(original); expect(await f.bytes()).toBe(bytes)
  for (const key of [JSON.stringify(['collection', 'original-host', []]), JSON.stringify(['collection', 'original-host', ['category-b', 'category-a']]), JSON.stringify(['collection', 'original-host', ['category-a', 'category-a']])]) {
    await expect(rpc.call('settings.set', { key: 'focus.projects', value: JSON.stringify([{ ...collection, key }, project]) }, principal)).rejects.toThrow()
    expect(f.owner.current).toBe(original); expect(await f.bytes()).toBe(bytes)
  }
  const directory = await mkdtemp(join(tmpdir(), 'group-preferences-socket-'))
  const server = new AgentMuxControlServer({ execute: request => {
    if (request.operation !== 'settings.get' && request.operation !== 'settings.set') throw Error('Original settings request required')
    return execute(request)
  } }, join(directory, 'control.sock'))
  try {
    await server.start()
    const call = promisify(execFile), args = [resolve('packages/core/bin/amux'), '--endpoint', `unix:${server.path}`, 'settings']
    const options = { timeout: 10000, env: { ...process.env, AGENTMUX_ENV: undefined, AGENTMUX_AGENT_SESSION_ID: undefined, AGENTMUX_AGENT_CAPABILITY: undefined } }
    const inspected = JSON.parse((await call(process.execPath, [...args, 'inspect', 'focus.projects'], options)).stdout).result
    expect(inspected.entries[0]).toMatchObject({ key: 'focus.projects', value: JSON.stringify(mixed) })
    const next = [project, collection]
    const changed = JSON.parse((await call(process.execPath, [...args, 'set', 'focus.projects', JSON.stringify(next)], options)).stdout).result
    expect(changed.entry).toMatchObject({ key: 'focus.projects', value: JSON.stringify(next) })
    expect((await new ConfigStore(f.store.filePath).get()).focus?.projects).toEqual(next)
  } finally { await server.stop(); await rm(directory, { recursive: true, force: true }) }
})

it('a conflicting or failed mixed preference save preserves original values and unrelated authored settings', async () => {
  const f = await configOwnerFixture({ focus: { recentActivityHours: 48, projects: [project] } }), original = f.owner.current
  await executeSettingsControl({ ...envelope, operation: 'settings.set', key: 'focus.projects', value: JSON.stringify(mixed) }, f.owner)
  await expect(f.owner.edit(original, { ...original, focus: { ...original.focus!, projects: [{ ...project, note: 'Stale change' }] } })).rejects.toMatchObject({ code: 'CONFIG_CONFLICT' })
  await f.owner.edit(original, { ...original, focus: { ...original.focus!, selectionFillPercent: 14 } })
  expect(f.owner.current.focus).toMatchObject({ projects: mixed, selectionFillPercent: 14 })
  const before = f.owner.current, bytes = await f.bytes()
  f.save.mockRejectedValueOnce(Error('Original mixed preference write failed'))
  await expect(executeSettingsControl({ ...envelope, operation: 'settings.set', key: 'focus.projects', value: JSON.stringify([project, collection]) }, f.owner)).rejects.toThrow('Original mixed preference write failed')
  expect(f.owner.current).toBe(before); expect(await f.bytes()).toBe(bytes)
})

const phase = process.env.AGENTMUX_GROUP_PREFERENCES_PHASE
it.runIf(phase === 'write' || phase === 'read')('retains mixed Pin order across independent configuration processes', async () => {
  const file = process.env.AGENTMUX_GROUP_PREFERENCES_FILE!, receipt = process.env.AGENTMUX_GROUP_PREFERENCES_RECEIPT!
  expect(file).toBeTruthy(); expect(receipt).toBeTruthy()
  const store = new ConfigStore(file)
  if (phase === 'write') await store.save(structuredClone(DEFAULT_CONFIG))
  let current: AppConfig = await store.get()
  const original = current
  const owner = new ConfigOwner({ read: () => current, save: next => store.save(next), publish: saved => { current = saved } })
  if (phase === 'write') await executeSettingsControl({ ...envelope, operation: 'settings.set', key: 'focus.projects', value: JSON.stringify(mixed) }, owner)
  expect(current.focus?.projects).toEqual(mixed)
  for (const field of ['hosts', 'executors', 'workspaces', 'appearance'] as const) expect(current[field]).toEqual(original[field])
  await writeFile(receipt, JSON.stringify({ phase, pid: process.pid, projects: current.focus?.projects }, null, 2) + '\n')
})
