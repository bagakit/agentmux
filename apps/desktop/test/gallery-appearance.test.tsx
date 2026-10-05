// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkflowComponentGallery } from '../src/renderer/src/components/WorkflowComponentGallery'
import { APP_APPEARANCE_IDS } from '../src/shared/contracts'

// Isolate Gallery's theme lifecycle; the actual controls and appearance owner remain in this test.
vi.mock('../src/renderer/src/components/ObservationSurfaceGallery', () => ({ ObservationSurfaceGallery: () => null }))
vi.mock('../src/renderer/src/components/workflow', () => ({ WorkflowCard: () => null, WorkflowDock: () => null, WorkflowToolRow: () => null }))

let container: HTMLDivElement, root: Root, dark: boolean
let listeners: Set<() => void>
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  dark = false; listeners = new Set()
  vi.spyOn(window, 'matchMedia').mockImplementation(query => ({
    media: query, get matches() { return dark }, onchange: null,
    addEventListener: (_event, listener) => { listeners.add(listener as () => void) },
    removeEventListener: (_event, listener) => { listeners.delete(listener as () => void) },
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false
  }))
  delete document.documentElement.dataset.appearance
  document.documentElement.style.colorScheme = ''
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals()
  delete document.documentElement.dataset.appearance; document.documentElement.style.colorScheme = ''
})
async function render() { await act(async () => root.render(createElement(WorkflowComponentGallery))) }
async function select(label: string) {
  const button = [...container.querySelectorAll<HTMLButtonElement>('.wf-gallery__theme button')].find(element => element.textContent === label)
  expect(button).toBeDefined(); await act(async () => button!.click())
}
async function changeSystem(prefersDark: boolean) {
  expect(listeners.size).toBe(1)
  await act(async () => { dark = prefersDark; for (const listener of listeners) listener() })
}

describe('Gallery consumes the application appearance owner', () => {
  it('uses the shared choices, follows system changes and releases the actual listener', async () => {
    await render()
    expect(container.querySelectorAll('.wf-gallery__theme button')).toHaveLength(APP_APPEARANCE_IDS.length)
    expect(container.querySelector('.wf-gallery__intro-mark use')?.getAttribute('href')).toBe('#agentmux-icon-object.workflow')
    const icons = [...container.querySelectorAll<SVGElement>('[data-semantic-icon]')]
    expect(icons.length).toBeGreaterThan(5)
    for (const icon of icons) {
      const href = icon.querySelector('use')?.getAttribute('href')
      expect(href, icon.dataset.semanticIcon).toMatch(/^#agentmux-icon-/)
      expect(document.getElementById(href!.slice(1))?.childElementCount).toBeGreaterThan(0)
    }
    expect(document.documentElement.dataset.appearance).toBe('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')
    await select('跟随系统')
    expect(document.documentElement.dataset.appearance).toBe('light')
    expect(document.documentElement.style.colorScheme).toBe('light')
    await changeSystem(true)
    expect(document.documentElement.dataset.appearance).toBe('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')
    await changeSystem(false)
    expect(document.documentElement.dataset.appearance).toBe('light')
    await act(async () => root.unmount())
    expect(listeners.size).toBe(0)
  })

  it('keeps an explicit choice when the system changes and has one listener across switches', async () => {
    await render(); await select('跟随系统'); await select('浅色'); await changeSystem(true)
    expect(document.documentElement.dataset.appearance).toBe('light')
    expect(document.documentElement.style.colorScheme).toBe('light')
    await select('深色'); await changeSystem(false)
    expect(document.documentElement.dataset.appearance).toBe('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')
  })
})
