// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GRAPHITE_THEME, mountThemeRuntime, previewTheme, updateThemeSelection } from '@agentmux/client-ui/theme'
import { LaunchRefine } from '../src/renderer/src/components/LaunchOptionControls'
import { composerDOM } from './helpers/composer-dom-fixture'
const dom = composerDOM(); let dispose: () => void, styles: HTMLStyleElement
beforeEach(() => {
  dispose = mountThemeRuntime(window, { appAppearance: 'light' })
  styles = document.createElement('style'); styles.textContent = readFileSync('packages/client-ui/src/styles/native-controls.css', 'utf8'); document.head.append(styles)
})
afterEach(() => { dispose(); styles.remove() })
it('the original Provider option selector consumes same root geometry/current variant color without rebuilding or changing choice payloads', async () => {
  const selected = vi.fn(), option = { id: 'original-option', label: 'Original choice', choices: [{ id: 'balanced', label: 'Balanced' }, { id: 'strict', label: 'Strict' }] }
  await dom.render(<LaunchRefine options={[option]} selection={{ 'original-option': 'balanced' }} active expanded onToggle={() => {}} onSelect={selected}/>)
  const control = document.querySelector<HTMLSelectElement>('select[aria-label="Original choice"]')!
  expect(control, 'nonempty production select consumer').not.toBeNull()
  const sprite = document.querySelector('[data-semantic-icon-sprite]')!, symbol = document.getElementById('agentmux-icon-control.select-open')!
  const renderedImage = () => decodeURIComponent(document.documentElement.style.getPropertyValue('--native-select-open-image'))
  // happy-dom caches descendant computed CSS when only ancestor custom properties change.
  // Bind the actual CSS consumer initially; changing painted pixels is proved in private Electron.
  expect(window.getComputedStyle(control).backgroundImage).toBe(document.documentElement.style.getPropertyValue('--native-select-open-image'))
  expect(window.getComputedStyle(control).appearance).toBe('none')
  expect(renderedImage()).toContain(`stroke="${GRAPHITE_THEME.variants.light.colors.text}"`)
  expect(renderedImage()).toContain('m6 9 6 6 6-6')
  await act(async () => { updateThemeSelection({ appAppearance: 'dark' }) })
  expect(renderedImage()).toContain(`stroke="${GRAPHITE_THEME.variants.dark.colors.text}"`)
  expect(document.querySelector('[data-semantic-icon-sprite]')).toBe(sprite); expect(document.getElementById('agentmux-icon-control.select-open')).toBe(symbol)
  const custom = structuredClone(GRAPHITE_THEME); custom.id = 'custom.native-select'; custom.name = 'Native select'
  custom.variants.dark.colors.text = '#aabbcc'
  custom.icons = { 'control.select-open': { kind: 'paths', paths: [{ d: 'M4 4H20V20H4Z', fill: 'currentColor' }] } }
  await act(async () => { expect(previewTheme(custom).applied).toBe(true) })
  expect(renderedImage()).toContain('M4 4H20V20H4Z'); expect(renderedImage()).toContain('color="#aabbcc"')
  expect(document.querySelector('select[aria-label="Original choice"]')).toBe(control)
  expect([...control.options].map(option => option.value)).toEqual(['', 'balanced', 'strict'])
  expect(control.value).toBe('balanced'); expect(control.disabled).toBe(false)
  await act(async () => { control.value = 'strict'; control.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(selected).toHaveBeenCalledOnce(); expect(selected).toHaveBeenCalledWith('original-option', 'strict')
  await dom.render(<LaunchRefine options={[option]} selection={{ 'original-option': 'balanced' }} active expanded disabled onToggle={() => {}} onSelect={selected}/>)
  expect(control.disabled).toBe(true); expect(Number(window.getComputedStyle(control).opacity)).toBe(0.55)
})
