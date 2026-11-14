// @vitest-environment happy-dom
import { act, useLayoutEffect, type ReactNode } from 'react'
import { expect, it, vi } from 'vitest'
import type { ReactFlowProps, useStoreApi } from '@xyflow/react'
import type { AgentMuxDesktopFocusResult } from '@agentmux/core/control'

const entry = vi.hoisted(() => {
  const value = { evaluated: [] as string[], attempts: 0, mode: 'ready' as 'ready' | 'held' | 'failed', release: undefined as (() => void) | undefined,
    store: null as ReturnType<typeof useStoreApi> | null,
    load(load: () => Promise<unknown>) {
      value.attempts++
      if (value.mode === 'failed') return Promise.reject(new Error('Private Map module unavailable'))
      if (value.mode === 'held') return new Promise((resolve, reject) => { value.release = () => { void load().then(resolve, reject) } })
      return load()
    } }
  Object.assign(globalThis, { __agentmuxMapEntryFixture: value })
  return value
})
vi.mock('@xyflow/react', async importOriginal => {
  const original = await importOriginal<typeof import('@xyflow/react')>()
  function ObserveStore() { const store = original.useStoreApi(); useLayoutEffect(() => { entry.store = store }, [store]); return null }
  return { ...original, ReactFlow: ({ children, ...props }: ReactFlowProps & { children?: ReactNode }) =>
    <original.ReactFlow {...props}>{children}<ObserveStore /></original.ReactFlow> }
})
import { focusEditorAppFixture as app } from './focus-editor-app-navigation.test'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { installCollaborationCanvasGeometry } from './helpers/collaboration-canvas-dom'
import { installCollaborationLayoutLoopback, settleCollaborationCanvas } from './helpers/collaboration-layout-loopback'

const list = () => app.host.querySelector<HTMLElement>('[data-desktop-focus-view="list"]')!
const map = () => app.host.querySelector<HTMLElement>('[data-desktop-focus-view="map"]')
const back = () => [...app.host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Back to List')!
function unchanged(before: ReturnType<typeof useAppStore.getState>) {
  const after = useAppStore.getState()
  expect(after.tabs).toBe(before.tabs); expect(after.layouts).toBe(before.layouts)
  expect(after.agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(after.sessions.find(session => session.id === app.originalAgent.id)!.control).toBe(before.sessions.find(session => session.id === app.originalAgent.id)!.control)
}
it('keeps a failed Map module local to the actual App and returns to the original List', async () => {
  expect(entry.evaluated).toEqual([])
  entry.mode = 'failed'; entry.attempts = 0
  const originalList = list(), before = useAppStore.getState()
  const controls = [vi.spyOn(api.sessions, 'stop'), vi.spyOn(api.sessions, 'write'), vi.spyOn(api.sessions, 'launchAgent')]
  await act(async () => originalList.querySelector<HTMLButtonElement>('[aria-label="Map"]')!.click())
  await app.until(() => Boolean(app.host.querySelector('[data-loading-phase="failed"]')))
  expect(map()).toBeNull(); expect(entry.evaluated).toEqual([]); expect(entry.attempts).toBe(1)
  expect(app.host.textContent).toContain('Could not open the map')
  expect(app.host.textContent).not.toContain('Retry map')
  await act(async () => back().click()); await app.settle()
  expect(list()).toBe(originalList); expect(originalList.hidden).toBe(false); unchanged(before)
  await act(async () => originalList.querySelector<HTMLButtonElement>('[aria-label="Map"]')!.click())
  await app.settle(); expect(entry.attempts).toBe(1)
  await act(async () => back().click())
  expect(controls.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0])
})

it('loads the real Map through actual App public navigation and keeps its viewport and selected original on reopen', async () => {
  expect(entry.evaluated).toEqual([])
  installCollaborationCanvasGeometry(); installCollaborationLayoutLoopback()
  entry.mode = 'held'; entry.attempts = 0; entry.store = null
  const originalList = list(), before = useAppStore.getState()
  const card = originalList.querySelector<HTMLElement>(`[data-session-id="${app.originalAgent.id}"] strong`)!
  const selectedName = card.textContent!, range = document.createRange(); range.selectNodeContents(card)
  window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range)
  let navigating!: Promise<unknown>, settled = false
  await act(async () => {
    navigating = useAppStore.getState().executeControl({ schemaVersion: 5, requestId: crypto.randomUUID(), operation: 'focus',
      target: { kind: 'surface', surface: 'focus', view: 'map' }, inputPolicy: 'preserve' }).then(result => { settled = true; return result })
  })
  await app.until(() => Boolean(app.host.querySelector('[data-loading-phase="loading"]')))
  expect(map()).toBeNull(); expect(entry.evaluated).toEqual([]); expect(entry.attempts).toBe(1)
  await app.settle(); expect(settled).toBe(false)
  await act(async () => back().click())
  expect(list()).toBe(originalList); expect(originalList.hidden).toBe(false)
  expect(window.getSelection()!.toString()).toBe(selectedName)
  await act(async () => entry.release!())
  await app.settle(); expect(map()).toBeNull(); expect(originalList.hidden).toBe(false)
  const superseded = await navigating as AgentMuxDesktopFocusResult
  expect(superseded.issues.some(issue => issue.code === 'NAVIGATION_CHANGED')).toBe(true)
  entry.mode = 'ready'
  let opened!: Promise<unknown>
  await act(async () => { opened = useAppStore.getState().executeControl({ schemaVersion: 5, requestId: crypto.randomUUID(), operation: 'focus',
    target: { kind: 'surface', surface: 'focus', view: 'map' }, inputPolicy: 'preserve' }) })
  const receipt = await opened as AgentMuxDesktopFocusResult
  expect(receipt.presentation.state).toBe('main-visible')
  await settleCollaborationCanvas(() => { expect(map()).not.toBeNull(); expect(entry.store).not.toBeNull(); expect(map()!.querySelector('.collaboration-agent__mark, .collaboration-agent__dot')).not.toBeNull() })
  expect(new Set(entry.evaluated)).toEqual(new Set(['Map', 'Graph']))
  const originalMap = map()!, originalStore = entry.store!, attempts = entry.attempts
  const mark = originalMap.querySelector<HTMLButtonElement>('[aria-label^="Original saved Agent name ·"]')!
  expect(mark).not.toBeNull(); await act(async () => mark.click())
  expect(mark.getAttribute('aria-pressed')).toBe('true')
  await act(async () => originalStore.setState({ transform: [31, -21, .8] }))
  const viewport = originalStore.getState().transform
  await act(async () => useAppStore.getState().setFocusView('list'))
  expect(originalMap.hidden).toBe(true)
  await act(async () => originalList.querySelector<HTMLButtonElement>('[aria-label="Map"]')!.click())
  await app.settle()
  expect(map()).toBe(originalMap); expect(originalMap.hidden).toBe(false); expect(entry.store).toBe(originalStore)
  expect(entry.store!.getState().transform).toBe(viewport)
  expect(originalMap.querySelector('[aria-pressed="true"][aria-label^="Original saved Agent name ·"]')).not.toBeNull()
  expect(entry.attempts).toBe(attempts); unchanged(before)
  window.getSelection()!.removeAllRanges()
})
