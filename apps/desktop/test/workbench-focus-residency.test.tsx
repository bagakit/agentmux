// @vitest-environment happy-dom
import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
const lifetime = vi.hoisted(() => ({ mounts: {} as Record<string, number>, unmounts: {} as Record<string, number> }))
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: ({ sessionId, linkOrigin }: { sessionId: string; linkOrigin: { tabGroupId: string } }) => {
  useEffect(() => { lifetime.mounts[sessionId] = (lifetime.mounts[sessionId] ?? 0) + 1; return () => { lifetime.unmounts[sessionId] = (lifetime.unmounts[sessionId] ?? 0) + 1 } }, [sessionId])
  return createElement('div', { 'data-session': sessionId, 'data-owner': linkOrigin.tabGroupId })
} }))
// Load the installed browser primary so original real Panel registration precedes layout effects.
vi.mock('react-resizable-panels', async () => {
  const { createRequire } = await import('node:module')
  return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js')
})
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'
const baseline = useAppStore.getState()
let root: Root, home: HTMLDivElement, target: HTMLDivElement
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  lifetime.mounts = {}; lifetime.unmounts = {}
  home = document.createElement('div'); target = document.createElement('div'); target.id = 'focus-fixture'
  document.body.append(home, target); root = createRoot(home)
  const config = await api.config.get(), snapshot = await api.sessions.snapshot()
  const tabs = Object.fromEntries([['a', 'session-codex'], ['b', 'session-claude'], ['parked', 'session-parked']].map(([id, sessionId]) => [id, createWorkbenchTab(id!, { regionId: `${id}:region`, kind: 'agent', phase: 'attached', workspaceId: 'workspace-demo', sessionId: sessionId! })]))
  useAppStore.setState({ config, sessions: [...snapshot.sessions, { ...snapshot.sessions[0]!, id: 'session-parked' }], providerCatalog: [], tabs, layouts: { 'workspace-demo': { root: { type: 'split', direction: 'horizontal', ratio: .45, first: { type: 'leaf', groupId: 'left' }, second: { type: 'leaf', groupId: 'right' } }, groups: [{ id: 'left', tabOrder: ['a', 'parked'], activeTabId: 'a', recentTabIds: ['a', 'parked'] }, { id: 'right', tabOrder: ['b'], activeTabId: 'b', recentTabIds: ['b'] }], activeGroupId: 'left' } } })
})
afterEach(async () => { await act(async () => root.unmount()); home.remove(); target.remove(); useAppStore.setState(baseline, true); vi.restoreAllMocks() })
const render = (focusTabId: string | null) => act(async () => root.render(createElement(WorkspaceWorkbench, { workspaceId: 'workspace-demo', visible: true, viewTargets: focusTabId ? { [focusTabId]: { hostId: 'focus-fixture', active: true, visible: true, surface: 'focus' } } : {} })))
it('moves existing DOM between Space and selected Focus tabs without touching split identity or lifetime', async () => {
  const layout = useAppStore.getState().layouts['workspace-demo']
  await render(null)
  const a = home.querySelector('[data-session="session-codex"]'), b = home.querySelector('[data-session="session-claude"]'), parked = home.querySelector('[data-session="session-parked"]')
  expect([a?.getAttribute('data-owner'), b?.getAttribute('data-owner'), parked?.getAttribute('data-owner')]).toEqual(['left', 'right', 'left'])
  await render('a'); expect(target.querySelector('[data-session]')).toBe(a); expect(home.contains(b)).toBe(true); expect(home.contains(parked)).toBe(true)
  await render('b'); expect(target.querySelector('[data-session]')).toBe(b); expect(home.contains(a)).toBe(true)
  await render(null); expect(home.contains(a)).toBe(true); expect(home.contains(b)).toBe(true); expect(target.childElementCount).toBe(0)
  expect(lifetime.mounts).toEqual({ 'session-codex': 1, 'session-claude': 1, 'session-parked': 1 }); expect(lifetime.unmounts).toEqual({})
  expect(useAppStore.getState().layouts['workspace-demo']).toBe(layout)
})
it('retains the healthy mounted work surface during a missing owner/layout handshake and recovers', async () => {
  await render('a'); const view = target.querySelector('[data-session]'), layout = useAppStore.getState().layouts['workspace-demo']!
  await act(async () => useAppStore.setState({ layouts: {} }))
  expect(target.querySelector('[data-session]')).toBe(view); expect(target.textContent).toContain('still restoring')
  await act(async () => useAppStore.setState({ layouts: { 'workspace-demo': { ...layout, groups: layout.groups.map(group => ({ ...group, tabOrder: [] })) } } }))
  expect(target.querySelector('[data-session]')).toBe(view)
  await act(async () => useAppStore.setState({ layouts: { 'workspace-demo': layout } }))
  expect(target.querySelector('[data-session]')).toBe(view); expect(target.textContent).not.toContain('still restoring'); expect(lifetime.unmounts).toEqual({})
})
