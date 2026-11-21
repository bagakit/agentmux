// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('../src/renderer/src/components/settings/ToolkitScriptEditor', () => ({ default: () => <textarea /> }))
// Extend only the public Core contribution; the catalog consumer and reader remain real.
vi.mock('@agentmux/core/amux-protocol', async importOriginal => {
  const original = await importOriginal<typeof import('@agentmux/core/amux-protocol')>()
  const entry = { id: 'catalog-extension-probe', title: 'New Core contribution', description: 'A catalog-extension-probe declaration.', form: 'marker', templates: [{ name: 'wire', text: '<amux:catalog-probe state="{{state}}" />' }], examples: [{ label: 'Added format', wire: '<amux:catalog-probe state="sample" />' }] } as unknown as import('@agentmux/core/amux-protocol').AgentMuxProtocolCatalogEntry
  return { ...original, AGENTMUX_PROTOCOL_CATALOG: [...original.AGENTMUX_PROTOCOL_CATALOG, entry] }
})
import { AGENTMUX_PROTOCOL_CATALOG } from '@agentmux/core/amux-protocol'
import { AGENTMUX_PROTOCOL_CATALOG as generatedGuideCatalog } from '../../../packages/core/src/amux-protocol.js'
import { agentMuxModuleSkill } from '../../../packages/core/src/agentmux-cli-module-skills'
import { focusGroupTaskPrompt } from '../src/renderer/src/lib/focus-group-task'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { settingsCatalog, settingsModules, settingsNavGroups } from '../src/renderer/src/components/settings/settings-modules'
import { WindowUtilityBar } from '../src/renderer/src/components/WindowUtilityBar'
import { AmuxProtocolReference } from '../src/renderer/src/components/documentation/AmuxProtocolReference'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
import { DocumentationTestOwner } from './helpers/documentation-owner'
const dom = composerDOM()
beforeEach(() => useAppStore.setState({ config: composerConfig, loading: false, mainSurface: 'workbench', detectExecutors: vi.fn(async () => {}), checkHost: vi.fn(async () => {}) }))
function connected<T extends HTMLElement = HTMLElement>(selector: string): T { const element = document.querySelector<T>(selector); expect(element, `Missing real document consumer: ${selector}`).not.toBeNull(); expect(element!.isConnected).toBe(true); return element! }
async function button(text: string) { const node = [...document.querySelectorAll<HTMLButtonElement>('.documentation-dialog button')].find(button => button.textContent?.trim() === text); expect(node, text).toBeDefined(); await act(async () => node!.click()) }
async function toggle(id: string, open: boolean) { const row = connected<HTMLDetailsElement>(`[data-protocol-entry="${id}"]`); await act(async () => { row.open = open; row.dispatchEvent(new Event('toggle')) }); return row }
async function mount() { await dom.render(<DocumentationTestOwner><WindowUtilityBar /></DocumentationTestOwner>); await dom.click('[data-documentation-open]'); connected('.documentation-dialog') }
async function search(value: string) { const input = connected<HTMLInputElement>('[aria-label="Search amux Protocols"]'); await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) }) }

it('opens the App-owned protocol directory from Settings Prompts without changing the active settings pane', async () => {
  await dom.render(<DocumentationTestOwner><SettingsPanel initialSection="prompts" onClose={() => {}} /></DocumentationTestOwner>)
  const entry = [...connected('[data-settings-pane="prompts"]').querySelectorAll<HTMLButtonElement>('button')]
    .find(button => button.textContent === 'amux Protocols')
  expect(entry).toBeDefined()
  await act(async () => { entry?.focus(); entry?.click() })
  expect(connected('.documentation-dialog h2').textContent).toBe('amux Protocols')
  await act(async () => connected<HTMLButtonElement>('[aria-label="Close documentation"]').click())
  await vi.waitFor(() => expect(document.activeElement?.textContent).toBe('amux Protocols'))
  expect(connected('[data-settings-pane="prompts"]').hidden).toBe(false)
  expect(settingsModules.map(module => module.id as string)).not.toContain('amux-protocols')
  expect(settingsNavGroups('').flatMap(group => group.items.map(module => module.id as string))).not.toContain('amux-protocols')
  expect(settingsCatalog.searchResults('catalog-extension-probe')).toEqual([])
})

it('shows the exact Focus prompt used by the real task producer and opens its editable template on demand', async () => {
  await mount()
  await search('Focus group tasks')
  const row = await toggle('focus-task', true)
  expect(row.querySelector('[data-protocol-example] pre')?.textContent)
    .toBe(focusGroupTaskPrompt('organize', { kind: 'new-agent', targetKey: 'original-project' }))
  expect(row.querySelector('.amux-protocols__templates pre')).toBeNull()
  const templates = row.querySelector<HTMLDetailsElement>('.amux-protocols__templates')!
  await act(async () => { templates.open = true; templates.dispatchEvent(new Event('toggle')) })
  expect([...templates.querySelectorAll('pre')].some(node => node.textContent?.includes('{{perspective}}'))).toBe(true)
})

it('document-local search discovers a new Core contribution and opens its real original-wire/card comparison', async () => {
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await mount()
  expect(document.activeElement).toBe(connected('[aria-label="Search amux Protocols"]'))
  expect(document.querySelectorAll('[data-protocol-example]')).toHaveLength(0)
  await search('catalog-extension-probe')
  expect(document.querySelectorAll('[data-protocol-entry]')).toHaveLength(1)
  expect([...document.querySelectorAll('[data-protocol-form]')].map(group => group.getAttribute('data-protocol-form'))).toEqual(['marker'])
  const row = connected<HTMLDetailsElement>('[data-protocol-entry="catalog-extension-probe"]')
  expect(row.open).toBe(false)
  await button('View first example'); expect(row.open).toBe(true)
  await toggle('catalog-extension-probe', true)
  expect(row.querySelector('.amux-protocols__wire pre')?.textContent).toBe('<amux:catalog-probe state="sample" />')
  expect(row.querySelector('.conversation-protocol')?.getAttribute('data-protocol-kind')).toBe('generic')
  expect(row.querySelector('.conversation-protocol dd')?.textContent).toBe('sample')
  await act(async () => connected<HTMLButtonElement>('[aria-label="Copy message"]').click())
  expect(copy).toHaveBeenCalledWith('<amux:catalog-probe state="sample" />')
  await search('nothing matches this original catalog')
  expect(document.querySelectorAll('[data-protocol-entry], [data-protocol-example]')).toHaveLength(0)
  expect(connected('.amux-protocols__empty').textContent).toContain('No entries match')
  await act(async () => connected<HTMLButtonElement>('[aria-label="Clear documentation search"]').click())
  expect(document.querySelectorAll('[data-protocol-entry]')).toHaveLength(AGENTMUX_PROTOCOL_CATALOG.length)
  expect(document.activeElement).toBe(connected('[aria-label="Search amux Protocols"]'))
})

it('all catalog examples demand-mount the original reader, and closing the document removes its activity without writes', async () => {
  const effects = [vi.spyOn(api.sessions, 'readHistory'), vi.spyOn(api.sessions, 'historyPage'), vi.spyOn(api.sessions, 'historyResource'), vi.spyOn(api.sessions, 'historySources'), vi.spyOn(api.sessions, 'submitPrompt'), vi.spyOn(api.ui, 'openObjectLink'), vi.spyOn(api.config, 'save')]
  await mount()
  expect(document.querySelectorAll('[data-protocol-entry]')).toHaveLength(AGENTMUX_PROTOCOL_CATALOG.length)
  const groups = [...document.querySelectorAll<HTMLElement>('[data-protocol-form]')]
  expect(new Set(groups.map(group => group.dataset.protocolForm))).toEqual(new Set(AGENTMUX_PROTOCOL_CATALOG.map(entry => entry.form)))
  for (const group of groups) {
    expect([...group.querySelectorAll<HTMLElement>('[data-protocol-entry]')].map(row => row.dataset.protocolEntry))
      .toEqual(AGENTMUX_PROTOCOL_CATALOG.filter(entry => entry.form === group.dataset.protocolForm).map(entry => entry.id))
    expect(group.querySelector('h3')?.getAttribute('id')).toBe(group.getAttribute('aria-labelledby'))
  }
  for (const entry of AGENTMUX_PROTOCOL_CATALOG) {
    const row = await toggle(entry.id, true)
    expect(row.querySelectorAll('[data-protocol-example]')).toHaveLength(entry.examples.length)
    expect(row.querySelectorAll('.log-turn')).toHaveLength(entry.form === 'prompt' ? 0 : entry.examples.length)
    expect([...row.querySelectorAll('.amux-protocols__wire pre, .amux-protocols__source pre')].map(node => node.textContent)).toEqual(entry.examples.map(example => example.wire))
  }
  expect(connected('[data-protocol-example="link"]').querySelector('[data-object-link-open], .inline-agent-link')).toBeNull()
  await act(async () => connected<HTMLButtonElement>('[aria-label="Close documentation"]').click())
  expect(document.querySelectorAll('[data-protocol-example]')).toHaveLength(0)
  for (const effect of effects) expect(effect).not.toHaveBeenCalled()
})

it('a retained inactive reference stops its own examples without deleting the original catalog row', async () => {
  await dom.render(<AmuxProtocolReference active />); const id = AGENTMUX_PROTOCOL_CATALOG[0]!.id
  await toggle(id, true); expect(document.querySelectorAll('[data-protocol-example]').length).toBeGreaterThan(0)
  await dom.render(<AmuxProtocolReference active={false} />)
  expect(connected<HTMLDetailsElement>(`[data-protocol-entry="${id}"]`).open).toBe(true)
  expect(document.querySelectorAll('[data-protocol-example]')).toHaveLength(0)
})

it('the original local CLI guide still derives its directory from Core and points to Documentation', () => {
  const skill = agentMuxModuleSkill('settings')!
  expect(skill).toContain('Open amux Protocols from Settings → Prompts')
  expect(skill).toContain("this local CLI's")
  expect(skill).toContain('does not describe the connected Runtime or an older installation')
  expect(generatedGuideCatalog.length).toBeGreaterThan(0)
  for (const entry of generatedGuideCatalog) { expect(skill).toContain(entry.title); expect(skill).toContain(`(${entry.id}, ${entry.form})`); expect(skill).toContain(entry.description) }
})
