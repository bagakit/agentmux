// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { composerDOM } from './helpers/composer-dom-fixture'
import { SettingsNavigation } from '../src/renderer/src/components/SettingsNavigation'
import { WindowUtilityBar } from '../src/renderer/src/components/WindowUtilityBar'
import { ProjectRailToolbar } from '../src/renderer/src/components/ProjectRailToolbar'

const dom = composerDOM()
it('the actual status and rail buttons request the same named Settings section without synthetic keyboard dispatch', async () => {
  const open = vi.fn(), key = vi.fn()
  window.addEventListener('keydown', key)
  try {
    await dom.render(<SettingsNavigation.Provider value={{ open }}><WindowUtilityBar /><ProjectRailToolbar onOpenSettings={open} /></SettingsNavigation.Provider>)
    const buttons = [...dom.container.querySelectorAll<HTMLButtonElement>('[data-shortcut-help-open]')]
    expect(buttons).toHaveLength(2)
    for (const button of buttons) {
      expect(button.tagName).toBe('BUTTON')
      expect(button.disabled).toBe(false)
      expect(button.isConnected).toBe(true)
      await act(async () => { button.focus(); button.click() })
      expect(document.activeElement).toBe(button)
    }
    expect(open.mock.calls).toEqual([['keyboard-shortcuts'], ['keyboard-shortcuts']])
    expect(key).not.toHaveBeenCalled()
  } finally { window.removeEventListener('keydown', key) }
})
