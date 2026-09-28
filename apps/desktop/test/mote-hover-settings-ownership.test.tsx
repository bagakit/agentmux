// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WindowOverlayPortal, OVERLAY_LAYER_BANDS } from '../src/renderer/src/components/WindowOverlayHost'
import { useAppStore } from '../src/renderer/src/store'
import { customAgent, customMoteId, customTab, defaultAgent, savedMoteKey } from './fixtures/mote-workface'
import { createMoteApp, moteClick, motePointer, moteType, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'

let app: MoteAppFixture
beforeEach(() => { app = createMoteApp() })
afterEach(async () => { await app.dispose() })
async function settings() {
  const button = app.container.querySelector<HTMLButtonElement>('footer [aria-label="Settings"]')!
  expect(button).not.toBeNull(); await moteClick(button)
  const page = app.container.querySelector<HTMLElement>('[data-settings-page]')!
  const input = page.querySelector<HTMLInputElement>('[aria-label="Search settings"]')!
  expect(page).not.toBeNull(); expect(input).not.toBeNull()
  await act(async () => { input.focus(); input.setSelectionRange(0, 0) })
  return { page, input }
}
function assertWindowOwnedPanel() {
  const panel = app.panel()
  expect(app.container.querySelectorAll('[data-pmo-teams-topic-floating]')).toHaveLength(1)
  expect(panel.closest('[inert], [aria-hidden="true"]')).toBeNull()
  expect(panel.parentElement?.classList.contains('app-shell')).toBe(true)
}

describe('actual App Mote ownership beside Settings', () => {
  it.each([false, true])('retains the unique original input outside inert workspace with Settings=%s', async openSettings => {
    await app.mount()
    const originalInput = app.container.querySelector<HTMLElement>(`[data-workbench-tab-id="default-tab"] [aria-label="Message Agent"]`)!
    expect(originalInput).not.toBeNull()
    const settingsOwner = openSettings ? await settings() : null
    const focused = document.activeElement, before = useAppStore.getState()
    const stored = window.localStorage.getItem(savedMoteKey)
    const warmCalls = app.warm.mock.calls.length
    await app.hover()
    assertWindowOwnedPanel()
    expect(app.panel().dataset.motePresentation).toBe('preview')
    expect(document.activeElement).toBe(focused)
    expect(window.localStorage.getItem(savedMoteKey)).toBe(stored)
    expect(useAppStore.getState().viewModes).toBe(before.viewModes)
    expect(useAppStore.getState().agentFocus).toBe(before.agentFocus)
    expect(useAppStore.getState().layouts).toBe(before.layouts)
    expect(app.ensureMote).not.toHaveBeenCalled(); expect(app.warm.mock.calls).toHaveLength(warmCalls)
    if (settingsOwner) {
      const workspace = app.container.querySelector('.app-shell__workspace')!
      expect(workspace.hasAttribute('inert')).toBe(true); expect(workspace.getAttribute('aria-hidden')).toBe('true')
      expect(settingsOwner.input.selectionStart).toBe(0)
    }
    await motePointer(app.entry(), 'out'); await motePointer(app.panel(), 'over')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 210)) })
    expect(app.panel().dataset.motePresentation).toBe('preview')
    const input = app.panel().querySelector<HTMLElement>('[aria-label="Message Agent"]')!
    expect(input).toBe(originalInput); expect(input.closest('[inert], [aria-hidden="true"]')).toBeNull()
    await motePointer(input, 'down'); await moteType(input, 'Default Settings-safe unsent')
    expect(app.panel().dataset.motePresentation).toBe('pinned')
    expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default Settings-safe unsent')
    const choice = app.panel().querySelector<HTMLButtonElement>(`[data-mote-topic-id="${customMoteId}"]`)!
    expect(choice).not.toBeNull(); await moteClick(choice)
    expect(app.panel().dataset.moteTargetTab).toBe(customTab.id)
    const customInput = app.panel().querySelector<HTMLElement>('[aria-label="Message Agent"]')!
    expect(customInput).not.toBeNull(); await moteType(customInput, 'Analyst Settings-safe unsent')
    expect(useAppStore.getState().agentComposerDrafts[customAgent.id]).toBe('Analyst Settings-safe unsent')
    expect(useAppStore.getState().agentFocus.execution).toEqual(before.agentFocus.execution)
    expect(useAppStore.getState().layouts).toEqual(before.layouts)
    expect(useAppStore.getState().viewModes).toBe(before.viewModes)
    expect(useAppStore.getState().agentSteerQueues).toBe(before.agentSteerQueues)
    expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled()
    expect(app.stop).not.toHaveBeenCalled(); expect(app.enqueue).not.toHaveBeenCalled()
    await moteClick(app.panel().querySelector<HTMLButtonElement>('[aria-label="Close Mote"]')!)
    if (settingsOwner) expect(app.container.querySelector('[data-settings-page]')).toBe(settingsOwner.page)
    expect(app.container.querySelector(`[data-workbench-tab-id="default-tab"] [aria-label="Message Agent"]`)).toBe(originalInput)
  })

  it('closes only the preview when the original window-chrome Entry owns keyboard focus above Settings', async () => {
    await app.mount(); const { page } = await settings()
    await act(async () => app.entry().focus()); await app.hover()
    const entry = app.entry()
    expect(entry.closest('[data-overlay-layer="window-chrome"]')).not.toBeNull()
    expect(app.panel().dataset.motePresentation).toBe('preview')
    const ime = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, isComposing: true })
    await act(async () => entry.dispatchEvent(ime))
    expect(ime.defaultPrevented).toBe(false)
    expect(app.panel().dataset.motePresentation).toBe('preview')
    expect(app.container.querySelector('[data-settings-page]')).toBe(page)
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    await act(async () => entry.dispatchEvent(escape)); await settleMoteApp()
    expect(escape.defaultPrevented).toBe(true)
    expect(app.panel().dataset.motePresentation).toBe('closed')
    expect(app.container.querySelector('[data-settings-page]')).toBe(page)
    expect(document.activeElement).toBe(entry)
  })

  it('preserves the ordinary content preview and Entry focus during composition Escape', async () => {
    await app.mount(); await act(async () => app.entry().focus()); await app.hover()
    const entry = app.entry(), before = useAppStore.getState()
    const ime = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, isComposing: true })
    await act(async () => entry.dispatchEvent(ime))
    expect(ime.defaultPrevented).toBe(false)
    expect(app.panel().dataset.motePresentation).toBe('preview')
    expect(document.activeElement).toBe(entry)
    expect(useAppStore.getState().agentFocus).toBe(before.agentFocus)
    expect(useAppStore.getState().viewModes).toBe(before.viewModes)
  })

  it('leaves Escape with an actual foreign dialog while the same Mote preview stays open', async () => {
    const foreignEscape = vi.fn((event: React.KeyboardEvent) => { event.preventDefault(); event.stopPropagation() })
    await app.mount(<WindowOverlayPortal layer={OVERLAY_LAYER_BANDS.dialog}>
      <div role="dialog" aria-label="Another actual floating owner"><input aria-label="Foreign input" onKeyDown={foreignEscape} /></div>
    </WindowOverlayPortal>)
    const { page } = await settings(); await app.hover()
    const input = document.querySelector<HTMLInputElement>('[aria-label="Foreign input"]')!
    expect(input).not.toBeNull(); await act(async () => input.focus())
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(foreignEscape).toHaveBeenCalledOnce()
    expect(app.panel().dataset.motePresentation).toBe('preview')
    expect(app.container.querySelector('[data-settings-page]')).toBe(page)
    expect(document.activeElement).toBe(input)
  })
})
