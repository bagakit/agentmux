// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getWindowOverlayHost } from '../src/renderer/src/components/WindowOverlayHost'
import { SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID } from '../src/shared/scratch-topics'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { requestPmoTeamsTopicFloatingOpen } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { createMoteApp, moteClick, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { defaultTab, defaultAgent } from './fixtures/mote-workface'

let app: MoteAppFixture
beforeEach(() => { app = createMoteApp() })
afterEach(async () => { await app.dispose() })
async function openFloat() {
  useAppStore.setState({ activeWorkspaceId: 'project', mainSurface: 'board' })
  await app.mount()
  await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: defaultTab.id }))
  await settleMoteApp()
}
function dialog() { const node = document.querySelector<HTMLElement>('.confirmation-dialog'); expect(node).not.toBeNull(); return node! }
function button(text: string) { const node = [...dialog().querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text); expect(node).not.toBeUndefined(); return node! }

describe('mounted original floating actions and generic overlay owner', () => {
  it('promotes a new Stop confirmation without stopping, moving, or closing its invoker; Cancel preserves the original draft', async () => {
    await openFloat()
    const original = useAppStore.getState(), host = getWindowOverlayHost()!
    const show = vi.spyOn(host, 'showPopover'), hide = vi.spyOn(host, 'hidePopover')
    await moteClick(app.panel().querySelector<HTMLElement>('[aria-label="Close Ship the target goal"]')!)
    expect(dialog().textContent).toContain('Stop Agent Session?')
    expect(host.matches(':popover-open')).toBe(true)
    expect(show).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(button('Cancel'))
    expect(app.panel().matches(':popover-open')).toBe(true)
    expect(app.stop).not.toHaveBeenCalled()
    await act(async () => useAppStore.setState({ agentNames: { unrelated: 'Unrelated output' } }))
    await settleMoteApp()
    expect(show).toHaveBeenCalledTimes(1)
    await moteClick(button('Cancel'))
    expect(document.querySelector('.confirmation-dialog')).toBeNull()
    expect(host.matches(':popover-open')).toBe(false)
    expect(hide).toHaveBeenCalledTimes(1)
    expect(app.panel().matches(':popover-open')).toBe(true)
    expect(useAppStore.getState().tabs).toBe(original.tabs)
    expect(useAppStore.getState().agentComposerDrafts).toBe(original.agentComposerDrafts)
    expect(useAppStore.getState().viewModes).toBe(original.viewModes)
    expect(app.stop).not.toHaveBeenCalled()
  })

  it.each([['Keep Session & Close', true], ['Stop & Close', false]] as const)('routes %s to the exact original Tab while the background Project stays selected', async (label, keep) => {
    await openFloat()
    const original = useAppStore.getState()
    const close = vi.spyOn(useAppStore.getState(), 'closeTab')
    const stop = vi.spyOn(api.sessions, 'stop').mockResolvedValue(undefined)
    await moteClick(app.panel().querySelector<HTMLElement>('[aria-label="Close Ship the target goal"]')!)
    await moteClick(button(label))
    expect(close.mock.calls).toEqual([[SCRATCH_WORKSPACE_ID, 'mote-group', defaultTab.id, { keepAgentSessions: keep }]])
    expect(useAppStore.getState().activeWorkspaceId).toBe('project')
    expect(useAppStore.getState().mainSurface).toBe('board')
    expect(useAppStore.getState().sessions).toBe(original.sessions)
    expect(useAppStore.getState().tabs[defaultTab.id]).toBeUndefined()
    expect(stop.mock.calls).toEqual(keep ? [] : [[original.sessions.find(item => item.id === defaultAgent.id)!.control]])
  })

  it('keeps ordinary mounted window chrome without promoting it on status or text changes', async () => {
    await app.mount()
    const host = getWindowOverlayHost()!, show = vi.spyOn(host, 'showPopover')
    const footer = document.createElement('div'); footer.dataset.overlayLayer = 'window-chrome'
    footer.innerHTML = '<button data-state="open">Footer</button>'
    await act(async () => { host.append(footer) })
    await act(async () => { footer.querySelector('button')!.textContent = 'Working'; footer.append(document.createElement('span')) })
    expect(footer.parentElement).toBe(host)
    expect(footer.textContent).toBe('Working')
    expect(show).not.toHaveBeenCalled()
    footer.remove()
  })
  it('lets the topmost confirmation consume Escape and returns focus to the retained original input', async () => {
    await openFloat()
    const input = app.panel().querySelector<HTMLElement>('[aria-label="Message Agent"]')!
    await act(async () => input.focus())
    await moteClick(app.panel().querySelector<HTMLElement>('[aria-label="Close Ship the target goal"]')!)
    await act(async () => button('Cancel').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    await settleMoteApp()
    expect(document.querySelector('.confirmation-dialog')).toBeNull()
    expect(app.panel().matches(':popover-open')).toBe(true)
    expect(document.activeElement).toBe(input)
    expect(useAppStore.getState().tabs[defaultTab.id]).not.toBeUndefined()
  })
})
