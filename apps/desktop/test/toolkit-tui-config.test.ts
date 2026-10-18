import { describe, expect, it, vi } from 'vitest'
import { fixturePath } from '../../../packages/core/test/helpers/fixture-values.js'
vi.mock('electron', () => ({ app: { getPath: () => process.cwd(), getAppPath: () => process.cwd() } }))
import { DEFAULT_CONFIG } from '../src/main/config-store.js'
import { ConfigOwner } from '../src/main/config-owner.js'
import { executeToolkitConfig, prepareToolkitConfig, toolkitFields } from '../src/main/toolkit-config.js'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, type ToolkitToolDefinition } from '@agentmux/core/control'
import type { AppConfig } from '../src/shared/contracts.js'

const original: ToolkitToolDefinition = { id: 'terminal-tool', revision: 'original-revision', name: 'Terminal tool',
  icon: 'terminal', enabled: false, statusBar: 'icon', workspacePath: fixturePath('workspace'), script: 'console.log("ready")', args: [] }
const base = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'mode-change', toolId: original.id } as const
function fixture() {
  let config: AppConfig = { ...structuredClone(DEFAULT_CONFIG), toolkit: { tools: [structuredClone(original)] } }
  const save = vi.fn(async (next: AppConfig) => structuredClone(next))
  const guardDelete = vi.fn(async () => {})
  const owner = new ConfigOwner({ read: () => config,
    prepare: (current, next) => prepareToolkitConfig(current, next, guardDelete), save,
    publish: saved => { config = saved } })
  return { owner, save, guardDelete, get definition() { return config.toolkit!.tools![0]! } }
}

describe('TUI Toolkit original configuration owner', () => {
  it('treats omitted script mode as the same authored value and preserves an unchanged revision', async () => {
    const f = fixture()
    const result = await executeToolkitConfig({ ...base, operation: 'toolkit.update', changes: { mode: 'script' }, expected: { mode: 'script' } }, f.owner)
    expect(result).toEqual({ operation: 'toolkit.update', definition: original, changed: false })
    expect(f.definition).toEqual(original)
    expect(f.save).not.toHaveBeenCalled()
    expect(toolkitFields(f.definition)).toEqual({ name: original.name, icon: original.icon, enabled: false, statusBar: 'icon',
      workspacePath: original.workspacePath, script: original.script, args: [], actions: [], mode: 'script' })
  })
  it('saves TUI mode and shell arguments through the same owner and supports a conflict-checked return to script mode', async () => {
    const f = fixture(), args = ['value with spaces', 'literal $value; command']
    const updated = await executeToolkitConfig({ ...base, operation: 'toolkit.update',
      changes: { mode: 'tui', script: 'printf "%s\\n" "$@"', args },
      expected: { mode: 'script', script: original.script, args: [] } }, f.owner)
    expect(updated).toMatchObject({ changed: true, definition: { mode: 'tui', script: 'printf "%s\\n" "$@"', args } })
    expect(f.definition).toMatchObject({ mode: 'tui', args })
    const tui = structuredClone(f.definition)
    expect(tui.revision).not.toBe(original.revision)
    await expect(executeToolkitConfig({ ...base, operation: 'toolkit.update',
      changes: { mode: 'script' }, expected: { mode: 'script' } }, f.owner)).rejects.toMatchObject({ code: 'CONFIG_CONFLICT' })
    expect(f.definition).toEqual(tui)
    const returned = await executeToolkitConfig({ ...base, operation: 'toolkit.update', changes: { mode: 'script' }, expected: { mode: 'tui' } }, f.owner)
    expect(returned).toMatchObject({ changed: true, definition: { mode: 'script', args } })
    expect(f.definition.revision).not.toBe(tui.revision)
    expect(f.save).toHaveBeenCalledTimes(2)
  })
  it('validates TUI restrictions against the complete updated definition and preserves the prior configuration on failure', async () => {
    const f = fixture()
    await executeToolkitConfig({ ...base, operation: 'toolkit.update', changes: { mode: 'tui' }, expected: { mode: 'script' } }, f.owner)
    const tui = structuredClone(f.definition)
    await expect(executeToolkitConfig({ ...base, operation: 'toolkit.update', changes: {
      actions: [{ id: 'action', label: 'Action', script: 'console.log("result")', args: [] }] } }, f.owner))
      .rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
    await expect(executeToolkitConfig({ ...base, operation: 'toolkit.update', changes: {
      display: { script: 'console.log("display")', args: [] } } }, f.owner))
      .rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
    expect(f.definition).toEqual(tui)
    expect(f.save).toHaveBeenCalledOnce()
  })
  it('compares delete expectations using the same default mode semantics', async () => {
    const f = fixture(), { id: _id, revision: _revision, ...expected } = original
    expect(await executeToolkitConfig({ ...base, operation: 'toolkit.remove', expected }, f.owner))
      .toEqual({ operation: 'toolkit.remove', toolId: original.id, removed: true })
    expect(f.guardDelete).toHaveBeenCalledExactlyOnceWith(original.id)
    expect(f.definition).toBeUndefined()
  })
})
