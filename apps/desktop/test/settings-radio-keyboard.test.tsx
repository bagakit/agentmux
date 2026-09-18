// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { AppearanceSettingsPane } from '../src/renderer/src/components/settings/AppearanceSettingsPane'
import { APP_APPEARANCE_IDS, type AppearanceConfig } from '../src/shared/contracts'
import { TERMINAL_THEME_CATALOG } from '../src/renderer/src/lib/terminal-theme'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const appearance: AppearanceConfig = { appAppearance: 'dark', terminalTheme: 'graphite', terminalFontSize: 12 }
function group(label: string, parent: Element = dom.container) {
  const node = parent.querySelector(`[role="radiogroup"][aria-label="${label}"]`)
  expect(node).not.toBeNull()
  return node!
}
function inputs(label: string, parent: Element = dom.container) {
  const found = [...group(label, parent).querySelectorAll<HTMLInputElement>('input[type="radio"]')]
  expect(found.length).toBeGreaterThan(0)
  return found
}
function choice(label: string, value: string, parent: Element = dom.container) {
  const input = inputs(label, parent).find(item => item.value === value)
  expect(input).toBeDefined()
  return input!
}

it('uses real grouped radio inputs with explicit names, associated labels and descriptions from the current catalogs', async () => {
  await dom.render(<AppearanceSettingsPane appearance={appearance} onSave={async () => {}} />)
  expect(APP_APPEARANCE_IDS.length).toBeGreaterThan(0)
  expect(TERMINAL_THEME_CATALOG.length).toBeGreaterThan(0)
  const application = inputs('Application appearance'), terminal = inputs('Terminal palette')
  expect(application.map(input => input.value)).toEqual([...APP_APPEARANCE_IDS])
  expect(terminal.map(input => input.value)).toEqual(TERMINAL_THEME_CATALOG.map(theme => theme.id))
  for (const values of [application, terminal]) {
    expect(new Set(values.map(input => input.name)).size).toBe(1)
    expect(values[0]!.name).not.toBe('')
    expect(values.filter(input => input.checked)).toHaveLength(1)
    for (const input of values) {
      expect(input.tabIndex).toBe(0)
      const label = input.closest('label')!
      expect(label.control).toBe(input)
      const title = label.querySelector('strong')!.textContent!.trim()
      expect(title.length).toBeGreaterThan(0)
      expect(input.getAttribute('aria-label')).toBe(title)
      const description = document.getElementById(input.getAttribute('aria-describedby')!)
      expect(description).not.toBeNull()
      expect(description!.textContent!.trim().length).toBeGreaterThan(0)
      expect(description!.closest('label')).toBe(label)
    }
  }
  expect(application[0]!.name).not.toBe(terminal[0]!.name)
})

it('label clicks edit the actual selected draft and preserve the other fields and original expected values', async () => {
  const onSave = vi.fn(async () => {})
  await dom.render(<AppearanceSettingsPane appearance={appearance} onSave={onSave} />)
  await act(async () => choice('Application appearance', 'light').closest('label')!.click())
  await act(async () => choice('Terminal palette', 'catppuccin-mocha').closest('label')!.click())
  expect(inputs('Application appearance').filter(input => input.checked).map(input => input.value)).toEqual(['light'])
  expect(inputs('Terminal palette').filter(input => input.checked).map(input => input.value)).toEqual(['catppuccin-mocha'])
  expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Terminal font size in pixels"]')!.value).toBe('12')
  await dom.click('.settings-pane-actions button')
  expect(onSave).toHaveBeenCalledExactlyOnceWith({ ...appearance, appAppearance: 'light', terminalTheme: 'catppuccin-mocha' }, appearance)
})

it('isolates native group names across mounted pane instances so selecting a second pane cannot uncheck the first', async () => {
  await dom.render(<><div data-pane="first"><AppearanceSettingsPane appearance={appearance} onSave={async () => {}} /></div>
    <div data-pane="second"><AppearanceSettingsPane appearance={appearance} onSave={async () => {}} /></div></>)
  const first = dom.container.querySelector('[data-pane="first"]')!, second = dom.container.querySelector('[data-pane="second"]')!
  const groups = ['Application appearance', 'Terminal palette']
  const names = [first, second].flatMap(parent => groups.map(label => inputs(label, parent)[0]!.name))
  expect(names).toHaveLength(4)
  expect(new Set(names).size).toBe(4)
  await act(async () => choice('Application appearance', 'light', second).closest('label')!.click())
  expect(inputs('Application appearance', first).filter(input => input.checked).map(input => input.value)).toEqual(['dark'])
  expect(inputs('Application appearance', second).filter(input => input.checked).map(input => input.value)).toEqual(['light'])
})

it('keeps the selected radio draft and authored baseline after an external same-field commit', async () => {
  const onSave = vi.fn(async () => {})
  await dom.render(<AppearanceSettingsPane appearance={appearance} onSave={onSave} />)
  await act(async () => choice('Application appearance', 'light').click())
  await dom.render(<AppearanceSettingsPane appearance={{ ...appearance, appAppearance: 'system', terminalFontSize: 16 }} onSave={onSave} />)
  expect(inputs('Application appearance').filter(input => input.checked).map(input => input.value)).toEqual(['light'])
  await dom.click('.settings-pane-actions button')
  expect(onSave).toHaveBeenCalledExactlyOnceWith({ ...appearance, appAppearance: 'light', terminalFontSize: 16 }, { ...appearance, terminalFontSize: 16 })
})
