// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserWorkbenchSurface } from '../src/renderer/src/lib/workbench-tabs'

const host = vi.hoisted(() => ({
  start: vi.fn(async () => ({ draft: null })), stop: vi.fn(async () => ({ draft: null })),
  get: vi.fn(async () => ({ draft: null })), importTask: vi.fn(), saveDraft: vi.fn(), saveVersion: vi.fn(), runTask: vi.fn(), stopTask: vi.fn(), locateTask: vi.fn(), returnControl: vi.fn(), reportError: vi.fn(),
  executeControl: vi.fn(async () => ({ operation: 'browser.history', operations: [] }))
}))
vi.mock('../src/renderer/src/lib/api', () => ({ api: {
  browser: { startDemonstration: host.start, stopDemonstration: host.stop, getDemonstration: host.get, getTaskAssets: async () => ({ assets: [], runs: [] }), importTaskAsset: host.importTask,
    saveTaskAssetDraft: host.saveDraft, saveTaskAssetVersion: host.saveVersion, runTaskAsset: host.runTask,
    stopTaskAsset: host.stopTask, locateTaskAssetStep: host.locateTask, returnControl: host.returnControl,
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


describe('versioned tasks in the actual BrowserPane', () => {
  it('consumes retained asset/version/cursor and refuses synthetic edit, locate, run, continue and stop', async () => {
    for (const mock of [host.importTask, host.saveDraft, host.saveVersion, host.runTask, host.stopTask, host.locateTask, host.returnControl]) mock.mockClear()
    const content = { name: 'Retained reviewed task', url: 'https://example.test/', parameters: [], steps: [
      { id: 'task-step-1', kind: 'click' as const, url: 'https://example.test/', reviewed: true,
        target: { role: 'button', name: 'Review preferences', ordinal: 1, count: 1 } }
    ] }
    const taskTab: BrowserWorkbenchSurface = { ...tab, taskAssets: {
      assets: [{ id: 'asset-1', browserId: tab.browserId, sourceRecordingId: 'draft-1', revision: 3, draft: content,
        versions: [{ ...content, version: 1, savedAt: 1 }], createdAt: 1, updatedAt: 2 }],
      runs: [{ id: 'run-1', assetId: 'asset-1', version: 1, browserId: tab.browserId, nextStep: 0,
        status: 'waiting-human', operationIds: ['real-operation-1'], startedAt: 1, updatedAt: 2 }]
    } }
    const element = document.createElement('div'); document.body.append(element)
    const root = createRoot(element)
    try {
      await act(async () => root.render(createElement(BrowserPane, { tab: taskTab, visible: false })))
      const trigger = element.querySelector<HTMLButtonElement>('[aria-label="More browser tools"]')!
      expect(trigger).not.toBeNull()
      await act(async () => trigger.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', buttons: 0 })))
      const open = document.querySelector<HTMLElement>('[aria-label="Open human demonstration draft"]')!
      expect(open).not.toBeNull()
      await act(async () => { open.focus(); open.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
      const editor = element.querySelector<HTMLElement>('[aria-label="Editable Browser task asset"]')!
      expect(editor).not.toBeNull()
      expect(editor.getAttribute('data-task-asset-id')).toBe('asset-1')
      expect(editor.querySelector<HTMLInputElement>('[aria-label="Task asset name"]')?.value).toBe(content.name)
      expect(editor.querySelectorAll('[data-task-step-id]')).toHaveLength(1)
      expect(editor.querySelector('.browser-task-asset__progress')?.getAttribute('data-run-status')).toBe('waiting-human')
      expect(editor.textContent).toContain('Waiting for human checkpoint · next step 1')
      const buttons = [...editor.querySelectorAll<HTMLButtonElement>('button')].filter(button =>
        ['Save draft', 'Save version', 'Run next step', 'Return control and continue', 'Stop task'].includes(button.textContent?.trim() ?? '') || button.getAttribute('aria-label') === 'Locate task step 1')
      expect(buttons).toHaveLength(6)
      for (const button of buttons) { expect(button.disabled).toBe(false); await act(async () => button.click()) }
      expect(host.saveDraft).not.toHaveBeenCalled(); expect(host.saveVersion).not.toHaveBeenCalled()
      expect(host.locateTask).not.toHaveBeenCalled(); expect(host.runTask).not.toHaveBeenCalled()
      expect(host.stopTask).not.toHaveBeenCalled(); expect(host.returnControl).not.toHaveBeenCalled()
    } finally { await act(async () => root.unmount()); element.remove() }
  })
})
