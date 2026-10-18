// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useCollaborationMotion } from '../src/renderer/src/lib/use-collaboration-motion'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { focusSettingsModule } from '../src/renderer/src/components/settings/modules/focus'
import { settingsCatalog } from '../src/renderer/src/components/settings/settings-modules'
import { applyConfigEdit } from '../src/shared/config-edit'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
import type { AppConfig } from '../src/shared/contracts'
import type { AppWindowDescriptor } from '@agentmux/core/control'
import { WorkbenchDocumentContext } from '../src/renderer/src/lib/workbench-document'
import { observeWorkbenchNativeVisibility, registerWorkbenchDocument } from '../src/renderer/src/lib/workbench-window-registry'

const dom = composerDOM(), Pane = focusSettingsModule.Pane
let releaseDocument: () => void
beforeEach(() => { releaseDocument = registerWorkbenchDocument(document, { windowId: 'main', documentGeneration: 'main-document' }) })
afterEach(() => releaseDocument())
function Control({ active = true }: { active?: boolean }) {
  const motion = useCollaborationMotion(active)
  return <><button data-motion={motion.enabled} data-preference={motion.preference} aria-busy={motion.saving}
    disabled={motion.saving} onClick={() => void motion.setEnabled(!motion.enabled)}>Motion</button>{motion.issue ? <p role="alert">{motion.issue}</p> : null}</>
}
function media(initial = false, owner = document) {
  const listeners = new Set<() => void>()
  let matches = initial
  const query = { get matches() { return matches }, addEventListener: vi.fn((_name: string, listener: () => void) => listeners.add(listener)), removeEventListener: vi.fn((_name: string, listener: () => void) => listeners.delete(listener)) }
  vi.spyOn(owner.defaultView!, 'matchMedia').mockReturnValue(query as unknown as MediaQueryList)
  return { listeners, query, change: async (next: boolean) => { await act(async () => { matches = next; for (const listener of [...listeners]) listener() }) } }
}
const enabled = () => dom.container.querySelector('button')?.getAttribute('data-motion') === 'true'
function savedOwner() {
  let current: AppConfig = { ...composerConfig }
  const save = vi.spyOn(api.config, 'save').mockImplementation(async (value, expected) => {
    current = applyConfigEdit(current, expected, value); useAppStore.setState({ config: current }); return current
  })
  return { save, get current() { return current }, async external(config: AppConfig) { current = config; await act(async () => useAppStore.setState({ config })) } }
}

it('follows the current document system preference, lets explicit choices override it and releases hidden motion observation', async () => {
  const system = media(true), owner = savedOwner()
  await dom.render(<Control />)
  expect(enabled()).toBe(false); expect(system.listeners.size).toBe(1)
  await system.change(false); expect(enabled()).toBe(true)
  await system.change(true); expect(enabled()).toBe(false)
  await dom.click('button')
  expect(owner.current.focus?.mapMotion).toBe('on'); expect(enabled()).toBe(true); expect(system.listeners.size).toBe(0)
  await dom.click('button')
  expect(owner.current.focus?.mapMotion).toBe('off'); expect(enabled()).toBe(false)
  await owner.external({ ...owner.current, focus: { recentActivityHours: 48, mapMotion: 'system' } })
  expect(system.listeners.size).toBe(1)
  await dom.render(<Control active={false} />)
  expect(system.listeners.size).toBe(0); expect(enabled()).toBe(false)
  await system.change(false)
  await dom.render(<Control />)
  expect(system.listeners.size).toBe(1); expect(enabled()).toBe(true)
  const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  expect(enabled()).toBe(false); expect(system.listeners.size).toBe(0)
  hidden.mockReturnValue('visible')
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  expect(enabled()).toBe(true); expect(system.listeners.size).toBe(1)
  await dom.render(<div />); expect(system.listeners.size).toBe(0)
})

it('moves motion observation with the actual workbench document and honors exact native window visibility', async () => {
  const frame = document.createElement('iframe'); document.body.append(frame)
  const child = frame.contentDocument!, originalMedia = media(false), childMedia = media(true, child)
  const identity = { windowId: 'motion-child', documentGeneration: 'motion-child-document' }
  const releaseChild = registerWorkbenchDocument(child, identity)
  const descriptor = (presentation: AppWindowDescriptor['presentation'], documentGeneration = identity.documentGeneration): AppWindowDescriptor => ({ ...identity, documentGeneration,
    target: { kind: 'tab', displayWorkspaceId: 'workspace', groupId: 'group', tabId: 'tab' }, presentation, bounds: null, focused: null })
  const render = (owner: Document) => dom.render(<WorkbenchDocumentContext.Provider value={{ document: owner, window: owner === child ? identity : null }}><Control /></WorkbenchDocumentContext.Provider>)
  try {
    await render(document); expect(enabled()).toBe(true); expect(originalMedia.listeners.size).toBe(1)
    await render(child); expect(enabled()).toBe(false); expect(originalMedia.listeners.size).toBe(0); expect(childMedia.listeners.size).toBe(1)
    await childMedia.change(false); expect(enabled()).toBe(true)
    await act(async () => observeWorkbenchNativeVisibility([descriptor('hidden', 'unrelated-generation')]))
    expect(enabled()).toBe(true); expect(childMedia.listeners.size).toBe(1)
    await act(async () => observeWorkbenchNativeVisibility([descriptor('hidden')]))
    expect(enabled()).toBe(false); expect(childMedia.listeners.size).toBe(0)
    expect(child.visibilityState).toBe('visible')
    await act(async () => observeWorkbenchNativeVisibility([descriptor('visible')]))
    expect(enabled()).toBe(true); expect(childMedia.listeners.size).toBe(1)
    await render(document); expect(enabled()).toBe(true); expect(originalMedia.listeners.size).toBe(1); expect(childMedia.listeners.size).toBe(0)
  } finally { await dom.render(<div />); releaseChild(); frame.remove() }
})

it('shows an actual rejected or unconfirmed motion save without false success, and permits a scoped retry', async () => {
  media(false)
  const save = vi.spyOn(api.config, 'save').mockRejectedValue(new Error('Motion save could not be confirmed. Retry after checking configuration.'))
  await dom.render(<Control />); expect(enabled()).toBe(true)
  await dom.click('button')
  expect(dom.container.querySelector('[role="alert"]')?.textContent).toContain('could not be confirmed')
  expect(enabled()).toBe(true); expect(dom.container.querySelector('button')?.disabled).toBe(false)
  expect(useAppStore.getState().config?.focus).toBeUndefined()
  save.mockImplementation(async (next, expected) => {
    const config = applyConfigEdit(useAppStore.getState().config!, expected, next)
    useAppStore.setState({ config }); return config
  })
  await dom.click('button')
  expect(enabled()).toBe(false); expect(dom.container.querySelector('[role="alert"]')).toBeNull()
  expect(save.mock.calls.map(([, expected]) => expected.focus?.mapMotion)).toEqual(['system', 'system'])
})

it('keeps one pending toggle and retains concurrent unrelated settings through the original authored merge', async () => {
  media(false)
  let finish!: () => void
  const save = vi.spyOn(api.config, 'save').mockImplementation((next, expected) => new Promise(resolve => {
    finish = () => { const config = applyConfigEdit(useAppStore.getState().config!, expected, next); useAppStore.setState({ config }); resolve(config) }
  }))
  await dom.render(<Control />)
  await dom.click('button')
  expect(dom.container.querySelector('button')?.getAttribute('aria-busy')).toBe('true')
  expect(enabled()).toBe(true)
  await dom.click('button'); expect(save).toHaveBeenCalledOnce()
  await act(async () => useAppStore.setState({ config: { ...composerConfig, copyPathsAsAbsolute: true, focus: { recentActivityHours: 72, replyLines: 3 } } }))
  await act(async () => finish())
  expect(useAppStore.getState().config?.focus).toEqual({ recentActivityHours: 72, replyLines: 3, mapMotion: 'off' })
  expect(useAppStore.getState().config?.copyPathsAsAbsolute).toBe(true)
  expect(enabled()).toBe(false)
})

it('finds map motion in the original settings catalogue and restores system through the real Focus editor', async () => {
  media(true)
  const owner = savedOwner()
  await owner.external({ ...composerConfig, focus: { recentActivityHours: 24, replyLines: 3, mapMotion: 'on' } })
  const results = settingsCatalog.searchResults('reduced')
  expect(results.some(result => result.module.id === 'focus' && result.targets.some(target => target.id === 'map-motion'))).toBe(true)
  await dom.render(<Pane config={owner.current} active onClose={() => {}} onNavigate={() => {}} />)
  const field = dom.container.querySelector('[data-settings-field="map-motion"]')!
  expect(field).not.toBeNull()
  expect(field.querySelector<HTMLInputElement>('input[value="on"]')?.checked).toBe(true)
  await dom.click('input[name="focus-map-motion"][value="system"]')
  expect(owner.save).not.toHaveBeenCalled()
  await owner.external({ ...owner.current, copyPathsAsAbsolute: true, focus: { ...owner.current.focus!, recentInputs: 10 } })
  await dom.click('[data-settings-save-bar] button')
  expect(owner.current.focus).toEqual({ recentActivityHours: 24, replyLines: 3, recentInputs: 10, mapMotion: 'system' })
  expect(owner.current.copyPathsAsAbsolute).toBe(true)
  await dom.render(<Control />); expect(enabled()).toBe(false)
})
