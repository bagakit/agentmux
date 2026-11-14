// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as Menu from '../src/renderer/src/components/HoverDropdownMenu'

let root: Root, container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks() })
const opened = 'agentmux:hover-menu-open'
function Menus({ count }: { count: number }) {
  return <>{Array.from({ length: count }, (_, index) => <Menu.Root key={index}><Menu.Trigger>Menu {index}</Menu.Trigger>
    <Menu.Portal><Menu.Content><Menu.Item>Action {index}</Menu.Item></Menu.Content></Menu.Portal></Menu.Root>)}</>
}
function over(element: Element) { element.dispatchEvent(new PointerEvent('pointerover', { pointerType: 'mouse', bubbles: true, cancelable: true, buttons: 0 })) }
it.each([1, 32])('keeps zero closed menu broadcast listeners and one open listener with %i mounted consumers', async count => {
  const add = vi.spyOn(window, 'addEventListener'), remove = vi.spyOn(window, 'removeEventListener')
  function listeners() {
    const changes = [...add.mock.calls.flatMap((call, index) => call[0] === opened ? [{ order: add.mock.invocationCallOrder[index]!, listener: call[1], added: true }] : []),
      ...remove.mock.calls.flatMap((call, index) => call[0] === opened ? [{ order: remove.mock.invocationCallOrder[index]!, listener: call[1], added: false }] : [])].sort((a, b) => a.order - b.order)
    const current = new Set<unknown>()
    for (const change of changes) if (change.added) current.add(change.listener); else current.delete(change.listener)
    return current.size
  }
  await act(async () => root.render(<Menus count={count} />))
  expect(listeners()).toBe(0)
  await act(async () => over(container.querySelector('button')!))
  expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1); expect(listeners()).toBe(1)
  await act(async () => window.dispatchEvent(new window.CustomEvent(opened, { detail: Symbol('external original owner') })))
  expect(document.querySelectorAll('[role="menu"]')).toHaveLength(0); expect(listeners()).toBe(0)
})

it('keeps only the final menu when two original triggers open in one React event batch', async () => {
  await act(async () => root.render(<Menus count={2} />))
  const [first, second] = container.querySelectorAll('button')
  await act(async () => { over(first!); over(second!) })
  const menus = document.querySelectorAll('[role="menu"]')
  expect(menus).toHaveLength(1); expect(menus[0]!.textContent).toBe('Action 1')
})

it('keeps controlled visibility with its original owner after a declined close notification', async () => {
  const change = vi.fn()
  const view = (title: string) => <Menu.Root open onOpenChange={change}><Menu.Trigger>{title}</Menu.Trigger><Menu.Portal><Menu.Content><Menu.Item>Read</Menu.Item></Menu.Content></Menu.Portal></Menu.Root>
  await act(async () => root.render(view('Original')))
  await act(async () => window.dispatchEvent(new window.CustomEvent(opened, { detail: Symbol() })))
  expect(change).toHaveBeenLastCalledWith(false)
  // The owner keeps the controlled menu open. A later render must keep its
  // existing window event contract, without installing closed-menu listeners.
  await act(async () => root.render(view('Original updated')))
  change.mockClear()
  await act(async () => window.dispatchEvent(new window.CustomEvent(opened, { detail: Symbol() })))
  expect(change).toHaveBeenCalledExactlyOnceWith(false)
})

it('reconciles consecutive declined controlled openings without retaining an optimistic listener or open state', async () => {
  const change = vi.fn(), add = vi.spyOn(window, 'addEventListener'), remove = vi.spyOn(window, 'removeEventListener')
  await act(async () => root.render(<Menu.Root open={false} onOpenChange={change}><Menu.Trigger>Original closed owner</Menu.Trigger><Menu.Portal><Menu.Content><Menu.Item>Read</Menu.Item></Menu.Content></Menu.Portal></Menu.Root>))
  const trigger = container.querySelector('button')!
  await act(async () => over(trigger)); await act(async () => over(trigger))
  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect(change.mock.calls).toEqual([[true], [true]])
  expect(add.mock.calls.filter(([type]) => type === opened)).toHaveLength(2)
  expect(remove.mock.calls.filter(([type]) => type === opened)).toHaveLength(2)
  await act(async () => window.dispatchEvent(new window.CustomEvent(opened, { detail: Symbol('another visible owner') })))
  expect(change.mock.calls).toEqual([[true], [true]])
})
