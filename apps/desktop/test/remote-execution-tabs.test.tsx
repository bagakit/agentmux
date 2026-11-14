// @vitest-environment happy-dom
import { act } from 'react'
import { createPortal } from 'react-dom'
import { expect, it, vi } from 'vitest'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import type { SettingsNavigationRequest } from '../src/renderer/src/components/SettingsNavigation'
import { WorkbenchDocumentContext } from '../src/renderer/src/lib/workbench-document'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const workRequest = { section: 'remote-execution', field: 'bindings' } as const

it('routes real Settings tabs with their original IDs and keyboard focus in the presenting document', async () => {
  const frame = document.createElement('iframe')
  document.body.append(frame)
  const owner = frame.contentDocument!
  const render = async (navigationRequest?: SettingsNavigationRequest, visible = true) => {
    await dom.render(createPortal(
      <WorkbenchDocumentContext.Provider value={{ document: owner, window: null }}>
        <SettingsPanel initialSection="remote-execution" visible={visible} navigationRequest={navigationRequest} onClose={() => {}} />
      </WorkbenchDocumentContext.Provider>, owner.body))
  }
  try {
    await render({ section: 'remote-execution', field: 'routes' })
    const list = owner.querySelector<HTMLElement>('.remote-work-tasks[role="tablist"]')!
    expect(list).not.toBeNull()
    const [routes, prepare, work] = Array.from(list.querySelectorAll<HTMLButtonElement>('button[role="tab"]'))
    const panel = (tab: HTMLButtonElement) => owner.getElementById(tab.getAttribute('aria-controls')!)!
    const selected = (tab: HTMLButtonElement) => {
      expect(list.querySelector('[aria-selected="true"]')).toBe(tab)
      expect(tab.tabIndex).toBe(0)
      for (const button of [routes, prepare, work]) {
        expect(panel(button).getAttribute('aria-labelledby')).toBe(button.id)
        expect(panel(button).hidden).toBe(button !== tab)
        expect(button.tabIndex).toBe(button === tab ? 0 : -1)
      }
    }
    const press = async (tab: HTMLButtonElement, key: string, overrides: KeyboardEventInit = {}) => {
      await act(async () => {
        tab.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...overrides }))
      })
    }
    selected(routes!)
    expect(panel(prepare!).querySelector('.agent-work-setup')).toBeNull()
    const activation = vi.spyOn(prepare!, 'click')
    routes!.focus()
    await press(routes!, 'ArrowRight', { isComposing: true })
    await press(routes!, 'ArrowRight', { ctrlKey: true })
    selected(routes!)
    expect(activation).not.toHaveBeenCalled()
    await press(routes!, 'ArrowRight')
    selected(prepare!)
    expect(activation).toHaveBeenCalledOnce()
    expect(owner.activeElement).toBe(prepare)
    const mounted = panel(prepare!).querySelector('.agent-work-setup')
    expect(mounted).not.toBeNull()
    await press(prepare!, 'End')
    selected(work!)
    expect(owner.activeElement).toBe(work)
    expect(panel(prepare!).querySelector('.agent-work-setup')).toBe(mounted)
    await press(work!, 'Home')
    selected(routes!)
    expect(owner.activeElement).toBe(routes)
    list.style.direction = 'rtl'
    await press(routes!, 'ArrowLeft')
    selected(prepare!)
    expect(owner.activeElement).toBe(prepare)
    expect(document.getElementById(prepare!.id)).toBeNull()

    await render(workRequest, false)
    selected(prepare!)
    await render(workRequest)
    selected(work!)
    expect(panel(prepare!).querySelector('.agent-work-setup')).toBe(mounted)
  } finally {
    await dom.render(null)
    frame.remove()
  }
})

it('starts at the work the user can do, and keeps an explicit task selection when a Session appears', async () => {
  const selected = () => dom.container.querySelector('[role="tablist"] [aria-selected="true"]')?.getAttribute('aria-controls')
  const show = async () => dom.render(<SettingsPanel initialSection="remote-execution" onClose={() => {}} />)
  useAppStore.setState({ sessions: [] })
  await show()
  expect(selected()).toMatch(/-start$/u)
  const remote = { ...composerSession('device-agent'), hostId: 'remote', workPlacement: { agentHostId: 'remote', resourceHostId: 'local' } }
  await act(async () => { useAppStore.setState({ sessions: [remote] }) })
  expect(selected()).toMatch(/-start$/u)
  await dom.render(null)
  await show()
  expect(selected()).toMatch(/-existing$/u)
  expect(dom.container.querySelector('[data-resource-row="device-agent"]')).not.toBeNull()
})
