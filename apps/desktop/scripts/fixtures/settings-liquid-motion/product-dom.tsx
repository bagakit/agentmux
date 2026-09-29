import { act } from 'react'
import { beforeEach, vi } from 'vitest'
import { SettingsPanel } from '../../../src/renderer/src/components/SettingsPanel'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { configOwnerFixture } from '../../../test/helpers/config-owner-fixture'
import { composerDOM } from '../../../test/helpers/composer-dom-fixture'

export const prompts = [
  { id: 'one', keyword: 'one', label: 'One', body: 'First instruction.\nSecond paragraph.' },
  { id: 'two', keyword: 'two', label: 'Two', body: 'Review the changes carefully.', providerId: 'codex', states: ['done'] as ['done'] }
]

export function liquidProductDOM() {
  const dom = composerDOM()
  let fixture: Awaited<ReturnType<typeof configOwnerFixture>>
  let reduced = false
  const changes = new Set<EventListenerOrEventListenerObject>()
  beforeEach(async () => {
    reduced = false
    changes.clear()
    const original = window.matchMedia.bind(window)
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => query === '(prefers-reduced-motion: reduce)' ? {
      get matches() { return reduced }, media: query, onchange: null,
      addEventListener: (_type, listener) => { if (listener) changes.add(listener) },
      removeEventListener: (_type, listener) => { if (listener) changes.delete(listener) },
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => true
    } as MediaQueryList : original(query))
    fixture = await configOwnerFixture({ composerShortcuts: prompts })
    const publish = fixture.publish.getMockImplementation()!
    fixture.publish.mockImplementation((saved) => { publish(saved); useAppStore.setState({ config: saved }) })
    useAppStore.setState({ config: fixture.owner.current, providerCatalog: await api.providers.list() })
    vi.spyOn(api.config, 'save').mockImplementation(async (next, expected) => await fixture.owner.edit(expected!, next))
  })
  return {
    ...dom,
    get container() { return dom.container },
    get owner() { return fixture.owner },
    get disk() { return fixture.disk },
    mount: async (section: 'overview' | 'general' | 'prompts' = 'prompts') => dom.render(<SettingsPanel initialSection={section} onClose={() => {}} />),
    reduce: async (value: boolean) => {
      await act(async () => {
        reduced = value
        for (const listener of changes) {
          const event = new Event('change')
          if (typeof listener === 'function') listener(event)
          else listener.handleEvent(event)
        }
      })
    },
    field: (name: string) => [...dom.container.querySelectorAll<HTMLLabelElement>('[data-prompt-editor] label')]
      .find((label) => label.querySelector('span')?.textContent === name)!.querySelector<HTMLInputElement | HTMLTextAreaElement>('input,textarea')!,
    fill: async (node: HTMLInputElement | HTMLTextAreaElement, value: string) => {
      await act(async () => {
        const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
        Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(node, value)
        node.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
  }
}
