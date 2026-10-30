// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('../src/renderer/src/components/settings/ToolkitScriptEditor', () => ({ default: () => <textarea /> }))
// Extend only the public Core contribution; the catalog consumer and reader remain real.
vi.mock('@agentmux/core/agent-message-render', async importOriginal => {
  const original = await importOriginal<typeof import('@agentmux/core/agent-message-render')>()
  const entry = { id: 'catalog-extension-probe', title: 'New Core contribution', description: 'A catalog-extension-probe declaration.', form: 'marker', examples: [{ label: 'Added format', wire: '<amux:catalog-probe state="sample" />' }] } as unknown as import('@agentmux/core/agent-message-render').AgentMuxProtocolCatalogEntry
  return { ...original, AGENTMUX_PROTOCOL_CATALOG: [...original.AGENTMUX_PROTOCOL_CATALOG, entry] }
})
import { AGENTMUX_PROTOCOL_CATALOG } from '@agentmux/core/agent-message-render'
import { agentMuxModuleSkill } from '../../../packages/core/src/agentmux-cli-module-skills'
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

it('removes the protocol preference from every actual Settings catalog consumer', async () => {
  expect(AGENTMUX_PROTOCOL_CATALOG.length).toBeGreaterThan(1)
  expect(settingsModules.map(module => module.id as string)).not.toContain('amux-protocols')
  expect(settingsNavGroups('').flatMap(group => group.items.map(module => module.id as string))).not.toContain('amux-protocols')
  expect(settingsCatalog.searchResults('catalog-extension-probe')).toEqual([])
  await dom.render(<SettingsPanel onClose={() => {}} />)
  expect(dom.container.querySelector('[data-settings-section="amux-protocols"], [data-settings-target="amux-protocols"]')).toBeNull()
})

it('document-local search discovers a new Core contribution and opens its real original-wire/card comparison', async () => {
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await mount()
  expect(document.activeElement).toBe(connected('[aria-label="Search amux Protocols"]'))
  expect(document.querySelectorAll('[data-protocol-example]')).toHaveLength(0)
  await search('catalog-extension-probe')
  expect(document.querySelectorAll('[data-protocol-entry]')).toHaveLength(1)
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
  expect(connected('.amux-protocols__empty').textContent).toContain('No formats match')
  await act(async () => connected<HTMLButtonElement>('[aria-label="Clear documentation search"]').click())
  expect(document.querySelectorAll('[data-protocol-entry]')).toHaveLength(AGENTMUX_PROTOCOL_CATALOG.length)
  expect(document.activeElement).toBe(connected('[aria-label="Search amux Protocols"]'))
})

it('all catalog examples demand-mount the original reader, and closing the document removes its activity without writes', async () => {
  const effects = [vi.spyOn(api.sessions, 'readHistory'), vi.spyOn(api.sessions, 'historyPage'), vi.spyOn(api.sessions, 'historyResource'), vi.spyOn(api.sessions, 'historySources'), vi.spyOn(api.sessions, 'submitPrompt'), vi.spyOn(api.ui, 'openObjectLink'), vi.spyOn(api.config, 'save')]
  await mount()
  expect(document.querySelectorAll('[data-protocol-entry]')).toHaveLength(AGENTMUX_PROTOCOL_CATALOG.length)
  for (const entry of AGENTMUX_PROTOCOL_CATALOG) {
    const row = await toggle(entry.id, true)
    expect(row.querySelectorAll('[data-protocol-example]')).toHaveLength(entry.examples.length)
    expect(row.querySelectorAll('.log-turn')).toHaveLength(entry.examples.length)
    expect([...row.querySelectorAll('.amux-protocols__wire pre')].map(node => node.textContent)).toEqual(entry.examples.map(example => example.wire))
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
  expect(skill).toContain('Documentation → amux Protocols')
  expect(skill).toContain("this local CLI's")
  expect(skill).toContain('does not describe the connected Runtime or an older installation')
  for (const entry of AGENTMUX_PROTOCOL_CATALOG) { expect(skill).toContain(entry.title); expect(skill).toContain(`(${entry.id}, ${entry.form})`); expect(skill).toContain(entry.description) }
})
