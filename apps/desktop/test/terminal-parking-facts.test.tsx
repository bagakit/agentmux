const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, useMemo } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { create } from 'zustand'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createWorkbenchTab, workspaceRootForPath, type WorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import * as visibility from '../src/renderer/src/lib/surface-navigation-visibility'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({ store: undefined as ReturnType<typeof create> | undefined, maps: [] as Map<unknown, unknown>[] }))
vi.mock('../src/renderer/src/store', () => ({ useAppStore: (selector: (state: unknown) => unknown) => mocks.store!(selector as never) }))
vi.mock('react', async (original) => {
  const react = await original<typeof import('react')>()
  return { ...react, useRef: <T,>(value: T) => {
    const ref = react.useRef(value)
    if (ref.current instanceof Map && !mocks.maps.includes(ref.current)) mocks.maps.push(ref.current)
    return ref
  } }
})
import { useTerminalColdParking, createTerminalParkingSessionSelector } from '../src/renderer/src/lib/terminal-cold-parking-coordinator'

declare const __AGENTMUX_TERMINAL_VIEW_SOURCE__: string | undefined
const source = typeof __AGENTMUX_TERMINAL_VIEW_SOURCE__ === 'string' ? __AGENTMUX_TERMINAL_VIEW_SOURCE__ : readFileSync(resolve('apps/desktop/src/renderer/src/components/TerminalView.tsx'), 'utf8')
const syntax = ts.createSourceFile('TerminalView.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function declaration(name: string): string {
  let found: ts.VariableDeclaration | undefined
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) found = node
    ts.forEachChild(node, visit)
  }
  visit(syntax); expect(found, 'actual Terminal declaration ' + name).toBeDefined()
  return ts.transpileModule('const ' + found!.getText(syntax), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
}
const roots: Root[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await act(() => root.unmount())
  mocks.maps.length = 0; vi.restoreAllMocks()
})
function mount(component: ReturnType<typeof createElement>) {
  const host = document.createElement('div'), root = createRoot(host); roots.push(root)
  return act(() => root.render(component))
}
function session(id: string, changes: Record<string, unknown> = {}): SessionSnapshot {
  const kind = changes.kind === 'agent' ? 'agent' : 'terminal'
  const control = kind === 'agent' ? { kind, hostId: 'local', agentSessionId: id, run: { runId: 'run:' + id } } : { kind, hostId: 'local', runId: id, run: { runId: 'run:' + id } }
  return { id, kind, control, hostId: 'local', workspacePath: _hygiene_fixturePath("repo"), processState: 'running', status: { state: 'running' }, ...changes } as SessionSnapshot
}
function tab(id: string) { return createWorkbenchTab(id, { regionId: 'region:' + id, kind: 'terminal', phase: 'attached', workspaceId: 'repo', sessionId: id }) }

describe('production Terminal related parking facts', () => {
  it('actual Terminal directory declarations skip unrelated changes and invalidate own path/host/config', async () => {
    let walks = 0, finds = 0
    const workspaces = [{ id: 'repo', hostId: 'local', path: _hygiene_fixturePath("repo"), name: 'Repo', kind: 'folder' as const }, { id: 'sub', hostId: 'local', path: _hygiene_fixturePath("repo/sub"), name: 'Sub', kind: 'folder' as const }]
    const originalFind = workspaces.find.bind(workspaces)
    workspaces.find = ((predicate: Parameters<typeof workspaces.find>[0], thisArg?: unknown) => { finds++; return originalFind(predicate, thisArg) }) as typeof workspaces.find
    const config = { workspaces } as unknown as AppConfig
    const store = create(() => ({ config, other: 0 })); mocks.store = store as never
    const rootPath = vi.fn((c: AppConfig, s: SessionSnapshot) => { walks++; return workspaceRootForPath(c, s) })
    const renderDeclarations = new Function('useAppStore', 'useMemo', 'workspaceRootForPath', 'session', 'linkOrigin',
      declaration('terminalConfig') + declaration('workspaceIsLocal') + declaration('activeWorkspaceRoot') + 'return { workspaceIsLocal, activeWorkspaceRoot };')
    let value: { workspaceIsLocal: boolean; activeWorkspaceRoot: string } | undefined
    function Probe({ own }: { own: SessionSnapshot }) {
      // Force parent renders as well as notifications; local memo must protect both boundaries.
      store(state => state.other)
      value = renderDeclarations(store, useMemo, rootPath, own, { workspaceId: 'repo' })
      return createElement('output', null, value!.activeWorkspaceRoot)
    }
    const own = session('s'); await mount(createElement(Probe, { own }))
    const initial = { walks, finds }
    for (let i = 1; i <= 20; i++) await act(() => store.setState({ other: i }))
    expect({ walks, finds }).toEqual(initial)
    expect(value).toEqual({ workspaceIsLocal: true, activeWorkspaceRoot: _hygiene_fixturePath("repo") })
    await act(() => roots[0]!.render(createElement(Probe, { own: { ...own, workspacePath: _hygiene_fixturePath("repo/sub/dir") } })))
    expect(value!.activeWorkspaceRoot).toBe(_hygiene_fixturePath("repo/sub")); expect(walks).toBe(initial.walks + 1)
    await act(() => roots[0]!.render(createElement(Probe, { own: { ...own, hostId: 'other' } })))
    expect(value!.activeWorkspaceRoot).toBe('')
    await act(() => store.setState({ config: { ...config, workspaces: [{ ...workspaces[0]!, hostId: 'other' }] } }))
    expect(value).toEqual({ workspaceIsLocal: false, activeWorkspaceRoot: _hygiene_fixturePath("repo") })
  })

  it('actual mounted coordinator skips unrelated Session clocks/Browser facts and follows related health/visibility/removal', async () => {
    const a = tab('a'), b = tab('b')
    const browser = createWorkbenchTab('browser', { regionId: 'browser-region', kind: 'browser', workspaceId: 'repo', browserId: 'original-browser' } as never)
    const store = create(() => ({ tabs: { a, b, browser } as Record<string, WorkbenchTab>, layouts: { repo: createWorkspaceLayout('group', ['a', 'b', 'browser']) }, sessions: [session('a'), session('b')], activeWorkspaceId: 'repo' }))
    mocks.store = store as never
    const spy = vi.spyOn(visibility, 'surfaceNavigationVisibility')
    let parked: ReadonlySet<string> = new Set()
    function Probe() { parked = useTerminalColdParking({ workbenchVisible: true }); return createElement('output', null, parked.size) }
    await mount(createElement(Probe)); const calls = spy.mock.calls.length
    for (let i = 0; i < 20; i++) await act(() => store.setState(state => ({ sessions: state.sessions.map(s => ({ ...s, updatedAt: i })), tabs: { ...state.tabs, browser: { ...browser, regions: Object.fromEntries(Object.entries(browser.regions).map(([id, r]) => [id, { ...r, title: 'Transient ' + i }])) } } })))
    expect(spy).toHaveBeenCalledTimes(calls)
    await act(() => store.setState(state => ({ sessions: state.sessions.map(s => s.id === 'b' ? { ...s, processState: 'exited', status: { ...s.status, state: 'exited' } } : s) })))
    expect(spy.mock.calls.length).toBeGreaterThan(calls)
    const beforeProjection = spy.mock.calls.length
    await act(() => store.setState(state => ({ layouts: { repo: { ...state.layouts.repo, groups: state.layouts.repo.groups.map(g => ({ ...g, activeTabId: 'b' })) } } })))
    expect(spy.mock.calls.length).toBeGreaterThan(beforeProjection)
    expect(parked.size).toBe(0)
    await act(() => store.setState({ tabs: {}, sessions: [] }))
    expect(mocks.maps).toHaveLength(3)
    expect(mocks.maps.map(map => map.size)).toEqual([0, 0, 0])
  })

  it('parking fact projection follows pending, health, missing and reappearing authority without timestamp churn', () => {
    const select = createTerminalParkingSessionSelector(['s'])
    const own = session('s', { kind: 'agent' }) as Extract<SessionSnapshot, { kind: 'agent' }>
    const first = select({ sessions: [own] })
    expect(select({ sessions: [{ ...own, updatedAt: 99 }] })).toBe(first)
    const newRun = select({ sessions: [{ ...own, control: { ...own.control, run: { runId: 'next-run' } } }] })
    expect(newRun).not.toBe(first)
    expect(newRun[0]!.runId).toBe('next-run')
    const newHost = select({ sessions: [{ ...own, control: { ...own.control, hostId: 'other' } }] })
    expect(newHost).not.toBe(newRun)
    expect(newHost[0]!.hostId).toBe('other')
    const terminal = select({ sessions: [session('s')] })
    expect(terminal[0]!.kind).toBe('terminal')
    expect(select({ sessions: [own] })[0]!.kind).toBe('agent')
    const pending = select({ sessions: [{ ...own, pendingInteraction: { requestId: 'question' } } as unknown as SessionSnapshot] })
    expect(pending[0]!.hasPendingInteraction).toBe(true)
    expect(select({ sessions: [own] })[0]!.hasPendingInteraction).toBe(false)
    expect(select({ sessions: [{ ...own, processState: 'exited', status: { ...own.status, state: 'exited' } }] })[0]!.canRebuild).toBe(false)
    expect(select({ sessions: [] })).toEqual([])
    expect(select({ sessions: [own] })[0]!.canRebuild).toBe(true)
  })

  it('visible-close and hidden-close release all primitive owners but context switches retain warm Regions', async () => {
    const a = tab('a'), b = tab('b')
    const store = create(() => ({ tabs: { a, b } as Record<string, WorkbenchTab>, layouts: { repo: createWorkspaceLayout('group', ['a', 'b']) }, sessions: [session('a'), session('b')], activeWorkspaceId: 'repo' }))
    mocks.store = store as never
    function Probe() { useTerminalColdParking({ workbenchVisible: true }); return null }
    await mount(createElement(Probe)); expect(mocks.maps.map(map => map.size)).toEqual([1, 1, 2])
    await act(() => store.setState({ activeWorkspaceId: 'another-project' }))
    expect(mocks.maps[2]!.size).toBe(2)
    await act(() => store.setState({ tabs: {} }))
    expect(mocks.maps.map(map => map.size)).toEqual([0, 0, 0])
    for (let i = 0; i < 30; i++) {
      await act(() => store.setState({ tabs: { a }, activeWorkspaceId: 'repo' }))
      await act(() => store.setState({ tabs: {} }))
    }
    expect(mocks.maps.map(map => map.size)).toEqual([0, 0, 0])
  })
})
