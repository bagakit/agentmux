import { describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
import { AGENTMUX_CONTROL_SCHEMA_VERSION, type AgentMuxControlSettingsResourceRequest } from '@agentmux/core'
import { AGENT_BUILT_IN_DERIVED_ACTIONS } from '@agentmux/core/agent-derived-actions'
import { createHostSettingsResourceRead } from '@agentmux/host/settings-resource-read'
import { executeSettingsResourcesControl as execute } from '../src/main/settings-resources-control.js'
import { ConfigStore, DEFAULT_CONFIG } from '../src/main/config-store.js'
import { applyConfigEdit, ConfigConflict } from '../src/shared/config-edit.js'
import { configOwnerFixture } from './helpers/config-owner-fixture.js'

type Input<T> = T extends unknown ? Omit<T, 'requestId' | 'schemaVersion'> : never
const request = (value: Input<AgentMuxControlSettingsResourceRequest>) => ({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'derived-test', ...value }) as AgentMuxControlSettingsResourceRequest
const review = { label: 'Review this work', base: 'new-agent', instruction: 'Review the changes and list concrete bugs.', executorId: 'codex' }
const official = AGENT_BUILT_IN_DERIVED_ACTIONS.map(action => action.id)
const list = async (owner: Parameters<typeof execute>[1]) => {
  const result = await execute(request({ operation: 'settings.resource.list', resource: 'derived-actions' }), owner)
  if (result.operation !== 'settings.resource.list') throw new Error('wrong result')
  return result.items
}

describe('derived actions through the sole Main owner', () => {
  it('lists official actions readonly before user actions, and an absent field is never written back', async () => {
    const f = await configOwnerFixture()
    expect((await f.disk()).agentDerivedActions).toBeUndefined()
    const items = await list(f.owner)
    expect(items.map(item => item.id)).toEqual(official)
    expect(items.every(item => item.readonly === true && item.value.hidden === false)).toBe(true)
    expect((await f.disk()).agentDerivedActions).toBeUndefined()
  })

  it('creates, updates, clears the default Agent and deletes a custom action durably', async () => {
    const f = await configOwnerFixture()
    await execute(request({ operation: 'settings.resource.add', resource: 'derived-actions', id: 'review', value: review }), f.owner)
    expect((await new ConfigStore(f.store.filePath).get()).agentDerivedActions?.actions).toEqual([{ id: 'review', ...review }])
    await expect(execute(request({ operation: 'settings.resource.add', resource: 'derived-actions', id: 'review', value: review }), f.owner)).rejects.toMatchObject({ code: 'SETTING_RESOURCE_EXISTS' })
    await execute(request({ operation: 'settings.resource.update', resource: 'derived-actions', id: 'review', changes: { executorId: null, label: 'Review' }, expected: { executorId: 'codex', label: review.label } }), f.owner)
    expect((await list(f.owner)).at(-1)).toEqual({ id: 'review', value: { label: 'Review', base: 'new-agent', instruction: review.instruction } })
    await expect(execute(request({ operation: 'settings.resource.update', resource: 'derived-actions', id: 'review', changes: { label: 'Stale' }, expected: { label: review.label } }), f.owner)).rejects.toBeInstanceOf(ConfigConflict)
    await expect(execute(request({ operation: 'settings.resource.update', resource: 'derived-actions', id: 'review', changes: { base: 'fork', executorId: 'codex' } }), f.owner)).rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
    await execute(request({ operation: 'settings.resource.remove', resource: 'derived-actions', id: 'review' }), f.owner)
    // The explicit empty list is the user's deletion and stays empty.
    expect((await new ConfigStore(f.store.filePath).get()).agentDerivedActions).toEqual({ actions: [] })
    await expect(execute(request({ operation: 'settings.resource.remove', resource: 'derived-actions', id: 'review' }), f.owner)).rejects.toMatchObject({ code: 'SETTING_RESOURCE_NOT_FOUND' })
  })

  it('keeps official actions read-only except their visibility, without touching the file on refusal', async () => {
    const f = await configOwnerFixture()
    const bytes = await f.bytes()
    for (const attempt of [
      request({ operation: 'settings.resource.add', resource: 'derived-actions', id: 'take-over', value: review }),
      request({ operation: 'settings.resource.remove', resource: 'derived-actions', id: 'fork' }),
      request({ operation: 'settings.resource.update', resource: 'derived-actions', id: 'take-over', changes: { label: 'Mine' } }),
      request({ operation: 'settings.resource.update', resource: 'derived-actions', id: 'take-over', changes: { hidden: 'yes' } })
    ]) await expect(execute(attempt, f.owner)).rejects.toMatchObject({ code: 'SETTING_IDENTITY_IMMUTABLE' })
    expect(await f.bytes()).toBe(bytes)
    await execute(request({ operation: 'settings.resource.update', resource: 'derived-actions', id: 'pass-on-experience', changes: { hidden: true } }), f.owner)
    await execute(request({ operation: 'settings.resource.update', resource: 'derived-actions', id: 'take-over', changes: { hidden: true }, expected: { hidden: false } }), f.owner)
    expect((await f.disk()).agentDerivedActions).toEqual({ hidden: ['take-over', 'pass-on-experience'] })
    expect((await list(f.owner)).filter(item => item.value.hidden).map(item => item.id)).toEqual(['take-over', 'pass-on-experience'])
    await execute(request({ operation: 'settings.resource.update', resource: 'derived-actions', id: 'take-over', changes: { hidden: false } }), f.owner)
    await execute(request({ operation: 'settings.resource.update', resource: 'derived-actions', id: 'pass-on-experience', changes: { hidden: false } }), f.owner)
    expect((await f.disk()).agentDerivedActions).toEqual({})
  })

  it('merges concurrent first edits by identity and conflicts on the same field', () => {
    const base = structuredClone(DEFAULT_CONFIG)
    const withA = { ...base, agentDerivedActions: { actions: [{ id: 'a', label: 'A', base: 'fork' as const, instruction: 'a' }] } }
    const withHidden = { ...base, agentDerivedActions: { hidden: ['fork' as const] } }
    const merged = applyConfigEdit(withA, base, withHidden)
    expect(merged.agentDerivedActions).toEqual({ actions: withA.agentDerivedActions.actions, hidden: ['fork'] })
    const withB = { ...base, agentDerivedActions: { actions: [{ id: 'b', label: 'B', base: 'fork' as const, instruction: 'b' }] } }
    expect(applyConfigEdit(withA, base, withB).agentDerivedActions?.actions?.map(action => action.id)).toEqual(['a', 'b'])
    const renamedA = { ...base, agentDerivedActions: { actions: [{ ...withA.agentDerivedActions.actions[0]!, label: 'A2' }] } }
    expect(() => applyConfigEdit({ ...base, agentDerivedActions: { actions: [{ ...withA.agentDerivedActions.actions[0]!, label: 'A3' }] } }, withA, renamedA)).toThrow(ConfigConflict)
  })

  it('rejects invalid saved records, carries the user list across a retirement and reads the same items from the Host file', async () => {
    const f = await configOwnerFixture()
    expect(() => f.store.validate({ ...structuredClone(DEFAULT_CONFIG), agentDerivedActions: { actions: [{ id: 'take-over', label: 'x', base: 'fork', instruction: 'y' }] } })).toThrow()
    await execute(request({ operation: 'settings.resource.add', resource: 'derived-actions', id: 'review', value: review }), f.owner)
    await execute(request({ operation: 'settings.resource.update', resource: 'derived-actions', id: 'fork', changes: { hidden: true } }), f.owner)
    // A retired config version resets to defaults; the user's own actions and choices come across.
    const retired = join(await mkdtemp(join(tmpdir(), 'agentmux-derived-retired-')), 'agentmux.config.json')
    await writeFile(retired, JSON.stringify({ ...(await f.disk()), version: DEFAULT_CONFIG.version - 1 }))
    expect((await new ConfigStore(retired).get()).agentDerivedActions).toEqual((await f.disk()).agentDerivedActions)
    const directory = await mkdtemp(join(tmpdir(), 'agentmux-derived-host-'))
    const path = join(directory, 'agentmux.config.json')
    await writeFile(path, JSON.stringify(await f.disk()))
    const host = await createHostSettingsResourceRead(path)({ ...request({ operation: 'settings.resource.list', resource: 'derived-actions' }) } as Parameters<ReturnType<typeof createHostSettingsResourceRead>>[0])
    expect(host).toEqual(await execute(request({ operation: 'settings.resource.list', resource: 'derived-actions' }), f.owner))
    await writeFile(path, JSON.stringify({ ...(await f.disk()), agentDerivedActions: { actions: 'broken' } }))
    await expect(createHostSettingsResourceRead(path)(request({ operation: 'settings.resource.list', resource: 'derived-actions' }) as Parameters<ReturnType<typeof createHostSettingsResourceRead>>[0])).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  })
})
