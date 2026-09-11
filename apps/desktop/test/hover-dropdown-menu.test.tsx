// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
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
  // 没有 onOpenChange：原生视图让位已不再逐个菜单接线，改由 App 的那个 MutationObserver 按
  // Radix 的 DOM 协议统一观察（lib/native-surface-overlay.ts）。适配器本身仍会通知它的 owner，
  // 那条性质由下面直接用 Menu.Root 的那个用例守。
  const action = vi.fn()
  await act(async () => root.render(<><input aria-label="editor" /><PaneSplitMenu disabled={disabled} regionCount={2} onSplit={action} onArrange={vi.fn()} /></>))
  return { trigger: container.querySelector<HTMLButtonElement>('.pane-action--split-menu')!, action }
}
const menu = () => document.querySelector<HTMLElement>('[role="menu"]')
it('production Split opens without a click, preserves the editor caret and executes once', async () => {
  const { trigger, action } = await split()
  const editor = container.querySelector('input')!
  editor.focus()
  await pointer(trigger, 'pointerover')
  expect(menu()).not.toBeNull()
  expect(document.activeElement).toBe(editor)
  await pointer(trigger, 'pointerdown')
  expect(menu()).not.toBeNull()
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => /right/i.test(el.textContent ?? ''))!
  expect(item).toBeDefined()
  await act(async () => item.click())
  expect(action).toHaveBeenCalledExactlyOnceWith('right')
  expect(menu()).toBeNull()
})
it('crossing the trigger gap keeps the menu; leaving both closes it', async () => {
  const { trigger } = await split()
  await pointer(trigger, 'pointerover')
  const content = menu()!
  await pointer(trigger, 'pointerout')
  await pointer(content, 'pointerover')
  await pause()
  expect(menu()).not.toBeNull()
  await pointer(content, 'pointerout')
  await pause()
  expect(menu()).toBeNull()
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
  const { trigger } = await split()
  trigger.focus()
  await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
  expect(menu()).not.toBeNull()
  await act(async () => menu()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(menu()).toBeNull()
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
  // 用测试文件所在目录派生组件目录，避免依赖 process.cwd()（全量跑时 cwd 是仓根，resolve 会爬出仓库）
  const dir = join(import.meta.dirname, '../src/renderer/src/components')
  const consumers = readdirSync(dir).filter((f) => f.endsWith('.tsx')).filter((f) => readFileSync(join(dir, f), 'utf8').includes('<DropdownMenu.Root'))
  expect(consumers.length).toBeGreaterThan(0)
  for (const file of consumers) expect(readFileSync(join(dir, file), 'utf8'), file).toContain("import * as DropdownMenu from './HoverDropdownMenu'")
})

it('Composer tools select actual skill and command references without submitting, and capture is one click', async () => {
  const { AgentComposerTools } = await import('../src/renderer/src/components/AgentComposerTools')
  const onChooseSkill = vi.fn(), onCommand = vi.fn(), onCapture = vi.fn(async () => {})
  const skill = { name: 'review', description: 'Review the code', path: '/skills/review/SKILL.md', source: 'project' as const }
  await act(async () => root.render(<AgentComposerTools disabled={false} commands={[{ text: '/status', description: 'Session status' }]}
    loadSkills={async () => [skill]} onChooseSkill={onChooseSkill} onCommand={onCommand} onCapture={onCapture} runAction={async (action) => { await action() }} />))
  const find = (label: string) => [...container.querySelectorAll('button')].find((button) => button.textContent?.includes(label))!
  // Composer 现在静息在一行态（工具收起），所以先按真实产品路径点一下那枚三态键切到工具可见的一档。
  // 这条测试断言的是「能力可达」而不是「默认停在哪一档」——默认档由 composer-form-actions.test.tsx
  // 钉着。不绕过控件直接设 state：那会让这里在切档坏掉时照样绿。
  const toggle = container.querySelector<HTMLButtonElement>('.composer-tool--mode')!
  await act(async () => toggle.click())
  expect(find('Skills'), 'toggling the dock must reveal the tool row').toBeTruthy()
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
