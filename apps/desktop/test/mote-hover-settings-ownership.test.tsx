// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WindowOverlayPortal, OVERLAY_LAYER_BANDS } from '../src/renderer/src/components/WindowOverlayHost'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { originalTopicAddress } from '../src/shared/space-addresses'
import { customAgent, customMoteId, customTab, defaultAgent, defaultTab, moteTopics, savedMoteKey, scratchWorkspace } from './fixtures/mote-workface'
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
function originalMoteMains() {
  const mains = [defaultTab, customTab].map((tab, index) => ({
    target: { ...originalTopicAddress(scratchWorkspace, moteTopics[index]!, {})!, expectedResource: {
      hostId: scratchWorkspace.hostId, workspaceId: scratchWorkspace.id, workspacePath: scratchWorkspace.path } },
    topic: moteTopics[index]!,
    current: { hostId: scratchWorkspace.hostId, sessionId: index ? customAgent.id : defaultAgent.id,
      displayWorkspaceId: scratchWorkspace.id, groupId: 'mote-group', tabId: tab.id, regionId: tab.layout.activeRegionId }
  }))
  // A retained Agent tab alone is not evidence that it is the Mote's current Main.
  // Supply that original role-owner observation before asserting its input ownership.
  vi.spyOn(api.moteDialogue, 'read').mockImplementation(async ({ target }) => {
    const main = mains.find(main => JSON.stringify(main.target) === JSON.stringify(target))
    expect(main).toBeDefined()
    return { main: { target, identity: { hostId: scratchWorkspace.hostId, moteId: main!.topic.id },
      status: 'ready', resource: null, documentRevision: 'original-document', roleRevision: 'original-role-' + main!.current.sessionId,
      current: main!.current, issue: null }, links: [], incarnation: 'original-links', throughSequence: 0,
      next: null, coverage: 'linked-sources-only', sourceStatus: 'read', sourceIssue: null }
  })
}

describe('actual App Mote ownership beside Settings', () => {
  it.each([false, true])('retains each exact input owner outside inert workspace with Settings=%s', async openSettings => {
    originalMoteMains()
    await app.mount()
    const originalInput = app.container.querySelector<HTMLElement>(`[data-workbench-tab-id="default-tab"] [aria-label="Message Agent"]`)!
    expect(originalInput).not.toBeNull()
    await vi.waitFor(() => expect(originalInput.closest('[hidden], [inert], [aria-hidden="true"]')).toBeNull())
    await act(async () => {
      originalInput.focus()
      const text = originalInput.querySelector('p')!.firstChild!
      const range = document.createRange(); range.setStart(text, 2); range.setEnd(text, 7)
      document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range)
    })
    const originalSelection = document.getSelection()!.getRangeAt(0).cloneRange()
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
    const previewInput = app.panel().querySelector<HTMLElement>('[aria-label="Message Agent"]')!
    expect(previewInput).not.toBeNull()
    if (settingsOwner) expect(previewInput).toBe(originalInput)
    else {
      // Both visible presentations keep their own tree. Hover must not steal
      // the Workspace's editing primary to replace the floating secondary.
      expect(previewInput).not.toBe(originalInput)
      expect(app.container.querySelector(`[data-workbench-tab-id="default-tab"] [aria-label="Message Agent"]`)).toBe(originalInput)
      expect(originalInput.closest('[hidden], [inert], [aria-hidden="true"]')).toBeNull()
      const selection = document.getSelection()!.getRangeAt(0)
      expect(selection.startContainer).toBe(originalSelection.startContainer); expect(selection.startOffset).toBe(2)
      expect(selection.endContainer).toBe(originalSelection.endContainer); expect(selection.endOffset).toBe(7)
    }
    if (settingsOwner) {
      const workspace = app.container.querySelector('.app-shell__workspace')!
      expect(workspace.hasAttribute('inert')).toBe(true); expect(workspace.getAttribute('aria-hidden')).toBe('true')
      expect(settingsOwner.input.selectionStart).toBe(0)
    }
    await motePointer(app.entry(), 'out'); await motePointer(app.panel(), 'over')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 210)) })
    expect(app.panel().dataset.motePresentation).toBe('preview')
    const input = app.panel().querySelector<HTMLElement>('[aria-label="Message Agent"]')!
    expect(input).toBe(previewInput); expect(input.closest('[hidden], [inert], [aria-hidden="true"]')).toBeNull()
    expect(input.closest('[data-workbench-region-id]')?.getAttribute('data-workbench-region-id')).toBe(defaultTab.layout.activeRegionId)
    expect(input.closest('[data-workbench-tab-id]')?.getAttribute('data-workbench-tab-id')).toBe(defaultTab.id)
    expect(input.closest('.agent-surface')?.querySelector('[data-activity-session]')?.getAttribute('data-activity-session')).toBe(defaultAgent.id)
    await motePointer(input, 'down'); await moteType(input, 'Default Settings-safe unsent')
    expect(app.panel().dataset.motePresentation).toBe('pinned')
    expect(app.panel().querySelector('[aria-label="Message Agent"]')).toBe(input)
    expect(document.activeElement).toBe(input)
    expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default Settings-safe unsent')
    const text = input.querySelector('p')!.firstChild!
    await act(async () => {
      const range = document.createRange(); range.setStart(text, 2); range.setEnd(text, 7)
      document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range)
    })
    await motePointer(input, 'out'); await motePointer(app.panel(), 'over'); await settleMoteApp()
    expect(app.panel().querySelector('[aria-label="Message Agent"]')).toBe(input)
    expect(input.closest('[hidden], [inert], [aria-hidden="true"]')).toBeNull()
    const selection = document.getSelection()!.getRangeAt(0)
    expect(selection.startContainer).toBe(text); expect(selection.startOffset).toBe(2)
    expect(selection.endContainer).toBe(text); expect(selection.endOffset).toBe(7)
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
    expect(useAppStore.getState().sessions).toBe(before.sessions)
    expect(useAppStore.getState().sessions.find(session => session.id === defaultAgent.id)?.control).toBe(defaultAgent.control)
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
