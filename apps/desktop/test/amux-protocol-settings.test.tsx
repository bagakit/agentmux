// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'

vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('../src/renderer/src/components/settings/ToolkitScriptEditor', () => ({ default: () => <textarea /> }))

// A new Core contribution must reach the actual composition, search, Pane and local guide
// without modifying a UI list. All existing formatters and the shared reader remain real.
vi.mock('@agentmux/core/agent-message-render', async importOriginal => {
  const original = await importOriginal<typeof import('@agentmux/core/agent-message-render')>()
  const entry = {
    id: 'catalog-extension-probe', title: 'New Core contribution', description: 'A catalog-extension-probe declaration.',
    form: 'marker',
    examples: [{ label: 'Added format', wire: '<amux:catalog-probe state="sample" />' }]
  } as unknown as import('@agentmux/core/agent-message-render').AgentMuxProtocolCatalogEntry
  return { ...original, AGENTMUX_PROTOCOL_CATALOG: [...original.AGENTMUX_PROTOCOL_CATALOG, entry] }
})

import { AGENTMUX_PROTOCOL_CATALOG } from '@agentmux/core/agent-message-render'
import { agentMuxModuleSkill } from '../../../packages/core/src/agentmux-cli-module-skills'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { settingsCatalog, settingsModules, settingsNavGroups } from '../src/renderer/src/components/settings/settings-modules'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
beforeEach(() => useAppStore.setState({ config: composerConfig, loading: false, mainSurface: 'workbench',
  detectExecutors: vi.fn(async () => {}), checkHost: vi.fn(async () => {}) }))

function connected<T extends HTMLElement = HTMLElement>(selector: string): T {
  const element = dom.container.querySelector<T>(selector)
  expect(element, `Missing actual settings consumer: ${selector}`).not.toBeNull()
  expect(element!.isConnected).toBe(true)
  return element!
}

async function toggle(id: string, open: boolean) {
  const row = connected<HTMLDetailsElement>(`[data-settings-field="${id}"]`)
  await act(async () => { row.open = open; row.dispatchEvent(new Event('toggle')) })
  return row
}

it('a new Core contribution automatically reaches the real Settings directory, Overview and search', async () => {
  expect(AGENTMUX_PROTOCOL_CATALOG.length).toBeGreaterThan(1)
  const registered = settingsModules.filter(module => module.id === 'amux-protocols')
  expect(registered).toHaveLength(1)
  expect(settingsNavGroups('').find(group => group.id === 'message-tool')?.items.map(module => module.id)).toContain('amux-protocols')
  expect(registered[0]!.searchTargets?.map(target => target.id)).toEqual(AGENTMUX_PROTOCOL_CATALOG.map(entry => entry.id))
  expect(registered[0]!.searchTargets?.every(target => target.kind === 'info')).toBe(true)
  expect(settingsCatalog.searchResults('catalog-extension-probe').find(result => result.module.id === 'amux-protocols')?.targets.map(target => target.id))
    .toEqual(['catalog-extension-probe'])
  await dom.render(<SettingsPanel onClose={() => {}} />)
  expect(connected('[data-settings-section="amux-protocols"] .settings-overview__summary').textContent)
    .toBe(`${AGENTMUX_PROTOCOL_CATALOG.length} read-only formats`)
  expect(dom.container.querySelector('[data-protocol-example]')).toBeNull()
})

it('real settings search locates a new contribution and explicitly opens its actual shared card', async () => {
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await dom.render(<SettingsPanel onClose={() => {}} />)
  const search = connected<HTMLInputElement>('[aria-label="Search settings"]')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'catalog-extension-probe')
    search.dispatchEvent(new Event('input', { bubbles: true }))
    search.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await dom.click('[data-settings-search-result="amux-protocols:catalog-extension-probe"]')
  const row = connected<HTMLDetailsElement>('[data-settings-field="catalog-extension-probe"]')
  expect(document.activeElement).toBe(row)
  expect(row.hasAttribute('data-settings-search-highlight')).toBe(true)
  expect(row.open).toBe(false)
  expect(row.querySelector('.log-turn')).toBeNull()
  await toggle('catalog-extension-probe', true)
  expect(row.querySelector('.conversation-protocol')?.getAttribute('data-protocol-kind')).toBe('generic')
  expect(row.querySelector('.conversation-protocol dd')?.textContent).toBe('sample')
  const preview = connected('[data-protocol-example="catalog-extension-probe"]')
  await act(async () => preview.querySelector<HTMLButtonElement>('[aria-label="Copy message"]')!.click())
  expect(copy).toHaveBeenCalledWith('<amux:catalog-probe state="sample" />')
})

it('all current examples render on demand without user-history reads, input, navigation or saves', async () => {
  const effects = [
    vi.spyOn(api.sessions, 'readHistory'), vi.spyOn(api.sessions, 'historyPage'), vi.spyOn(api.sessions, 'historyResource'),
    vi.spyOn(api.sessions, 'historySources'), vi.spyOn(api.sessions, 'submitPrompt'),
    vi.spyOn(api.ui, 'openObjectLink'), vi.spyOn(api.config, 'save')
  ]
  await dom.render(<SettingsPanel initialSection="amux-protocols" onClose={() => {}} />)
  expect(dom.container.querySelectorAll('.amux-protocols__row')).toHaveLength(AGENTMUX_PROTOCOL_CATALOG.length)
  expect(dom.container.querySelectorAll('[data-protocol-example]')).toHaveLength(0)
  for (const entry of AGENTMUX_PROTOCOL_CATALOG) {
    const row = await toggle(entry.id, true)
    expect(row.querySelectorAll('[data-protocol-example]')).toHaveLength(entry.examples.length)
    expect(row.querySelectorAll('.log-turn')).toHaveLength(entry.examples.length)
    expect(Array.from(row.querySelectorAll('.amux-protocols__wire > pre'), node => node.textContent))
      .toEqual(entry.examples.map(example => example.wire))
  }
  const objectExample = connected('[data-protocol-example="link"]')
  expect(objectExample.textContent).toContain('amux://agent/SID')
  expect(objectExample.querySelector('[data-object-link-open], .inline-agent-link')).toBeNull()
  await dom.render(<SettingsPanel initialSection="amux-protocols" visible={false} onClose={() => {}} />)
  expect(dom.container.querySelectorAll('[data-protocol-example]')).toHaveLength(0)
  for (const effect of effects) expect(effect).not.toHaveBeenCalled()
})

it('local settings skill derives every format from the same Core contributions and states its scope', () => {
  const skill = agentMuxModuleSkill('settings')!
  expect(skill).toContain("this local CLI's")
  expect(skill).toContain('does not describe the connected Runtime or an older installation')
  expect(skill).toContain('Settings → Message Tool → amux Protocols')
  for (const entry of AGENTMUX_PROTOCOL_CATALOG) {
    expect(skill).toContain(entry.title)
    expect(skill).toContain(`(${entry.id}, ${entry.form})`)
    expect(skill).toContain(entry.description)
  }
})
