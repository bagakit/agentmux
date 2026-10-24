// @vitest-environment happy-dom
import { act, useState } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { CapsuleRuntimeObservation } from '@agentmux/core'
import type { CapsuleConfig, CapsuleMethod, CapsulePort } from '@agentmux/core/capsule'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
import type { SettingsModule, SettingsPaneProps } from '../src/renderer/src/components/settings/settings-catalog'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))

// Extend the actual compile-time composition. The original shell/catalog/visited-editor path
// receives a field-only word and an absent target, without a product-only test hook.
vi.mock('../src/renderer/src/components/settings/settings-modules', async importOriginal => {
  const original = await importOriginal<typeof import('../src/renderer/src/components/settings/settings-modules')>()
  const { createSettingsCatalog } = await import('../src/renderer/src/components/settings/settings-catalog')
  const { semanticIconComponent } = await import('@agentmux/client-ui/icons')
  function ContributedPane({ active }: SettingsPaneProps) {
    const [draft, setDraft] = useState('Authored field text')
    return <section data-settings-field="fixture-field" data-fixture-active={String(active)}>
      <label>Contributor field<textarea aria-label="Contributor field" value={draft} onChange={event => setDraft(event.target.value)} /></label>
    </section>
  }
  const fixture = { id: 'fixture', group: 'preferences', title: 'Contributed page', description: 'An independent contributor.',
    keywords: 'page-needle', icon: semanticIconComponent('object.settings'), savedSummary: () => 'Saved', Pane: ContributedPane,
    searchTargets: [{ id: 'fixture-field', title: 'Contributor field', keywords: 'unique-field-needle' },
      { id: 'absent-field', title: 'Unavailable original field', keywords: 'absent-needle' }]
  } satisfies SettingsModule
  const modules = [...original.settingsModules, fixture] as const
  const settingsCatalog = createSettingsCatalog(modules)
  return { ...original, settingsModules: modules, settingsCatalog,
    visibleSettingsSections: settingsCatalog.visibleSections, settingsNavGroups: settingsCatalog.navGroups }
})

import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { settingsCatalog, settingsModules } from '../src/renderer/src/components/settings/settings-modules'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { getSemanticIconCatalog } from '@agentmux/client-ui/icons'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
const dom = composerDOM()
let scrollTarget: ReturnType<typeof vi.spyOn>
const query = () => connected<HTMLInputElement>('[aria-label="Search settings"]')
function connected<T extends HTMLElement = HTMLElement>(selector: string, scope: ParentNode = dom.container): T {
  const element = scope.querySelector<T>(selector)
  expect(element, `Missing actual consumer: ${selector}`).not.toBeNull()
  expect(element!.isConnected).toBe(true)
  return element!
}
async function fill(selector: string, value: string) {
  const node = connected<HTMLInputElement | HTMLTextAreaElement>(selector)
  await act(async () => {
    Object.getOwnPropertyDescriptor(node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function key(key: string, extra: KeyboardEventInit = {}) {
  await act(async () => query().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra })))
}
const result = (key: string) => `[data-settings-search-result="${key}"]`
beforeEach(() => {
  useAppStore.setState({ config: composerConfig, loading: false,
    detectExecutors: vi.fn(async () => {}), checkHost: vi.fn(async () => {}) })
  scrollTarget = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return { x: 0, y: this.hasAttribute('data-settings-field') ? 240 : 40, width: 600, height: 60, top: this.hasAttribute('data-settings-field') ? 240 : 40,
      right: 600, bottom: 300, left: 0, toJSON() {} } as DOMRect
  })
})

it('discovers a field-only contribution through the original search without mounting any editor until explicit selection', async () => {
  const save = vi.spyOn(api.config, 'save'), reveal = vi.spyOn(api.ui, 'revealCrashLog')
  await dom.render(<SettingsPanel onClose={() => {}} />)
  expect(connected('.settings-content__hint').textContent).toBe('EscClose')
  await fill('[aria-label="Search settings"]', 'unique-field-needle')
  expect(connected('.settings-content__hint').textContent).toBe('EscClear search')
  expect(settingsCatalog.visibleSections('unique-field-needle').map(module => module.id)).toEqual(['fixture'])
  expect(connected(result('fixture:fixture-field')).textContent).toContain('Contributor field')
  expect(dom.container.querySelectorAll('[data-settings-pane]')).toHaveLength(0)
  expect(query()).toBe(document.activeElement)
  await dom.click(result('fixture:fixture-field'))
  const pane = connected<HTMLElement>('[data-settings-pane="fixture"]')
  const target = connected('[data-settings-field="fixture-field"]', pane)
  expect(pane.hidden).toBe(false)
  expect(pane.scrollTop).toBe(184)
  expect(document.activeElement).toBe(target)
  expect(target.hasAttribute('data-settings-search-highlight')).toBe(true)
  expect(dom.container.querySelectorAll('[data-settings-pane]')).toHaveLength(1)
  expect(save).not.toHaveBeenCalled(); expect(reveal).not.toHaveBeenCalled()
  expect(useAppStore.getState().detectExecutors).not.toHaveBeenCalled()
  expect(useAppStore.getState().checkHost).not.toHaveBeenCalled()
})

it.each(['clear', 'escape', 'empty', 'whitespace'] as const)('restores the original section, scroll, editor, draft and Range after %s', async exit => {
  const close = vi.fn()
  await dom.render(<SettingsPanel initialSection="profile" onClose={close} />)
  const pane = connected<HTMLElement>('[data-settings-pane="profile"]')
  const name = connected<HTMLInputElement>('[aria-label="Display name"]', pane)
  await fill('[aria-label="Display name"]', 'My original authored draft')
  name.setSelectionRange(3, 11, 'backward')
  pane.scrollTop = 137
  const before = useAppStore.getState()
  await fill('[aria-label="Search settings"]', 'Terminal font size')
  await dom.click(result('appearance:terminal-font-size'))
  await fill('[aria-label="Search settings"]', 'unique-field-needle')
  await dom.click(result('fixture:fixture-field'))
  expect(pane.hidden).toBe(true)
  if (exit === 'clear') await dom.click('[aria-label="Clear settings search"]')
  else if (exit === 'escape') await key('Escape')
  else await fill('[aria-label="Search settings"]', exit === 'empty' ? '' : '   ')
  expect(connected('[data-settings-pane="profile"]')).toBe(pane)
  expect(pane.hidden).toBe(false); expect(pane.inert).toBe(false)
  expect(pane.scrollTop).toBe(137)
  expect(connected('[aria-label="Display name"]')).toBe(name)
  expect(name.value).toBe('My original authored draft')
  expect([name.selectionStart, name.selectionEnd, name.selectionDirection]).toEqual([3, 11, 'backward'])
  expect(document.activeElement).toBe(query())
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(close).not.toHaveBeenCalled()
})

it('keeps no-match and IME Escape reversible without mounting, closing, or treating saved values as search text', async () => {
  const close = vi.fn()
  useAppStore.setState({ config: { ...composerConfig, profile: { displayName: 'private-value-needle', about: '', avatar: '', shareWithAgents: false } } })
  await dom.render(<SettingsPanel onClose={close} initialSection="general" />)
  const pane = connected<HTMLElement>('[data-settings-pane="general"]'); pane.scrollTop = 93
  await fill('[aria-label="Search settings"]', 'private-value-needle')
  expect(connected('.settings-nav-empty[role="status"]').textContent).toContain('No settings match')
  expect(dom.container.querySelectorAll('[data-settings-pane]')).toHaveLength(1)
  await key('Escape', { isComposing: true })
  expect(query().value).toBe('private-value-needle')
  expect(close).not.toHaveBeenCalled()
  await key('Escape')
  expect(query().value).toBe(''); expect(pane.hidden).toBe(false); expect(pane.scrollTop).toBe(93)
  await key('Escape'); expect(close).toHaveBeenCalledOnce()
})

it('returns to results and can reveal the same original target repeatedly without replacing its editor', async () => {
  await dom.render(<SettingsPanel onClose={() => {}} />)
  await fill('[aria-label="Search settings"]', 'unique-field-needle')
  await dom.click(result('fixture:fixture-field'))
  const pane = connected<HTMLElement>('[data-settings-pane="fixture"]')
  const editor = connected<HTMLTextAreaElement>('[aria-label="Contributor field"]')
  await fill('[aria-label="Contributor field"]', 'Keep the same contributed draft')
  const target = connected('[data-settings-field="fixture-field"]')
  await dom.click('.settings-search-return button')
  expect(pane.hidden).toBe(true)
  expect(target.hasAttribute('data-settings-search-highlight')).toBe(false)
  expect(connected('[data-fixture-active]').dataset.fixtureActive).toBe('false')
  await dom.click(result('fixture:fixture-field'))
  expect(connected('[data-settings-pane="fixture"]')).toBe(pane)
  expect(connected('[aria-label="Contributor field"]')).toBe(editor)
  expect(editor.value).toBe('Keep the same contributed draft')
  expect(target.hasAttribute('data-settings-search-highlight')).toBe(true)
})

it('shows absent exact targets truthfully and never substitutes a nearby connected field', async () => {
  await dom.render(<SettingsPanel onClose={() => {}} />)
  await fill('[aria-label="Search settings"]', 'absent-needle')
  await dom.click(result('fixture:absent-field'))
  expect(connected('.settings-search-return [role="status"]').textContent).toContain('not shown')
  expect(connected('[data-settings-pane="fixture"]').scrollTop).toBe(0)
  expect(connected('[data-settings-field="fixture-field"]').hasAttribute('data-settings-search-highlight')).toBe(false)
})

it('selects the original same section explicitly from the actual compact Radix menu while results are shown', async () => {
  await dom.render(<SettingsPanel initialSection="appearance" onClose={() => {}} />)
  await fill('[aria-label="Search settings"]', 'Terminal font size')
  const pane = connected<HTMLElement>('[data-settings-pane="appearance"]')
  expect(pane.hidden).toBe(true)
  const trigger = connected('[aria-label="Settings section"]')
  await act(async () => trigger.dispatchEvent(new PointerEvent('pointerover', {
    bubbles: true, cancelable: true, pointerType: 'mouse', buttons: 0, button: 0
  })))
  const item = connected<HTMLElement>('[role="menuitemradio"]', document)
  expect(item.textContent).toBe('Appearance')
  const checked = item.getAttribute('aria-checked')
  await act(async () => item.click())
  expect(pane.hidden).toBe(false)
  expect(checked).toBe('false')
  expect(connected('.settings-content__header h2').textContent).toBe('Appearance')
})

it('external exact A-B-A navigation invalidates old query/target and does not restore an obsolete source', async () => {
  const close = vi.fn()
  const routeA = { section: 'profile' as const }, routeB = { section: 'general' as const }
  await dom.render(<SettingsPanel initialSection="profile" navigationRequest={routeA} onClose={close} />)
  await fill('[aria-label="Display name"]', 'Preserved through source navigation')
  await fill('[aria-label="Search settings"]', 'unique-field-needle')
  await dom.click(result('fixture:fixture-field'))
  await dom.render(<SettingsPanel initialSection="general" navigationRequest={routeB} onClose={close} />)
  expect(query().value).toBe('')
  expect(connected('[data-settings-pane="general"]').hidden).toBe(false)
  expect(connected('[data-settings-field="fixture-field"]').hasAttribute('data-settings-search-highlight')).toBe(false)
  await dom.render(<SettingsPanel initialSection="profile" navigationRequest={{ ...routeA }} onClose={close} />)
  expect(connected<HTMLInputElement>('[aria-label="Display name"]').value).toBe('Preserved through source navigation')
  await key('Escape'); expect(close).toHaveBeenCalledOnce()
})

it('real original General and Appearance fields are direct targets while original save/diagnostic behavior stays explicit', async () => {
  const save = vi.spyOn(api.config, 'save'), reveal = vi.spyOn(api.ui, 'revealCrashLog')
  await dom.render(<SettingsPanel initialSection="profile" onClose={() => {}} />)
  for (const [term, target] of [['terminal font size', 'appearance:terminal-font-size'], ['Show crash log', 'general:crash-log'], ['Session recovery', 'general:session-recovery']] as const) {
    await fill('[aria-label="Search settings"]', term)
    await dom.click(result(target))
    const [section, id] = target.split(':')
    expect(connected(`[data-settings-pane="${section}"]`).hidden).toBe(false)
    expect(connected(`[data-settings-pane="${section}"] [data-settings-field="${id}"]`).hasAttribute('data-settings-search-highlight')).toBe(true)
  }
  expect(save).not.toHaveBeenCalled(); expect(reveal).not.toHaveBeenCalled()
  expect(scrollTarget).toHaveBeenCalled()
})

it('finds icon customization through the original Appearance target and opens the shared complete editor without saving', async () => {
  const save = vi.spyOn(api.config, 'save')
  await dom.render(<SettingsPanel onClose={() => {}} />)
  for (const term of ['icon', 'icons', 'semantic icons', '图标']) {
    await fill('[aria-label="Search settings"]', term)
    expect(settingsCatalog.searchResults(term).some(item => item.module.id === 'appearance' && item.targets.some(target => target.id === 'workspace-theme'))).toBe(true)
    await dom.click(result('appearance:workspace-theme'))
    const target = connected('[data-settings-pane="appearance"] [data-settings-field="workspace-theme"]')
    expect(target.hasAttribute('data-settings-search-highlight')).toBe(true)
    expect(target.textContent).toContain('semantic icons')
    expect(target.textContent).toContain('Preview in this window')
  }
  const customize = [...dom.container.querySelectorAll<HTMLButtonElement>('[data-settings-pane="appearance"] button')]
    .find(button => button.textContent?.trim() === 'Customize selected theme')
  expect(customize).toBeDefined()
  await act(async () => customize!.click())
  const catalog = getSemanticIconCatalog()
  expect(catalog.icons.length).toBeGreaterThan(400)
  expect(dom.container.querySelectorAll('.theme-icon-editor__meaning')).toHaveLength(catalog.icons.length)
  expect(dom.container.querySelector('[aria-label="Semantic icon editor"]')).not.toBeNull()
  expect(save).not.toHaveBeenCalled()
})

it('all static field contributions have unique local target identities and remain statically searchable', () => {
  const contributions = settingsModules.flatMap(module => (module as SettingsModule).searchTargets?.map(target => ({ module, target })) ?? [])
  expect(contributions.length).toBeGreaterThan(40)
  expect(new Set(contributions.map(({ module, target }) => `${module.id}:${target.id}`)).size).toBe(contributions.length)
  for (const { module, target } of contributions) {
    expect(settingsCatalog.searchResults(target.title).some(result => result.module.id === module.id && result.targets.some(candidate => candidate.id === target.id))).toBe(true)
  }
})

it('every production static target reaches its connected original Pane location through explicit search selection', async () => {
  const save = vi.spyOn(api.config, 'save'), reveal = vi.spyOn(api.ui, 'revealCrashLog')
  const system = vi.spyOn(api.ui, 'openDefaultBrowserSettings')
  // This navigation proof supplies platform reads for service-owned fields. It
  // never starts a service or replaces the original Pane/field destinations.
  const capsuleRuntime = vi.spyOn(api.capsuleRuntime, 'call').mockImplementation(async method => {
    if (method !== 'capsule.runtime.inspect') throw new Error(`Unexpected service mutation: ${method}`)
    return { revision: 1, desired: 'running', phase: 'running',
      stateDirectory: fixturePath('settings-targets/state'), socketPath: fixturePath('settings-targets/capsule.sock'),
      run: { hostId: 'local', runId: 'settings-targets-fixture-run' }, runtime: null, operation: null, issue: null } satisfies CapsuleRuntimeObservation
  })
  const capsuleConfig: CapsuleConfig = { revision: 1, contentRoot: fixturePath('settings-targets/content'),
    defaultStorageMode: 'managed', defaultMode: 'isolated', defaultTheme: 'follow' }
  const capsuleReads = vi.spyOn(api.capsules, 'call').mockImplementation((async (method: CapsuleMethod) => {
    if (method === 'capsule.config.inspect') return { config: capsuleConfig }
    if (method === 'capsule.ls') return { capsules: [], issues: [] }
    throw new Error(`Unexpected Capsule mutation: ${method}`)
  }) as CapsulePort['call'])
  await dom.render(<SettingsPanel onClose={() => {}} />)
  const contributions = settingsModules.filter(module => (module as SettingsModule).id !== 'fixture')
    .flatMap(module => (module as SettingsModule).searchTargets?.map(target => ({ module, target })) ?? [])
  expect(contributions.length).toBeGreaterThan(40)
  for (const { module, target } of contributions) {
    await fill('[aria-label="Search settings"]', target.title)
    await dom.click(result(`${module.id}:${target.id}`))
    const pane = connected<HTMLElement>(`[data-settings-pane="${module.id}"]`)
    expect(pane.hidden).toBe(false)
    expect(pane.querySelectorAll(`[data-settings-field="${target.id}"]`), `${module.id}:${target.id} (${target.title}); mounted fields: ${[...pane.querySelectorAll<HTMLElement>('[data-settings-field]')].map(node => node.dataset.settingsField).join(', ')}`).toHaveLength(1)
    const location = connected(`[data-settings-field="${target.id}"]`, pane)
    expect(location.closest('[hidden], [inert]')).toBeNull()
    expect(document.activeElement).toBe(location)
    expect(location.hasAttribute('data-settings-search-highlight')).toBe(true)
    expect(dom.container.querySelector('.settings-search-return [role="status"]')).toBeNull()
  }
  expect(save).not.toHaveBeenCalled(); expect(reveal).not.toHaveBeenCalled(); expect(system).not.toHaveBeenCalled()
  expect([...new Set(capsuleRuntime.mock.calls.map(([method]) => method))]).toEqual(['capsule.runtime.inspect'])
  expect([...new Set(capsuleReads.mock.calls.map(([method]) => method))].sort()).toEqual(['capsule.config.inspect', 'capsule.ls'])
  for (const [, params] of [...capsuleRuntime.mock.calls, ...capsuleReads.mock.calls]) expect(params).toEqual({})
})
