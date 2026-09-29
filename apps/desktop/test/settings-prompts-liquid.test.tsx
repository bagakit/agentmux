// @vitest-environment happy-dom
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { liquidProductDOM, prompts } from '../scripts/fixtures/settings-liquid-motion/product-dom'

const dom = liquidProductDOM()
const host = () => dom.container.querySelector<HTMLElement>('.prompt-library__items')!
const lens = () => host().querySelector<HTMLElement>('[data-liquid-selection]')!
const editor = () => dom.container.querySelector<HTMLElement>('[data-prompt-editor]')!
const status = () => editor().querySelector<HTMLElement>('[data-prompt-status]')!
const row = (id: string) => host().querySelector<HTMLButtonElement>(`[data-prompt-id="${id}"]`)!
const open = async (id: string) => { await act(async () => { row(id).focus(); row(id).click() }) }
const settledSave = async () => {
  await dom.click('[data-settings-save-bar] button')
  for (let attempt = 0; attempt < 100; attempt++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
    if (!dom.container.querySelector('[data-settings-save-bar] [role="status"]')?.textContent?.includes('Saving')) return
  }
  throw new Error('The real ConfigOwner save did not settle')
}

describe('Prompt liquid selection through SettingsPanel, its module and ConfigOwner', () => {
  it('keeps one decorative surface and one native textarea connected across real object selection', async () => {
    await dom.mount()
    expect([...host().querySelectorAll<HTMLElement>('[data-prompt-id]')].map(node => node.dataset.promptId)).toEqual(['one', 'two'])
    expect(host().querySelectorAll('[data-liquid-selection]')).toHaveLength(1)
    const surface = lens(), textarea = dom.field('Prompt')
    expect(surface.getAttribute('aria-hidden')).toBe('true')
    expect(surface.dataset.liquidSelection).toBe('one')
    await open('two')
    expect(document.activeElement).toBe(row('two'))
    expect(row('two').getAttribute('aria-pressed')).toBe('true')
    expect(editor().dataset.promptEditor).toBe('two')
    expect(lens()).toBe(surface)
    expect(surface.dataset.liquidSelection).toBe('two')
    expect(dom.field('Prompt')).toBe(textarea)
    expect(textarea.value).toBe(prompts[1]!.body)
    await open('one')
    expect(dom.field('Prompt')).toBe(textarea)
    expect(textarea.value).toBe(prompts[0]!.body)
    await dom.click('.prompt-editor__remove button')
    expect(dom.field('Prompt')).toBe(textarea)
    expect(editor().dataset.promptEditor).toBe('two')
    await dom.click('.prompt-pending-delete button')
    expect(dom.field('Prompt')).toBe(textarea)
    expect(editor().dataset.promptEditor).toBe('one')
    expect(textarea.value).toBe(prompts[0]!.body)
    expect(api.config.save).not.toHaveBeenCalled()
  })

  it('derives the selected object status from its draft while the whole library remains the save owner', async () => {
    await dom.mount()
    expect(dom.field('Name').closest('label')!.querySelector('span')!.textContent).toBe('Name')
    expect(editor().querySelectorAll('h3')).toHaveLength(0)
    expect(status().dataset.promptStatus).toBe('saved')
    expect(status().textContent).toContain('Saved')
    await dom.fill(dom.field('Name'), 'Current authored title')
    expect(status().dataset.promptStatus).toBe('unsaved')
    expect(status().textContent).toContain('Unsaved')
    await open('two')
    expect(status().dataset.promptStatus).toBe('saved')
    expect(dom.container.querySelector('.prompt-save-summary')!.textContent).toContain('1 changed')
    await dom.fill(dom.field('Prompt'), '   ')
    expect(status().dataset.promptStatus).toBe('invalid')
    expect(status().textContent).toContain('Needs attention')
    expect(dom.field('Prompt').getAttribute('aria-invalid')).toBe('true')
    await dom.fill(dom.field('Prompt'), prompts[1]!.body)
    expect(status().dataset.promptStatus).toBe('saved')
    await open('one')
    expect(status().dataset.promptStatus).toBe('unsaved')
    await settledSave()
    expect(vi.mocked(api.config.save).mock.calls).toHaveLength(1)
    expect(vi.mocked(api.config.save).mock.calls[0]![1]!.composerShortcuts).toEqual(prompts)
    expect((await dom.disk()).composerShortcuts).toEqual([{ ...prompts[0], label: 'Current authored title' }, prompts[1]])
    expect(status().dataset.promptStatus).toBe('saved')
  })

  it('preserves the connected IME editor, exact draft, filter identity and read-only usage during decoration and section changes', async () => {
    await dom.mount()
    const textarea = dom.field('Prompt') as HTMLTextAreaElement
    await dom.fill(textarea, '  中文组字\nexact draft  ')
    await act(async () => {
      textarea.focus(); textarea.setSelectionRange(2, 4)
      textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '中文' }))
      host().dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 12, clientY: 12 }))
      host().dispatchEvent(new Event('scroll'))
    })
    expect(document.activeElement).toBe(textarea)
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([2, 4])
    expect(dom.field('Prompt')).toBe(textarea)
    await act(async () => textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' })))
    const search = dom.container.querySelector<HTMLInputElement>('[aria-label="Search prompts"]')!
    await dom.fill(search, 'Two')
    expect([...host().querySelectorAll<HTMLElement>('[data-prompt-id]')].map(node => node.dataset.promptId)).toEqual(['two'])
    expect(lens().dataset.liquidSelection).toBe('one')
    expect(lens().hidden).toBe(true)
    expect(editor().dataset.promptEditor).toBe('one')
    expect(textarea.value).toBe('  中文组字\nexact draft  ')
    await dom.click('[aria-label="Clear prompt search"]')
    expect(document.activeElement).toBe(search)
    await dom.click('[data-settings-target="general"]')
    expect(dom.container.querySelector<HTMLElement>('[data-settings-pane="prompts"]')!.hidden).toBe(true)
    await dom.click('[data-settings-target="prompts"]')
    expect(dom.field('Prompt')).toBe(textarea)
    expect(textarea.value).toBe('  中文组字\nexact draft  ')
    const usage = editor().querySelector('[aria-label="Usage preview"]')!
    expect(usage.querySelectorAll('button,input,textarea,select')).toHaveLength(0)
    expect(usage.textContent).toContain('/one')
    expect(usage.textContent).toContain('draft')
    expect((await dom.disk()).composerShortcuts).toEqual(prompts)
    expect(dom.draft()).toBe('Keep my draft')
    expect(useAppStore.getState().sessions).toHaveLength(1)
    expect(api.config.save).not.toHaveBeenCalled()
  })

  it('disconnects only the inactive Prompt host observations and reconnects the same visited host on return', async () => {
    // happy-dom has no layout; this fixture supplies only the library's
    // visible box. Actual media-query geometry is checked in Electron.
    const rect = HTMLElement.prototype.getBoundingClientRect
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('prompt-library__items') && !this.closest('[hidden]')) return new DOMRect(0, 0, 220, 400)
      return rect.call(this)
    })
    const listeners = new Map<HTMLElement, Map<string, Set<EventListenerOrEventListenerObject>>>()
    const add = HTMLElement.prototype.addEventListener, remove = HTMLElement.prototype.removeEventListener
    const relevant = new Set(['pointermove', 'pointerleave', 'scroll'])
    const track = (node: HTMLElement, type: string, listener: EventListenerOrEventListenerObject | null, attaching: boolean) => {
      if (!node.classList?.contains('prompt-library__items') || !relevant.has(type) || !listener) return
      if (!listeners.has(node)) listeners.set(node, new Map())
      const byType = listeners.get(node)!
      if (!byType.has(type)) byType.set(type, new Set())
      if (attaching) byType.get(type)!.add(listener)
      else byType.get(type)!.delete(listener)
    }
    vi.spyOn(HTMLElement.prototype, 'addEventListener').mockImplementation(function (this: HTMLElement, type, listener, options) {
      track(this, type, listener, true); add.call(this, type, listener, options)
    })
    vi.spyOn(HTMLElement.prototype, 'removeEventListener').mockImplementation(function (this: HTMLElement, type, listener, options) {
      track(this, type, listener, false); remove.call(this, type, listener, options)
    })
    await dom.mount()
    const original = host()
    const counts = () => ['pointermove', 'pointerleave', 'scroll'].map(type => listeners.get(original)?.get(type)?.size ?? 0)
    expect(counts()).toEqual([1, 1, 1])
    await dom.click('[data-settings-target="general"]')
    expect(host()).toBe(original)
    expect(counts()).toEqual([0, 0, 0])
    expect(lens().dataset.liquidPaused).toBe('true')
    await dom.click('[data-settings-target="prompts"]')
    expect(host()).toBe(original)
    expect(counts()).toEqual([1, 1, 1])
    expect(api.config.save).not.toHaveBeenCalled()
  })
})
