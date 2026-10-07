import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { GRAPHITE_THEME, mountThemeRuntime, previewTheme } from '@agentmux/client-ui/theme'
import { semanticIconHref } from '@agentmux/client-ui/icons'
import { MobilePrimaryNavigation } from '../src/navigation/MobilePrimaryNavigation'
let host: HTMLDivElement, root: Root, release: () => void
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); host = document.createElement('div'); document.body.append(host); root = createRoot(host); release = mountThemeRuntime(window) })
afterEach(async () => { await act(async () => root.unmount()); release(); host.remove(); vi.unstubAllGlobals() })
it('phone workfaces use the same exact destination roles as Desktop, preserve selection and isolate user overrides', async () => {
  const select = vi.fn()
  await act(async () => root.render(<MobilePrimaryNavigation current="focus" onSelect={select} />))
  for (const [id, role] of [['space', 'navigation.space'], ['focus', 'navigation.focus'], ['goals', 'navigation.goals']] as const) {
    const button = host.querySelector<HTMLButtonElement>(`[data-workface="${id}"]`)!
    expect(button, 'nonempty phone navigation consumer').not.toBeNull()
    expect(button.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref(role))
    expect(button.querySelector('[data-icon-animation]')).toBeNull()
    const theme = structuredClone(GRAPHITE_THEME); theme.id = 'custom.phone-destinations'; theme.name = 'Phone destinations'
    theme.icons = { [role]: { kind: 'paths', paths: [{ d: 'M3 5H21V19H3Z' }] } }
    await act(async () => { expect(previewTheme(theme).applied).toBe(true) })
    expect(host.querySelector(`[data-workface="${id}"]`)).toBe(button)
    expect(document.getElementById(semanticIconHref(role).slice(1))?.querySelector('path')?.getAttribute('d')).toBe('M3 5H21V19H3Z')
    expect(document.getElementById(semanticIconHref('object.topic').slice(1))?.querySelector('path')?.getAttribute('d')).not.toBe('M3 5H21V19H3Z')
    await act(async () => button.click()); expect(select).toHaveBeenLastCalledWith(id)
  }
  expect(select).toHaveBeenCalledTimes(3)
  expect(host.querySelector('[data-workface="focus"]')?.getAttribute('aria-current')).toBe('page')
  expect(host.querySelectorAll('button')).toHaveLength(5)
})
