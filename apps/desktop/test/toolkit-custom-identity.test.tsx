import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, useState } from 'react'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, type ToolkitToolDefinition, type ToolkitToolFields, type ToolkitScriptSnapshot } from '@agentmux/core/control'
import { ConfigOwner } from '../src/main/config-owner'
import { DEFAULT_CONFIG } from '../src/main/config-store'
import { executeToolkitConfig, prepareToolkitConfig, findToolkitTool } from '../src/main/toolkit-config'
import type { AppConfig } from '../src/shared/contracts'
import { ToolkitSettingsPane } from '../src/renderer/src/components/settings/ToolkitSettingsPane'
const accountUsageScript = 'console.log("User authored tool")\n'
const editableTool = { ...definition('auth'), name: 'Auth', script: accountUsageScript, args: ['tool', 'current'] }
import { UserToolkitResult } from '../src/renderer/src/components/toolkit/UserToolkitResult'
import { SettingsNavigation } from '../src/renderer/src/components/SettingsNavigation'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM } from './helpers/composer-dom-fixture'

vi.mock('electron', () => ({ app: { getPath: () => _hygiene_fixturePath("tmp"), getAppPath: () => process.cwd() } }))
// Functional editor shape only; finite compositor capture loads the real Monaco component.
vi.mock('../src/renderer/src/components/settings/ToolkitScriptEditor', () => ({ default: ({ id, actionId, value, onChange }: { id: string; actionId: string | null; value: string; onChange(value: string): void }) =>
  <textarea data-identity-script={id} data-identity-action={actionId ?? ''} aria-label="Functional script field" value={value} onChange={event => onChange(event.target.value)} /> }))
const dom = composerDOM(), paths: string[] = []
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} }) })
afterEach(async () => { for (const path of paths.splice(0)) await rm(path, { recursive: true }) })
function definition(id: string): ToolkitToolDefinition { return ({ id, revision: `saved-${id}`, name: id, icon: 'terminal', enabled: true, statusBar: 'icon', workspacePath: _hygiene_fixturePath("fixed"), script: `console.log('${id}')`, args: [], actions: [] }) }
async function setup(tools: ToolkitToolDefinition[] = []) {
  const directory = await mkdtemp(join(tmpdir(), 'amx-custom-identity-')); paths.push(directory)
  const path = join(directory, 'config.json'); let config: AppConfig = { ...structuredClone(DEFAULT_CONFIG), toolkit: { tools } }
  await writeFile(path, JSON.stringify(config)); let publish = (_config: AppConfig) => {}
  const owner = new ConfigOwner({ read: () => config, prepare: (before, next) => prepareToolkitConfig(before, next, async () => {}),
    save: async next => { await writeFile(path, JSON.stringify(next)); return next }, publish: next => { config = next; publish(next) } })
  const writer = {
    add: vi.fn(async (id: string, value: ToolkitToolFields) => {
      const saved = await executeToolkitConfig({ operation: 'toolkit.add', schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: crypto.randomUUID(), toolId: id, value }, owner)
      if (!('definition' in saved)) throw Error('Expected ordinary saved definition'); return saved.definition
    }),
    update: vi.fn(async (id: string, changes: Partial<ToolkitToolFields>, expected: Partial<ToolkitToolFields>) => {
      const saved = await executeToolkitConfig({ operation: 'toolkit.update', schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: crypto.randomUUID(), toolId: id, changes, expected }, owner)
      if (!('definition' in saved)) throw Error('Expected ordinary updated definition'); return saved.definition
    })
  }
  const run = vi.fn(async () => 'No execution'), remove = vi.fn(async (id: string, expected: ToolkitToolFields) => {
    await executeToolkitConfig({ operation: 'toolkit.remove', schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: crypto.randomUUID(), toolId: id, expected }, owner)
  })
  function View({ toolId, active = true, request = 0 }: { toolId?: string; active?: boolean; request?: number }) {
    const [current, setCurrent] = useState(config); publish = setCurrent
    return <ToolkitSettingsPane tools={current.toolkit?.tools ?? []} toolId={toolId} navigationRequest={{ section: 'toolkit', toolId, executorId: String(request) }} active={active}
      performance={{ enabled: true, statusBar: 'icon' }} writer={writer} onSave={vi.fn()} onRemoveTool={remove} onRunTool={run} />
  }
  return { View, owner, writer, run, remove, path }
}
async function button(label: string, root: ParentNode = dom.container) {
  const node = Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(item => item.textContent?.trim() === label)
  expect(node, label).toBeDefined(); await act(async () => node!.click())
}
async function fill(selector: string, value: string) {
  const node = dom.container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector); expect(node).not.toBeNull()
  await act(async () => { Object.getOwnPropertyDescriptor(node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(node, value); node!.dispatchEvent(new Event('input', { bubbles: true })) })
}
describe('actual Toolkit custom identity', () => {
  it('chooses Custom first with a creation empty state or the first real saved tool', async () => {
    const m = await setup(); await dom.render(<m.View />)
    expect(Array.from(dom.container.querySelectorAll('.toolkit-library__group')).map(item => item.textContent)).toEqual(['Custom', 'Built-in'])
    expect(dom.container.querySelector('.toolkit-workbench__empty h3')?.textContent).toBe('Make a tool your own.')
    expect(dom.container.querySelector('.toolkit-library__items [data-tool-template]')).toBeNull()
    expect(dom.container.querySelector('[data-tool-id="performance"]')?.getAttribute('aria-pressed')).toBe('false')
    expect(m.writer.add).not.toHaveBeenCalled(); expect(m.run).not.toHaveBeenCalled()
    const saved = await setup([definition('alpha'), definition('beta')]); await dom.render(<saved.View />)
    expect(dom.container.querySelector<HTMLInputElement>('.toolkit-editor__name input')?.value).toBe('alpha')
    expect(dom.container.querySelector('.toolkit-editor__metadata')?.textContent).toContain('Custom tool')
  })
  it('creates a blank ordinary draft and cancels back to Custom without enabling a pattern', async () => {
    const m = await setup(); await dom.render(<m.View />); await button('New custom tool')
    const name = dom.container.querySelector<HTMLInputElement>('.toolkit-editor__name input')!
    expect(name.value).toBe(''); expect(document.activeElement).toBe(name)
    expect(dom.container.querySelector<HTMLTextAreaElement>('[data-identity-script]')?.value).not.toBe(accountUsageScript)
    await button('Cancel new tool'); expect(dom.container.querySelector('.toolkit-workbench__empty h3')?.textContent).toBe('Make a tool your own.')
    expect(dom.container.querySelector('[data-tool-id="performance"]')?.getAttribute('aria-pressed')).toBe('false')
    expect(m.writer.add).not.toHaveBeenCalled(); expect(m.run).not.toHaveBeenCalled()
  })
  it('a saved inline user tool remains fully editable alongside packages', async () => {
    const m = await setup([{ ...editableTool, revision: 'initial', workspacePath: _hygiene_fixturePath("fixed") }]); await dom.render(<m.View />)
    expect(m.writer.add).not.toHaveBeenCalled()
    expect(dom.container.querySelector<HTMLTextAreaElement>('[data-identity-script]')?.value).toBe(accountUsageScript)
    await fill('.toolkit-editor__name input', 'Workspace summary')
    await dom.click('.toolkit-icon-picker input[value="zap"]')
    await fill('[data-identity-script]', "console.log('Workspace summary')\n")
    await fill('.toolkit-editor__fields input:not([type])', _hygiene_fixturePath("workspace-notes"))
    await fill('.toolkit-argument:nth-of-type(1) input', '--project'); await fill('.toolkit-argument:nth-of-type(2) input', 'current')
    await button('Add action'); await fill('.toolkit-editor__action-heading input', 'Open report')
    await fill('[data-identity-script]', "console.log('Report ready')\n"); await button('Add argument')
    await fill('.toolkit-argument input', 'report.md'); await button('Main script'); await button('Save tool')
    expect(m.writer.update).toHaveBeenCalledOnce(); await expect(m.writer.update.mock.results[0]!.value).resolves.toBeDefined(); const id = 'auth'
    const saved = findToolkitTool(m.owner.current, id)
    expect(saved).toEqual({ id, revision: expect.any(String), name: 'Workspace summary', icon: 'zap', enabled: true, statusBar: 'icon', workspacePath: _hygiene_fixturePath("workspace-notes"), script: "console.log('Workspace summary')\n", args: ['--project', 'current'], actions: [{ id: expect.any(String), label: 'Open report', script: "console.log('Report ready')\n", args: ['report.md'] }] })
    expect(JSON.parse(await readFile(m.path, 'utf8')).toolkit.tools).toEqual([saved])
    expect(Object.keys(saved).sort()).toEqual(['actions', 'args', 'enabled', 'icon', 'id', 'name', 'revision', 'script', 'statusBar', 'workspacePath'].sort())
    expect(m.run).not.toHaveBeenCalled()
  })
  it('preserves dirty fields across local and Built-in, then honors the exact changed deep link', async () => {
    const m = await setup([definition('alpha'), definition('beta')]); await dom.render(<m.View />)
    await fill('.toolkit-editor__name input', 'Authored alpha draft'); await dom.click('[data-tool-id="performance"]'); await dom.click('[data-tool-id="alpha"]')
    expect(dom.container.querySelector<HTMLInputElement>('.toolkit-editor__name input')?.value).toBe('Authored alpha draft')
    await dom.render(<m.View toolId="beta" request={1} />)
    expect(dom.container.querySelector('[data-tool-editor]')?.getAttribute('data-tool-editor')).toBe('beta')
    expect(dom.container.querySelector<HTMLInputElement>('.toolkit-editor__name input')?.value).toBe('beta')
    await dom.render(<m.View toolId="missing" request={2} />)
    expect(dom.container.querySelector('.toolkit-workbench__empty h3')?.textContent).toBe('This saved tool is unavailable.')
    expect(dom.container.querySelector('[data-tool-editor]')).toBeNull(); expect(m.run).not.toHaveBeenCalled()
  })
  it('deleting the last saved tool returns to Custom and deleting one preserves the remaining Custom', async () => {
    const m = await setup([definition('alpha'), definition('beta')]); await dom.render(<m.View />)
    await button('Delete tool'); await button('Delete tool', document.querySelector('.confirmation-dialog')!)
    expect(m.remove).toHaveBeenCalledOnce(); await act(async () => { await m.remove.mock.results[0]!.value }); expect(dom.container.querySelector('[data-tool-editor]')?.getAttribute('data-tool-editor')).toBe('beta')
    await button('Delete tool'); await button('Delete tool', document.querySelector('.confirmation-dialog')!)
    await act(async () => { await m.remove.mock.results[1]!.value })
    expect(m.owner.current.toolkit?.tools).toEqual([])
    expect(dom.container.querySelector('.toolkit-workbench__empty h3')?.textContent).toBe('Make a tool your own.')
    expect(dom.container.querySelector('[data-tool-id="performance"]')?.getAttribute('aria-pressed')).toBe('false')
  })
  it('128 definitions mount only the selected functional editor and leave zero when inactive', async () => {
    const tools = Array.from({ length: 128 }, (_, index) => definition(`custom-${index}`)), m = await setup(tools)
    await dom.render(<m.View />); expect(dom.container.querySelectorAll('[data-identity-script]')).toHaveLength(1)
    await dom.click('[data-tool-id="custom-127"]'); expect(dom.container.querySelector('[data-identity-script]')?.getAttribute('data-identity-script')).toBe('custom-127')
    const create = Array.from(dom.container.querySelectorAll<HTMLButtonElement>('button')).find(item => item.textContent?.trim() === 'New custom tool')!
    expect(create.isConnected).toBe(true); expect(create.disabled).toBe(true)
    await dom.render(<m.View active={false} />); expect(dom.container.querySelectorAll('[data-identity-script]')).toHaveLength(0)
    expect(m.writer.add).not.toHaveBeenCalled(); expect(m.run).not.toHaveBeenCalled()
  })
  it('shows Custom on the actual generic result and Configure retains its exact saved tool', async () => {
    const saved = { ...definition('custom-summary'), name: 'Workspace summary' }, close = vi.fn(), openToolkit = vi.fn(), released = vi.fn()
    const controlled: ToolkitScriptSnapshot = { schema: 'agentmux.toolkit.v1', kind: 'script', toolId: saved.id, definition: saved, state: 'idle', reason: null, admission: null, latestConfirmed: null, consumerCount: 1, sequence: 1 }
    vi.spyOn(api.toolkit, 'observe').mockImplementation((id, read) => { expect(id).toBe(saved.id); read(controlled); return { dispose: released } })
    const run = vi.spyOn(api.toolkit, 'run'), action = vi.spyOn(api.toolkit, 'action')
    await dom.render(<SettingsNavigation.Provider value={{ open: vi.fn(), openToolkit }}><UserToolkitResult definition={saved} active close={close} /></SettingsNavigation.Provider>)
    expect(dom.container.querySelector('.toolkit-result__identity small')?.textContent).toBe('Custom tool')
    expect(dom.container.querySelector('h2')?.textContent).toBe('Workspace summary'); await button('Configure')
    expect(openToolkit).toHaveBeenCalledWith(saved.id); expect(run).not.toHaveBeenCalled(); expect(action).not.toHaveBeenCalled()
  })
})
