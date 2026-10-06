import { act } from 'react'
import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { GRAPHITE_THEME, mountThemeRuntime, previewTheme } from '@agentmux/client-ui/theme'
import { MobileApp } from '../src/MobileApp'
import { createBrowserPlatform } from '../src/platform/browser'
import { click, mount, mounted } from './conversation-fixture'
const require = createRequire(import.meta.url)
const postcss = createRequire(realpathSync(require.resolve('vite/package.json')))('postcss')
const css = postcss.parse(readFileSync(require.resolve('../src/mobile.css'), 'utf8'))
function declaration(selector: string, property: string): string | undefined {
  const matches: string[] = []
  css.walkRules(selector, (rule: any) => rule.walkDecls(property, (decl: any) => matches.push(decl.value)))
  return matches.at(-1)
}
let cleanup: () => void
beforeEach(() => { cleanup = mountThemeRuntime(window) })
afterEach(async () => { await act(async () => { for (const view of mounted.splice(0)) { view.root.unmount(); view.element.remove() } }); cleanup(); document.body.replaceChildren() })
it('the actual phone connection fact selects distinct themed masks in the original 5px status slot', async () => {
  expect(declaration('.mobile-status-dot', 'width')).toBe('5px')
  expect(declaration('.mobile-status-dot', 'height')).toBe('5px')
  expect(declaration('.mobile-status-dot', 'mask')).toBe('var(--native-connection-unconfirmed-mask) center / contain no-repeat')
  expect(declaration("[data-connection='connected'] .mobile-status-dot", 'mask-image')).toBe('var(--native-connection-connected-mask)')
  expect(declaration('.mobile-status-dot', 'border-radius')).toBeUndefined()
  const overlay = document.createElement('div'); document.body.append(overlay)
  const platform = createBrowserPlatform({ overlayContainer: () => overlay })
  const view = await mount(<MobileApp client={null} connection={{ state: 'unavailable', message: 'Original connection observation unavailable' }} platform={platform}/>)
  const button = view.element.querySelector<HTMLButtonElement>('.mobile-settings-button')!
  const marker = button.querySelector('.mobile-status-dot')!
  expect(marker.getAttribute('aria-label')).toBe('尚未连接')
  const root = document.documentElement.style
  const before = root.getPropertyValue('--native-connection-unconfirmed-mask')
  expect(before).toContain('data:image/svg+xml')
  const custom = structuredClone(GRAPHITE_THEME); custom.id = 'custom.phone-connection'; custom.name = 'Phone connection glyphs'
  custom.icons = { 'status.connection-unconfirmed': { kind: 'paths', paths: [{ d: 'M12 3L21 20H3Z', fill: 'currentColor' }] }, 'status.connection-connected': { kind: 'paths', paths: [{ d: 'M4 4H20V20H4Z', fill: 'currentColor' }] } }
  await act(async () => { expect(previewTheme(custom).applied).toBe(true) })
  expect(decodeURIComponent(root.getPropertyValue('--native-connection-unconfirmed-mask'))).toContain('M12 3L21 20H3Z')
  expect(decodeURIComponent(root.getPropertyValue('--native-connection-connected-mask'))).toContain('M4 4H20V20H4Z')
  expect(root.getPropertyValue('--native-connection-unconfirmed-mask')).not.toBe(before)
  const originalRecord = localStorage.getItem('agentmux-mobile-workface-v1')
  for (const [state, label] of [['connecting', '连接中'], ['disconnected', '连接中断'], ['connected', '已连接']] as const) {
    await view.render(<MobileApp client={null} connection={{ state, message: 'Original connection fact' }} platform={platform}/>)
    expect(view.element.querySelector('[data-connection]')?.getAttribute('data-connection')).toBe(state)
    expect(button.querySelector('.mobile-status-dot')).toBe(marker)
    expect(marker.getAttribute('aria-label')).toBe(label)
    expect(button.disabled).toBe(false)
  }
  await click(button)
  expect(overlay.querySelector('[role="dialog"]')).not.toBeNull()
  await click(overlay.querySelector('[aria-label="关闭面板"]')!)
  expect(overlay.querySelector('[role="dialog"]')).toBeNull()
  expect(localStorage.getItem('agentmux-mobile-workface-v1')).toBe(originalRecord)
})
