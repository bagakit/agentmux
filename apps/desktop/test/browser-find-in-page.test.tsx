// @vitest-environment happy-dom
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMuxBrowserControl } from '@agentmux/core'
import type { AppConfig, BrowserFindInPageResult } from '../src/shared/contracts.js'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
})
vi.mock('electron', () => ({ WebContentsView: class {}, app: { getPath: () => tmpdir() } }))

import { BrowserViewManager, BROWSER_FIND_RESULT_TIMEOUT_MS } from '../src/main/browser-view-manager.js'
import { BrowserPane } from '../src/renderer/src/components/BrowserPane.js'
import { api } from '../src/renderer/src/lib/api.js'
import { isMacPlatform } from '../src/renderer/src/lib/host-platform.js'
import { useAppStore } from '../src/renderer/src/store.js'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'

// Main: the actual owner methods with only the native page replaced.
function findOwner(agent = false) {
  let nextRequest = 0
  const contents = Object.assign(new EventEmitter(), {
    findInPage: vi.fn(() => ++nextRequest),
    stopFindInPage: vi.fn(),
    focus: vi.fn()
  })
  const entry = { id: 'original-browser', navigationId: 'original-document', view: { webContents: contents } }
  const owner = Object.assign(Object.create(BrowserViewManager.prototype), {
    require: vi.fn((id: string) => { if (id !== entry.id) throw new Error(`Unknown Browser: ${id}`); return entry }),
    agentOwnsInput: () => agent,
    pendingFinds: new WeakMap()
  }) as BrowserViewManager
  return { contents, entry, owner }
}
const final = (requestId: number, activeMatchOrdinal: number, matches: number) =>
  ({ requestId, activeMatchOrdinal, matches, selectionArea: { x: 0, y: 0, width: 0, height: 0 }, finalUpdate: true })

describe('Main finds in one exact Browser page', () => {
  afterEach(() => vi.useRealTimers())

  it('runs Chromium find on that page and answers with its own final result', async () => {
    const { contents, owner } = findOwner()
    const result = owner.findInPage('original-browser', 'needle', { forward: true, newSession: true })
    expect(contents.findInPage).toHaveBeenCalledExactlyOnceWith('needle', { forward: true, findNext: true, matchCase: false })
    contents.emit('found-in-page', {}, { ...final(1, 1, 9), finalUpdate: false })
    contents.emit('found-in-page', {}, final(7, 4, 4))
    contents.emit('found-in-page', {}, final(1, 2, 5))
    await expect(result).resolves.toEqual({ status: 'found', navigationId: 'original-document', activeMatchOrdinal: 2, matches: 5 })
    expect(contents.listenerCount('found-in-page')).toBe(0)
    const previous = owner.findInPage('original-browser', 'needle', { forward: false, newSession: false })
    expect(contents.findInPage).toHaveBeenLastCalledWith('needle', { forward: false, findNext: false, matchCase: false })
    contents.emit('found-in-page', {}, final(2, 1, 5))
    await expect(previous).resolves.toMatchObject({ activeMatchOrdinal: 1, matches: 5 })
  })

  it('settles a replaced wait at once so waits never pile up, and stop clears the page', async () => {
    const { contents, owner } = findOwner()
    const replaced = owner.findInPage('original-browser', 'n', { forward: true, newSession: true })
    const current = owner.findInPage('original-browser', 'ne', { forward: true, newSession: true })
    await expect(replaced).resolves.toEqual({ status: 'unconfirmed', navigationId: 'original-document' })
    expect(contents.listenerCount('found-in-page')).toBe(1)
    owner.stopFindInPage('original-browser', { focusPage: false })
    await expect(current).resolves.toEqual({ status: 'unconfirmed', navigationId: 'original-document' })
    expect(contents.listenerCount('found-in-page')).toBe(0)
    expect(contents.stopFindInPage).toHaveBeenCalledExactlyOnceWith('clearSelection')
    expect(contents.focus).not.toHaveBeenCalled()
    owner.stopFindInPage('original-browser', { focusPage: true })
    expect(contents.focus).toHaveBeenCalledOnce()
  })

  it('reports an unconfirmed result when the page never finalizes', async () => {
    vi.useFakeTimers()
    const { contents, owner } = findOwner()
    const result = owner.findInPage('original-browser', 'needle', { forward: true, newSession: true })
    await vi.advanceTimersByTimeAsync(BROWSER_FIND_RESULT_TIMEOUT_MS)
    await expect(result).resolves.toEqual({ status: 'unconfirmed', navigationId: 'original-document' })
    expect(contents.listenerCount('found-in-page')).toBe(0)
  })

  it('refuses find and stop while an Agent controls the page, and touches nothing', async () => {
    const { contents, owner } = findOwner(true)
    await expect(owner.findInPage('original-browser', 'needle', { forward: true, newSession: true })).rejects.toMatchObject({ code: 'BROWSER_AGENT_CONTROL_ACTIVE' })
    expect(() => owner.stopFindInPage('original-browser', { focusPage: true })).toThrow(expect.objectContaining({ code: 'BROWSER_AGENT_CONTROL_ACTIVE' }))
    expect(contents.findInPage).not.toHaveBeenCalled()
    expect(contents.stopFindInPage).not.toHaveBeenCalled()
  })
})

// Renderer: the real BrowserPane with Main replaced at the preload boundary.
const config: AppConfig = {
  version: 9,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {},
  workspaces: [],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
}
const tab = {
  id: 'browser-1', navigationId: 'navigation-1', browserId: 'browser-1', regionId: 'region-1', workspaceId: 'workspace-1',
  kind: 'browser' as const, mode: 'normal' as const, profileId: 'profile-1', url: 'https://example.test/', title: 'Example',
  loading: false, canGoBack: true, canGoForward: true, viewport: 'responsive' as const, driving: false, appLinkPrompt: null, error: null
}
const agentControl: AgentMuxBrowserControl = { owner: 'agent', activeOperationId: null, revision: 1, inputIsolation: 'isolated' }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(settle => { resolve = settle })
  return { promise, resolve }
}
const found = (navigationId: string, activeMatchOrdinal: number, matches: number): BrowserFindInPageResult =>
  ({ status: 'found', navigationId, activeMatchOrdinal, matches })

async function mountPane(initial: typeof tab & { control?: AgentMuxBrowserControl } = tab) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const render = (next: typeof tab & { control?: AgentMuxBrowserControl }) => act(async () => root.render(<BrowserPane tab={next} visible />))
  await render(initial)
  const section = () => container.querySelector<HTMLElement>('.browser-surface')!
  const input = () => container.querySelector<HTMLInputElement>('.browser-find input')
  const count = () => container.querySelector('.browser-find__count')?.textContent
  const button = (label: string) => container.querySelector<HTMLButtonElement>(`.browser-find [aria-label="${label}"]`)!
  const openWithKeyboard = () => act(async () => {
    section().querySelector<HTMLElement>('.browser-toolbar button')!.dispatchEvent(new KeyboardEvent('keydown',
      { key: 'f', bubbles: true, cancelable: true, metaKey: isMacPlatform(), ctrlKey: !isMacPlatform() }))
  })
  const type = (value: string) => act(async () => {
    const field = input()!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const key = (init: KeyboardEventInit) => act(async () => { input()!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })) })
  const settle = () => act(async () => {})
  const cleanup = async () => { await act(async () => root.unmount()); container.remove() }
  return { container, render, input, count, button, openWithKeyboard, type, key, settle, cleanup }
}

describe('BrowserPane find row', () => {
  beforeEach(() => { useAppStore.setState({ config: structuredClone(config) }) })
  afterEach(() => vi.restoreAllMocks())

  it('opens from the Browser chord, searches the exact Browser and shows the count', async () => {
    const find = vi.spyOn(api.browser, 'findInPage').mockResolvedValue(found('navigation-1', 2, 5))
    const pane = await mountPane()
    try {
      expect(pane.input(), 'the row is not shown before it is asked for').toBeNull()
      await pane.openWithKeyboard()
      expect(document.activeElement).toBe(pane.input())
      await pane.type('needle')
      expect(find).toHaveBeenCalledExactlyOnceWith('browser-1', 'needle', { forward: true, newSession: true })
      await pane.settle()
      expect(pane.count()).toBe('2/5')
      find.mockResolvedValue(found('navigation-1', 0, 0))
      await pane.type('absent')
      await pane.settle()
      expect(pane.count()).toBe('0 results')
      expect(pane.button('Next match').disabled, 'no match leaves nothing to move to').toBe(true)
      expect(pane.button('Previous match').disabled).toBe(true)
      await pane.key({ key: 'Enter' })
      expect(find, 'Enter still searches again').toHaveBeenLastCalledWith('browser-1', 'absent', { forward: true, newSession: false })
      find.mockResolvedValue({ status: 'unconfirmed', navigationId: 'navigation-1' })
      await pane.type('maybe')
      await pane.settle()
      expect(pane.count(), 'an unconfirmed count is named as a count, not a page status').toBe('? results')
      expect(pane.button('Next match').disabled, 'searching again is the way out of an unconfirmed count').toBe(false)
    } finally { await pane.cleanup() }
  })

  it('opens from the More menu', async () => {
    const pane = await mountPane()
    try {
      const trigger = pane.container.querySelector<HTMLButtonElement>('[aria-label="More browser tools"]')!
      await act(async () => { trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
      const item = [...document.querySelectorAll<HTMLElement>('.browser-menu [role="menuitem"]')].find(node => node.textContent?.trim() === 'Find in page…')
      expect(item, 'the More menu offers Find in page').toBeDefined()
      await act(async () => {
        item!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }))
        item!.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }))
        item!.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }))
      })
      expect(pane.input()).not.toBeNull()
    } finally { await pane.cleanup() }
  })

  it('moves with Enter and Shift+Enter in the same session, and Escape stops, clears and closes', async () => {
    const find = vi.spyOn(api.browser, 'findInPage').mockResolvedValue(found('navigation-1', 1, 3))
    const stop = vi.spyOn(api.browser, 'stopFindInPage').mockResolvedValue()
    const pane = await mountPane()
    try {
      await pane.openWithKeyboard()
      await pane.type('needle')
      await pane.key({ key: 'Enter' })
      expect(find).toHaveBeenLastCalledWith('browser-1', 'needle', { forward: true, newSession: false })
      await pane.key({ key: 'Enter', shiftKey: true })
      expect(find).toHaveBeenLastCalledWith('browser-1', 'needle', { forward: false, newSession: false })
      await pane.key({ key: 'Enter', isComposing: true })
      expect(find, 'an IME confirmation is not a find').toHaveBeenCalledTimes(3)
      await act(async () => pane.button('Previous match').click())
      expect(find).toHaveBeenCalledTimes(4)
      expect(find).toHaveBeenLastCalledWith('browser-1', 'needle', { forward: false, newSession: false })
      await act(async () => pane.button('Next match').click())
      expect(find).toHaveBeenCalledTimes(5)
      expect(find).toHaveBeenLastCalledWith('browser-1', 'needle', { forward: true, newSession: false })
      await pane.key({ key: 'Escape' })
      expect(stop).toHaveBeenCalledExactlyOnceWith('browser-1', { focusPage: true })
      expect(pane.input()).toBeNull()
    } finally { await pane.cleanup() }
  })

  it('never lets a slower answer for an earlier query or document replace the current count', async () => {
    const first = deferred<BrowserFindInPageResult>(), second = deferred<BrowserFindInPageResult>()
    const find = vi.spyOn(api.browser, 'findInPage').mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const pane = await mountPane()
    try {
      await pane.openWithKeyboard()
      await pane.type('n')
      await pane.type('ne')
      await act(async () => second.resolve(found('navigation-1', 1, 1)))
      await act(async () => first.resolve(found('navigation-1', 9, 9)))
      expect(pane.count()).toBe('1/1')

      const late = deferred<BrowserFindInPageResult>()
      find.mockReturnValueOnce(late.promise)
      await pane.key({ key: 'Enter' })
      await pane.render({ ...tab, navigationId: 'navigation-2', loading: true })
      await act(async () => late.resolve(found('navigation-1', 7, 7)))
      expect(pane.count(), 'an answer about the earlier document is void').toBe('1/1')
      find.mockResolvedValue(found('navigation-2', 3, 4))
      await pane.render({ ...tab, navigationId: 'navigation-2' })
      await pane.settle()
      expect(pane.count()).toBe('3/4')
    } finally { await pane.cleanup() }
  })

  it('runs the kept query again once a new document has loaded', async () => {
    const find = vi.spyOn(api.browser, 'findInPage').mockResolvedValue(found('navigation-1', 1, 2))
    const pane = await mountPane()
    try {
      await pane.openWithKeyboard()
      await pane.type('needle')
      expect(find).toHaveBeenCalledOnce()
      find.mockResolvedValue(found('navigation-2', 1, 6))
      await pane.render({ ...tab, navigationId: 'navigation-2', loading: true })
      expect(find, 'a loading document is not searched yet').toHaveBeenCalledOnce()
      await pane.render({ ...tab, navigationId: 'navigation-2', loading: false })
      expect(find).toHaveBeenLastCalledWith('browser-1', 'needle', { forward: true, newSession: true })
      await pane.settle()
      expect(pane.count()).toBe('1/6')
      await pane.render({ ...tab, navigationId: 'navigation-2', loading: true })
      await pane.render({ ...tab, navigationId: 'navigation-2', loading: false })
      expect(find, 'the same document is not searched again').toHaveBeenCalledTimes(2)
    } finally { await pane.cleanup() }
  })

  it('disables the row under Agent control and says to take control first', async () => {
    const find = vi.spyOn(api.browser, 'findInPage')
    const stop = vi.spyOn(api.browser, 'stopFindInPage')
    const pane = await mountPane({ ...tab, control: agentControl })
    try {
      await pane.openWithKeyboard()
      expect(pane.input()!.disabled).toBe(true)
      expect(pane.button('Next match').disabled).toBe(true)
      expect(pane.button('Previous match').disabled).toBe(true)
      expect(pane.count()).toBe('Take control to search')
      await act(async () => pane.button('Close find').click())
      expect(pane.input()).toBeNull()
      expect(find).not.toHaveBeenCalled()
      expect(stop).not.toHaveBeenCalled()
    } finally { await pane.cleanup() }
  })
})
