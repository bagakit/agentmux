// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createClientUiRoot } from './helpers/client-ui-render'
import { getWindowOverlayHost, resolveOverlayContainer } from '../src/renderer/src/components/WindowOverlayHost'
import { OpenDestinationBar } from '../src/renderer/src/components/OpenDestinationBar'

beforeEach(() => { document.body.replaceChildren() })
afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren() })

describe('window overlay host ownership', () => {
  it('resolves one host without scanning unrelated retained workbench descendants', () => {
    const workbench = document.createElement('main')
    workbench.id = 'root'
    for (let index = 0; index < 1000; index++) workbench.appendChild(document.createElement('span'))
    document.body.appendChild(workbench)
    const query = vi.spyOn(document, 'querySelector')
    const queryAll = vi.spyOn(document, 'querySelectorAll')
    const lookup = vi.spyOn(document, 'getElementById')
    const first = resolveOverlayContainer() as HTMLElement
    const persistent = first.parentElement!
    expect(persistent.parentElement).toBe(document.body)
    expect(first.hasAttribute('data-overlay-host')).toBe(true)
    expect(first.classList.contains('window-overlay-host')).toBe(true)
    expect(first.id).not.toBe('')
    for (let index = 0; index < 50; index++) expect(resolveOverlayContainer()).toBe(first)
    expect(getWindowOverlayHost()).toBe(first)
    expect(lookup).toHaveBeenCalledTimes(52)
    expect(query).not.toHaveBeenCalled()
    expect(queryAll).not.toHaveBeenCalled()
    expect(Array.from(document.body.children)).toEqual([workbench, persistent])
  })

  it('recreates a removed host and routes custom containers without resolving the default', () => {
    const first = resolveOverlayContainer() as HTMLElement
    first.remove()
    const recreated = resolveOverlayContainer() as HTMLElement
    expect(recreated).not.toBe(first)
    expect(recreated.id).toBe(first.id)
    expect(recreated.parentElement?.parentElement).toBe(document.body)
    expect(Array.from(document.body.children)).toEqual([recreated.parentElement])
    const lookup = vi.spyOn(document, 'getElementById')
    const custom = document.createDocumentFragment()
    expect(resolveOverlayContainer(custom)).toBe(custom)
    expect(lookup).not.toHaveBeenCalled()
  })

  function observePopover(host: HTMLElement) {
    let shown = false
    const matches = host.matches.bind(host)
    vi.spyOn(host, 'matches').mockImplementation(selector => selector === ':popover-open' ? shown : matches(selector))
    const show = vi.fn(() => { shown = true }), hide = vi.fn(() => { shown = false })
    Object.defineProperties(host, { showPopover: { configurable: true, value: show }, hidePopover: { configurable: true, value: hide } })
    return { show, hide }
  }
  const mutationsDelivered = () => new Promise(resolve => setTimeout(resolve, 0))

  it('a real destination toolbar focus hint preserves its already shown menu host instead of interrupting the pending pointer gesture', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const host = getWindowOverlayHost()!, popover = observePopover(host)
    const menu = document.createElement('div'); menu.setAttribute('role', 'menu'); host.append(menu)
    const root = createClientUiRoot(menu)
    try {
      await act(async () => { root.render(createElement(OpenDestinationBar, { canSplit: true, onSelect: vi.fn() })); await mutationsDelivered() })
      expect(popover.show).toHaveBeenCalledOnce()
      const destination = menu.querySelector<HTMLButtonElement>('[data-destination="right"]')!
      // Native pointerdown focuses this real button before pointerup can click it.
      // WorkbenchActionRows discloses its actual tooltip from this focus event.
      await act(async () => { destination.focus(); await mutationsDelivered() })
      expect(host.querySelector('[role="tooltip"]')?.textContent).toBe('Open in a split on the right')
      expect(document.activeElement).toBe(destination)
      expect(popover.hide).not.toHaveBeenCalled()
      expect(popover.show).toHaveBeenCalledOnce()
    } finally { await act(async () => root.unmount()) }
  })

  it('a standalone tooltip still shows while newer menus and dialogs retain top layer promotion', async () => {
    const host = getWindowOverlayHost()!, popover = observePopover(host)
    const tooltip = document.createElement('div'); tooltip.setAttribute('role', 'tooltip'); host.append(tooltip)
    await mutationsDelivered()
    expect(popover.show).toHaveBeenCalledOnce()
    expect(popover.hide).not.toHaveBeenCalled()
    const menu = document.createElement('div'); menu.setAttribute('role', 'menu'); host.append(menu)
    await mutationsDelivered()
    expect(popover.show).toHaveBeenCalledTimes(2)
    expect(popover.hide).toHaveBeenCalledOnce()
    const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog'); host.append(dialog)
    await mutationsDelivered()
    expect(popover.show).toHaveBeenCalledTimes(3)
    expect(popover.hide).toHaveBeenCalledTimes(2)
    menu.remove(); dialog.remove()
    await mutationsDelivered()
    expect(host.matches(':popover-open')).toBe(true)
    tooltip.remove()
    await mutationsDelivered()
    expect(popover.hide).toHaveBeenCalledTimes(3)
    expect(host.matches(':popover-open')).toBe(false)
  })
})
