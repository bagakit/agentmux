// @vitest-environment happy-dom
import { act, useContext } from 'react'
import { expect, it, vi } from 'vitest'
import type { SettingsNavigation as Navigation } from '../src/renderer/src/components/SettingsNavigation'
import type { AgentMuxDesktopFocusResult } from '@agentmux/core/control'
const entry = vi.hoisted(() => {
  const value = { evaluations: 0, attempts: 0, mode: 'ready' as 'ready' | 'held' | 'failed', release: undefined as (() => void) | undefined,
    navigation: null as React.ContextType<typeof Navigation>,
    load(load: () => Promise<unknown>) {
      value.attempts++
      if (value.mode === 'failed') return Promise.reject(new Error('Private Mesh module unavailable'))
      if (value.mode === 'held') return new Promise((resolve, reject) => { value.release = () => { void load().then(resolve, reject) } })
      return load()
    } }
  Object.assign(globalThis, { __agentmuxMeshEntryFixture: value }); return value
})
vi.mock('../src/renderer/src/components/ProjectRail', async importOriginal => {
  const original = await importOriginal<typeof import('../src/renderer/src/components/ProjectRail')>()
  const { SettingsNavigation } = await import('../src/renderer/src/components/SettingsNavigation')
  return { ...original, ProjectRail: (props: React.ComponentProps<typeof original.ProjectRail>) => {
    entry.navigation = useContext(SettingsNavigation); return <original.ProjectRail {...props} />
  } }
})
import { focusEditorAppFixture as app } from './focus-editor-app-navigation.test'
import { useAppStore } from '../src/renderer/src/store'
import { settingsCatalog, settingsModules } from '../src/renderer/src/components/settings/settings-modules'
import { api } from '../src/renderer/src/lib/api'
async function inspect() {
  const result = await useAppStore.getState().executeControl({ schemaVersion: 5, requestId: crypto.randomUUID(), operation: 'inspect.client' })
  if (result.operation !== 'inspect.client') throw Error('The original public client observation is required')
  return result.observation.desktop
}
async function ready() { await vi.waitFor(async () => { await act(async () => {}); expect(app.host.querySelector('.mesh-settings-pane')).not.toBeNull() }, { timeout: 5000 }) }
async function open(field?: string, hostId = 'local') { await act(async () => entry.navigation!.open('hosts', undefined, field, hostId)) }
function sameWork(before: ReturnType<typeof useAppStore.getState>) {
  const after = useAppStore.getState()
  expect(after.config).toBe(before.config); expect(after.agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(after.sessions.find(session => session.id === app.originalAgent.id)!.control).toBe(before.sessions.find(session => session.id === app.originalAgent.id)!.control)
}
it('keeps Mesh directory search available before loading and isolates a failed editor inside actual App', async () => {
  expect(entry.evaluations).toBe(0); entry.mode = 'failed'; entry.attempts = 0
  expect(settingsModules).toHaveLength(33)
  expect(settingsCatalog.searchResults('Mesh network overview').some(result => result.module.id === 'hosts')).toBe(true)
  expect(settingsCatalog.channelEntries.length).toBeGreaterThan(0); expect(entry.evaluations).toBe(0)
  const before = useAppStore.getState(), controls = [vi.spyOn(api.sessions, 'stop'), vi.spyOn(api.sessions, 'write'), vi.spyOn(api.sessions, 'launchAgent')]
  await open('incoming'); await app.until(() => Boolean(app.host.querySelector('[data-settings-editor-state="failed"]')))
  expect((await inspect()).overlays.settingsPage).toMatchObject({ sectionId: 'hosts', visible: false, hostId: null })
  expect(app.host.querySelector('[data-settings-target-issue]')).toBeNull()
  expect(app.host.textContent).toContain('Could not open Mesh settings')
  const back = [...app.host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Back to Overview')!
  await act(async () => back.click()); expect((await inspect()).overlays.settingsPage).toMatchObject({ sectionId: 'overview', visible: true })
  await open(); await app.settle(); expect(entry.attempts).toBe(1)
  expect(controls.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0]); sameWork(before)
})

it('waits for the actual delayed Host in public Settings navigation and retains its editor draft through hiding and closing', async () => {
  entry.mode = 'held'; entry.attempts = 0
  useAppStore.setState(state => ({ config: { ...state.config!, hosts: [...state.config!.hosts,
    { id: 'mesh-draft', kind: 'ssh', label: 'Original draft device', hostname: 'unprepared.invalid' }] } }))
  const before = useAppStore.getState(); let pending!: Promise<unknown>, settled = false
  await act(async () => { pending = useAppStore.getState().executeControl({ schemaVersion: 5, requestId: crypto.randomUUID(), operation: 'focus',
    target: { kind: 'settings', sectionId: 'hosts', hostId: 'local' }, inputPolicy: 'preserve' }).then(value => { settled = true; return value }) })
  await app.until(() => Boolean(app.host.querySelector('[data-settings-editor-state="loading"]')))
  expect((await inspect()).overlays.settingsPage).toMatchObject({ sectionId: 'hosts', visible: false, hostId: null })
  await app.settle(); expect(settled).toBe(false)
  await act(async () => entry.release!()); await ready()
  const receipt = await pending as AgentMuxDesktopFocusResult
  // The original bounded public wait may end before a cold module compiles.
  // Its receipt stays honest; the next original observation reads the real Host.
  expect(receipt.overlays.settingsPage).toMatchObject({ sectionId: 'hosts', hostId: receipt.overlays.settingsPage!.visible ? 'local' : null })
  expect((await inspect()).overlays.settingsPage).toMatchObject({ sectionId: 'hosts', visible: true, hostId: 'local' })
  expect(entry.evaluations).toBe(1)
  await open(undefined, 'mesh-draft'); await ready()
  const mesh = app.host.querySelector('.mesh-settings-pane'), input = app.host.querySelector<HTMLInputElement>('[data-host-name]')!
  expect(input).not.toBeNull()
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Unsaved original Mesh name'); input.dispatchEvent(new Event('input', { bubbles: true })); input.focus(); input.setSelectionRange(2, 9) })
  const attempts = entry.attempts
  await act(async () => entry.navigation!.open('profile')); await app.settle()
  await open(undefined, 'mesh-draft'); await ready()
  expect(app.host.querySelector('.mesh-settings-pane')).toBe(mesh); expect(app.host.querySelector('[data-host-name]')).toBe(input)
  expect(input.value).toBe('Unsaved original Mesh name'); expect([input.selectionStart, input.selectionEnd]).toEqual([2, 9])
  await act(async () => { await useAppStore.getState().executeControl({ schemaVersion: 5, requestId: crypto.randomUUID(), operation: 'focus', target: { kind: 'settings', sectionId: null }, inputPolicy: 'preserve' }) })
  await open(undefined, 'mesh-draft'); await ready(); expect(app.host.querySelector('[data-host-name]')).toBe(input); expect(input.value).toBe('Unsaved original Mesh name')
  expect(entry.attempts).toBe(attempts); sameWork(before)
})

it('delivers the original incoming field once its delayed Mesh editor exists', async () => {
  entry.mode = 'held'; entry.attempts = 0
  await open('incoming'); await app.until(() => Boolean(app.host.querySelector('[data-settings-editor-state="loading"]')))
  expect(app.host.querySelector('[data-settings-target-issue]')).toBeNull()
  await act(async () => entry.release!()); await ready()
  await app.until(() => Boolean(app.host.querySelector('[data-settings-field="incoming"][data-settings-search-highlight]')))
  const target = app.host.querySelector('[data-settings-field="incoming"]')!
  expect(document.activeElement).toBe(target)
  expect(app.host.querySelector('[data-settings-target-issue]')).toBeNull()
  expect((await inspect()).overlays.settingsPage).toMatchObject({ sectionId: 'hosts', hostId: 'local', visible: true })
})

it('keeps later user focus and a later Settings route ahead of the delayed Mesh field', async () => {
  entry.mode = 'held'
  await open('incoming'); await app.until(() => Boolean(app.host.querySelector('[data-settings-editor-state="loading"]')))
  const later = document.body.appendChild(document.createElement('input')); later.value = 'Later user input'
  try {
    await app.settle(); await act(async () => later.focus())
    await act(async () => entry.release!()); await ready()
    expect(document.activeElement).toBe(later); expect(later.value).toBe('Later user input')
    expect(app.host.querySelector('[data-settings-field="incoming"][data-settings-search-highlight]')).toBeNull()
    await act(async () => entry.navigation!.open('profile')); await app.settle()
    expect((await inspect()).overlays.settingsPage).toMatchObject({ sectionId: 'profile', visible: true })
  } finally { later.remove() }
})

it('keeps a later Settings page when the old Mesh module finishes after navigation', async () => {
  entry.mode = 'held'
  const before = useAppStore.getState()
  await open('incoming'); await app.until(() => Boolean(app.host.querySelector('[data-settings-editor-state="loading"]')))
  await act(async () => entry.navigation!.open('profile')); await app.settle()
  await act(async () => entry.release!()); await app.settle()
  expect((await inspect()).overlays.settingsPage).toMatchObject({ sectionId: 'profile', visible: true })
  expect(app.host.querySelector('.mesh-settings-pane')).toBeNull()
  sameWork(before)
})
