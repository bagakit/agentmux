// @vitest-environment happy-dom
import { act, useState } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { SurfaceModeSwitch } from '../src/renderer/src/components/SurfaceModeSwitch'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const options = [{ value: 'first', label: 'First', ariaLabel: 'First mode' }, { value: 'second', label: 'Second' }] as const
const changes = vi.fn()
function Consumer({ active = true }: { active?: boolean }) {
  const [value, setValue] = useState<'first' | 'second'>('first')
  return <form><SurfaceModeSwitch value={value} options={options} ariaLabel="Local modes" active={active}
    onChange={next => { changes(next); setValue(next) }} /><textarea aria-label="Unsent draft" defaultValue="Keep this draft" /></form>
}
const tabs = () => [...dom.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
const selected = () => tabs().find(tab => tab.getAttribute('aria-selected') === 'true')!
const key = async (target: HTMLElement, name: string) => act(async () => {
  target.focus(); target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: name }))
})
beforeEach(() => { changes.mockClear() })

it('keeps native local keyboard focus, caller selection and the original draft through hide/reveal', async () => {
  await dom.render(<Consumer />)
  const draft = dom.container.querySelector<HTMLTextAreaElement>('[aria-label="Unsent draft"]')!
  const lens = dom.container.querySelector('[data-liquid-selection]')
  expect(lens).not.toBeNull()
  expect(lens?.getAttribute('aria-hidden')).toBe('true')
  expect(tabs().map(tab => tab.type)).toEqual(['button', 'button'])
  expect(tabs()[0]?.getAttribute('aria-label')).toBe('First mode')
  for (const [name, value] of [['ArrowLeft', 'second'], ['ArrowRight', 'first'], ['End', 'second'], ['Home', 'first']] as const) {
    await key(selected(), name)
    expect(selected().dataset.surfaceMode).toBe(value)
    expect(document.activeElement).toBe(selected())
    expect(tabs().map(tab => tab.tabIndex)).toEqual(value === 'first' ? [0, -1] : [-1, 0])
    expect(dom.container.querySelector('[data-liquid-selection]')).toBe(lens)
  }
  await act(async () => tabs()[1]!.click())
  expect(selected().textContent).toBe('Second')
  await dom.render(<Consumer active={false} />)
  expect(selected().textContent).toBe('Second')
  expect(dom.container.querySelector('[data-liquid-selection]')).toBe(lens)
  await dom.render(<Consumer />)
  expect(selected().textContent).toBe('Second')
  expect(dom.container.querySelector('[aria-label="Unsent draft"]')).toBe(draft)
  expect(draft.value).toBe('Keep this draft')
  expect(changes.mock.calls.map(([value]) => value)).toEqual(['second', 'first', 'second', 'first', 'second'])
})

it('does not invent selection or disable explicit controls when decoration is inactive', async () => {
  await dom.render(<SurfaceModeSwitch<'first' | 'second'> value="first" options={options} onChange={changes} active={false} ariaLabel="Local modes" />)
  await key(tabs()[0]!, 'ArrowRight')
  expect(changes).toHaveBeenLastCalledWith('second')
  expect(selected().dataset.surfaceMode).toBe('first')
  expect(tabs()[1]?.disabled).toBe(false)
  expect(document.activeElement).toBe(tabs()[1])
  await key(tabs()[1]!, 'ArrowUp')
  expect(changes).toHaveBeenCalledTimes(1)
  await dom.render(<SurfaceModeSwitch<'first' | 'second'> value="second" options={options} onChange={changes} active={false} ariaLabel="Local modes" />)
  expect(selected().dataset.surfaceMode).toBe('second')
})

it('loads generic decoration and mode rules through their neutral style owners', () => {
  const base = 'apps/desktop/src/renderer/src/styles/'
  const entry = readFileSync(base + 'index.css', 'utf8')
  const liquid = readFileSync(base + 'liquid-selection.css', 'utf8')
  const modes = readFileSync(base + 'surface-mode-switch.css', 'utf8')
  expect(entry).toContain("@import './liquid-selection.css'")
  expect(entry).toContain("@import './surface-mode-switch.css'")
  expect(entry.indexOf("@import './liquid-selection.css'")).toBeLessThan(entry.indexOf("@import './settings-materials.css'"))
  expect(liquid).toContain('.liquid-selection[hidden] { display: none; }')
  expect(liquid).toContain('prefers-reduced-transparency: reduce')
  expect(liquid).toContain('prefers-contrast: more')
  expect(modes).toContain('forced-colors: active')
  expect(modes).toContain('.surface-mode-switch button:focus-visible')
  expect(modes).not.toContain('backdrop-filter: blur')
  expect(readFileSync(base + 'settings-materials.css', 'utf8')).not.toMatch(/^\s*\.liquid-selection/m)
  expect(readFileSync(base + 'source-control.css', 'utf8')).not.toMatch(/^\.source-control-switch/m)
})
