// @vitest-environment happy-dom
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'

const clock = vi.hoisted(() => ({ time: 100, serial: 0, frames: new Map<number, FrameRequestCallback>() }))
// Only clocks/frame delivery are controlled; App, footer, Store, recorder, snapshot and codec are production.
vi.mock('../src/renderer/src/lib/surface-switch-observation', async importOriginal => {
  const original = await importOriginal<typeof import('../src/renderer/src/lib/surface-switch-observation')>()
  return { ...original, surfaceSwitchObservation: original.createSurfaceSwitchObservation(() => clock.time, () => 1000 + clock.time,
    cb => { clock.frames.set(++clock.serial, cb); return clock.serial }, id => { clock.frames.delete(id) },
    () => document.visibilityState === 'visible') }
})
// Native PTY/editor painting leaves are outside this presentation diagnostic boundary.
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
vi.mock('../src/renderer/src/components/WorkspaceWorkbench', () => ({ WorkspaceWorkbench: () => createElement('textarea', { 'aria-label': 'Original reading draft', defaultValue: 'Original unsent draft' }) }))
vi.mock('../src/renderer/src/components/SurfaceToolDock', () => ({ SurfaceToolDock: () => null }))

import { App } from '../src/renderer/src/App'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { surfaceSwitchObservation } from '../src/renderer/src/lib/surface-switch-observation'
import { rendererPerformance } from '../src/renderer/src/lib/renderer-performance'
import { parseRendererPerformanceSnapshot } from '@agentmux/core/control'
import { isMacPlatform } from '../src/renderer/src/lib/host-platform'

const initial = useAppStore.getState()
let container: HTMLDivElement, root: Root, firstId: number
const records = () => rendererPerformance.snapshot().surfaceSwitches.filter(record => record.id > firstId)
const button = (name: string) => {
  const value = container.querySelector<HTMLButtonElement>(`.window-status-bar button[aria-label^="${name}"]`)
  expect(value, `Actual footer ${name}`).not.toBeNull(); return value!
}
async function frame() {
  expect(clock.frames.size).toBeGreaterThan(0)
  await act(async () => { const [id, cb] = clock.frames.entries().next().value!; clock.frames.delete(id); clock.time += 16; cb(clock.time) })
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); clock.time = 100; clock.frames.clear()
  vi.spyOn(performance, 'now').mockImplementation(() => clock.time)
  surfaceSwitchObservation.ownerDeparted(); firstId = surfaceSwitchObservation.snapshot().at(-1)?.id ?? 0
  const session = composerSession('surface-original'), workspace = composerConfig.workspaces[0]!
  useAppStore.setState({ ...initial, initialize: async () => () => {}, loading: false,
    config: composerConfig, sessions: [{ ...session, workspacePath: workspace.path }], providerCatalog: await api.providers.list(),
    activeWorkspaceId: workspace.id, mainSurface: 'workbench', toolsOpen: false, tabs: {}, layouts: {}, error: null,
    timelines: {}, agentNames: {}, agentComposerDrafts: { [session.id]: 'Original unsent draft' } }, true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => root.render(createElement(App)))
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); useAppStore.setState(initial, true)
  surfaceSwitchObservation.ownerDeparted(); clock.frames.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it('observes the actual footer→Store→App commit→snapshot/strict codec for all five surfaces without changing original work', async () => {
  const before = useAppStore.getState(), draft = container.querySelector<HTMLTextAreaElement>('[aria-label="Original reading draft"]')!
  expect(draft).not.toBeNull(); draft.focus(); draft.setSelectionRange(2, 7)
  for (const [label, internal, publicId] of [['Focus', 'agents', 'focus'], ['Goals', 'board', 'goals'], ['Survey', 'survey', 'survey'], ['Recall', 'recall', 'recall'], ['Space', 'workbench', 'space']] as const) {
    await act(async () => button(label).click())
    expect(useAppStore.getState().mainSurface).toBe(internal)
    const selected = records().at(-1)!
    expect(selected).toMatchObject({ source: 'footer-click', to: publicId, eventAtMonoMs: null, inputDelayMs: null,
      selectedSource: 'layout-effect', selectedMs: expect.any(Number), actionResult: 'returned', frameMs: null, state: 'pending', pendingStage: 'frame' })
    await frame(); expect(records().at(-1)!.frameMs).toBeNull(); await frame()
    expect(records().at(-1)).toMatchObject({ state: 'observed', frameMs: 32, pendingStage: null })
  }
  expect(records()).toHaveLength(5)
  expect(records().map(record => [record.from, record.to])).toEqual([['space', 'focus'], ['focus', 'goals'], ['goals', 'survey'], ['survey', 'recall'], ['recall', 'space']])
  expect(parseRendererPerformanceSnapshot(rendererPerformance.snapshot()).surfaceSwitches).toEqual(rendererPerformance.snapshot().surfaceSwitches)
  const after = useAppStore.getState()
  expect(after.sessions).toBe(before.sessions); expect(after.sessions[0]!.control).toBe(before.sessions[0]!.control)
  expect(after.tabs).toBe(before.tabs); expect(after.layouts).toBe(before.layouts); expect(after.agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(container.querySelector('[aria-label="Original reading draft"]')).toBe(draft)
  expect(draft.value).toBe('Original unsent draft'); expect([draft.selectionStart, draft.selectionEnd]).toEqual([2, 7])
})

it('uses a prior actual same-target commit, cancels quick switches, and never labels programmatic navigation footer activation', async () => {
  await act(async () => button('Space').click())
  expect(records()[0]).toMatchObject({ from: 'space', to: 'space', selectedSource: 'already-committed-handler', selectedMs: 0 })
  await frame(); const stale = [...clock.frames.values()][0]!
  await act(async () => { button('Focus').click(); button('Goals').click() })
  expect(records()[0]).toMatchObject({ state: 'superseded', frameMs: null })
  expect(records()[1]).toMatchObject({ to: 'focus', state: 'superseded', selectedMs: null })
  expect(records()[2]).toMatchObject({ from: 'focus', to: 'goals', selectedSource: 'layout-effect', frameMs: null })
  stale(clock.time); expect(records()[2]!.frameMs).toBeNull()
  await act(async () => useAppStore.getState().setMainSurface('recall'))
  expect(records()).toHaveLength(3); expect(records()[2]).toMatchObject({ state: 'superseded', frameMs: null })
  expect(clock.frames.size).toBe(0)
})

it('waits through actual Settings/quick switch/loading/document coverage and freezes on root owner departure', async () => {
  await act(async () => button('Focus').click())
  await act(async () => button('Settings').click())
  expect(records()[0]).toMatchObject({ state: 'pending', pendingStage: 'presentation', frameMs: null })
  expect(clock.frames.size).toBe(0)
  await act(async () => button('Settings').click())
  expect(clock.frames.size).toBe(1)
  const chord = isMacPlatform() ? { metaKey: true } : { ctrlKey: true, shiftKey: true }
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ...chord, bubbles: true })))
  // The original global router owns quick-switcher semantics; only its actual overlay commit counts.
  const quick = document.querySelector('.quick-switch')
  expect(quick, 'Actual original QuickSwitcher overlay').not.toBeNull()
  expect(records()[0]!.pendingStage).toBe('presentation'); expect(clock.frames.size).toBe(0)
  await act(async () => quick!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(document.querySelector('.quick-switch')).toBeNull()
  await act(async () => useAppStore.setState({ loading: true }))
  expect(records()[0]!.pendingStage).toBe('presentation'); expect(clock.frames.size).toBe(0)
  await act(async () => useAppStore.setState({ loading: false }))
  const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  expect(clock.frames.size).toBe(0); expect(records()[0]!.frameMs).toBeNull()
  hidden.mockRestore(); await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  expect(clock.frames.size).toBe(1)
  const current = [...clock.frames.values()][0]!
  await act(async () => root.render(null))
  expect(records()[0]).toMatchObject({ state: 'superseded', frameMs: null }); expect(clock.frames.size).toBe(0)
  current(clock.time); expect(records()[0]!.frameMs).toBeNull()
})
