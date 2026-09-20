// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserWorkbenchSurface } from '../src/renderer/src/lib/workbench-tabs'

const host = vi.hoisted(() => ({
  start: vi.fn(async () => ({ draft: null })), stop: vi.fn(async () => ({ draft: null })),
  get: vi.fn(async () => ({ draft: null })), reportError: vi.fn(),
  executeControl: vi.fn(async () => ({ operation: 'browser.history', operations: [] }))
}))
vi.mock('../src/renderer/src/lib/api', () => ({ api: {
  browser: { startDemonstration: host.start, stopDemonstration: host.stop, getDemonstration: host.get,
    cancelElementSelection: async () => {}, setAnnotationMarkers: async () => {}, setBounds: async () => {} },
  ui: { getZoomFactor: () => 1 }
} }))
vi.mock('../src/renderer/src/store', () => ({ useAppStore: (selector: (state: unknown) => unknown) => selector({
  applyBrowserEvent: () => {}, executeControl: host.executeControl, reportError: host.reportError,
  setWorkspaceTool: () => {}, saveBrowserBookmark: async () => {}, openFile: async () => {},
  config: { browser: { toolbar: { more: true } } }, toolsOpen: false,
  browserAnnotationsByBrowserId: {}, addBrowserAnnotation: () => {}
}) }))
import { BrowserPane } from '../src/renderer/src/components/BrowserPane'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
const tab: BrowserWorkbenchSurface = {
  kind: 'browser', regionId: 'region-1', workspaceId: 'workspace-1', browserId: 'browser-1', id: 'browser-1',
  navigationId: 'nav-1', profileId: 'profile-1', url: 'https://example.test/', title: 'Preferences', loading: false,
  canGoBack: false, canGoForward: false, viewport: 'responsive', error: null, driving: false, appLinkPrompt: null,
  demonstration: { draft: { id: 'draft-1', browserId: 'browser-1', navigationId: 'nav-1', url: 'https://example.test/',
    status: 'stopped', revision: 2, startedAt: 1, updatedAt: 2, steps: [
      { id: 'step-1', sequence: 1, recordedAt: 2, navigationId: 'nav-1', source: 'native-human', method: 'fillInput',
        url: 'https://example.test/', args: [], inputKey: 'input-1', blockedReason: 'Supply a fresh parameter; no input value was recorded.',
        target: { role: 'text input', name: 'Display name', ordinal: 1, count: 1 } }
    ] } }
}

describe('human demonstration in the actual BrowserPane', () => {
  it('consumes the durable projection through existing details and rejects synthetic start/stop clicks', async () => {
    host.start.mockClear(); host.stop.mockClear(); host.get.mockClear(); host.reportError.mockClear()
    const element = document.createElement('div')
    document.body.append(element)
    const root = createRoot(element)
    try {
      await act(async () => root.render(createElement(BrowserPane, { tab, visible: false })))
      const trigger = element.querySelector<HTMLButtonElement>('[aria-label="More browser tools"]')!
      expect(trigger).not.toBeNull()
      await act(async () => trigger.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', buttons: 0 })))
      const open = document.querySelector<HTMLElement>('[aria-label="Open human demonstration draft"]')!
      expect(open).not.toBeNull()
      await act(async () => { open.focus(); open.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
      expect(host.get).toHaveBeenCalledExactlyOnceWith('browser-1')
      const details = element.querySelector('[aria-label="Human demonstration draft"]')!
      expect(details).not.toBeNull()
      expect(details.querySelectorAll('[data-sequence]')).toHaveLength(1)
      expect(details.textContent).toContain('Display name')
      expect(details.textContent).toContain('input-1')
      const start = details.querySelector<HTMLButtonElement>('[aria-label="Start recording demonstration"]')!
      expect(start).not.toBeNull()
      await act(async () => start.click())
      expect(host.start).not.toHaveBeenCalled()
      const recording: BrowserWorkbenchSurface = { ...tab, demonstration: { draft: { ...tab.demonstration!.draft!, status: 'recording' } } }
      await act(async () => root.render(createElement(BrowserPane, { tab: recording, visible: false })))
      const stop = element.querySelector<HTMLButtonElement>('[aria-label="Stop recording demonstration"]')!
      expect(stop).not.toBeNull()
      await act(async () => stop.click())
      expect(host.stop).not.toHaveBeenCalled()
      expect(host.reportError).not.toHaveBeenCalled()
    } finally { await act(async () => root.unmount()); element.remove() }
  })
})
