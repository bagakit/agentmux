// @vitest-environment happy-dom
import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
const residency = vi.hoisted(() => ({ mounts: {} as Record<string, number> }))
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: ({ sessionId, linkOrigin }: { sessionId: string; linkOrigin: { tabGroupId: string } }) => {
  useEffect(() => { residency.mounts[sessionId] = (residency.mounts[sessionId] ?? 0) + 1 }, [sessionId])
  return createElement('div', { 'data-session-projection': sessionId, 'data-owner-group': linkOrigin.tabGroupId })
} }))
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'

describe('mounted existing Tab Focus projection', () => {
  const baseline = useAppStore.getState()
  let root: Root
  let home: HTMLDivElement
  let target: HTMLDivElement | undefined

  beforeEach(async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    residency.mounts = {}
    home = document.createElement('div')
    document.body.append(home)
    root = createRoot(home)
    const config = await api.config.get()
    const snapshot = await api.sessions.snapshot()
    const tab = createWorkbenchTab('selected-tab', { regionId: 'selected-region', workspaceId: 'workspace-demo', kind: 'agent', phase: 'attached', sessionId: 'session-codex' })
    const sibling = createWorkbenchTab('sibling-tab', { regionId: 'sibling-region', workspaceId: 'workspace-demo', kind: 'agent', phase: 'attached', sessionId: 'session-claude' })
    useAppStore.setState({ config, sessions: snapshot.sessions, providerCatalog: [], tabs: { [tab.id]: tab, [sibling.id]: sibling }, layouts: { 'workspace-demo': { root: { type: 'leaf', groupId: 'durable-group' }, groups: [{ id: 'durable-group', tabOrder: [tab.id, sibling.id], activeTabId: tab.id, recentTabIds: [tab.id, sibling.id] }], activeGroupId: 'durable-group' } } })
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    home.remove()
    target?.remove()
    target = undefined
    useAppStore.setState(baseline, true)
    vi.restoreAllMocks()
  })
  const mount = () => root.render(createElement(WorkspaceWorkbench, { workspaceId: 'workspace-demo', visible: true, viewTargets: { 'selected-tab': { hostId: 'fixture-focus-target', active: true, visible: true, surface: 'focus', headerPortalTargetId: 'fixture-focus-target-header' } } }))
  function addTarget() {
    target = document.createElement('div')
    target.id = 'fixture-focus-target'
    document.body.append(target)
  }

  it('loads original Regions and keeps their original group address and sibling residency', async () => {
    addTarget()
    await act(async () => mount())
    expect(target!.querySelector('[data-workbench-region-id="selected-region"]')).toBeTruthy()
    expect(target!.querySelector('[data-session-projection="session-codex"]')?.getAttribute('data-owner-group')).toBe('durable-group')
    expect(home.querySelector('[data-workbench-region-id="sibling-region"]')).toBeTruthy()
    expect(home.querySelector('[data-workbench-region-id="sibling-region"]')?.closest('[data-active]')?.getAttribute('data-active')).toBe('false')
    expect(useAppStore.getState().layouts['workspace-demo']!.groups[0]!.tabOrder).toEqual(['selected-tab', 'sibling-tab'])
    const originalRun = useAppStore.getState().sessions.find(session => session.id === 'session-codex')!.control.run.runId
    await act(async () => (target!.querySelector('[data-workbench-region-id="selected-region"]') as HTMLElement).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
    expect(useAppStore.getState().tabs['selected-tab']!.layout.activeRegionId).toBe('selected-region')
    expect(useAppStore.getState().layouts['workspace-demo']!.activeGroupId).toBe('durable-group')
    expect(useAppStore.getState().agentFocus.execution.sessionId).toBe('session-codex')
    expect(useAppStore.getState().sessions.find(session => session.id === 'session-codex')!.control.run.runId).toBe(originalRun)
    expect(residency.mounts).toEqual({ 'session-codex': 1, 'session-claude': 1 })
    await act(async () => useAppStore.getState().focusExecutionSession('session-codex'))
    await act(async () => mount())
    expect(residency.mounts).toEqual({ 'session-codex': 1, 'session-claude': 1 })
  })

  it('keeps a missing durable owner visible as recovery without inventing a group', async () => {
    addTarget()
    const originalTabs = useAppStore.getState().tabs
    useAppStore.setState({ layouts: { 'workspace-demo': { root: { type: 'leaf', groupId: 'durable-group' }, groups: [{ id: 'durable-group', tabOrder: [], activeTabId: null, recentTabIds: [] }], activeGroupId: 'durable-group' } } })
    await act(async () => mount())
    expect(target!.textContent).toContain('Restoring Tab layout')
    expect(target!.querySelector('[data-session-projection]')).toBeNull()
    expect(useAppStore.getState().tabs).toBe(originalTabs)
    expect(useAppStore.getState().sessions.map(session => session.id)).toEqual(['session-codex', 'session-claude'])
  })

  it('waits for a delayed portal target then stops observing unrelated DOM output', async () => {
    const lookup = vi.spyOn(document, 'getElementById')
    await act(async () => mount())
    expect(home.querySelector('[data-session-projection="session-codex"]')).toBeTruthy()
    await act(async () => { addTarget(); await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(target!.querySelector('[data-session-projection="session-codex"]')).toBeTruthy()
    const lookupsAfterAttachment = lookup.mock.calls.length
    await act(async () => { target!.append(document.createElement('span')); await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(lookup.mock.calls.length).toBe(lookupsAfterAttachment)
  })
})
