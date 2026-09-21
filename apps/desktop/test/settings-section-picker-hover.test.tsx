// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import ts from 'typescript'
import { SettingsPanel, settingsNavGroups } from '../src/renderer/src/components/SettingsPanel'
import { PaneSplitMenu } from '../src/renderer/src/components/PaneSplitMenu'
import * as Menu from '../src/renderer/src/components/HoverDropdownMenu'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM, composerConfig } from './helpers/composer-dom-fixture'
import { allStyleRules } from './helpers/styles'

const dom = composerDOM()
beforeEach(() => {
  useAppStore.setState({ detectExecutors: vi.fn(async () => {}), checkHost: vi.fn(async () => {}) })
})
const menu = () => document.querySelector<HTMLElement>('[role="menu"]')
const picker = () => dom.container.querySelector<HTMLButtonElement>('[aria-label="Settings section"]')!
const font = () => dom.container.querySelector<HTMLInputElement>('[aria-label="Terminal font size in pixels"]')!
const pause = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 220)) })
async function pointer(target: Element, type: string, relatedTarget: EventTarget | null = null, pointerType = 'mouse') {
  await act(async () => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType, relatedTarget, buttons: 0, button: 0 })))
}
async function type(input: HTMLInputElement, value: string) {
  input.focus()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
function focused(input: HTMLInputElement, value: string, caret: number | null) {
  expect(input.isConnected).toBe(true)
  expect(input.closest('[hidden], [inert]')).toBeNull()
  expect(document.activeElement).toBe(input)
  expect(input.value).toBe(value)
  expect([input.selectionStart, input.selectionEnd]).toEqual([caret, caret])
}
async function select(item: HTMLElement) {
  // Happy DOM has no native default mousedown focus. Native proof uses trusted pointer/click instead.
  await pointer(item, 'pointerdown')
  await act(async () => { item.focus(); item.click() })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
}
async function browse(input: HTMLInputElement, trigger: HTMLElement, items: HTMLElement[], value: string, caret: number | null) {
  expect(items.length).toBeGreaterThan(1)
  for (const item of items) {
    await pointer(item, 'pointerover', trigger)
    await pointer(item, 'pointermove')
    focused(input, value, caret)
    await pointer(item, 'pointerout', menu())
    focused(input, value, caret)
  }
  await pointer(menu()!, 'pointerout', input)
  focused(input, value, caret)
  await pause()
  expect(menu()).toBeNull()
  focused(input, value, caret)
  // FocusScope releases its close callback in the following task. Complete that original
  // lifecycle before opening an independent second path; neither close timer can mask it.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  await pointer(input, 'pointerout', trigger)
  await pointer(trigger, 'pointerover', input)
  expect(menu()).not.toBeNull()
  const direct = document.querySelector<HTMLElement>('[role="menuitem"], [role="menuitemradio"]')!
  expect(direct).toBeTruthy()
  await pointer(trigger, 'pointerout', direct)
  await pointer(direct, 'pointerover', trigger)
  await pointer(direct, 'pointermove')
  await pointer(direct, 'pointerout', input)
  focused(input, value, caret)
  await pause()
  expect(menu()).toBeNull()
  focused(input, value, caret)
}

it('actual Settings RadioItems preserve the authored numeric draft through every hover and leave', async () => {
  const save = vi.spyOn(api.config, 'save')
  await dom.render(<SettingsPanel initialSection="appearance" onClose={() => {}} />)
  await type(font(), '1'); focused(font(), '1', null)
  await type(font(), '18'); focused(font(), '18', null)
  const configBefore = JSON.stringify(useAppStore.getState().config)
  await pointer(picker(), 'pointerover')
  expect(menu()).not.toBeNull()
  const items = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
  const expected = settingsNavGroups('').flatMap(group => group.items.map(item => item.title))
  expect(expected.length).toBeGreaterThan(1)
  expect(items.map(item => item.textContent)).toEqual(expected)
  expect([...document.querySelectorAll('.settings-section-menu__label')].map(item => item.textContent)).toEqual(settingsNavGroups('').map(group => group.title))
  await browse(font(), picker(), items.slice(0, 2), '18', null)
  expect(dom.container.querySelector('.settings-content__header h2')!.textContent).toBe('Appearance')
  expect(dom.container.querySelector<HTMLButtonElement>('[data-settings-pane="appearance"] .primary-button')!.disabled).toBe(false)
  expect(JSON.stringify(useAppStore.getState().config)).toBe(configBefore)
  expect(save).not.toHaveBeenCalled()
})

it('actual ordinary Split Items preserve text caret across rows, and explicit selection executes once', async () => {
  const split = vi.fn()
  await dom.render(<><input aria-label="Authored text" defaultValue="draft" /><PaneSplitMenu regionCount={2} onSplit={split} onArrange={vi.fn()} /></>)
  const input = dom.container.querySelector('input')!
  const trigger = dom.container.querySelector<HTMLElement>('[aria-label="Choose split direction"]')!
  input.focus(); input.setSelectionRange(2, 2)
  await pointer(trigger, 'pointerover')
  const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
  await browse(input, trigger, items.slice(0, 2), 'draft', 2)
  expect(split).not.toHaveBeenCalled()
  await pointer(trigger, 'pointerover')
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent === 'Split Left')!
  expect(item).toBeTruthy()
  await select(item)
  expect(split).toHaveBeenCalledExactlyOnceWith('left')
  expect(menu()).toBeNull()
})

it('different category selection closes to the exact connected trigger and returning keeps dirty draft/scroll', async () => {
  await dom.render(<SettingsPanel initialSection="appearance" onClose={() => {}} />)
  await type(font(), '18')
  const pane = dom.container.querySelector<HTMLElement>('[data-settings-pane="appearance"]')!
  pane.scrollTop = 123
  await pointer(picker(), 'pointerover')
  await select([...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(node => node.textContent === 'General')!)
  expect(menu()).toBeNull()
  expect(dom.container.querySelector('.settings-content__header h2')!.textContent).toBe('General')
  expect(picker().isConnected).toBe(true)
  expect(picker().closest('[hidden], [inert]')).toBeNull()
  expect(document.activeElement).toBe(picker())
  await pointer(picker(), 'pointerover')
  await select([...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(node => node.textContent === 'Appearance')!)
  expect(font().value).toBe('18')
  expect(pane.hidden).toBe(false)
  expect(pane.scrollTop).toBe(123)
  expect(dom.container.querySelector<HTMLButtonElement>('[data-settings-pane="appearance"] .primary-button')!.disabled).toBe(false)
  expect(useAppStore.getState().config).toEqual(composerConfig)
})

it('hover Escape keeps input; keyboard Escape returns to trigger without closing Settings', async () => {
  const close = vi.fn()
  await dom.render(<SettingsPanel initialSection="appearance" onClose={close} />)
  await type(font(), '18')
  await pointer(picker(), 'pointerover')
  await act(async () => font().dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' })))
  await pause()
  expect(menu()).toBeNull(); focused(font(), '18', null)
  for (const key of ['ArrowDown', 'Enter', ' ']) {
    picker().focus()
    await act(async () => picker().dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key })))
    expect(menu()).not.toBeNull()
    await act(async () => menu()!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' })))
    await pause()
    expect(menu()).toBeNull()
    expect(document.activeElement).toBe(picker())
  }
  expect(close).not.toHaveBeenCalled()
})

it('search derives nonempty categories, no matches disable the picker, and clear restores input/draft', async () => {
  await dom.render(<SettingsPanel initialSection="appearance" onClose={() => {}} />)
  await type(font(), '18')
  const search = dom.container.querySelector<HTMLInputElement>('[aria-label="Search settings"]')!
  await type(search, 'copy')
  await pointer(picker(), 'pointerover')
  const expected = settingsNavGroups('copy').flatMap(group => group.items.map(item => item.title))
  expect(expected.length).toBeGreaterThan(0)
  expect([...document.querySelectorAll('[role="menuitemradio"]')].map(item => item.textContent)).toEqual(expected)
  await pointer(menu()!, 'pointerout'); await pause()
  await type(search, 'zz-no-matches')
  expect(settingsNavGroups('zz-no-matches')).toEqual([])
  expect(picker().disabled).toBe(true)
  await pointer(picker(), 'pointerover')
  expect(menu()).toBeNull()
  await dom.click('[aria-label="Clear settings search"]')
  expect(document.activeElement).toBe(search)
  expect(search.value).toBe('')
  const appearance = [...dom.container.querySelectorAll<HTMLButtonElement>('nav button')].find(node => node.textContent === 'Appearance')!
  await act(async () => appearance.click())
  expect(font().value).toBe('18')
})

it.each(['item', 'radio'] as const)('disabled %s hover/move/leave retains input/caret and never selects', async kind => {
  const choose = vi.fn()
  await dom.render(<><input defaultValue="draft" /><Menu.Root><Menu.Trigger>Options</Menu.Trigger><Menu.Content>
    {kind === 'item' ? <Menu.Item disabled onSelect={choose}>Disabled</Menu.Item>
      : <Menu.RadioGroup value="other" onValueChange={choose}><Menu.RadioItem value="disabled" disabled>Disabled</Menu.RadioItem></Menu.RadioGroup>}
  </Menu.Content></Menu.Root></>)
  const input = dom.container.querySelector('input')!, trigger = dom.container.querySelector('button')!
  input.focus(); input.setSelectionRange(2, 2)
  await pointer(trigger, 'pointerover')
  const item = document.querySelector<HTMLElement>('[data-disabled]')!
  expect(item).toBeTruthy()
  await pointer(item, 'pointerover'); await pointer(item, 'pointermove')
  focused(input, 'draft', 2)
  await pointer(item, 'pointerout', menu())
  focused(input, 'draft', 2)
  await pointer(item, 'pointerdown'); await act(async () => item.click())
  expect(choose).not.toHaveBeenCalled()
  await pointer(item, 'pointerout', input)
  await pause()
  expect(menu()).toBeNull()
  focused(input, 'draft', 2)
})

it('caller pointer handlers run once and defaultPrevented survives shared composition', async () => {
  const move = vi.fn((event: React.PointerEvent) => event.preventDefault())
  const leave = vi.fn((event: React.PointerEvent) => event.preventDefault())
  const down = vi.fn((event: React.PointerEvent) => event.preventDefault())
  await dom.render(<><input defaultValue="draft" /><Menu.Root><Menu.Trigger>Options</Menu.Trigger><Menu.Content>
    <Menu.Item onPointerMove={move} onPointerLeave={leave} onPointerDown={down}>Item</Menu.Item>
  </Menu.Content></Menu.Root></>)
  const input = dom.container.querySelector('input')!, trigger = dom.container.querySelector('button')!
  input.focus(); input.setSelectionRange(2, 2)
  await pointer(trigger, 'pointerover')
  const item = document.querySelector<HTMLElement>('[role="menuitem"]')!
  await pointer(item, 'pointermove'); await pointer(item, 'pointerout', menu()); await pointer(item, 'pointerdown')
  expect(move).toHaveBeenCalledOnce(); expect(leave).toHaveBeenCalledOnce(); expect(down).toHaveBeenCalledOnce()
  focused(input, 'draft', 2)
})

it('actual source consumers and focus-derived styles are nonempty and retain enabled hover equivalents', () => {
  const directory = join(import.meta.dirname, '../src/renderer/src/components')
  const consumers = readdirSync(directory).filter(file => file.endsWith('.tsx')).filter(file => readFileSync(join(directory, file), 'utf8').includes('<DropdownMenu.Root'))
  expect(consumers.length).toBeGreaterThan(0)
  const classes = new Set<string>()
  let items = 0
  for (const file of consumers) {
    const source = ts.createSourceFile(file, readFileSync(join(directory, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    function visit(node: ts.Node): void {
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && ['DropdownMenu.Item', 'DropdownMenu.RadioItem'].includes(node.tagName.getText(source))) {
        items++
        for (const attribute of node.attributes.properties) {
          if (ts.isJsxAttribute(attribute) && attribute.name.getText(source) === 'className' && attribute.initializer && ts.isStringLiteral(attribute.initializer)) {
            for (const token of attribute.initializer.text.split(/\s+/)) classes.add(token)
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  expect(items).toBeGreaterThan(0); expect(classes.size).toBeGreaterThan(0)
  const require = createRequire(import.meta.url)
  const postcss = createRequire(require.resolve('vite'))('postcss') as {
    parse(css: string): { walkRules(fn: (rule: { selectors: string[] }) => void): void }
  }
  const selectors = new Set<string>()
  postcss.parse(allStyleRules()).walkRules(rule => rule.selectors.forEach(selector => selectors.add(selector)))
  const highlighted = [...selectors].filter(selector => selector.includes('[data-highlighted]') && [...classes].some(token => selector.includes('.' + token + '[data-highlighted]')))
  expect(highlighted.length).toBeGreaterThan(0)
  for (const selector of highlighted) {
    const enabled = selector.replace('[data-highlighted]', ':hover:where(:not([data-disabled]))')
    const existing = selector.replace('[data-highlighted]', ':hover')
    expect(selectors.has(enabled) || selectors.has(existing), selector).toBe(true)
  }
})
