// @vitest-environment happy-dom
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { liquidProductDOM } from '../scripts/fixtures/settings-liquid-motion/product-dom'

const dom = liquidProductDOM()
const lens = () => dom.container.querySelector<HTMLElement>('nav[aria-label="Settings sections"] [data-liquid-selection]')!

describe('Settings liquid selection through the original connected SettingsPanel', () => {
  it('uses one decorative selection surface while native category buttons own the actual selection', async () => {
    await dom.mount('overview')
    const nav = dom.container.querySelector('nav[aria-label="Settings sections"]')!
    const buttons = [...nav.querySelectorAll<HTMLButtonElement>('[data-settings-target]')]
    expect(buttons.length).toBeGreaterThan(1)
    expect(nav.querySelectorAll('[data-liquid-selection]')).toHaveLength(1)
    expect(lens().getAttribute('aria-hidden')).toBe('true')
    expect(lens().dataset.liquidSelection).toBe('overview')
    expect(dom.container.querySelector('[data-settings-pane="prompts"]')).toBeNull()
    const surface = lens()
    for (const id of ['general', 'prompts', 'general']) {
      const button = nav.querySelector<HTMLButtonElement>(`[data-settings-target="${id}"]`)!
      await act(async () => { button.focus(); button.click() })
      expect(button.isConnected).toBe(true)
      expect(document.activeElement).toBe(button)
      expect(button.getAttribute('aria-current')).toBe('page')
      expect(dom.container.querySelector<HTMLElement>('.settings-page')!.dataset.settingsPage).toBe(id)
      expect(lens()).toBe(surface)
      expect(surface.dataset.liquidSelection).toBe(id)
    }
    expect(api.config.save).not.toHaveBeenCalled()
  })

  it('preserves visited drafts and connected input identity when leaving, reducing motion, and returning', async () => {
    await dom.mount()
    const textarea = dom.field('Prompt') as HTMLTextAreaElement
    await dom.fill(textarea, '  中文组字\nexact draft  ')
    await act(async () => {
      textarea.focus()
      textarea.setSelectionRange(2, 4)
      textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '中文' }))
      dom.container.querySelector('nav')!.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 8, clientY: 8 }))
    })
    expect(document.activeElement).toBe(textarea)
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([2, 4])
    await dom.reduce(true)
    expect(lens().dataset.liquidPaused).toBe('true')
    await act(async () => textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' })))
    await dom.click('[data-settings-target="general"]')
    const promptPane = dom.container.querySelector<HTMLElement>('[data-settings-pane="prompts"]')!
    expect(promptPane.hidden).toBe(true)
    await dom.click('[data-settings-target="prompts"]')
    expect(dom.field('Prompt')).toBe(textarea)
    expect(textarea.value).toBe('  中文组字\nexact draft  ')
    expect(promptPane.hidden).toBe(false)
    expect(dom.draft()).toBe('Keep my draft')
    expect(useAppStore.getState().sessions).toHaveLength(1)
    expect(api.config.save).not.toHaveBeenCalled()
  })

  it('does not attach the selected lens to a neighbouring row when search has no target', async () => {
    await dom.mount('general')
    const search = dom.container.querySelector<HTMLInputElement>('[aria-label="Search settings"]')!
    await dom.fill(search, 'nothing-matches-this-proof')
    expect(dom.container.querySelectorAll('nav [data-settings-target]')).toHaveLength(0)
    expect(lens().hidden).toBe(true)
    expect(lens().dataset.liquidPaused).toBe('true')
    expect(lens().dataset.liquidSelection).toBe('general')
    await dom.click('[aria-label="Clear settings search"]')
    expect(document.activeElement).toBe(search)
    expect(lens().dataset.liquidSelection).toBe('general')
    expect(dom.container.querySelectorAll('nav [data-settings-target]').length).toBeGreaterThan(1)
  })
})
