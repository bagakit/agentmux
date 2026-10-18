// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const page = (id: string) => dom.container.querySelector<HTMLElement>(`[data-settings-pane="${id}"]`)!
async function edit(control: HTMLInputElement, value?: string) {
  await act(async () => {
    control.focus()
    if (control.type === 'radio' || control.type === 'checkbox') control.click()
    else {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(control, value!)
      control.dispatchEvent(new Event('input', { bubbles: true }))
      control.dispatchEvent(new Event('change', { bubbles: true }))
    }
  })
}
async function select(control: HTMLSelectElement, value: string) {
  await act(async () => { control.focus(); control.value = value; control.dispatchEvent(new Event('change', { bubbles: true })) })
}
async function jump(pane: HTMLElement, group: string) {
  const button = pane.querySelector<HTMLButtonElement>(`[data-settings-preview-open="${group}"]`)!
  await act(async () => { button.focus(); button.click() })
}
async function back(pane: HTMLElement) {
  const button = pane.querySelector<HTMLButtonElement>('[data-settings-preview-return]')!
  await act(async () => { button.focus(); button.click() })
}

it('Focus previews the chosen group and returns to the same edited control and reading position without saving or remounting', async () => {
  const save = vi.spyOn(api.config, 'save'), read = vi.spyOn(api.sessions, 'historyPage')
  const original = useAppStore.getState()
  await dom.render(<SettingsPanel initialSection="focus" onClose={() => {}} />)
  const pane = page('focus'), preview = pane.querySelector<HTMLElement>('.focus-settings-preview')!
  for (const [field, value, group, scene, label] of [
    ['reply-lines', '3', 'project-scanning', 'board', 'Reply excerpt'],
    ['recent-inputs', '10', 'agent-reading', 'reading', 'Recent inputs in a new preview'],
    ['link-destination', 'tab', 'opening-resources', 'links', 'Open links in Focus']
  ]) {
    const control = pane.querySelector<HTMLInputElement>(`input[name="focus-${field}"][value="${value}"]`)!
    for (const position of [137, 319]) {
      pane.scrollTop = position
      await edit(control)
      await jump(pane, group!)
      expect(document.activeElement, 'The explicit preview action reaches the original preview').toBe(preview)
      expect(pane.querySelector('.focus-settings-preview')).toBe(preview)
      expect(preview.querySelector('[data-scene]')!.getAttribute('data-scene')).toBe(scene)
      expect(preview.querySelector('[data-settings-preview-return]')!.textContent).toBe(`Back to ${label}`)
      const canvas = preview.querySelector<HTMLElement>('.focus-settings-preview__canvas')!
      canvas.scrollTop = 29
      pane.scrollTop = 887
      await back(pane)
      expect(document.activeElement, 'Returning continues the exact authored input').toBe(control)
      expect(pane.scrollTop, 'The authored reading position is restored').toBe(position)
      expect(control.checked).toBe(true)
      expect(canvas.scrollTop).toBe(29)
    }
  }
  expect(pane.querySelector('[data-settings-save-bar]')!.textContent).toContain('Unsaved changes')
  expect(useAppStore.getState().agentComposerDrafts).toBe(original.agentComposerDrafts)
  expect(useAppStore.getState().sessions).toBe(original.sessions)
  expect(save).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled()
})

it('Agent takeover keeps the original simulation and draft while all three groups return to their own controls', async () => {
  const save = vi.spyOn(api.config, 'save'), operate = vi.spyOn(api.browser, 'runScript')
  await dom.render(<SettingsPanel initialSection="browser-agent-control" onClose={() => {}} />)
  const pane = page('browser-agent-control'), preview = pane.querySelector<HTMLElement>('.browser-agent-preview')!
  const effects = preview.querySelector('.browser-agent-preview__effects')!.shadowRoot!
  await select(preview.querySelector('[aria-label="Simulation state"]')!, 'waiting')
  await select(preview.querySelector('[aria-label="Simulation page"]')!, 'dark')
  pane.querySelector<HTMLDetailsElement>('.browser-agent-control__advanced')!.open = true
  for (const [field, value, group, label] of [
    ['showDiscussion', undefined, 'cursor', 'Show discussion box'],
    ['glowColor', '#c78cfa', 'glow', 'Glow color'],
    ['pointerDurationMs', '620', 'fine-tuning', 'Cursor travel']
  ]) {
    const control = pane.querySelector<HTMLInputElement>(`[data-settings-field="${field}"] input`)!
    for (const position of [181, 427]) {
      pane.scrollTop = position
      await edit(control, value)
      const authored = control.type === 'checkbox' ? control.checked : control.value
      await jump(pane, group!)
      expect(document.activeElement, 'The explicit preview action reaches the original simulation').toBe(preview)
      expect(pane.querySelector('.browser-agent-preview')).toBe(preview)
      expect(preview.querySelector('[data-settings-preview-return]')!.textContent).toBe(`Back to ${label}`)
      expect(preview.querySelector<HTMLSelectElement>('[aria-label="Simulation state"]')!.value).toBe('waiting')
      expect(preview.querySelector<HTMLSelectElement>('[aria-label="Simulation page"]')!.value).toBe('dark')
      expect(preview.querySelector('.browser-operation-status__cue')!.textContent).toBe('Waiting')
      pane.scrollTop = 23
      await back(pane)
      expect(document.activeElement, 'Returning continues the exact authored input').toBe(control)
      expect(pane.scrollTop, 'The authored reading position is restored').toBe(position)
      expect(control.type === 'checkbox' ? control.checked : control.value).toBe(authored)
      expect(pane.querySelector<HTMLDetailsElement>('.browser-agent-control__advanced')!.open).toBe(true)
    }
  }
  expect(preview.querySelector('.browser-agent-preview__effects')!.shadowRoot).toBe(effects)
  expect(effects.querySelector('style')!.textContent).toContain('--amux-agent-color:#c78cfa')
  expect(pane.querySelector('[data-settings-save-bar]')!.textContent).toContain('Unsaved changes')
  expect(save).not.toHaveBeenCalled(); expect(operate).not.toHaveBeenCalled()
})

it('an untouched group returns to its actual preview opener and preserves an open Focus reading example', async () => {
  await dom.render(<SettingsPanel initialSection="focus" onClose={() => {}} />)
  const pane = page('focus'), opener = pane.querySelector<HTMLButtonElement>('[data-settings-preview-open="agent-reading"]')!
  pane.scrollTop = 215
  await jump(pane, 'agent-reading')
  await dom.click('.focus-settings-preview__try')
  const reading = pane.querySelector('[aria-label="Example Agent reading"]')!
  expect(reading).not.toBeNull()
  pane.scrollTop = 713
  await back(pane)
  expect(document.activeElement).toBe(opener)
  expect(pane.scrollTop).toBe(215)
  expect(pane.querySelector('[aria-label="Example Agent reading"]')).toBe(reading)
  await jump(pane, 'agent-reading')
  expect(pane.querySelector('[aria-label="Example Agent reading"]')).toBe(reading)
})
