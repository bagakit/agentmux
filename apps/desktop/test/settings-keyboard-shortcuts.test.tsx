// @vitest-environment happy-dom
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { buildCheatSheet, formatChord } from '../src/renderer/src/lib/shortcut-cheat-sheet'
import { SHORTCUT_BINDINGS, chordForPlatform } from '../src/renderer/src/lib/shortcut-registry'
import * as platform from '../src/renderer/src/lib/host-platform'
import { liquidProductDOM } from '../scripts/fixtures/settings-liquid-motion/product-dom'
import { api } from '../src/renderer/src/lib/api'

vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
const dom = liquidProductDOM()
const rows = () => [...dom.container.querySelectorAll<HTMLElement>('[data-keyboard-shortcuts] [data-binding-id]')]
const search = (label: string) => dom.container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
async function fill(node: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('read-only shortcuts through connected original SettingsPanel', () => {
  it('registers a real catalog pane and shows every complete registry binding with both platform projections', async () => {
    await dom.render(<SettingsPanel initialSection="keyboard-shortcuts" onClose={() => {}} />)
    expect(SHORTCUT_BINDINGS.length).toBeGreaterThan(0)
    const registryIds = SHORTCUT_BINDINGS.map(binding => binding.id)
    for (const isMac of [true, false]) {
      vi.spyOn(platform, 'isMacPlatform').mockReturnValue(isMac)
      await dom.render(<SettingsPanel initialSection="keyboard-shortcuts" onClose={() => {}} />)
      const found = rows()
      expect(found.length).toBeGreaterThan(0)
      expect(found.map(row => row.dataset.bindingId).sort()).toEqual([...registryIds].sort())
      for (const binding of SHORTCUT_BINDINGS) {
        const row = found.find(row => row.dataset.bindingId === binding.id)!
        expect(row.isConnected).toBe(true)
        expect([...row.querySelectorAll('kbd')].map(key => key.textContent)).toEqual(formatChord(chordForPlatform(binding, isMac), isMac))
      }
    }
    expect(dom.container.querySelector('[data-keyboard-shortcuts] [data-settings-save-bar]')).toBeNull()
    expect(api.config.save).not.toHaveBeenCalled()
  })

  it('title search exposes the whole page; local command/chord queries and empty-state Clear keep connected focus', async () => {
    await dom.mount('overview')
    await fill(search('Search settings'), 'shortcuts')
    expect(dom.container.querySelector<HTMLElement>('.settings-page')!.dataset.settingsPage).toBe('keyboard-shortcuts')
    expect(rows().length).toBeGreaterThan(0)
    expect(rows().map(row => row.dataset.bindingId).sort()).toEqual(SHORTCUT_BINDINGS.map(binding => binding.id).sort())
    const field = search('Find a command or shortcut')
    await fill(field, 'save')
    const expected = buildCheatSheet(platform.isMacPlatform()).flatMap(group => group.rows).filter(row => row.label.toLowerCase().includes('save'))
    expect(expected.length).toBeGreaterThan(0)
    expect(rows().map(row => row.dataset.bindingId)).toEqual(expected.map(row => row.id))
    await fill(field, 'unmatched-command-query')
    expect(rows()).toEqual([])
    await dom.click('[aria-label="Clear shortcut search"]')
    expect(document.activeElement).toBe(field)
    expect(field.isConnected).toBe(true)
    expect(rows().length).toBe(SHORTCUT_BINDINGS.length)
    expect(api.config.save).not.toHaveBeenCalled()
  })

  it('reroutes an already-open Prompt without hidden focus, remounting its textarea, losing draft or writing config', async () => {
    await dom.mount('prompts')
    const textarea = dom.field('Prompt') as HTMLTextAreaElement
    await dom.fill(textarea, 'unwritten 中文 draft')
    await act(async () => { textarea.focus(); textarea.setSelectionRange(3, 7) })
    await dom.render(<SettingsPanel initialSection="keyboard-shortcuts" onClose={() => {}} />)
    const focused = document.activeElement as HTMLElement
    expect(focused).toBe(search('Search settings'))
    expect(focused.isConnected).toBe(true)
    expect(focused.closest('[hidden], [inert]')).toBeNull()
    await dom.click('[data-settings-target="prompts"]')
    expect(dom.field('Prompt')).toBe(textarea)
    expect(textarea.value).toBe('unwritten 中文 draft')
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([3, 7])
    expect(api.config.save).not.toHaveBeenCalled()
  })
})
