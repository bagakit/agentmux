// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PaneSplitMenu } from '../src/renderer/src/components/PaneSplitMenu'
import * as Menu from '../src/renderer/src/components/HoverDropdownMenu'

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.useRealTimers()
})
async function pointer(target: Element, type: string, pointerType = 'mouse', relatedTarget: EventTarget | null = null) {
  await act(async () => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType, relatedTarget, buttons: 0, button: 0 })))
}
async function pause() { await act(async () => { await new Promise((r) => setTimeout(r, 220)) }) }
async function split(disabled = false) {
  const action = vi.fn(), open = vi.fn()
  await act(async () => root.render(<><input aria-label="editor" /><PaneSplitMenu disabled={disabled} regionCount={2} onSplit={action} onArrange={vi.fn()} onOpenChange={open} /></>))
  return { trigger: container.querySelector<HTMLButtonElement>('.pane-action--split-menu')!, action, open }
}
const menu = () => document.querySelector<HTMLElement>('[role="menu"]')
it('production Split opens without a click, preserves the editor caret and executes once', async () => {
  const { trigger, action, open } = await split()
  const editor = container.querySelector('input')!
  editor.focus()
  await pointer(trigger, 'pointerover')
  expect(menu()).not.toBeNull()
  expect(open).toHaveBeenLastCalledWith(true)
  expect(document.activeElement).toBe(editor)
  await pointer(trigger, 'pointerdown')
  expect(menu()).not.toBeNull()
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => /right/i.test(el.textContent ?? ''))!
  expect(item).toBeDefined()
  await act(async () => item.click())
  expect(action).toHaveBeenCalledExactlyOnceWith('right')
  expect(open).toHaveBeenLastCalledWith(false)
  expect(menu()).toBeNull()
})
it('crossing the trigger gap keeps the menu; leaving both closes and restores native-view yielding', async () => {
  const { trigger, open } = await split()
  await pointer(trigger, 'pointerover')
  const content = menu()!
  await pointer(trigger, 'pointerout')
  await pointer(content, 'pointerover')
  await pause()
  expect(menu()).not.toBeNull()
  await pointer(content, 'pointerout')
  await pause()
  expect(menu()).toBeNull()
  expect(open).toHaveBeenLastCalledWith(false)
})
it('disabled and touch hover never disclose, but touch press still opens', async () => {
  let { trigger } = await split(true)
  await pointer(trigger, 'pointerover')
  expect(menu()).toBeNull()
  ;({ trigger } = await split())
  await pointer(trigger, 'pointerover', 'touch')
  expect(menu()).toBeNull()
  await pointer(trigger, 'pointerdown', 'touch')
  expect(menu()).not.toBeNull()
})
it('keyboard opens and Escape dismisses the real Radix menu', async () => {
  const { trigger, open } = await split()
  trigger.focus()
  await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
  expect(menu()).not.toBeNull()
  await act(async () => menu()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(menu()).toBeNull()
  expect(open).toHaveBeenLastCalledWith(false)
})
it('switching hover menus closes the previous owner and unmount releases the active owner', async () => {
  const first = vi.fn(), second = vi.fn()
  const example = (name: string, onOpenChange: (open: boolean) => void) => <Menu.Root onOpenChange={onOpenChange}><Menu.Trigger>{name}</Menu.Trigger><Menu.Portal><Menu.Content><Menu.Item>{name} action</Menu.Item></Menu.Content></Menu.Portal></Menu.Root>
  await act(async () => root.render(<>{example('A', first)}{example('B', second)}</>))
  const [a, b] = container.querySelectorAll('button')
  await pointer(a!, 'pointerover')
  await pointer(b!, 'pointerover')
  expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1)
  expect(menu()?.textContent).toContain('B action')
  expect(first).toHaveBeenLastCalledWith(false)
  await act(async () => root.render(null))
  expect(second).toHaveBeenLastCalledWith(false)
})
it('all existing dropdown consumers import the shared hover adapter, with nonempty discovery', () => {
  const dir = resolve('../../apps/desktop/src/renderer/src/components')
  const consumers = readdirSync(dir).filter((f) => f.endsWith('.tsx')).filter((f) => readFileSync(join(dir, f), 'utf8').includes('<DropdownMenu.Root'))
  expect(consumers.length).toBeGreaterThan(0)
  for (const file of consumers) expect(readFileSync(join(dir, file), 'utf8'), file).toContain("import * as DropdownMenu from './HoverDropdownMenu'")
})

it('Composer tools select actual skill and command references without submitting, and capture is one click', async () => {
  const { AgentComposerTools } = await import('../src/renderer/src/components/AgentComposerTools')
  const onChooseSkill = vi.fn(), onCommand = vi.fn(), onCapture = vi.fn(async () => {})
  const skill = { name: 'review', description: 'Review the code', path: '/skills/review/SKILL.md', source: 'project' as const }
  await act(async () => root.render(<AgentComposerTools disabled={false} commands={[{ text: '/status', description: 'Session status' }]}
    loadSkills={async () => [skill]} onChooseSkill={onChooseSkill} onCommand={onCommand} onCapture={onCapture} reportError={vi.fn()} />))
  const find = (label: string) => [...container.querySelectorAll('button')].find((button) => button.textContent?.includes(label))!
  await pointer(find('Skills'), 'pointerover')
  expect(menu()?.textContent).toContain('review')
  await act(async () => (document.querySelector('[role="menuitem"]') as HTMLElement).click())
  expect(onChooseSkill).toHaveBeenCalledExactlyOnceWith(skill)
  await pointer(find('Commands'), 'pointerover')
  await act(async () => (document.querySelector('[role="menuitem"]') as HTMLElement).click())
  expect(onCommand).toHaveBeenCalledExactlyOnceWith('/status')
  await act(async () => find('Capture').click())
  expect(onCapture).toHaveBeenCalledOnce()
})
it('outside pointer dismisses a hover menu', async () => {
  const { trigger } = await split()
  await pointer(trigger, 'pointerover')
  await pointer(container.querySelector('input')!, 'pointerdown')
  expect(menu()).toBeNull()
})
