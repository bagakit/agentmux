// @vitest-environment happy-dom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const require = createRequire(join(import.meta.dirname, '../package.json'))
const packageDirectory = dirname(dirname(require.resolve('@radix-ui/react-dropdown-menu')))
const capture = (options?: boolean | AddEventListenerOptions) => options === true || typeof options === 'object' && options.capture === true
let root: Root
let host: HTMLDivElement
let keyCalls = 0
let pointerRegistrations = 0
const keyOwners = new Map<EventListenerOrEventListenerObject, EventListener>()

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  keyCalls = pointerRegistrations = 0
  const add = document.addEventListener.bind(document)
  const remove = document.removeEventListener.bind(document)
  vi.spyOn(document, 'addEventListener').mockImplementation((type, listener, options) => {
    if (type === 'pointerdown' || type === 'pointermove') pointerRegistrations++
    if (type === 'keydown' && capture(options)) {
      let wrapped = keyOwners.get(listener)
      if (!wrapped) {
        wrapped = event => { keyCalls++; typeof listener === 'function' ? listener(event) : listener.handleEvent(event) }
        keyOwners.set(listener, wrapped)
      }
      return add(type, wrapped, options)
    }
    return add(type, listener, options)
  })
  vi.spyOn(document, 'removeEventListener').mockImplementation((type, listener, options) => {
    if (type === 'keydown' && capture(options)) {
      const wrapped = keyOwners.get(listener)
      if (wrapped) { keyOwners.delete(listener); return remove(type, wrapped, options) }
    }
    return remove(type, listener, options)
  })
})

afterEach(async () => {
  await act(async () => root.unmount())
  expect(keyOwners.size, 'The final Root releases the document observation').toBe(0)
  host.remove()
  vi.restoreAllMocks()
})

for (const entry of ['index.mjs', 'index.js']) {
  it(`${entry}: closed menu count does not amplify native keyboard callbacks or pointer registrations`, async () => {
    // Load the real installed entry, including CJS used by Node consumers. This is
    // the same dependency shared by the production Dropdown and Context adapters.
    const file = process.env.AGENTMUX_MENU_COST_PACKAGE
      ? join(process.env.AGENTMUX_MENU_COST_PACKAGE, entry)
      : join(packageDirectory, 'dist', entry)
    const Menu = entry.endsWith('.mjs') ? await import(/* @vite-ignore */ pathToFileURL(file).href) : require(file)
    for (const count of [1, 32, 100]) {
      await act(async () => root.render(<StrictMode>{Array.from({ length: count }, (_, key) =>
        <Menu.Root key={key} open={false}><Menu.Trigger>Menu</Menu.Trigger></Menu.Root>
      )}</StrictMode>))
      expect(keyOwners.size).toBe(1)
      keyCalls = pointerRegistrations = 0
      for (let i = 0; i < 34; i++) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
      expect(keyCalls).toBe(34)
      expect(pointerRegistrations).toBe(68)
      // A partially released cohort must retain the shared observation.
      await act(async () => root.render(<Menu.Root open={false}><Menu.Trigger>Retained</Menu.Trigger></Menu.Root>))
      expect(keyOwners.size).toBe(1)
      keyCalls = 0
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true }))
      expect(keyCalls).toBe(1)
      await act(async () => root.render(null))
      expect(keyOwners.size).toBe(0)
      keyCalls = 0
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }))
      expect(keyCalls).toBe(0)
    }
  })
}

it('Dropdown and Context menus share the same modality owner and preserve keyboard focus and Escape', async () => {
  const Dropdown = await import('@radix-ui/react-dropdown-menu')
  const Context = await import('@radix-ui/react-context-menu')
  const contextAction = vi.fn()
  await act(async () => root.render(<>
    <Dropdown.Root><Dropdown.Trigger>Actions</Dropdown.Trigger><Dropdown.Portal><Dropdown.Content>
      <Dropdown.Item>First action</Dropdown.Item>
      <Dropdown.Sub><Dropdown.SubTrigger>More</Dropdown.SubTrigger><Dropdown.Portal><Dropdown.SubContent><Dropdown.Item>Nested action</Dropdown.Item></Dropdown.SubContent></Dropdown.Portal></Dropdown.Sub>
    </Dropdown.Content></Dropdown.Portal></Dropdown.Root>
    <Context.Root><Context.Trigger id="context-target">Context target</Context.Trigger><Context.Portal><Context.Content><Context.Item onSelect={contextAction}>Context action</Context.Item></Context.Content></Context.Portal></Context.Root>
  </>))
  expect(keyOwners.size).toBe(1)
  const trigger = host.querySelector('button')!
  await act(async () => trigger.focus())
  await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  expect(document.activeElement?.textContent).toBe('First action')
  const sub = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === 'More')!
  await act(async () => sub.focus())
  await act(async () => sub.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  expect(document.activeElement?.textContent).toBe('Nested action')
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect(document.activeElement).toBe(trigger)
  const contextTarget = host.querySelector('#context-target')!
  const openContext = async () => {
    await act(async () => {
      contextTarget.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'mouse', button: 2, buttons: 2, bubbles: true }))
      contextTarget.dispatchEvent(new MouseEvent('contextmenu', { button: 2, clientX: 20, clientY: 20, bubbles: true, cancelable: true }))
    })
    expect(document.querySelector('[role="menu"]')?.textContent).toBe('Context action')
  }
  await openContext()
  await act(async () => document.querySelector('[role="menu"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  expect(document.querySelector('[role="menu"]')).toBeNull()
  await openContext()
  await act(async () => (document.querySelector('[role="menuitem"]') as HTMLElement).click())
  expect(contextAction).toHaveBeenCalledOnce()
  expect(document.querySelector('[role="menu"]')).toBeNull()
})
