import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, type ToolkitToolDefinition, type ToolkitToolFields } from '@agentmux/core/control'
import { ConfigOwner } from '../src/main/config-owner'
import { DEFAULT_CONFIG } from '../src/main/config-store'
import { executeToolkitConfig, prepareToolkitConfig } from '../src/main/toolkit-config'
import type { AppConfig } from '../src/shared/contracts'
import { ToolkitSettingsPane } from '../src/renderer/src/components/settings/ToolkitSettingsPane'
import { accountUsageScript } from '../src/renderer/src/components/settings/account-usage-template'
import { composerDOM } from './helpers/composer-dom-fixture'

vi.mock('electron', () => ({ app: { getPath: () => _hygiene_fixturePath("tmp"), getAppPath: () => process.cwd() } }))
// The narrow functional test uses a plain source field. Native proof uses Monaco.
vi.mock('../src/renderer/src/components/settings/ToolkitScriptEditor', () => ({ default: ({ value, onChange }: { value: string; onChange(value: string): void }) => <textarea aria-label="Script test field" value={value} onChange={event => onChange(event.target.value)} /> }))
const dom = composerDOM(), directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true }) })
async function setup(saved: ToolkitToolDefinition[] = []) {
  const directory = await mkdtemp(join(tmpdir(), 'agentmux-template-config-')); directories.push(directory)
  const path = join(directory, 'config.json')
  let config: AppConfig = { ...structuredClone(DEFAULT_CONFIG), toolkit: { tools: saved } }
  await writeFile(path, JSON.stringify(config))
  const owner = new ConfigOwner({ read: () => config, prepare: (before, next) => prepareToolkitConfig(before, next, async () => {}),
    save: async next => { await writeFile(path, JSON.stringify(next)); return next }, publish: next => { config = next } })
  const writer = {
    add: vi.fn(async (id: string, value: ToolkitToolFields) => {
      const result = await executeToolkitConfig({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: crypto.randomUUID(), operation: 'toolkit.add', toolId: id, value }, owner)
      if (!('definition' in result)) throw Error('Expected saved ordinary tool')
      return result.definition
    }),
    update: vi.fn(async (id: string, changes: Partial<ToolkitToolFields>, expected: Partial<ToolkitToolFields>) => {
      const result = await executeToolkitConfig({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: crypto.randomUUID(), operation: 'toolkit.update', toolId: id, changes, expected }, owner)
      if (!('definition' in result)) throw Error('Expected saved ordinary tool')
      return result.definition
    })
  }
  const run = vi.fn(async () => 'Admitted')
  const pane = (tools = config.toolkit!.tools!, key = 'same') => <ToolkitSettingsPane key={key} tools={tools} active performance={{ enabled: true, statusBar: 'icon' }} writer={writer} onSave={vi.fn()} onRemoveTool={vi.fn()} onRunTool={run} />
  return { owner, writer, run, path, pane }
}
async function button(text: string) {
  const node = Array.from(dom.container.querySelectorAll<HTMLButtonElement>('button')).find(node => node.textContent?.trim() === text)
  expect(node).toBeDefined(); await act(async () => node!.click())
}
async function input(selector: string, value: string) {
  const node = dom.container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)
  expect(node).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(node, value)
    node!.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
describe('actual Toolkit Settings account template consumer', () => {
  it('previews and creates one disabled ordinary draft, then saves through the actual ConfigOwner without running', async () => {
    const m = await setup(); await dom.render(m.pane())
    await dom.click('[data-tool-template="account-usage"]')
    expect(dom.container.querySelector('[aria-label="Account usage template"]')).not.toBeNull()
    expect(dom.container.querySelector('.toolkit-template__source')?.textContent).toBe(accountUsageScript)
    expect(m.writer.add).not.toHaveBeenCalled(); expect(m.run).not.toHaveBeenCalled()
    await button('Use this starting point')
    const name = dom.container.querySelector<HTMLInputElement>('.toolkit-editor__name input')
    expect(name).not.toBeNull(); expect(name!.value).toBe('Account usage'); expect(document.activeElement).toBe(name)
    expect(dom.container.querySelector<HTMLInputElement>('.toolkit-editor__toggle input')?.checked).toBe(false)
    await input('.toolkit-editor__fields input:not([type])', _hygiene_fixturePath("fixed-fixture"))
    await button('Save tool')
    expect(m.writer.add).toHaveBeenCalledTimes(1); expect(m.run).not.toHaveBeenCalled()
    const [id, value] = m.writer.add.mock.calls[0]!
    expect(id).toMatch(/^tool-/)
    expect(value).toEqual({ name: 'Account usage', icon: 'gauge', enabled: false, statusBar: 'icon', workspacePath: _hygiene_fixturePath("fixed-fixture"), script: accountUsageScript, args: ['', ''], actions: [] })
    const saved: AppConfig = JSON.parse(await readFile(m.path, 'utf8'))
    expect(saved.toolkit!.tools).toHaveLength(1)
    expect(saved.toolkit!.tools![0]).toMatchObject({ id, revision: expect.any(String), ...value })
  })
  it('keeps an independently edited saved tool while previewing and creating another template and on fresh hydrate', async () => {
    const original: ToolkitToolDefinition = { id: 'template:account-usage', revision: 'user-authored', name: 'My account view', icon: 'terminal', enabled: true,
      statusBar: 'label', workspacePath: _hygiene_fixturePath("user-fixed"), script: "console.log('independent authored output')", args: ['user-query', 'exact-user-key'], actions: [] }
    const m = await setup([original]); await dom.render(m.pane())
    await dom.click('[data-tool-id="template:account-usage"]')
    expect(dom.container.querySelector<HTMLInputElement>('.toolkit-editor__name input')?.value).toBe(original.name)
    await dom.click('[data-tool-template="account-usage"]'); await button('Use this starting point')
    await input('.toolkit-editor__fields input:not([type])', _hygiene_fixturePath("new-fixed")); await button('Save tool')
    expect(m.writer.add).toHaveBeenCalledTimes(1)
    const saved: AppConfig = JSON.parse(await readFile(m.path, 'utf8'))
    expect(saved.toolkit!.tools).toHaveLength(2)
    expect(saved.toolkit!.tools![0]).toEqual(original)
    await dom.render(m.pane(saved.toolkit!.tools, 'fresh-hydrate'))
    await dom.click('[data-tool-id="template:account-usage"]')
    expect(dom.container.querySelector<HTMLInputElement>('.toolkit-editor__name input')?.value).toBe(original.name)
    expect(dom.container.querySelector<HTMLTextAreaElement>('[aria-label="Script test field"]')?.value).toBe(original.script)
    expect(m.writer.update).not.toHaveBeenCalled(); expect(m.run).not.toHaveBeenCalled()
    expect(JSON.parse(await readFile(m.path, 'utf8')).toolkit.tools[0]).toEqual(original)
  })
  it('does not execute or create tools while previewing at the ordinary 128-tool limit', async () => {
    const tools = Array.from({ length: 128 }, (_, index): ToolkitToolDefinition => ({ id: `saved-${index}`, revision: `saved-revision-${index}`, name: `Saved ${index}`, icon: 'terminal', enabled: false, statusBar: 'icon', workspacePath: _hygiene_fixturePath("fixed"), script: 'console.log(1)', args: [], actions: [] }))
    const m = await setup(tools); await dom.render(m.pane())
    await dom.click('[data-tool-template="account-usage"]')
    const create = Array.from(dom.container.querySelectorAll<HTMLButtonElement>('button')).find(node => node.textContent?.trim() === 'Use this starting point')
    expect(create).toBeDefined(); expect(create!.disabled).toBe(true)
    expect(m.writer.add).not.toHaveBeenCalled(); expect(m.writer.update).not.toHaveBeenCalled(); expect(m.run).not.toHaveBeenCalled()
    expect(m.owner.current.toolkit!.tools).toEqual(tools)
  })
})
