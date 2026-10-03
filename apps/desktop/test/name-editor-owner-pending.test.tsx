// @vitest-environment happy-dom
import { act, createElement, useState } from 'react'
import { type Root } from 'react-dom/client'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { access, appendFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { AgentMuxSpatialStateStore } from '../../../packages/core/src/spatial-state'
import { displayLabel, type AgentMuxDisplayLabelMutation, type AgentMuxDisplayLabelResult,
  type AgentMuxNameContext, type AgentMuxNameTarget } from '../../../packages/core/src/spatial-graph'
import { createWorkspaceLayout } from '@agentmux/layout'
import { api } from '../src/renderer/src/lib/api'
import { currentDisplayNameRevision, useAppStore } from '../src/renderer/src/store'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import { createFocusProjectionSelector, type FocusContext } from '../src/renderer/src/lib/focus-context'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { FocusContextRow } from '../src/renderer/src/components/FocusContextRow'
import { FocusToolbar } from '../src/renderer/src/components/FocusToolbar'
import { SurveyZoneItem } from '../src/renderer/src/components/SurveyZoneItem'
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'
import type { AgentMuxZoneFact } from '@agentmux/core/control'

// Terminal painting belongs to the separate native proof. This fixture keeps
// the production Workbench, Tab menu/editor and Store while avoiding xterm's
// canvas dependency in happy-dom.
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => <div data-name-owner-session-placeholder /> }))

// Mount the production editors. Their real Store methods reach a real durable
// Core owner; only delivery of its already-completed API ACK is held back.
const baseline = useAppStore.getState(), tabId = 'owner-pending-tab'
const ui: AgentMuxNameContext = { actor: { kind: 'device', id: 'private-editor', verified: true }, source: 'desktop-ui',
  entryPoint: 'spatial:renameLabel', transport: 'electron-ipc', location: { windowId: 'private-editor-window' } }
type Kind = 'Agent row' | 'Focus Tab' | 'Survey Zone' | 'Workbench Tab' | 'Workbench Agent'
const kinds: Kind[] = ['Agent row', 'Focus Tab', 'Survey Zone', 'Workbench Tab', 'Workbench Agent']
type Held = { input: AgentMuxDisplayLabelMutation; result: AgentMuxDisplayLabelResult; release(): void }
let root: Root | undefined, container: HTMLDivElement, context: FocusContext, zone: AgentMuxZoneFact,
  owner: AgentMuxSpatialStateStore, directory: string, dispose: (() => void) | undefined, held: Held[], focusTrace: unknown[],
  coreFlights: Promise<AgentMuxDisplayLabelResult>[]
function trace(event: Event) {
  const target = event.target as Element
  if (target?.classList?.contains('workbench-tab__rename')) focusTrace.push({ type: event.type, value: (target as HTMLInputElement).value,
    related: (event as FocusEvent).relatedTarget instanceof Element ? ((event as FocusEvent).relatedTarget as Element).outerHTML.slice(0, 350) : null,
    stack: new Error().stack?.split('\n').slice(1, 35) })
}
const settle = () => act(async () => { await new Promise(done => setTimeout(done, 20)) })
const key = (node: Element, value: string) => act(async () => {
  node.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: value }))
})
async function value(input: HTMLInputElement, text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function request(index: number, expectedValue?: string) {
  await act(async () => { await vi.waitFor(() => expect(held[index], `real Core result for save ${index}`).toBeTruthy()) })
  expect(api.spatial.renameLabel, 'one actual API request per deliberate save').toHaveBeenCalledTimes(index + 1)
  expect(held).toHaveLength(index + 1)
  if (expectedValue !== undefined) expect(held[index]!.input.value).toBe(expectedValue)
  return held[index]!
}
async function deliver(index: number) { await act(async () => held[index]!.release()); await settle() }
function target(kind: Kind): AgentMuxNameTarget {
  return kind === 'Agent row' || kind === 'Workbench Agent' ? { kind: 'agent-session', id: context.id }
    : kind === 'Focus Tab' || kind === 'Workbench Tab' ? { kind: 'tab', id: tabId } : { kind: 'zone', id: zone.zoneId }
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Error.stackTraceLimit = 40
  focusTrace = []; document.addEventListener('blur', trace, true); document.addEventListener('input', trace, true)
  window.localStorage.clear()
  directory = await mkdtemp(join(tmpdir(), 'amux-name-draft-owner-'))
  owner = new AgentMuxSpatialStateStore(join(directory, 'spatial.json')); held = []; coreFlights = []
  const config = await api.config.get(), snapshot = await api.sessions.snapshot()
  const original = snapshot.sessions.find(session => session.kind === 'agent')!
  const workspace = { ...config.workspaces[0]!, id: 'owner-pending-workspace', path: resolve(directory), hostId: 'local' }
  const session = { ...original, workspacePath: workspace.path, hostId: 'local', label: 'Original Agent' }
  const tab = createWorkbenchTab(tabId, { regionId: 'owner-pending-region', kind: 'agent', phase: 'attached', workspaceId: workspace.id, sessionId: session.id }, 'Original Tab')
  const work = { config: { ...config, workspaces: [workspace] }, sessions: [session],
    tabs: { [tab.id]: tab }, layouts: { [workspace.id]: createWorkspaceLayout('owner-pending-group', [tab.id]) },
    spaceZoneBindings: {}, spatialRequests: {} }
  const committed = await owner.commit({ expectedRevision: 0, graph: desktopSpatialGraph(work, []) })
  const initialZone = committed.graph.zones.find(item => item.workspaceId === workspace.id && item.kind === 'directory')!
  expect(initialZone).toBeTruthy()
  // Register exact retained starting labels before mounting any edit. Initial
  // legacy-name retention is not allowed to race the test's manual baseline.
  await owner.retainDisplayLabels([
    { target: { kind: 'tab', id: tabId }, value: 'Original Tab' },
    { target: { kind: 'agent-session', id: session.id }, value: 'Original Agent' },
    { target: { kind: 'zone', id: initialZone.zoneId }, value: 'Original exploration' },
  ])
  vi.spyOn(api.spatial, 'read').mockImplementation(() => owner.readForLayout())
  vi.spyOn(api.spatial, 'commit').mockImplementation(input => owner.commit(input))
  vi.spyOn(api.spatial, 'retainLabels').mockImplementation(values => owner.retainDisplayLabels(values))
  vi.spyOn(api.spatial, 'confirmNameCommit').mockImplementation(id => owner.confirmNameCommit(id))
  vi.spyOn(api.spatial, 'onChange').mockImplementation(listener => owner.subscribe(listener))
  vi.spyOn(api.spatial, 'renameLabel').mockImplementation(async input => {
    const completing = owner.mutateDisplayLabel(input, ui); coreFlights.push(completing)
    const result = await completing
    let release!: () => void
    const delivery = new Promise<void>(done => { release = done })
    held.push({ input, result, release }); await delivery; return result
  })
  vi.spyOn(api.config, 'get').mockResolvedValue(work.config)
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ ...snapshot, sessions: [session], recoveryCandidates: [] })
  useAppStore.setState({ ...baseline, ...work, activeWorkspaceId: workspace.id, timelines: {}, scratchTopicSnapshots: {},
    agentNames: {}, surveyExplorationNames: {}, nameLabels: {}, nameAuthorityRevision: 0, nameAcknowledgementRevision: 0,
    nameEditFailure: null, nameSaveUnconfirmed: null, restoredWorkbench: { tabs: work.tabs, layouts: work.layouts } }, true)
  dispose = await useAppStore.getState().initialize()
  await useAppStore.getState().retryWorkbenchSave()
  context = createFocusProjectionSelector()(useAppStore.getState()).contexts.find(item => item.id === session.id)!
  expect(context).toBeTruthy()
  zone = (await owner.read())!.graph.zones.find(item => item.workspaceId === workspace.id && item.kind === 'directory')! as AgentMuxZoneFact
  expect(zone).toBeTruthy()
  await vi.waitFor(() => {
    for (const nameTarget of [{ kind: 'tab', id: tabId }, { kind: 'agent-session', id: session.id }, { kind: 'zone', id: zone.zoneId }]) {
      expect(currentDisplayNameRevision(nameTarget.kind, nameTarget.id)).toBe(1)
    }
  })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async test => {
  // A failing opening oracle can observe API invocation before disk I/O has
  // returned. Complete that real owner write before releasing its held ACK.
  await Promise.all(coreFlights ?? [])
  if (process.env.AGENTMUX_NAME_DRAFT_OBSERVATIONS && owner) await appendFile(process.env.AGENTMUX_NAME_DRAFT_OBSERVATIONS,
    JSON.stringify({ kind: 'test', test: test.task.name, requests: held.map(item => ({ input: item.input, result: { applied: item.result.applied,
      diskDurability: item.result.diskDurability, record: item.result.record } })),
      focusTrace, activeElement: document.activeElement?.outerHTML.slice(0, 350) }) + '\n')
  for (const item of held ?? []) item.release()
  await settle()
  if (root) await act(async () => root!.unmount()); root = undefined
  container?.remove(); document.getElementById('agentmux-window-overlay-host')?.remove()
  if (dispose) await useAppStore.getState().retryWorkbenchSave()
  dispose?.(); dispose = undefined
  document.removeEventListener('blur', trace, true); document.removeEventListener('input', trace, true)
  useAppStore.setState(baseline, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
  if (directory) {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    const removed = await access(directory).then(() => false, error => { if (error.code === 'ENOENT') return true; throw error })
    expect(removed, 'private real Core owner directory is removed after its save completes').toBe(true)
    if (process.env.AGENTMUX_NAME_DRAFT_OBSERVATIONS) await appendFile(process.env.AGENTMUX_NAME_DRAFT_OBSERVATIONS,
      JSON.stringify({ kind: 'cleanup', test: test.task.name, directory, removed }) + '\n')
  }
})
async function mount(kind: Kind) {
  function SurveyFixture() {
    const [editing, setEditing] = useState(true)
    const title = useAppStore(state => state.surveyExplorationNames[zone.zoneId] ?? 'Original exploration')
    return <SurveyZoneItem zone={zone} title={title} glyph={null} selected activity={null} editing={editing}
      onEdit={setEditing} onRename={(name, revision) => useAppStore.getState().setSurveyExplorationName(zone.zoneId, name, revision)} onSelect={() => {}} />
  }
  await act(async () => root!.render(kind === 'Agent row'
    ? createElement(FocusContextRow, { context, selected: true, onSelect() {} })
    : kind === 'Focus Tab' ? createElement(FocusToolbar, { children: null, selectedId: context.id, selected: context, tab: useAppStore.getState().tabs[tabId]!, onReview() {}, onCloseWorkspace() {} })
    : kind === 'Survey Zone' ? createElement(SurveyFixture)
    : createElement(WorkspaceWorkbench, { workspaceId: context.workspaceId, visible: true })))
  const selector = kind === 'Agent row' ? '.focus-context__rename' : kind === 'Focus Tab' ? '.focus-toolbar__rename'
    : kind === 'Survey Zone' ? '.survey-item-name input' : '.workbench-tab__rename'
  const input = () => container.querySelector<HTMLInputElement>(selector)
  async function open() {
    if (kind === 'Survey Zone') {
      await act(async () => container.querySelector<HTMLButtonElement>('.survey-item')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
    } else {
      const trigger = container.querySelector<HTMLButtonElement>(kind === 'Agent row' ? 'button.focus-context'
        : kind === 'Focus Tab' ? '.focus-toolbar__identity' : `[data-workbench-tab-id="${tabId}"]`)!
      expect(trigger).toBeTruthy()
      await act(async () => trigger.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 100, clientY: 20 })))
      await settle()
      const label = kind === 'Agent row' || kind === 'Workbench Agent' ? 'Rename Agent' : 'Rename Tab'
      const action = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent === label)
      expect(action, label).toBeTruthy(); await act(async () => action!.click()); await settle()
    }
    expect(input()).toBeTruthy()
  }
  async function submit() {
    if (kind === 'Survey Zone') await act(async () => input()!.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    else await key(input()!, 'Enter')
  }
  if (kind !== 'Survey Zone') await open()
  expect(input()).toBeTruthy()
  expect(api.spatial.renameLabel, 'opening an edit must not submit its seed').toHaveBeenCalledTimes(0)
  expect(document.activeElement, 'the opened production editor receives focus after its menu exits').toBe(input())
  return { input, open, submit }
}
it.each(kinds)('%s advances only its confirmed save baseline while retaining newer input', async kind => {
  const edit = await mount(kind), nameTarget = target(kind), initial = currentDisplayNameRevision(nameTarget.kind, nameTarget.id)
  const originalRegions = structuredClone((await owner.read())!.graph.regions)
  await value(edit.input()!, 'Submitted first'); await edit.submit()
  const first = await request(0, 'Submitted first')
  expect(first.input.value, 'opening an edit must not silently save its seed').toBe('Submitted first')
  expect(first.input.expectedNameRevision).toBe(initial); expect(first.result.applied).toBe(true)
  expect(first.result.diskDurability).toBe('confirmed')
  await value(edit.input()!, 'Newer unsaved draft'); await deliver(0)
  expect(edit.input()?.value, 'an earlier confirmed ACK must preserve later input').toBe('Newer unsaved draft')
  await edit.submit(); const next = await request(1, 'Newer unsaved draft')
  expect(next.input.expectedNameRevision, 'the same edit advances exactly its own successful revision').toBe(initial + 1)
  expect(next.result.applied, 'the next save must pass the real Core CAS').toBe(true)
  await deliver(1); expect(edit.input()).toBeNull()
  const reopened = new AgentMuxSpatialStateStore(owner.path)
  expect(displayLabel((await reopened.read())!.graph, nameTarget)).toMatchObject({ value: 'Newer unsaved draft', nameRevision: initial + 2 })
  expect((await reopened.read())!.graph.regions).toEqual(originalRegions)
  expect((await reopened.queryNameChanges({ target: nameTarget })).records.map(row => row.status)).toEqual(['applied', 'applied'])
})
it.each(kinds.flatMap(kind => ['before ACK', 'after ACK'].map(order => [kind, order] as const)))('%s keeps the draft and refuses a later owner %s', async (kind, order) => {
  const edit = await mount(kind), nameTarget = target(kind), initial = currentDisplayNameRevision(nameTarget.kind, nameTarget.id)
  await value(edit.input()!, 'Own submitted'); await edit.submit(); await request(0, 'Own submitted')
  await value(edit.input()!, 'Do not overwrite another editor')
  if (order === 'after ACK') await deliver(0)
  const other = new AgentMuxSpatialStateStore(owner.path)
  const later = await other.mutateDisplayLabel({ operationId: `later-${kind}-${order}`, target: nameTarget, value: 'Other editor choice',
    source: 'manual', expectedNameRevision: initial + 1 }, { ...ui, actor: { kind: 'device', id: 'other-editor', verified: true } })
  expect(later.applied).toBe(true)
  // Let the production watch project the newer revision. The current edit may
  // not silently absorb it, even when its own older write ACK arrives afterward.
  await act(async () => { await vi.waitFor(() => expect(currentDisplayNameRevision(nameTarget.kind, nameTarget.id)).toBe(initial + 2)) })
  if (order === 'before ACK') await deliver(0)
  expect(edit.input()?.value).toBe('Do not overwrite another editor')
  await edit.submit(); const next = await request(1, 'Do not overwrite another editor')
  expect(next.input.expectedNameRevision, 'only the edit\'s own ACK advances its baseline').toBe(initial + 1)
  expect(next.result.applied, 'a subsequent independent owner must win the real CAS').toBe(false)
  await deliver(1)
  expect(edit.input()?.value, 'a real CAS conflict retains the unsaved draft').toBe('Do not overwrite another editor')
  expect(useAppStore.getState().nameEditFailure?.message).toContain('Name changed since this request')
  expect(displayLabel((await new AgentMuxSpatialStateStore(owner.path).read())!.graph, nameTarget)).toMatchObject({ value: 'Other editor choice', nameRevision: initial + 2 })
  expect((await owner.queryNameChanges({ target: nameTarget })).records.at(-1)).toMatchObject({ requested: 'Do not overwrite another editor', status: 'failed', actual: 'Other editor choice' })
})
it.each(kinds)('%s isolates a reopened edit from its earlier confirmed ACK', async kind => {
  const edit = await mount(kind), nameTarget = target(kind), initial = currentDisplayNameRevision(nameTarget.kind, nameTarget.id)
  await value(edit.input()!, 'Old edit save'); await edit.submit(); await request(0, 'Old edit save')
  await act(async () => { await vi.waitFor(() => expect(currentDisplayNameRevision(nameTarget.kind, nameTarget.id)).toBe(initial + 1)) })
  await key(edit.input()!, 'Escape'); expect(edit.input()).toBeNull()
  await edit.open(); await value(edit.input()!, 'Reopened draft'); await deliver(0)
  expect(edit.input()?.value, 'old ACK must not close a reopened editor').toBe('Reopened draft')
  await edit.submit(); const next = await request(1, 'Reopened draft')
  expect(next.input.expectedNameRevision, 'old ACK must not increment the reopened edit\'s independently captured baseline').toBe(initial + 1)
  expect(next.result.applied).toBe(true); await deliver(1); expect(edit.input()).toBeNull()
  expect(displayLabel((await new AgentMuxSpatialStateStore(owner.path).read())!.graph, nameTarget)).toMatchObject({ value: 'Reopened draft', nameRevision: initial + 2 })
})
it.each(['Workbench Tab', 'Workbench Agent'] as const)('%s retains the advanced baseline when an ACK and later input share a React batch', async kind => {
  const edit = await mount(kind), nameTarget = target(kind), initial = currentDisplayNameRevision(nameTarget.kind, nameTarget.id)
  await value(edit.input()!, 'Submitted first'); await edit.submit(); const first = await request(0, 'Submitted first')
  expect(first.result.applied).toBe(true)
  await value(edit.input()!, 'Newer draft B')
  const existingInput = edit.input()!
  await act(async () => {
    first.release()
    // The API/Store await chain queues its successful ACK state updater while
    // React still holds this batch. The input event comes from that older render.
    for (let i = 0; i < 8; ++i) await Promise.resolve()
    expect(useAppStore.getState().nameAcknowledgementRevision).toBe(first.result.state.revision)
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(existingInput, 'Newest draft C')
    existingInput.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(edit.input()?.value).toBe('Newest draft C')
  await edit.submit(); const next = await request(1, 'Newest draft C')
  expect(next.input.expectedNameRevision, 'a stale-render input must not put the previous revision back').toBe(initial + 1)
  expect(next.result.applied).toBe(true); await deliver(1)
  expect(edit.input()).toBeNull()
  expect(displayLabel((await new AgentMuxSpatialStateStore(owner.path).read())!.graph, nameTarget)).toMatchObject({ value: 'Newest draft C', nameRevision: initial + 2 })
})
