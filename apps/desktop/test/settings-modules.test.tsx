const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AppConfig } from '../src/shared/contracts'
import type { SettingsModule, SettingsPaneProps } from '../src/renderer/src/components/settings/settings-catalog'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
// This shell test owns navigation and drafts; the browser-only Monaco leaf has its own gates.
vi.mock('../src/renderer/src/components/settings/ToolkitScriptEditor', () => ({ default: () => <textarea data-inline-editor /> }))
const registration = vi.hoisted(() => ({ originalIds: [] as string[] }))

// Extend only the real compile-time composition. Panel has no fixture prop and the generic
// catalog, Overview, navigation and visited Pane consumer remain production code.
vi.mock('../src/renderer/src/components/settings/settings-modules', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/renderer/src/components/settings/settings-modules')>()
  const { createSettingsCatalog } = await import('../src/renderer/src/components/settings/settings-catalog')
  const { useState } = await import('react')
  const { Settings2 } = await import('lucide-react')
  registration.originalIds = original.settingsModules.map(module => module.id)
  function FixturePane({ active }: SettingsPaneProps) {
    const [draft, setDraft] = useState('Fresh draft')
    return <label data-fixture-active={String(active)}>Fixture draft
      <input aria-label="Fixture draft" value={draft} onChange={event => setDraft(event.target.value)} />
    </label>
  }
  const fixture = {
    id: 'fixture-module', group: 'resources', title: 'Fixture module',
    description: 'One independently contributed settings page.', keywords: 'fixture-needle', icon: Settings2,
    savedSummary: (config: AppConfig) => config.copyPathsAsAbsolute === true ? 'Saved absolute paths' : 'Saved abbreviated paths',
    Pane: FixturePane
  } satisfies SettingsModule
  const settingsModules = [...original.settingsModules, fixture] as const
  const settingsCatalog = createSettingsCatalog(settingsModules)
  return { ...original, settingsModules, settingsCatalog,
    visibleSettingsSections: settingsCatalog.visibleSections, settingsNavGroups: settingsCatalog.navGroups }
})

import { SettingsPanel, visibleSettingsSections } from '../src/renderer/src/components/SettingsPanel'
import { settingsNavGroups } from '../src/renderer/src/components/settings/settings-modules'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
beforeEach(() => {
  useAppStore.setState({ config: { ...composerConfig, copyPathsAsAbsolute: false,
    browser: { ...composerConfig.browser, agentAutomation: false, appLinkSchemes: { custom: 'deny' } } },
    loading: false, mainSurface: 'workbench',
    detectExecutors: vi.fn(async () => {}), checkHost: vi.fn(async () => {}) })
})
function connected<T extends HTMLElement = HTMLElement>(selector: string, scope: ParentNode = dom.container): T {
  const element = scope.querySelector<T>(selector)
  expect(element, `Missing connected consumer: ${selector}`).not.toBeNull()
  expect(element!.isConnected).toBe(true)
  return element!
}
async function input(selector: string, value: string) {
  const element = connected<HTMLInputElement>(selector)
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
async function section(title: string) {
  const button = [...dom.container.querySelectorAll<HTMLButtonElement>('nav[aria-label="Settings sections"] button')]
    .find(node => node.textContent === title)
  expect(button, `Missing section: ${title}`).toBeDefined()
  expect(button!.isConnected).toBe(true)
  await act(async () => button!.click())
}
const mountedPanes = () => [...dom.container.querySelectorAll<HTMLElement>('[data-settings-pane]')]
  .map(node => node.dataset.settingsPane)
const overviewRow = () => connected('[data-settings-overview] [data-settings-section="fixture-module"]')

it('a contributed module reaches Overview, sidebar, compact menu, search and its actual Pane through the generic shell', async () => {
  await dom.render(<SettingsPanel onClose={() => {}} />)
  expect(registration.originalIds).toEqual([
    'profile', 'appearance', 'notifications', 'browser', 'general', 'keyboard-shortcuts', 'mote', 'space', 'focus', 'goals', 'survey', 'notes', 'toolkit', 'agents', 'prompts', 'hosts', 'devices'
  ])
  const catalog = visibleSettingsSections('')
  expect(catalog.map(module => module.id)).toEqual([
    'profile', 'appearance', 'notifications', 'browser', 'general', 'keyboard-shortcuts',
    'hosts', 'devices', 'toolkit', 'agents', 'prompts', 'fixture-module',
    'space', 'focus', 'goals', 'survey', 'notes', 'mote'
  ])
  const navigation = settingsNavGroups('').flatMap(group => group.items)
  expect(new Set(navigation.map(module => module.id))).toEqual(new Set(catalog.map(module => module.id)))
  expect(navigation).toHaveLength(catalog.length)
  expect(navigation.map(module => module.id)).toEqual(catalog.map(module => module.id))
  expect([...dom.container.querySelectorAll('[data-settings-overview] [data-settings-section]')]
    .map(node => node.getAttribute('data-settings-section'))).toEqual(navigation.map(module => module.id))
  expect([...dom.container.querySelectorAll('nav[aria-label="Settings sections"] button:not([data-settings-overview-nav])')]
    .map(node => node.textContent)).toEqual(navigation.map(module => module.title))
  expect(overviewRow().textContent).toContain('Saved abbreviated paths')
  expect(mountedPanes()).toEqual([])
  const search = connected<HTMLInputElement>('[aria-label="Search settings"]')
  search.focus()
  const trigger = connected('[aria-label="Settings section"]')
  await act(async () => trigger.dispatchEvent(new PointerEvent('pointerover', {
    bubbles: true, cancelable: true, pointerType: 'mouse', buttons: 0, button: 0
  })))
  const menu = connected('[role="menu"]', document)
  const choices = [...menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
  expect(choices.map(node => node.textContent)).toEqual(['Overview', ...navigation.map(module => module.title)])
  expect(document.activeElement).toBe(search)
  const contributedChoice = choices.find(node => node.textContent === 'Fixture module')
  expect(contributedChoice).toBeDefined()
  await act(async () => contributedChoice!.click())
  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect(dom.container.querySelector('.settings-content__header h2')?.textContent).toBe('Fixture module')
  expect(connected<HTMLInputElement>('[aria-label="Fixture draft"]').value).toBe('Fresh draft')
  expect(mountedPanes()).toEqual(['fixture-module'])
  await dom.click('[data-settings-overview-nav]')
  expect(overviewRow().textContent).toContain('Saved abbreviated paths')
  await input('[aria-label="Search settings"]', 'fixture-needle')
  expect([...dom.container.querySelectorAll('nav[aria-label="Settings sections"] button')]
    .map(node => node.textContent)).toEqual(['Fixture module'])
  expect(dom.container.querySelector('.settings-content__header h2')?.textContent).toBe('Fixture module')
  expect(connected<HTMLElement>('[data-settings-pane="fixture-module"]').hidden).toBe(false)
  expect(mountedPanes()).toEqual(['fixture-module'])
})

it('keeps the contributed draft, component identity and reading position while its summary follows only saved configuration', async () => {
  const save = vi.spyOn(api.config, 'save').mockResolvedValue(undefined)
  await dom.render(<SettingsPanel onClose={() => {}} />)
  expect(connected('[data-settings-overview] [data-settings-section="general"] .settings-overview__summary').textContent)
    .toBe('Home paths (~)')
  await section('Fixture module')
  const pane = connected<HTMLElement>('[data-settings-pane="fixture-module"]')
  const draft = connected<HTMLInputElement>('[aria-label="Fixture draft"]', pane)
  await input('[aria-label="Fixture draft"]', 'Keep this authored text')
  pane.scrollTop = 137
  await dom.click('[data-settings-overview-nav]')
  expect(pane.hidden).toBe(true)
  expect(pane.inert).toBe(true)
  expect(connected('[data-fixture-active]', pane).dataset.fixtureActive).toBe('false')
  expect(overviewRow().textContent).toContain('Saved abbreviated paths')
  const before = useAppStore.getState().config!
  await act(async () => useAppStore.getState().setConfig({ ...before, copyPathsAsAbsolute: true }))
  expect(overviewRow().textContent).toContain('Saved absolute paths')
  expect(connected('[data-settings-overview] [data-settings-section="general"] .settings-overview__summary').textContent)
    .toBe('Absolute paths')
  await section('General')
  await section('Fixture module')
  expect(connected('[data-settings-pane="fixture-module"]')).toBe(pane)
  expect(connected('[aria-label="Fixture draft"]', pane)).toBe(draft)
  expect(draft.value).toBe('Keep this authored text')
  expect(pane.scrollTop).toBe(137)
  expect(connected('[data-fixture-active]', pane).dataset.fixtureActive).toBe('true')
  await input('[aria-label="Search settings"]', 'no-fixture-or-section-matches')
  expect(connected('.settings-nav-empty[role="status"]').textContent).toContain('No settings match')
  expect(pane.hidden).toBe(true)
  await dom.click('[aria-label="Clear settings search"]')
  expect(document.activeElement).toBe(connected('[aria-label="Search settings"]'))
  expect(connected('[data-settings-pane="fixture-module"]')).toBe(pane)
  expect(pane.hidden).toBe(false)
  expect(draft.value).toBe('Keep this authored text')
  expect(pane.scrollTop).toBe(137)
  expect(mountedPanes()).toEqual(['fixture-module', 'general'])
  expect(save).not.toHaveBeenCalled()
  expect(useAppStore.getState().detectExecutors).not.toHaveBeenCalled()
  expect(useAppStore.getState().checkHost).not.toHaveBeenCalled()
})

it('Browser module saves its authored automation value against the original field while preserving newer nested Browser facts', async () => {
  const save = vi.spyOn(api.config, 'save').mockResolvedValue(undefined)
  await dom.render(<SettingsPanel initialSection="browser" onClose={() => {}} />)
  const pane = connected('[data-settings-pane="browser"]')
  const toggle = connected<HTMLInputElement>('input[type="checkbox"]', pane)
  expect(toggle.checked).toBe(false)
  await act(async () => toggle.click())
  expect(toggle.checked).toBe(true)
  const baseline = useAppStore.getState().config!
  const latest: AppConfig = { ...baseline, copyPathsAsAbsolute: true,
    browser: { ...baseline.browser, toolbar: { ...baseline.browser.toolbar, screenshot: false },
      appLinkSchemes: { custom: 'allow', another: 'deny' } } }
  await act(async () => useAppStore.getState().setConfig(latest))
  expect(connected('input[type="checkbox"]', pane)).toBe(toggle)
  expect(toggle.checked).toBe(true)
  const button = connected<HTMLButtonElement>('[data-settings-save-bar] button', pane)
  expect(button.disabled).toBe(false)
  await act(async () => button.click())
  expect(save).toHaveBeenCalledExactlyOnceWith(
    { ...latest, browser: { ...latest.browser, agentAutomation: true } },
    { ...latest, browser: { ...latest.browser, agentAutomation: false } }
  )
  expect(useAppStore.getState().config).toBe(latest)
})


it('finds the saved local Auth tool through ordinary auth and usage settings search without creating or running', async () => {
  useAppStore.setState({ config: { ...composerConfig, toolkit: { tools: [{ id: 'auth', name: 'Auth', icon: 'key-round', enabled: true, statusBar: 'icon', script: 'console.log(1)', args: [], revision: 'saved-local', workspacePath: _hygiene_fixturePath("fixed") }] } } })
  const save = vi.spyOn(api.config, 'save').mockResolvedValue(undefined)
  const add = vi.spyOn(api.toolkit, 'add')
  const run = vi.spyOn(api.toolkit, 'run')
  await dom.render(<SettingsPanel onClose={() => {}} />)
  for (const query of ['auth', 'account', '用量', 'Mods']) {
    await input('[aria-label="Search settings"]', query)
    expect([...dom.container.querySelectorAll('nav[aria-label="Settings sections"] button')]
      .map(node => node.textContent)).toEqual(['Toolkit Library'])
    expect(connected('.settings-content__header h2').textContent).toBe('Toolkit Library')
    expect(connected('.toolkit-library').getAttribute('aria-label')).toBe('Toolkit Library')
    expect(connected<HTMLElement>('[data-settings-pane="toolkit"]').hidden).toBe(false)
  }
  const local = connected<HTMLButtonElement>('[data-tool-id="auth"]')
  expect(local.textContent).toContain('Auth')
  expect(local.textContent).toContain('Custom')
  await act(async () => local.click())
  expect(connected<HTMLInputElement>('.toolkit-editor__name input').value).toBe('Auth')
  expect(dom.container.querySelector('[data-tool-template]')).toBeNull()
  expect(save).not.toHaveBeenCalled()
  expect(add).not.toHaveBeenCalled()
  expect(run).not.toHaveBeenCalled()
})

it('presents Mods beside Preferences through the actual shell and preserves the authored tool draft across pages', async () => {
  useAppStore.setState({ config: { ...composerConfig, toolkit: { tools: [{ id: 'custom-summary', name: 'My summary', icon: 'terminal', enabled: true, statusBar: 'icon', script: 'console.log(1)', args: [], revision: 'saved-local', workspacePath: _hygiene_fixturePath("fixed") }] } } })
  const save = vi.spyOn(api.config, 'save').mockResolvedValue(undefined)
  const add = vi.spyOn(api.toolkit, 'add')
  const run = vi.spyOn(api.toolkit, 'run')
  await dom.render(<SettingsPanel onClose={() => {}} />)
  const overview = connected('[aria-labelledby="settings-overview-toolkit"]')
  expect(connected('h3', overview).textContent).toBe('Mods')
  expect(connected('[data-settings-section="toolkit"]', overview).textContent).toContain('Toolkit Library')
  const nav = connected('nav[aria-label="Settings sections"]')
  const row = connected('[data-settings-target="toolkit"]', nav)
  expect(row.previousElementSibling!.textContent).toBe('Mods')
  const groups = settingsNavGroups('')
  expect(groups.map(group => group.title)).toEqual(['Preferences', 'Connections', 'Mods', 'Resources', 'Work', 'Mote'])
  expect(groups.find(group => group.title === 'Mods')!.items.map(item => item.id)).toEqual(['toolkit'])
  expect(groups.find(group => group.title === 'Preferences')!.items.map(item => item.id)).not.toContain('toolkit')
  await section('Toolkit Library')
  expect(connected('.settings-content__breadcrumb').textContent).toBe('Mods')
  await dom.click('[data-tool-id="custom-summary"]')
  await input('.toolkit-editor__name input', 'Keep my custom draft')
  const pane = connected('[data-settings-pane="toolkit"]')
  await section('General')
  expect(pane.hidden).toBe(true)
  await section('Toolkit Library')
  expect(connected('[data-settings-pane="toolkit"]')).toBe(pane)
  expect(connected<HTMLInputElement>('.toolkit-editor__name input').value).toBe('Keep my custom draft')
  expect(save).not.toHaveBeenCalled()
  expect(add).not.toHaveBeenCalled()
  expect(run).not.toHaveBeenCalled()
})
