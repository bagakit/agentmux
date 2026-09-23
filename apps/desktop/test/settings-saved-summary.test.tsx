// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { BrowserSettingsPane } from '../src/renderer/src/components/settings/BrowserSettingsPane'
import { GeneralSettingsPane } from '../src/renderer/src/components/settings/GeneralSettingsPane'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const kinds = ['copy', 'browser'] as const
type Kind = typeof kinds[number]

function pane(kind: Kind, saved: boolean, onSave: (value: boolean, expected: boolean) => Promise<void>) {
  return kind === 'copy'
    ? <GeneralSettingsPane copyPathsAsAbsolute={saved} onSave={onSave} />
    : <BrowserSettingsPane browser={{ ...composerConfig.browser, agentAutomation: saved }} onSave={onSave} onForget={async () => {}} />
}

function controls(kind: Kind) {
  const group = dom.container.querySelector<HTMLElement>('.settings-group')!
  expect(group).not.toBeNull()
  expect(group.isConnected).toBe(true)
  expect(group.querySelector('header > span')!.textContent).toBe(kind === 'copy' ? 'Home directory in copied paths' : 'Agent automation')
  const input = group.querySelector<HTMLInputElement>('input[type="checkbox"]')!
  const summary = group.querySelector<HTMLElement>('header > small')!
  expect(input.isConnected).toBe(true)
  expect(summary.isConnected).toBe(true)
  expect(input.closest('label')!.textContent!.length).toBeGreaterThan(0)
  return { input, summary }
}

function savedText(kind: Kind, saved: boolean): string {
  return `Saved: ${kind === 'copy' ? saved ? 'Absolute' : 'Abbreviated' : saved ? 'On' : 'Off'}`
}

it.each(kinds.flatMap(kind => [false, true].map(saved => ({ kind, saved }))))(
  '$kind identifies saved=$saved while the opposite checkbox remains an unsaved draft', async ({ kind, saved }) => {
    const save = vi.fn(async () => {})
    await dom.render(pane(kind, saved, save))
    const original = controls(kind)
    expect(original.input.checked).toBe(saved)
    expect(original.summary.textContent).toBe(savedText(kind, saved))
    await dom.click('input[type="checkbox"]')
    expect(controls(kind).input).toBe(original.input)
    expect(original.input.checked).toBe(!saved)
    expect(original.summary.textContent).toBe(savedText(kind, saved))
    expect(dom.container.querySelector('[data-settings-save-bar] [role="status"]')!.textContent).toBe('Unsaved changes')
    expect(save).not.toHaveBeenCalled()
  }
)

it.each(kinds)('%s retains the saved fact and expected value through pending and failed saves', async kind => {
  let reject!: (reason: Error) => void
  const save = vi.fn(() => new Promise<void>((_, fail) => { reject = fail }))
  await dom.render(pane(kind, false, save))
  await dom.click('input[type="checkbox"]')
  await dom.click('[data-settings-save-bar] button')
  expect(save).toHaveBeenCalledExactlyOnceWith(true, false)
  expect(controls(kind).summary.textContent).toBe(savedText(kind, false))
  expect(controls(kind).input.checked).toBe(true)
  expect(dom.container.querySelector('[data-settings-save-bar] [role="status"]')!.textContent).toContain('Saving changes')
  await act(async () => reject(new Error('Original save failed')))
  expect(dom.container.querySelector('[data-settings-save-bar] [role="alert"]')!.textContent).toBe('Original save failed')
  expect(controls(kind).summary.textContent).toBe(savedText(kind, false))
  expect(controls(kind).input.checked).toBe(true)
})

it.each(kinds)('%s advances its saved summary only on publication and retains a later edit', async kind => {
  let resolve!: () => void
  const save = vi.fn(() => new Promise<void>(done => { resolve = done }))
  await dom.render(pane(kind, false, save))
  await dom.click('input[type="checkbox"]')
  await dom.click('[data-settings-save-bar] button')
  const original = controls(kind)
  await dom.click('input[type="checkbox"]')
  expect(original.input.checked).toBe(false)
  expect(original.summary.textContent).toBe(savedText(kind, false))
  expect(save).toHaveBeenCalledExactlyOnceWith(true, false)
  await dom.render(pane(kind, true, save))
  await act(async () => resolve())
  expect(controls(kind).input).toBe(original.input)
  expect(original.input.checked).toBe(false)
  expect(original.summary.textContent).toBe(savedText(kind, true))
  expect(dom.container.querySelector('[data-settings-save-bar] [role="status"]')!.textContent).toBe('Unsaved changes')
})
