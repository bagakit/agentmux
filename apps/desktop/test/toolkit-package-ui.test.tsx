import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, useMemo, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, type ToolkitDescriptor, type ToolkitPackageConfiguration, type ToolkitScriptSnapshot, type ToolkitToolConfiguration } from '@agentmux/core/control'
import { ConfigOwner } from '../src/main/config-owner'
import { DEFAULT_CONFIG } from '../src/main/config-store'
import { executeToolkitConfig, prepareToolkitConfig } from '../src/main/toolkit-config'
import type { AppConfig } from '../src/shared/contracts'
import { ToolkitSettingsPane } from '../src/renderer/src/components/settings/ToolkitSettingsPane'
import { toolkitSettingsModule } from '../src/renderer/src/components/settings/modules/toolkit'
import { SettingsNavigation } from '../src/renderer/src/components/SettingsNavigation'
import { UserToolkitResult } from '../src/renderer/src/components/toolkit/UserToolkitResult'
import { useToolkitDrafts, toolkitDraftDirty } from '../src/renderer/src/components/settings/use-toolkit-drafts'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM } from './helpers/composer-dom-fixture'
vi.mock('electron', () => ({ app: { getPath: () => _hygiene_fixturePath("tmp"), getAppPath: () => process.cwd() } }))
vi.mock('../src/renderer/src/components/settings/ToolkitScriptEditor', () => ({ default: () => <textarea data-inline-editor /> }))
const dom = composerDOM()
const pkg = (id = 'local'): ToolkitPackageConfiguration => ({ kind: 'package', id, revision: 'config-v1', packagePath: _hygiene_fixturePath("local/extension"), enabled: true, statusBar: 'icon', workspacePath: _hygiene_fixturePath("work"), args: ['current'] })
const fact = (tool = pkg(), name = 'Workspace report'): ToolkitDescriptor => ({ kind: 'package', toolId: tool.id, name, icon: 'zap', readonly: false, configRevision: tool.revision, path: tool.packagePath, enabled: tool.enabled, statusBar: tool.statusBar, availability: 'available', reason: null })
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }); vi.spyOn(api.toolkit, 'list').mockResolvedValue([fact()]); vi.spyOn(api.toolkit, 'script').mockResolvedValue({ toolId: 'local', path: _hygiene_fixturePath("local/extension/report.mjs"), sha256: 'a'.repeat(64), text: 'console.log("File source")' }) })
afterEach(() => { vi.restoreAllMocks() })
async function click(text: string, root: ParentNode = dom.container) { const button = [...root.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === text); expect(button, text).toBeDefined(); await act(async () => button!.click()) }
async function fill(label: string, value: string) { const input = dom.container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!; expect(input).not.toBeNull(); await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) }) }
function setup(tools: ToolkitToolConfiguration[] = [pkg()]) {
  let config: AppConfig = { ...structuredClone(DEFAULT_CONFIG), toolkit: { tools } }, publish = (_value: AppConfig) => {}
  const saves: AppConfig[] = [], runs = vi.fn(async (_id: string) => 'Execution admitted')
  const owner = new ConfigOwner({ read: () => config, prepare: (before, next) => prepareToolkitConfig(before, next, async () => {}), save: async next => { saves.push(structuredClone(next)); return next }, publish: next => { config = next; publish(next) } })
  const execute = async (operation: 'toolkit.add' | 'toolkit.update', id: string, value: unknown, expected?: unknown) => {
    const result = await executeToolkitConfig({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: crypto.randomUUID(), operation, toolId: id, ...(operation === 'toolkit.add' ? { value } : { changes: value, expected }) }, owner)
    if (!('definition' in result)) throw new Error('Expected saved configuration'); return result.definition
  }
  const writer = { add: vi.fn((id, value) => execute('toolkit.add', id, value)), update: vi.fn((id, changes, expected) => execute('toolkit.update', id, changes, expected)) }
  function View({ active = true }: { active?: boolean }) { const [current, setCurrent] = useState(config); publish = setCurrent; return <ToolkitSettingsPane active={active} tools={current.toolkit?.tools ?? []} performance={{ enabled: true, statusBar: 'icon' }} writer={writer} onSave={async () => {}} onRemoveTool={async () => {}} onRunTool={runs} /> }
  return { View, owner, writer, saves, runs }
}
describe('local extension package in the actual Settings and result consumers', () => {
  it('runs the saved package through the registered Settings module using its resolved file revision', async () => {
    const definition = { id: 'local', revision: 'effective-files-v2', name: 'Workspace report', icon: 'zap', enabled: true, statusBar: 'icon' as const, workspacePath: _hygiene_fixturePath("work"), script: 'console.log(1)', args: [], actions: [] }
    const snapshot: ToolkitScriptSnapshot = { schema: 'agentmux.toolkit.v1', kind: 'script', toolId: 'local', definition, state: 'idle', reason: null, admission: null, latestConfirmed: null, consumerCount: 0, sequence: 1 }
    const get = vi.spyOn(api.toolkit, 'get').mockResolvedValue(snapshot)
    const run = vi.spyOn(api.toolkit, 'run').mockResolvedValue(snapshot)
    const Pane = toolkitSettingsModule.Pane
    const config: AppConfig = { ...structuredClone(DEFAULT_CONFIG), toolkit: { tools: [pkg()] } }
    await dom.render(<Pane config={config} active toolId="local" />)
    expect(dom.container.querySelector('[data-tool-package="local"]')).not.toBeNull()
    expect(get).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled()
    await click('Run')
    expect(get).toHaveBeenCalledExactlyOnceWith('local')
    expect(run).toHaveBeenCalledExactlyOnceWith('local', { invocationId: expect.any(String), expectedRevision: 'effective-files-v2', expectedLatestExecutionId: null })
    expect(dom.container.textContent).toContain('Execution admitted')
  })
  it('reads identity from manifest facts, refreshes unrelated content and keeps Built-in at the same level without querying', async () => {
    const model = setup(), run = vi.spyOn(api.toolkit, 'run')
    await dom.render(<model.View />)
    expect(dom.container.querySelector('[data-tool-id="local"] strong')?.textContent).toBe('Workspace report')
    expect([...dom.container.querySelectorAll('.toolkit-library__group')].map(node => node.textContent)).toEqual(['Custom', 'Built-in'])
    expect(dom.container.querySelector('[data-tool-package="local"]')).not.toBeNull()
    expect(dom.container.querySelector('[data-inline-editor]')).toBeNull()
    expect(api.toolkit.script).not.toHaveBeenCalled()
    await click('View entry script'); expect(dom.container.querySelector<HTMLTextAreaElement>('[aria-label="Current local entry script"]')?.value).toBe('console.log("File source")')
    vi.mocked(api.toolkit.list).mockResolvedValue([fact(pkg(), 'Build status')])
    vi.mocked(api.toolkit.script).mockResolvedValue({ toolId: 'local', path: _hygiene_fixturePath("local/extension/report.mjs"), sha256: 'b'.repeat(64), text: 'console.log("Edited source")' })
    await click('Refresh files')
    expect(dom.container.querySelector('[data-tool-id="local"] strong')?.textContent).toBe('Build status')
    expect(dom.container.querySelector<HTMLTextAreaElement>('[aria-label="Current local entry script"]')?.value).toBe('console.log("Edited source")')
    expect(model.saves).toEqual([]); expect(model.runs).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled()
    await dom.render(<model.View active={false} />); expect(dom.container.querySelector('[aria-label="Current local entry script"]')).toBeNull()
  })
  it('saves only ordinary package preferences with precise expected fields through the real ConfigOwner', async () => {
    const model = setup(); await dom.render(<model.View />)
    await fill('Fixed working directory', _hygiene_fixturePath("new-work")); await click('Save preferences')
    expect(model.writer.update).toHaveBeenCalledWith('local', { workspacePath: _hygiene_fixturePath("new-work") }, { workspacePath: _hygiene_fixturePath("work") })
    const saved = model.owner.current.toolkit!.tools![0]!
    expect(saved).toEqual({ ...pkg(), workspacePath: _hygiene_fixturePath("new-work"), revision: expect.any(String) })
    expect(Object.keys(saved).sort()).toEqual(['kind', 'id', 'revision', 'packagePath', 'enabled', 'statusBar', 'workspacePath', 'args'].sort())
    expect(model.saves).toHaveLength(1); expect(model.runs).not.toHaveBeenCalled()
    await click('Run'); expect(model.runs).toHaveBeenCalledExactlyOnceWith('local')
  })
  it('starts a package installation as a cancellable draft, never an adopted example or script copy', async () => {
    const model = setup([]); await dom.render(<model.View />); await click('Install package')
    const input = dom.container.querySelector<HTMLInputElement>('[aria-label="Package directory"]')!
    expect(input.value).toBe(''); expect(document.activeElement).toBe(input)
    await click('Cancel installation'); expect(model.writer.add).not.toHaveBeenCalled(); expect(model.runs).not.toHaveBeenCalled()
    await click('Install package'); await fill('Package directory', _hygiene_fixturePath("another-package")); await fill('Fixed working directory', _hygiene_fixturePath("work")); await click('Install package', dom.container.querySelector('.toolkit-editor__footer')!)
    const record = model.owner.current.toolkit!.tools![0]!
    expect(record).toMatchObject({ kind: 'package', packagePath: _hygiene_fixturePath("another-package"), workspacePath: _hygiene_fixturePath("work"), args: [] })
    expect('script' in record || 'name' in record || 'icon' in record).toBe(false)
    expect(model.writer.add).toHaveBeenCalledOnce(); expect(model.runs).not.toHaveBeenCalled()
  })
  it('does not substitute facts from a different path or config revision for the selected package', async () => {
    vi.mocked(api.toolkit.list).mockResolvedValue([{ ...fact(), configRevision: 'outside', name: 'Wrong source' } as ToolkitDescriptor])
    const model = setup(); await dom.render(<model.View />)
    expect(dom.container.querySelector('[data-tool-id="local"] strong')?.textContent).toBe('local')
    expect(dom.container.textContent).not.toContain('Wrong source')
  })
  it('retains later package arguments and the original same-field expectation during a sibling pending save', async () => {
    let drafts!: ReturnType<typeof useToolkitDrafts>
    function Consumer({ tool }: { tool: ToolkitPackageConfiguration }) { drafts = useToolkitDrafts(useMemo(() => [tool], [tool])); return <output>{toolkitDraftDirty(drafts.entries.local!) ? 'Unsaved' : 'Saved'}</output> }
    const original = pkg(); await dom.render(<Consumer tool={original} />)
    await act(async () => { drafts.edit('local', { statusBar: 'label' }) })
    let resolve!: (tool: ToolkitPackageConfiguration) => void
    const pending = new Promise<ToolkitPackageConfiguration>(accept => { resolve = accept }), update = vi.fn(() => pending)
    let saving!: Promise<boolean>
    await act(async () => { saving = drafts.save('local', { add: vi.fn(), update }) })
    await act(async () => { drafts.edit('local', { args: ['later', ''] }) })
    const outside = { ...original, args: ['CLI'], workspacePath: _hygiene_fixturePath("outside"), revision: 'outside' }
    await dom.render(<Consumer tool={outside} />)
    await act(async () => { resolve({ ...outside, statusBar: 'label', revision: 'accepted' }); await saving })
    expect(drafts.entries.local!.value.args).toEqual(['later', ''])
    expect(drafts.entries.local!.expected!.args).toEqual(['current'])
    expect(drafts.entries.local!.value.workspacePath).toBe(_hygiene_fixturePath("outside"))
    const conflict = vi.fn(async () => { throw new Error('resource-conflict') })
    await act(async () => { await drafts.save('local', { add: vi.fn(), update: conflict }) })
    expect(conflict).toHaveBeenCalledWith('local', { args: ['later', ''] }, { args: ['current'] })
    expect(drafts.entries.local!.value.args).toEqual(['later', ''])
    expect(dom.container.textContent).toContain('Unsaved')
  })
  it('keeps retained output and exact Stop when files are unavailable, then uses the new resolved revision on explicit run', async () => {
    const definition = { id: 'local', revision: 'effective-v1', name: 'Workspace report', icon: 'zap', enabled: true, statusBar: 'icon' as const, workspacePath: _hygiene_fixturePath("work"), script: 'console.log(1)', args: [], actions: [] }
    const run = { hostId: 'runtime', runId: 'original-run' }, admission = { executionId: 'original-execution', invocationId: 'original-invocation', definition, expectedLatestExecutionId: null, target: { workspacePath: _hygiene_fixturePath("work") }, run, state: 'running' as const, reason: null, startedAt: 1, text: 'Original output' }
    const retained: ToolkitScriptSnapshot = { schema: 'agentmux.toolkit.v1', kind: 'script', toolId: 'local', definition, state: 'running', reason: null, admission, latestConfirmed: null, consumerCount: 1, sequence: 1 }
    const stop = vi.spyOn(api.toolkit, 'stop').mockResolvedValue(retained), execute = vi.spyOn(api.toolkit, 'run').mockResolvedValue(retained)
    vi.spyOn(api.toolkit, 'observe').mockImplementation((_id, consume) => { consume({ schema: 'agentmux.toolkit.v1', kind: 'package-unavailable', toolId: 'local', configuration: pkg(), reason: 'Directory moved', retained }); return { dispose: vi.fn() } })
    const next = { ...retained, definition: { ...definition, revision: 'effective-v2' }, admission: null, state: 'idle' as const, sequence: 2 }
    vi.spyOn(api.toolkit, 'get').mockResolvedValue(next)
    await dom.render(<SettingsNavigation.Provider value={{ open: vi.fn(), openToolkit: vi.fn() }}><UserToolkitResult definition={{ id: 'local', name: 'Workspace report', icon: 'zap', enabled: true, statusBar: 'icon' }} active close={() => {}} /></SettingsNavigation.Provider>)
    expect(dom.container.textContent).toContain('Original output'); expect(dom.container.textContent).toContain('Directory moved')
    expect([...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === 'Run saved tool')?.disabled).toBe(true)
    await click('Stop'); expect(stop).toHaveBeenCalledExactlyOnceWith('local', 'original-execution')
    await click('Run saved tool'); expect(execute).toHaveBeenCalledWith('local', { invocationId: expect.any(String), expectedRevision: 'effective-v2', expectedLatestExecutionId: null })
  })
})
