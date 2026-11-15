// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { applyConfigEdit } from '../src/shared/config-edit'
import { parseFocusProjects } from '../src/shared/focus-project-preferences'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '@agentmux/layout'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import { initializeSpatialControlFixture } from './helpers/spatial-control-owner-fixture'
import { configOwnerFixture } from './helpers/config-owner-fixture'
import { executeSettingsControl } from '../src/main/settings-control'
import { createFocusCardViewport, FocusContextCards } from '../src/renderer/src/components/FocusContextCards'
import { agentContextForSession } from '../src/renderer/src/lib/focus-context'
import { createRef } from 'react'
vi.mock('electron', async () => { const { tmpdir } = await import('node:os'); return { app: { getPath: () => tmpdir() } } })
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))
const dom = composerDOM()
const key = (id: string) => JSON.stringify(['local', id])
const preference = (id: string) => ({ key: key(id), pinned: true, note: '', color: 'blue' as const, collapsed: null })
async function scene(quiet = false) {
  const workspaces = ['one', 'two', 'three'].map(id => ({ ...composerConfig.workspaces[0]!, id, name: id, path: composerConfig.workspaces[0]!.path + '/' + id }))
  const sessions = workspaces.map(workspace => {
    const state = quiet ? workspace.id === 'two' ? 'running' as const : 'done' as const : 'working' as const
    const status = { state, source: 'native-hook' as const, observedAt: Date.now() }
    return { ...composerSession(workspace.id), workspacePath: workspace.path, status,
      semanticStatus: { ...status, ...(quiet && workspace.id !== 'two' ? { stateEnteredAt: Date.now() - 4 * 86400000 } : {}) } }
  })
  const tabs = Object.fromEntries(workspaces.map(workspace => { const tab = createWorkbenchTab('tab-' + workspace.id, { kind: 'agent', phase: 'attached', regionId: 'r-' + workspace.id, workspaceId: workspace.id, sessionId: workspace.id }); return [tab.id, tab] }))
  useAppStore.setState({ config: { ...composerConfig, workspaces, focus: { recentActivityHours: 48, projects: [preference('one'), preference('two')] } },
    mainSurface: 'agents', sessions, tabs, layouts: Object.fromEntries(workspaces.map(workspace => [workspace.id, createWorkspaceLayout('g-' + workspace.id, ['tab-' + workspace.id])])),
    timelines: {}, agentNames: {}, agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } } })
  vi.spyOn(api.spatial, 'read').mockResolvedValue({ schemaVersion: 1, revision: 1, graph: desktopSpatialGraph(useAppStore.getState(), []) })
  await initializeSpatialControlFixture()
  const save = vi.spyOn(api.config, 'save').mockImplementation(async (next, expected) => {
    parseFocusProjects(next.focus?.projects)
    return applyConfigEdit(useAppStore.getState().config!, expected!, next)
  })
  await dom.render(<GlobalFocusSurface />)
  return { save, before: useAppStore.getState() }
}
function rows() { return [...dom.container.querySelectorAll<HTMLElement>('[data-project-id][data-lane-id]')] }
function button(label: string) { const element = document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`); expect(element).not.toBeNull(); return element! }
async function click(label: string) { await act(async () => button(label).click()) }

it('the actual Focus consumer persists exact pin order by keyboard and drag without replacing workface or Runs', async () => {
  const { before } = await scene()
  expect(rows().map(row => row.dataset.projectId)).toEqual(['one', 'two', 'three'])
  const original = dom.container.querySelector('[data-session-id="one"]')
  await act(async () => button('Reorder pinned project · two').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true })))
  expect(rows().map(row => row.dataset.projectId)).toEqual(['two', 'one', 'three'])
  const transfer = new DataTransfer()
  const drag = (type: string) => { const event = new Event(type, { bubbles: true, cancelable: true }); Object.defineProperty(event, 'dataTransfer', { value: transfer }); return event }
  await act(async () => button('Reorder pinned project · one').dispatchEvent(drag('dragstart')))
  await act(async () => rows()[0]!.dispatchEvent(drag('drop')))
  expect(rows().map(row => row.dataset.projectId)).toEqual(['one', 'two', 'three'])
  expect(dom.container.querySelector('[data-session-id="one"]')).toBe(original)
  for (const field of ['sessions', 'tabs', 'layouts', 'agentFocus', 'agentComposerDrafts'] as const) expect(useAppStore.getState()[field]).toBe(before[field])
})

it('actual project editing retains a failed draft, saves note/color to ConfigOwner and isolates original identity', async () => {
  const { save, before } = await scene()
  await click('Project preferences · one')
  const input = document.querySelector<HTMLInputElement>('[aria-label="Project note"]')!
  expect(input).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Daily route')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await click('Project color · violet')
  save.mockRejectedValueOnce(Error('Private disk unavailable'))
  await click('Save project preferences')
  expect(document.querySelector('[data-focus-project-preferences]')?.textContent).toContain('Private disk unavailable')
  expect(input.value).toBe('Daily route')
  await click('Save project preferences')
  expect(useAppStore.getState().config?.focus?.projects?.find(item => item.key === key('one'))).toMatchObject({ pinned: true, note: 'Daily route', color: 'violet' })
  expect(rows()[0]!.dataset.focusProjectColor).toBe('violet')
  expect(rows()[0]!.querySelector('[data-focus-project-note]')?.textContent).toBe('Daily route')
  expect(useAppStore.getState().config?.focus?.projects?.find(item => item.key === key('two'))).toEqual(preference('two'))
  for (const field of ['sessions', 'tabs', 'layouts', 'agentFocus', 'agentComposerDrafts'] as const) expect(useAppStore.getState()[field]).toBe(before[field])
})

it('the public settings owner validates and durably retains project preferences without changing runtime settings', async () => {
  const f = await configOwnerFixture()
  const projects = [preference('one'), { ...preference('one'), key: JSON.stringify(['remote', 'one']), note: 'Other machine', color: 'green' as const }]
  const reply = await executeSettingsControl({ schemaVersion: 5, requestId: 'personal-projects', operation: 'settings.set', key: 'focus.projects', value: JSON.stringify(projects) }, f.owner)
  expect(reply).toMatchObject({ operation: 'settings.set', entry: { key: 'focus.projects', value: JSON.stringify(projects) } })
  expect((await f.disk()).focus?.projects).toEqual(projects)
  expect(f.owner.current.workspaces).toEqual(f.store.validate(f.owner.current).workspaces)
  const saved = await f.bytes()
  for (const invalid of [[projects[0], projects[0]], [{ ...projects[0], color: 'neon' }], [{ ...projects[0], key: 'one' }], [{ ...projects[0], extra: true }]]) {
    await expect(executeSettingsControl({ schemaVersion: 5, requestId: 'invalid-projects', operation: 'settings.set', key: 'focus.projects', value: JSON.stringify(invalid) }, f.owner)).rejects.toThrow()
    expect(await f.bytes()).toBe(saved)
  }
})

it('the actual scan compacts only known old quiet projects, preserves pinned and unknown work and exposes the original search target', async () => {
  const { before } = await scene(true)
  const old = rows().find(row => row.dataset.projectId === 'three')!
  expect(old.dataset.collapsed).toBe('true')
  expect(rows().find(row => row.dataset.projectId === 'one')!.dataset.collapsed).toBeUndefined()
  expect(rows().find(row => row.dataset.projectId === 'two')!.dataset.collapsed).toBeUndefined()
  expect(old.querySelector('.focus-project-lanes__status-rail')?.textContent).toContain('1')
  const slot = old.querySelector<HTMLElement>('[data-focus-card-key]')!
  expect(slot.dataset.focusCardBody).toBe('pending')
  expect(old.querySelector('[data-focus-heat]')?.getAttribute('data-focus-heat')).toBe('cool')
  await click('Expand project · three')
  const card = old.querySelector('[data-session-id="three"]')
  expect(old.dataset.collapsed).toBeUndefined()
  expect(useAppStore.getState().config?.focus?.projects?.find(item => item.key === key('three'))?.collapsed).toBe(false)
  expect(old.querySelector('[data-focus-card-key]')).toBe(slot)
  expect(slot.dataset.focusCardBody).toBe('mounted')
  await click('Collapse project · three')
  expect(old.dataset.collapsed).toBe('true')
  const search = button('Search contexts') as unknown as HTMLInputElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'three')
    search.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const result = rows().find(row => row.dataset.projectId === 'three')!
  expect(result.dataset.collapsed).toBeUndefined()
  expect(result.querySelector('[data-session-id="three"]')).toBe(card)
  for (const field of ['sessions', 'tabs', 'layouts', 'agentFocus', 'agentComposerDrafts'] as const) expect(useAppStore.getState()[field]).toBe(before[field])
})

it('new work reopens a previously quiet lane once and completion cannot silently fold it again', async () => {
  await scene(true)
  const old = rows().find(row => row.dataset.projectId === 'three')!
  expect(old.dataset.collapsed).toBe('true')
  const update = async (state: 'working' | 'done') => act(async () => useAppStore.setState(current => ({ sessions: current.sessions.map(session => {
    if (session.id !== 'three' || session.kind !== 'agent') return session
    const status = { state, source: 'native-hook' as const, observedAt: Date.now(), stateEnteredAt: Date.now() }
    return { ...session, status, semanticStatus: status }
  }) })))
  await update('working')
  expect(old.dataset.collapsed).toBeUndefined()
  await update('done')
  expect(old.dataset.collapsed).toBeUndefined()
  expect(old.querySelector('[data-focus-heat]')?.getAttribute('data-focus-heat')).toBe('recent')
})

it('heat changes only presentation while a newer unknown observation cannot be hidden by the old quiet projection', async () => {
  await scene(true)
  const old = rows().find(row => row.dataset.projectId === 'three')!, slot = old.querySelector('[data-focus-card-key]')
  expect(old.dataset.collapsed).toBe('true')
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === 'three' && session.kind === 'agent'
    ? { ...session, semanticStatus: undefined, status: { state: 'running', source: 'run-process', observedAt: Date.now() } } : session) })))
  expect(old.dataset.collapsed).toBeUndefined()
  expect(old.querySelector('[data-focus-card-key]')).toBe(slot)
  expect(old.querySelector('[data-focus-heat]')?.getAttribute('data-focus-heat')).toBe('unknown')
  expect(rows().map(row => row.dataset.projectId)).toEqual(['one', 'two', 'three'])
})

it('a bad future visit cannot erase an already confirmed recent visit and hide its exact project', async () => {
  await scene(true)
  const old = rows().find(row => row.dataset.projectId === 'three')!
  expect(old.dataset.collapsed).toBe('true')
  const session = useAppStore.getState().sessions.find(session => session.id === 'three')!
  const identity = { name: 'three', kind: 'agent' as const, providerId: 'codex', hostId: 'local', workspacePath: session.workspacePath }
  await act(async () => useAppStore.setState(state => ({ agentFocus: { ...state.agentFocus, execution: { ...state.agentFocus.execution, history: [
    { sessionId: 'three', focusedAt: Date.now() - 3600000, identity }, { sessionId: 'three', focusedAt: Date.now() + 3600000, identity }
  ] } } })))
  expect(old.dataset.collapsed).toBeUndefined()
  expect(old.querySelector('[data-focus-heat]')?.getAttribute('data-focus-heat')).toBe('warm')
})

it('the original card consumer defers hidden source reads and pauses summary demand while retaining its visited body', async () => {
  const read = vi.fn(async () => {}), laterRead = vi.fn(async () => {})
  const session = composerSession('external')
  const context = { ...agentContextForSession(session, undefined, 'External source', composerConfig.workspaces[0], null),
    access: { identity: { runtimeId: 'original-source', agentSessionId: 'external' }, locations: [], select() {}, open() {}, refresh() {}, readConversation: read } }
  const ref = createRef<HTMLDivElement>(), viewport = createFocusCardViewport()
  const render = (visible: boolean, readConversation = read) => dom.render(<FocusContextCards contexts={[{ ...context, access: { ...context.access, readConversation } }]} viewport={viewport} scrollRef={ref} visible={visible} selectedId={null} goalLinks={new Map()} identities={new Map()} onSelect={() => {}} />)
  await render(false)
  expect(read).not.toHaveBeenCalled()
  expect(dom.container.querySelector('[data-focus-card-body]')?.getAttribute('data-focus-card-body')).toBe('pending')
  await render(true)
  expect(read).toHaveBeenCalledOnce()
  const body = dom.container.querySelector('[data-session-id="external"]')
  expect(body).not.toBeNull()
  await render(false, laterRead)
  expect(laterRead).not.toHaveBeenCalled()
  expect(dom.container.querySelector('[data-session-id="external"]')).toBe(body)
  await render(true, laterRead)
  expect(laterRead).toHaveBeenCalledOnce()
  expect(dom.container.querySelector('[data-session-id="external"]')).toBe(body)
})
