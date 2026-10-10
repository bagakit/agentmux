// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createPortal } from 'react-dom'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const require = createRequire(join(import.meta.dirname, '../package.json'))
const dropdownDirectory = dirname(dirname(require.resolve('@radix-ui/react-dropdown-menu')))
let root: Root
let home: HTMLDivElement
let frame: HTMLIFrameElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  home = document.createElement('div')
  frame = document.createElement('iframe')
  document.body.append(home, frame)
  root = createRoot(home)
})
afterEach(async () => {
  await act(async () => root.unmount())
  frame.remove()
  home.remove()
  vi.restoreAllMocks()
})

for (const entry of ['index.mjs', 'index.js']) {
  it(`${entry}: keyboard navigation follows the candidate's real document`, async () => {
    const file = join(dropdownDirectory, 'dist', entry)
    const Menu = entry.endsWith('.mjs') ? await import(/* @vite-ignore */ pathToFileURL(file).href) : require(file)
    const child = frame.contentDocument!
    const selected = vi.fn()
    await act(async () => root.render(createPortal(<Menu.Root open={true} modal={false}>
      <Menu.Trigger>Actions</Menu.Trigger>
      <Menu.Portal container={child.body}><Menu.Content>
        <Menu.Item id="first" onSelect={selected}>First</Menu.Item>
        <Menu.Item id="middle">Middle</Menu.Item>
        <Menu.Item id="last">Last</Menu.Item>
      </Menu.Content></Menu.Portal>
    </Menu.Root>, child.body)))
    const key = async (value: string) => {
      await act(async () => child.activeElement!.dispatchEvent(new KeyboardEvent('keydown', {
        key: value, bubbles: true, cancelable: true
      })))
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    }
    await act(async () => child.getElementById('last')!.focus())
    await key('Home')
    expect(child.activeElement?.id).toBe('first')
    expect(document.activeElement?.id).not.toBe('first')
    await key('ArrowDown')
    expect(child.activeElement?.id).toBe('middle')
    await key('ArrowUp')
    expect(child.activeElement?.id).toBe('first')
    await key('Enter')
    expect(selected).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })
}
