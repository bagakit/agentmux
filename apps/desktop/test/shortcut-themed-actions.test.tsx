// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GRAPHITE_THEME, mountThemeRuntime, previewTheme } from '@agentmux/client-ui/theme'
import { semanticIconHref } from '@agentmux/client-ui/icons'
import { PROMPT_REACTION_STARTERS } from '@agentmux/core/prompt-reaction'
import type { AppConfig } from '../src/shared/contracts'
import { ShortcutSettingsPane } from '../src/renderer/src/components/settings/ShortcutSettingsPane'
import { composerDOM } from './helpers/composer-dom-fixture'
const dom = composerDOM(); let cleanup: () => void
beforeEach(() => { cleanup = mountThemeRuntime(window) })
afterEach(() => cleanup())
const saved = { id: 'original-prompt', label: 'Original prompt', keyword: 'original', body: 'Keep original authored bytes.\n  Second line.' }
const config = { composerShortcuts: [saved] } as AppConfig
const button = (label: string) => {
  const result = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === label)
  expect(result, `Nonempty production action: ${label}`).toBeDefined(); return result!
}
it('cancels only an unsaved prompt with the cancel role while retaining the saved removal affordance and original data', async () => {
  const save = vi.fn(async () => {})
  await dom.render(<ShortcutSettingsPane config={config} active onSave={save}/>)
  expect(button('Delete prompt').querySelector('use')?.getAttribute('href')).toBe(semanticIconHref('action.remove'))
  await act(async () => button('Add prompt').click())
  const cancel = button('Cancel new prompt')
  expect(cancel.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref('action.cancel'))
  const custom = structuredClone(GRAPHITE_THEME); custom.id = 'custom.prompt-cancel'; custom.name = 'Prompt cancel'
  custom.icons = { 'action.cancel': { kind: 'paths', paths: [{ d: 'M4 4H20V20H4Z' }] } }
  await act(async () => { expect(previewTheme(custom).applied).toBe(true) })
  expect(button('Cancel new prompt')).toBe(cancel)
  expect(document.getElementById(semanticIconHref('action.cancel').slice(1))?.querySelector('path')?.getAttribute('d')).toBe('M4 4H20V20H4Z')
  await act(async () => cancel.click())
  expect([...dom.container.querySelectorAll('[data-prompt-id]')].map(node => node.getAttribute('data-prompt-id'))).toEqual([saved.id])
  expect(dom.container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(saved.body)
  expect(config.composerShortcuts).toEqual([saved]); expect(save).not.toHaveBeenCalled()
})
it('adds quick reply drafts through a distinct action role, preserving selected-state semantics and the actual save payload', async () => {
  const save = vi.fn(async () => {})
  await dom.render(<ShortcutSettingsPane config={config} active onSave={save}/>)
  const add = button('Add quick replies')
  expect(add.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref('action.add-quick-replies'))
  const custom = structuredClone(GRAPHITE_THEME); custom.id = 'custom.prompt-add'; custom.name = 'Prompt add'
  custom.icons = { 'action.add-quick-replies': { kind: 'paths', paths: [{ d: 'M12 3L21 20H3Z' }] }, 'status.selected': { kind: 'paths', paths: [{ d: 'M4 4H20V20H4Z' }] } }
  await act(async () => { expect(previewTheme(custom).applied).toBe(true) })
  expect(document.getElementById(semanticIconHref('action.add-quick-replies').slice(1))?.querySelector('path')?.getAttribute('d')).toBe('M12 3L21 20H3Z')
  expect(dom.container.querySelector('[aria-label="Selected prompt"] use')?.getAttribute('href')).toBe(semanticIconHref('status.selected'))
  await act(async () => add.click())
  expect([...dom.container.querySelectorAll('[data-prompt-id]')].map(node => node.getAttribute('data-prompt-id'))).toEqual([saved.id, ...PROMPT_REACTION_STARTERS.map(prompt => prompt.id)])
  expect(save).not.toHaveBeenCalled(); expect(config.composerShortcuts).toEqual([saved])
  await dom.click('[data-settings-save-bar] button')
  expect(save).toHaveBeenCalledOnce()
  expect(save).toHaveBeenCalledWith([saved, ...PROMPT_REACTION_STARTERS], [saved])
})
