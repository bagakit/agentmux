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
const tailcatRequest = { section: 'network-node', field: 'incoming' } as const

it('routes Node’s connection tabs with their original panel IDs and keyboard focus in the presenting document', async () => {
  const frame = document.createElement('iframe')
  document.body.append(frame)
  const owner = frame.contentDocument!
  const render = async (navigationRequest?: SettingsNavigationRequest, visible = true) => {
    await dom.render(createPortal(
      <WorkbenchDocumentContext.Provider value={{ document: owner, window: null }}>
        <SettingsPanel initialSection="network-node" visible={visible} navigationRequest={navigationRequest} onClose={() => {}} />
      </WorkbenchDocumentContext.Provider>, owner.body))
  }
  try {
    await render({ section: 'network-node', field: 'publishing' })
    const list = owner.querySelector<HTMLElement>('.cluster-node-tabs[role="tablist"]')!
    expect(list).not.toBeNull()
    const [identity, gateway, tailcat, ssh] = Array.from(list.querySelectorAll<HTMLButtonElement>('button[role="tab"]'))
    const panel = (tab: HTMLButtonElement) => owner.getElementById(tab.getAttribute('aria-controls')!)!
    const selected = (tab: HTMLButtonElement) => {
      expect(list.querySelector('[aria-selected="true"]')).toBe(tab)
      expect(tab.tabIndex).toBe(0)
      for (const button of [identity, gateway, tailcat, ssh]) {
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
    selected(identity!)
    expect(panel(gateway!).querySelector('[data-mesh-settings]')).toBeNull()
    const activation = vi.spyOn(gateway!, 'click')
    identity!.focus()
    await press(identity!, 'ArrowRight', { isComposing: true })
    await press(identity!, 'ArrowRight', { ctrlKey: true })
    selected(identity!)
    expect(activation).not.toHaveBeenCalled()
    await press(identity!, 'ArrowRight')
    selected(gateway!)
    expect(activation).toHaveBeenCalledOnce()
    expect(owner.activeElement).toBe(gateway)
    const mounted = panel(gateway!).querySelector('[data-mesh-settings]')
    expect(mounted).not.toBeNull()
    await press(gateway!, 'End')
    selected(ssh!)
    expect(owner.activeElement).toBe(ssh)
    expect(panel(gateway!).querySelector('[data-mesh-settings]')).toBe(mounted)
    await press(ssh!, 'Home')
    selected(identity!)
    expect(owner.activeElement).toBe(identity)
    list.style.direction = 'rtl'
    await press(identity!, 'ArrowLeft')
    selected(gateway!)
    expect(owner.activeElement).toBe(gateway)
    expect(document.getElementById(gateway!.id)).toBeNull()

    await render(tailcatRequest, false)
    selected(gateway!)
    await render(tailcatRequest)
    selected(tailcat!)
    expect(panel(gateway!).querySelector('[data-mesh-settings]')).toBe(mounted)
  } finally {
    await dom.render(null)
    frame.remove()
  }
})

it('Quick keeps an explicit new-work task and opens the same original Session from Continue', async () => {
  const activeTask = () => dom.container.querySelector('[data-cluster-page="quick"]')?.getAttribute('data-quick-view')
  useAppStore.setState({ sessions: [] })
  await dom.render(<SettingsPanel initialSection="remote-execution" onClose={() => {}} />)
  expect(activeTask()).toBe('home')
  await dom.click('[data-quick-task="prepare"]')
  expect(activeTask()).toBe('prepare')
  const mounted = dom.container.querySelector('.agent-work-setup')
  expect(mounted).not.toBeNull()
  const remote = { ...composerSession('device-agent'), hostId: 'remote', workPlacement: { agentHostId: 'remote', resourceHostId: 'local' } }
  await act(async () => { useAppStore.setState({ sessions: [remote] }) })
  expect(activeTask()).toBe('prepare')
  await dom.click('.cluster-journey-nav button')
  await dom.click('[data-quick-task="bindings"]')
  expect(activeTask()).toBe('bindings')
  expect(dom.container.querySelector('[data-resource-row="device-agent"]')).not.toBeNull()
  expect(dom.container.querySelector('.agent-work-setup')).toBe(mounted)
  expect(mounted?.closest('[hidden]')).not.toBeNull()
})
