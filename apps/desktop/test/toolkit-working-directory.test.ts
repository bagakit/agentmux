import { describe, expect, it, vi } from 'vitest'
import { fixturePath } from '../../../packages/core/test/helpers/fixture-values.js'
const host = vi.hoisted(() => ({ home: process.cwd() }))
vi.mock('electron', () => ({ app: { getPath: () => host.home, getAppPath: () => process.cwd() } }))
import { DEFAULT_CONFIG } from '../src/main/config-store.js'
import { ConfigOwner } from '../src/main/config-owner.js'
import { executeToolkitConfig, prepareToolkitConfig, toolkitFields } from '../src/main/toolkit-config.js'
import type { AppConfig } from '../src/shared/contracts.js'
import type { ToolkitToolFields } from '@agentmux/core/control'

const fields: ToolkitToolFields = { name: 'Directory tool', icon: 'terminal', enabled: false, statusBar: 'icon',
  workspacePath: '~/.agentmux', script: 'console.log("ready")', args: [] }
function fixture() {
  host.home = fixturePath('exact-host-home')
  let config: AppConfig = structuredClone(DEFAULT_CONFIG)
  const save = vi.fn(async (next: AppConfig) => structuredClone(next)), guardDelete = vi.fn(async () => {})
  const owner = new ConfigOwner({ read: () => config, prepare: (current, next) => prepareToolkitConfig(current, next, guardDelete),
    save, publish: next => { config = next } })
  return { owner, save, guardDelete, tools: () => config.toolkit?.tools ?? [] }
}
describe('Toolkit Host directory persistence', () => {
  it('saves the expanded absolute path and compares equivalent changes and expected values before issuing revisions', async () => {
    const f = fixture()
    const created = await executeToolkitConfig({ operation: 'toolkit.add', toolId: 'directory-tool', value: fields }, f.owner).catch(cause => cause)
    expect(created).toMatchObject({ definition: { workspacePath: host.home + '/.agentmux' } })
    const original = f.tools()[0]!
    expect(original.workspacePath).toBe(host.home + '/.agentmux')
    const unchanged = await executeToolkitConfig({ operation: 'toolkit.update', toolId: original.id,
      changes: { workspacePath: '$HOME/.agentmux' }, expected: { workspacePath: '~/.agentmux' } }, f.owner)
    expect(unchanged).toMatchObject({ changed: false, definition: { revision: original.revision } })
    expect(f.save).toHaveBeenCalledOnce()
    await executeToolkitConfig({ operation: 'toolkit.update', toolId: original.id,
      changes: { workspacePath: '${HOME}/next folder' }, expected: { workspacePath: '~/.agentmux' } }, f.owner)
    expect(f.tools()[0]!.workspacePath).toBe(host.home + '/next folder')
    await expect(executeToolkitConfig({ operation: 'toolkit.update', toolId: original.id,
      changes: { workspacePath: '~/another' }, expected: { workspacePath: '~/.agentmux' } }, f.owner)).rejects.toMatchObject({ code: 'CONFIG_CONFLICT' })
    await executeToolkitConfig({ operation: 'toolkit.remove', toolId: original.id,
      expected: { ...toolkitFields(f.tools()[0]!), workspacePath: '$HOME/next folder' } }, f.owner)
    expect(f.guardDelete).toHaveBeenCalledExactlyOnceWith(original.id)
    expect(f.tools()).toEqual([])
  })
  it('uses the shared default only for new package creation and never defaults omitted partial expected values', async () => {
    const f = fixture()
    await executeToolkitConfig({ operation: 'toolkit.add', toolId: 'directory-package', value: {
      kind: 'package', packagePath: fixturePath('package'), enabled: false, statusBar: 'icon', args: [] } }, f.owner)
    expect(f.tools()[0]!.workspacePath).toBe(host.home + '/.agentmux')
    await executeToolkitConfig({ operation: 'toolkit.update', toolId: 'directory-package', changes: { enabled: true }, expected: { enabled: false } }, f.owner)
    expect(f.tools()[0]!.workspacePath).toBe(host.home + '/.agentmux')
  })
  it('normalizes direct ConfigOwner writes before revision comparison without probing directory availability', async () => {
    const f = fixture()
    await f.owner.update(current => ({ ...current, toolkit: { ...current.toolkit,
      tools: [{ id: 'direct', revision: 'caller-revision', ...fields, workspacePath: '~/not-created/link/../target' }] } }))
    expect(f.tools()[0]!.workspacePath).toBe(host.home + '/not-created/link/../target')
    const revision = f.tools()[0]!.revision
    await f.owner.update(current => ({ ...current, toolkit: { ...current.toolkit,
      tools: [{ ...f.tools()[0]!, workspacePath: '$HOME/not-created/link/../target' }] } }))
    expect(f.tools()[0]!.revision).toBe(revision)
  })
  it('preserves the saved tool on invalid input and reports meaningful field validation messages', async () => {
    const f = fixture()
    await executeToolkitConfig({ operation: 'toolkit.add', toolId: 'directory-tool', value: fields }, f.owner)
    const original = structuredClone(f.tools()[0])
    await expect(executeToolkitConfig({ operation: 'toolkit.update', toolId: 'directory-tool', changes: { workspacePath: './ambiguous' } }, f.owner))
      .rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE', message: expect.stringContaining('Working directory') })
    await expect(executeToolkitConfig({ operation: 'toolkit.update', toolId: 'directory-tool', changes: { icon: 'unavailable-icon' } }, f.owner))
      .rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE', message: expect.stringContaining('Choose an available tool icon') })
    expect(f.tools()[0]).toEqual(original)
  })
})
