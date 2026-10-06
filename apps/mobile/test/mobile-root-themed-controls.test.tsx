import { act } from 'react'
import { afterEach, expect, it } from 'vitest'
import { GRAPHITE_THEME, previewTheme } from '@agentmux/client-ui/theme'
import { semanticIconHref } from '@agentmux/client-ui/icons'
import { MobileApp } from '../src/MobileApp'
import { createBrowserPlatform } from '../src/platform/browser'
import { button, click, mount, mounted } from './conversation-fixture'
afterEach(async () => { await act(async () => { for (const view of mounted.splice(0)) { view.root.unmount(); view.element.remove() } }); document.body.replaceChildren() })
it('the actual phone root and connection drawer retain actions and semantic references across root icon overrides', async () => {
  const overlay = document.createElement('div'); document.body.append(overlay)
  const view = await mount(<MobileApp client={null} connection={{ state: 'unavailable', message: 'Original Host not connected' }} platform={createBrowserPlatform({ overlayContainer: () => overlay })}/>)
  const open = button(view.element, '连接你的 Mac')
  expect(open.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref('action.menu'))
  const custom = structuredClone(GRAPHITE_THEME); custom.id = 'custom.mobile-root'; custom.name = 'Phone controls'
  custom.icons = { 'action.menu': { kind: 'paths', paths: [{ d: 'M4 4H20V20H4Z' }] }, 'action.close': { kind: 'paths', paths: [{ d: 'M12 3L21 20H3Z' }] } }
  await act(async () => { expect(previewTheme(custom).applied).toBe(true) })
  expect(button(view.element, '连接你的 Mac')).toBe(open)
  expect(document.getElementById(semanticIconHref('action.menu').slice(1))?.querySelector('path')?.getAttribute('d')).toBe('M4 4H20V20H4Z')
  await click(open)
  const close = overlay.querySelector<HTMLButtonElement>('[aria-label="关闭面板"]')!
  expect(close, 'actual phone dialog close').not.toBeNull()
  expect(close.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref('action.close'))
  expect(document.getElementById(semanticIconHref('action.close').slice(1))?.querySelector('path')?.getAttribute('d')).toBe('M12 3L21 20H3Z')
  await click(close)
  expect(overlay.querySelector('[role="dialog"]')).toBeNull()
  expect(button(view.element, '连接你的 Mac')).toBe(open)
})
