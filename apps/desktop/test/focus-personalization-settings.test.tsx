// @vitest-environment happy-dom
import type { AppConfig } from '../src/shared/contracts'
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { FocusSettingsPane } from '../src/renderer/src/components/settings/FocusSettingsPane'
import { FocusSettingsPreview } from '../src/renderer/src/components/settings/FocusSettingsPreview'
import { focusSettingsModule } from '../src/renderer/src/components/settings/modules/focus'
import { resolveFocusPreferences } from '../src/shared/focus-preferences'
import { applyConfigEdit } from '../src/shared/config-edit'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { focusProjectRoots } from '../src/renderer/src/lib/focus-project-lanes'
import { agentBookmarks } from '../src/renderer/src/lib/agent-bookmarks'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
import { GRAPHITE_THEME, mountThemeRuntime, previewTheme } from '@agentmux/client-ui/theme'

const dom = composerDOM(), Pane = focusSettingsModule.Pane
const choose = (field: string, value: string | number) => dom.click(`input[name="focus-${field}"][value="${value}"]`)
afterEach(() => vi.useRealTimers())

it('the real Focus input example shares the customizable return drawing and original return action', async () => {
  const release = mountThemeRuntime(window, { appAppearance: 'dark' })
  try {
    await dom.render(<FocusSettingsPreview values={resolveFocusPreferences(undefined)} active scene="reading" onScene={() => {}} />)
    const card = dom.container.querySelector<HTMLElement>('[data-example-agent="example-agent-0"]')!
    await act(async () => card.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
    const entries = dom.container.querySelectorAll<HTMLElement>('.agent-input-recall__entry')
    expect(entries).toHaveLength(6)
    const entry = entries[0]!
    await act(async () => { entry.focus(); entry.click() })
    const original = dom.container.querySelector<HTMLElement>('[aria-label="Example original input"]')!
    expect(original).not.toBeNull()
    const back = original.querySelector<HTMLButtonElement>('button')!, drawing = back.querySelector('svg')!
    expect(back.textContent?.trim()).toBe('Recent inputs')
    expect(drawing.getAttribute('data-semantic-icon')).toBe('navigation.back')
    const theme = structuredClone(GRAPHITE_THEME)
    theme.id = 'custom.example-return'; theme.icons = { 'navigation.back': { kind: 'paths', paths: [{ d: 'M3 4H21L12 20Z' }] } }
    await act(async () => { expect(previewTheme(theme).applied).toBe(true) })
    expect(original.querySelector('button')).toBe(back); expect(back.querySelector('svg')).toBe(drawing)
    expect(drawing.querySelector('use')?.getAttribute('href')).toBe('#agentmux-icon-navigation.back')
    expect(document.getElementById('agentmux-icon-navigation.back')?.querySelector('path')?.getAttribute('d')).toBe('M3 4H21L12 20Z')
    await act(async () => back.click())
    expect(dom.container.querySelector('[aria-label="Example original input"]')).toBeNull()
    expect(dom.container.querySelector('[aria-label="Example Agent reading"]')).not.toBeNull()
    expect(document.activeElement).toBe(entry)
  } finally { release() }
})

it('previews all five settings through real shared content before saving, then merges only the authored changes', async () => {
  let config = { ...composerConfig }, current = useAppStore.getState()
  const roots = focusProjectRoots(composerConfig)
  const bookmarks = agentBookmarks.get(), reads = vi.spyOn(api.sessions, 'historySources'), history = vi.spyOn(api.sessions, 'historyPage')
  const save = vi.spyOn(api.config, 'save').mockImplementation(async (next, expected) => { config = applyConfigEdit(config, expected!, next); return config })
  await dom.render(<Pane config={config} active onClose={() => {}} onNavigate={() => {}} />)
  const order = () => [...dom.container.querySelectorAll<HTMLElement>('[data-example-project]')].map(node => node.dataset.exampleProject)
  expect(order()).toEqual(['Review', 'Studio', 'Atlas', 'Research'])
  await choose('recent-activity', 12)
  expect(order()).toEqual(['Review', 'Atlas', 'Studio', 'Research'])
  await choose('reply-lines', 3)
  expect(dom.container.querySelector<HTMLElement>('.focus-settings-preview')!.style.getPropertyValue('--focus-reply-lines')).toBe('3')
  expect(dom.container.querySelector('[data-example-agent="example-agent-2"]')!.textContent).toContain('Allow access to the selected project?')
  expect(dom.container.querySelector('[data-example-agent="example-agent-3"] [data-semantic-icon="status.activity-unknown"]')).not.toBeNull()
  await choose('preview-trigger', 'keyboard'); await choose('recent-inputs', 10)
  await dom.click('.focus-settings-preview__try')
  expect(dom.container.querySelectorAll('.agent-input-recall__entry')).toHaveLength(10)
  await choose('link-destination', 'tab'); await dom.click('.focus-settings-preview__link')
  expect(dom.container.querySelector('.focus-settings-preview__links')?.getAttribute('data-destination')).toBe('tab')
  expect(dom.container.querySelector('.focus-settings-preview__resource')?.textContent).toContain('own Tab in Space')
  expect(focusProjectRoots(composerConfig)).toBe(roots)
  expect(save).not.toHaveBeenCalled(); expect(reads).not.toHaveBeenCalled(); expect(history).not.toHaveBeenCalled()
  expect(useAppStore.getState().sessions).toBe(current.sessions); expect(useAppStore.getState().agentComposerDrafts).toBe(current.agentComposerDrafts)
  expect(useAppStore.getState().mainSurface).toBe(current.mainSurface); expect(agentBookmarks.get()).toBe(bookmarks)
  config = { ...config, copyPathsAsAbsolute: true }; useAppStore.setState({ config })
  await dom.render(<Pane config={config} active onClose={() => {}} onNavigate={() => {}} />)
  await dom.click('[data-settings-save-bar] button')
  expect(config.focus).toEqual({ recentActivityHours: 12, replyLines: 3, previewTrigger: 'keyboard', recentInputs: 10, linkDestination: 'tab' })
  expect(config.copyPathsAsAbsolute).toBe(true)
  expect(save).toHaveBeenCalledTimes(1)
})

it('uses the original intent timing, cancels hidden or changed intent, and keeps explicit keyboard reading in keyboard-only mode', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const values = resolveFocusPreferences(undefined)
  const render = (active: boolean, previewTrigger = values.previewTrigger) => dom.render(<FocusSettingsPreview values={{ ...values, previewTrigger }} active={active} scene="reading" onScene={() => {}} />)
  await render(true)
  await dom.hover('[data-example-agent="example-agent-0"]')
  await act(async () => vi.advanceTimersByTime(179)); expect(dom.container.querySelector('[aria-label="Example Agent reading"]')).toBeNull()
  await act(async () => vi.advanceTimersByTime(1)); expect(dom.container.querySelector('[aria-label="Example Agent reading"]')).not.toBeNull()
  await act(async () => dom.container.querySelector('[aria-label="Example Agent reading"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(dom.container.querySelector('[aria-label="Example Agent reading"]')).toBeNull()
  await render(false); expect(dom.container.querySelector('[aria-label="Example Agent reading"]')).toBeNull()
  await render(true, 'deliberate'); await dom.hover('[data-example-agent="example-agent-0"]')
  await act(async () => vi.advanceTimersByTime(180)); expect(dom.container.querySelector('[aria-label="Example Agent reading"]')).toBeNull()
  await render(true, 'keyboard'); await act(async () => vi.advanceTimersByTime(1000)); expect(dom.container.querySelector('[aria-label="Example Agent reading"]')).toBeNull()
  const card = dom.container.querySelector<HTMLElement>('[data-example-agent="example-agent-0"]')!
  await act(async () => card.focus()); await dom.hover('[data-example-agent="example-agent-0"]')
  const outerEscape = vi.fn(); window.addEventListener('keydown', outerEscape)
  await act(async () => card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(outerEscape).toHaveBeenCalledTimes(1); window.removeEventListener('keydown', outerEscape)
  await act(async () => vi.advanceTimersByTime(1000)); expect(dom.container.querySelector('[aria-label="Example Agent reading"]')).toBeNull()
  await act(async () => card.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
  expect(dom.container.querySelectorAll('.agent-input-recall__entry')).toHaveLength(6)
  const first = dom.container.querySelector<HTMLElement>('.agent-input-recall__entry')!
  await dom.hover('.agent-input-recall__entry'); expect(dom.container.querySelector('[aria-label="Example original input"]')).toBeNull()
  await act(async () => first.click()); expect(dom.container.querySelector('[aria-label="Example original input"]')).not.toBeNull()
  expect(document.activeElement).toBe(dom.container.querySelector('[aria-label="Example original input"]'))
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(dom.container.querySelector('[aria-label="Example original input"]')).toBeNull()
  expect(dom.container.querySelector('[aria-label="Example Agent reading"]')).not.toBeNull()
  expect(document.activeElement).toBe(first)
  await render(false); await act(async () => vi.advanceTimersByTime(1000)); expect(dom.container.querySelector('[aria-label="Example Agent reading"]')).toBeNull()
})

it('restores defaults as an unsaved draft and retains an authored choice after an actual same-field refusal', async () => {
  const original = { ...composerConfig, focus: { recentActivityHours: 48 as const, replyLines: 1 as const } }
  let current: AppConfig = original
  vi.spyOn(api.config, 'save').mockImplementation(async (next, expected) => applyConfigEdit(current, expected!, next))
  await dom.render(<Pane config={original} active onClose={() => {}} onNavigate={() => {}} />)
  await choose('reply-lines', 3)
  current = { ...original, focus: { ...original.focus, replyLines: 2 } }; useAppStore.setState({ config: current })
  await dom.render(<Pane config={current} active onClose={() => {}} onNavigate={() => {}} />)
  await dom.click('[data-settings-save-bar] button')
  expect(dom.container.querySelector('[role="alert"]')?.textContent).toContain('focus.replyLines')
  expect(dom.container.querySelector<HTMLInputElement>('input[name="focus-reply-lines"][value="3"]')!.checked).toBe(true)
  const save = vi.fn().mockResolvedValue(undefined)
  await dom.render(<FocusSettingsPane key="defaults" preferences={{ recentActivityHours: 12, replyLines: 1, previewTrigger: 'keyboard', recentInputs: 3, linkDestination: 'tab' }} onSave={save} />)
  await dom.click('.focus-settings__intro button')
  expect(save).not.toHaveBeenCalled()
  await dom.click('[data-settings-save-bar] button')
  expect(save.mock.calls[0]![0]).toEqual(resolveFocusPreferences(undefined))
})
