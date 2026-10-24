// @vitest-environment happy-dom
import { act } from 'react'
import { readFile, writeFile } from 'node:fs/promises'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { App } from '../src/renderer/src/App'
import { api } from '../src/renderer/src/lib/api'
import { prepareRendererUpdate, restorePersistedUiState, useAppStore } from '../src/renderer/src/store'
import { AgentMuxSpatialStateStore } from '../../../packages/core/src/spatial-state'
import { desktopSpatialGraph, desktopWorkbenchFromSpatial } from '../src/renderer/src/lib/desktop-spatial-state'
import { restorePersistedWorkbench } from '../src/renderer/src/lib/workbench-persistence'
import { emptyNotebookState } from '@agentmux/core/notebook-catalog'
import type { AgentMuxSurveyOrganization } from '@agentmux/core/control'
import { composerDOM } from './helpers/composer-dom-fixture'
import { arrangeSurveyListUi } from './helpers/survey-list-ui-fixture'
import { protectedFacts } from './helpers/workface-control-fixture'

vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('react-resizable-panels', async () => {
  const { createRequire } = await import('node:module')
  return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js')
})
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: ({ session }: { session: { id: string } }) => <textarea data-original-terminal={session.id} defaultValue="Original terminal input" /> }))
vi.mock('../src/renderer/src/components/EditorPane', () => ({ EditorPane: () => <textarea data-original-file defaultValue="Original file input" /> }))

const dom = composerDOM()
let fixture: Awaited<ReturnType<typeof arrangeSurveyListUi>>, savedStorage: string | null
beforeEach(async () => {
  savedStorage = localStorage.getItem('agentmux-workbench-v1')
  vi.spyOn(api.notebooks, 'read').mockResolvedValue(emptyNotebookState())
  vi.spyOn(api.notebooks, 'onChange').mockImplementation(() => () => {})
  fixture = await arrangeSurveyListUi()
  Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const rectangles = new Map<Element, DOMRect>(), list = document.querySelector('.survey-page-list')
    let top = 80
    const ungrouped = list?.querySelector('.survey-list-ungrouped')
    if (ungrouped) {
      const rows = [...ungrouped.querySelectorAll('.survey-list-item')], height = Math.max(50, rows.length * 90)
      rectangles.set(ungrouped, new DOMRect(10, top, 240, height))
      rows.forEach((row, index) => rectangles.set(row, new DOMRect(10, top + index * 90, 240, 70)))
      top += height
    }
    for (const group of list?.querySelectorAll('.survey-list-group') ?? []) {
      const header = group.querySelector('.survey-list-group-heading')!, rows = [...group.querySelectorAll('.survey-list-item')].filter(row => !row.closest('[hidden]'))
      const height = 40 + rows.length * 90 + 20
      rectangles.set(header, new DOMRect(10, top, 240, 40)); rectangles.set(group, new DOMRect(10, top, 240, height))
      rows.forEach((row, index) => rectangles.set(row, new DOMRect(10, top + 40 + index * 90, 240, 70)))
      top += height
    }
    const rectangle = rectangles.get(this) ?? rectangles.get(this.closest('.survey-list-item, .survey-list-group-heading')!)
    if (rectangle) {
      // Browser bounds include sortable CSS transforms; dnd-kit's measuring owner removes them.
      // Returning untransformed bounds here would make its subtraction shift a sibling twice.
      let x = 0, y = 0
      for (let element: HTMLElement | null = this; element; element = element.parentElement) {
        const translate = element.style.transform.match(/translate3d\(([-\d.]+)px,\s*([-\d.]+)px/)
        if (translate) { x += Number(translate[1]); y += Number(translate[2]) }
      }
      return new DOMRect(rectangle.x + x, rectangle.y + y, rectangle.width, rectangle.height)
    }
    return new DOMRect(0, 0, 1000, 700)
  })
})
afterEach(() => { if (savedStorage === null) localStorage.removeItem('agentmux-workbench-v1'); else localStorage.setItem('agentmux-workbench-v1', savedStorage) })
const organization = () => useAppStore.getState().surveyOrganization
const row = (index: number) => [...dom.container.querySelectorAll<HTMLElement>('[data-survey-zone-id]')].find(item => item.dataset.surveyZoneId === fixture.zones[index])!
const group = (id: string) => [...dom.container.querySelectorAll<HTMLElement>('[data-survey-list-group]')].find(item => item.dataset.surveyListGroup === id)!
const button = (label: string, within: ParentNode = document) => [...within.querySelectorAll<HTMLButtonElement>('button')].find(item => item.getAttribute('aria-label') === label)!
const field = (label: string) => document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
async function click(target: HTMLElement) { expect(target).toBeDefined(); await act(async () => target.click()) }
async function key(target: HTMLElement, key: string, code = key) { await act(async () => target.dispatchEvent(new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true }))) }
async function input(target: HTMLInputElement, value: string) {
  expect(target).not.toBeNull()
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(target, value); target.dispatchEvent(new Event('input', { bubbles: true })) })
}
async function openMenu(target: HTMLElement) { expect(target).toBeDefined(); await act(async () => target.focus()); await key(target, 'ArrowDown'); await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).not.toBeNull()) }
async function menuItem(text: string, submenu = false) {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === text)!
  expect(item, text).toBeDefined()
  if (submenu) { await act(async () => item.focus()); await key(item, 'ArrowRight') } else await click(item)
}
async function render() { await dom.render(<App />); await vi.waitFor(() => expect(dom.container.querySelector('.global-survey-surface:not([hidden]) .survey-page-list')).not.toBeNull()) }
async function write(next: AgentMuxSurveyOrganization) { await act(async () => { expect((await useAppStore.getState().setSurveyOrganization(next, organization())).outcome).toBe('changed') }) }
async function holdOriginalSaveReceipt() {
  const original = useAppStore.getState().setSurveyOrganization
  let finish!: () => void, arrived = false, first = true
  const pending = new Promise<void>(resolve => { finish = resolve })
  await act(async () => useAppStore.setState({ setSurveyOrganization: async (...args) => {
    const report = await original(...args)
    if (first) { first = false; arrived = true; await pending }
    return report
  } }))
  return { finish: () => finish(), arrived: () => arrived }
}
function groups(): AgentMuxSurveyOrganization { return { ungrouped: [fixture.zones[2]!], groups: [
  { groupId: 'group-a', name: 'First group', collapsed: false, zoneIds: [fixture.zones[0]!] },
  { groupId: 'group-b', name: 'Second group', collapsed: false, zoneIds: [fixture.zones[1]!] }
] } }
function unchanged(before: ReturnType<typeof protectedFacts>, selection = fixture.selection) {
  expect(protectedFacts()).toEqual(before); expect(useAppStore.getState().surveyZoneSelection).toBe(selection); fixture.noLifecycle()
}

it('[survey-list-ui] actual App item menus create, rename, collapse, move and dissolve one client group without replacing the selected workface', async () => {
  await render(); const before = protectedFacts(), selected = useAppStore.getState().surveyZoneSelection
  const terminal = dom.container.querySelector<HTMLTextAreaElement>('[data-original-terminal="survey-session-0"]')!
  expect(terminal).not.toBeNull(); terminal.value = 'Still typing in the original terminal'
  await openMenu(button('Options for Research A', row(0))); await menuItem('Move to group', true); await menuItem('New group…')
  await vi.waitFor(() => expect(field('Survey group name')).not.toBeNull())
  const groupId = organization().groups[0]!.groupId
  await input(field('Survey group name'), 'Research collection'); await click(button('Save group name'))
  await vi.waitFor(() => expect(organization().groups[0]!.name).toBe('Research collection'))
  await click(button('Collapse survey group: Research collection')); expect(row(0).closest('[hidden]')).not.toBeNull()
  expect(group(groupId).dataset.collapsed).toBe('true')
  expect(dom.container.querySelector('[data-original-terminal="survey-session-0"]')).toBe(terminal); expect(terminal.value).toBe('Still typing in the original terminal')
  const facts = await useAppStore.getState().executeControl({ schemaVersion: 5, requestId: 'ui-collapsed-members', operation: 'space.ls', target: {}, presentation: true })
  expect(facts.operation).toBe('space.ls'); if (facts.operation === 'space.ls') expect(facts.catalog.survey!.items.map(item => item.zoneId)).toContain(fixture.zones[0])
  await click(button('Expand survey group: Research collection'))
  const context = row(1).querySelector<HTMLElement>('.survey-item')!
  await act(async () => context.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 30, clientY: 40 })))
  await menuItem('Move to group', true); await menuItem('Research collection')
  await vi.waitFor(() => expect(organization().groups[0]!.zoneIds).toEqual([fixture.zones[0], fixture.zones[1]]))
  expect(group(groupId).querySelectorAll('[data-survey-zone-id]')).toHaveLength(2)
  await openMenu(button('Options for Research B', row(1))); await menuItem('Move to group', true); await menuItem('Ungrouped')
  await vi.waitFor(() => expect(organization().groups[0]!.zoneIds).toEqual([fixture.zones[0]]))
  expect(organization().ungrouped).toEqual([fixture.zones[2], fixture.zones[1]])
  await openMenu(button('Options for survey group: Research collection')); await menuItem('Ungroup all items')
  await vi.waitFor(() => expect(organization().groups).toEqual([]))
  expect(dom.container.querySelectorAll('[data-survey-zone-id]')).toHaveLength(3); unchanged(before, selected)
})

it('[survey-list-ui] an open actual item menu keeps its original CAS baseline when a public owner write arrives', async () => {
  await write(groups()); await render(); const before = protectedFacts(), baseline = organization()
  await openMenu(button('Options for Research C', row(2)))
  const later = { ...baseline, groups: baseline.groups.map(original => ({ ...original, name: original.name + ' external' })) }
  await write(later)
  await menuItem('Move to group', true); await menuItem('First group')
  await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('changed'))
  expect(organization()).toEqual(later); unchanged(before)
})

it('[survey-list-ui] later group-name typing and cancellation survive an earlier save reply without reopening the editor', async () => {
  await write(groups()); await render(); const before = protectedFacts()
  await openMenu(button('Options for survey group: First group')); await menuItem('Rename group')
  await input(field('Survey group name'), 'Earlier saved title')
  const pending = await holdOriginalSaveReceipt()
  await click(button('Save group name')); await vi.waitFor(() => expect(pending.arrived()).toBe(true))
  await input(field('Survey group name'), 'Later unsent title')
  await act(async () => pending.finish())
  expect(field('Survey group name')?.value).toBe('Later unsent title')
  await click(button('Save group name'))
  await vi.waitFor(() => expect(organization().groups[0]!.name).toBe('Later unsent title'))
  await openMenu(button('Options for survey group: Later unsent title')); await menuItem('Rename group')
  await input(field('Survey group name'), 'Cancelled unsent title')
  await key(field('Survey group name'), 'Escape'); expect(field('Survey group name')).toBeNull()
  await new Promise(resolve => setTimeout(resolve, 0)); expect(field('Survey group name')).toBeNull()
  expect(organization().groups[0]!.name).toBe('Later unsent title'); unchanged(before)
})

it('[survey-list-ui] a late new-group save does not steal a newer exploration name draft or focus', async () => {
  await render(); const before = protectedFacts()
  const pending = await holdOriginalSaveReceipt()
  await openMenu(button('Options for Research A', row(0))); await menuItem('Move to group', true); await menuItem('New group…')
  await vi.waitFor(() => expect(pending.arrived()).toBe(true))
  expect(field('Survey group name')).not.toBeNull()
  await key(row(1).querySelector<HTMLElement>('.survey-item')!, 'F2'); await input(field('Exploration name'), 'Newer independent exploration draft')
  const groupEditor = field('Survey group name'), editor = field('Exploration name'); await act(async () => editor.focus()); await act(async () => pending.finish())
  expect(field('Survey group name')).toBe(groupEditor); expect(field('Exploration name')).toBe(editor)
  expect(editor.value).toBe('Newer independent exploration draft'); expect(document.activeElement).toBe(editor); unchanged(before)
})

it('[survey-list-ui] collapse and cross-group movement retain an original exploration name draft', async () => {
  await write(groups()); await render(); const before = protectedFacts()
  await key(row(0).querySelector<HTMLElement>('.survey-item')!, 'F2'); await input(field('Exploration name'), 'Unsent exploration rename')
  await click(button('Collapse survey group: First group')); await click(button('Expand survey group: First group'))
  expect(field('Exploration name')?.value).toBe('Unsent exploration rename'); unchanged(before)
  const terminal = dom.container.querySelector<HTMLTextAreaElement>('[data-original-terminal="survey-session-0"]')!
  await act(async () => terminal.focus()); expect(document.activeElement).toBe(terminal)
  const terminalBaseline = protectedFacts()
  const current = organization(); await write({ ...current, groups: current.groups.map(original => ({ ...original,
    zoneIds: original.groupId === 'group-a' ? [] : [fixture.zones[0]!, ...original.zoneIds] })) })
  expect(field('Exploration name')?.value).toBe('Unsent exploration rename'); expect(document.activeElement).toBe(terminal); unchanged(terminalBaseline)
  const editor = field('Exploration name'); await act(async () => {
    editor.focus(); editor.setSelectionRange(4, 4)
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowLeft', code: 'ArrowLeft', bubbles: true }))
  })
  expect([editor.selectionStart, editor.selectionEnd]).toEqual([4, 4])
  const editorBaseline = protectedFacts()
  const moved = organization(); await write({ ...moved, groups: moved.groups.map(original => ({ ...original,
    zoneIds: original.groupId === 'group-a' ? [fixture.zones[0]!] : original.zoneIds.filter(id => id !== fixture.zones[0]) })) })
  expect(field('Exploration name')?.value).toBe('Unsent exploration rename'); expect(document.activeElement).toBe(field('Exploration name'))
  expect([field('Exploration name').selectionStart, field('Exploration name').selectionEnd]).toEqual([4, 4]); unchanged(editorBaseline)
})

async function keyboardDrag(target: HTMLElement, direction: 'ArrowDown' | 'ArrowUp', cancel = false) {
  await act(async () => target.focus()); await key(target, ' ', 'Space')
  await vi.waitFor(() => expect(dom.container.querySelector('.survey-page-list')?.getAttribute('data-dragging')).toBe('true'))
  await new Promise(resolve => setTimeout(resolve, 30))
  await key(target, direction); await new Promise(resolve => setTimeout(resolve, 30))
  await key(target, cancel ? 'Escape' : ' ', cancel ? 'Escape' : 'Space')
  await vi.waitFor(() => expect(dom.container.querySelector('.survey-page-list')?.hasAttribute('data-dragging')).toBe(false))
}
it('[survey-list-ui] dnd-kit keyboard movement sorts in both directions and Escape cancels without mutating work', async () => {
  await write({ ungrouped: [...fixture.zones], groups: [] }); await render(); const before = protectedFacts()
  await keyboardDrag(button('Move survey item: Research A'), 'ArrowDown')
  await vi.waitFor(() => expect(organization().ungrouped).toEqual([fixture.zones[1], fixture.zones[0], fixture.zones[2]]))
  await keyboardDrag(button('Move survey item: Research A'), 'ArrowUp')
  await vi.waitFor(() => expect(organization().ungrouped).toEqual(fixture.zones))
  await keyboardDrag(button('Move survey item: Research A'), 'ArrowDown', true)
  expect(organization().ungrouped).toEqual(fixture.zones); unchanged(before)
})

it('[survey-list-ui] keyboard dragging reorders complete groups through their dedicated handles', async () => {
  await write(groups()); await render(); const before = protectedFacts()
  await keyboardDrag(button('Move survey group: First group'), 'ArrowDown')
  await vi.waitFor(() => expect(organization().groups.map(item => item.groupId)).toEqual(['group-b', 'group-a']))
  expect(organization().groups.map(item => item.zoneIds)).toEqual([[fixture.zones[1]], [fixture.zones[0]]]); unchanged(before)
})

it('[survey-list-ui] keyboard dragging moves an ungrouped item into an original named group', async () => {
  await write(groups()); await render(); const before = protectedFacts()
  await keyboardDrag(button('Move survey item: Research C'), 'ArrowDown')
  await vi.waitFor(() => expect(organization().ungrouped).toEqual([]))
  expect(organization().groups[0]!.zoneIds).toEqual([fixture.zones[2], fixture.zones[0]])
  expect(group('group-a').querySelectorAll('[data-survey-zone-id]')).toHaveLength(2); unchanged(before)
})

it('[survey-list-ui] a keyboard drop enters a collapsed nonempty group without changing the selected original workface', async () => {
  const next = groups(); next.groups[0]!.collapsed = true
  await write(next); await render(); const before = protectedFacts()
  expect(row(0).closest('[hidden]')).not.toBeNull()
  await keyboardDrag(button('Move survey item: Research C'), 'ArrowDown')
  await vi.waitFor(() => expect(organization().ungrouped).toEqual([]))
  expect(organization().groups[0]).toMatchObject({ collapsed: true, zoneIds: [fixture.zones[0], fixture.zones[2]] })
  expect(row(2).closest('[hidden]')).not.toBeNull()
  expect(dom.container.querySelector('[data-original-terminal="survey-session-0"]')).not.toBeNull(); unchanged(before)
})

it('[survey-list-ui] a keyboard drag keeps its pickup baseline when another writer changes the list', async () => {
  await write({ ungrouped: [...fixture.zones], groups: [] }); await render(); const before = protectedFacts()
  const target = button('Move survey item: Research A')
  await act(async () => target.focus()); await key(target, ' ', 'Space')
  await vi.waitFor(() => expect(dom.container.querySelector('.survey-page-list')?.getAttribute('data-dragging')).toBe('true'))
  await new Promise(resolve => setTimeout(resolve, 30))
  const later = { ungrouped: [fixture.zones[2]!, fixture.zones[1]!, fixture.zones[0]!], groups: [] }
  await write(later); await key(target, 'ArrowUp'); await new Promise(resolve => setTimeout(resolve, 30)); await key(target, ' ', 'Space')
  await vi.waitFor(() => expect(dom.container.querySelector('.survey-page-list')?.hasAttribute('data-dragging')).toBe(false))
  await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('changed'))
  expect(organization()).toEqual(later); unchanged(before)
})

it.runIf(Boolean(process.env.SURVEY_LIST_UI_RESTART_PHASE))('[survey-list-ui-restart] a second actual App restores grouped order, collapse, selected workface and original drafts from client and Core files', async () => {
  const path = process.env.SURVEY_LIST_UI_RESTART_FILE!
  if (process.env.SURVEY_LIST_UI_RESTART_PHASE === 'write') {
    await render()
    await openMenu(button('Options for Research A', row(0))); await menuItem('Move to group', true); await menuItem('New group…')
    await vi.waitFor(() => expect(field('Survey group name')).not.toBeNull())
    await input(field('Survey group name'), 'Saved original group'); await click(button('Save group name'))
    await vi.waitFor(() => expect(organization().groups[0]!.name).toBe('Saved original group'))
    await openMenu(button('Options for Research B', row(1))); await menuItem('Move to group', true); await menuItem('Saved original group')
    await vi.waitFor(() => expect(organization().groups[0]!.zoneIds).toEqual([fixture.zones[0], fixture.zones[1]]))
    await click(button('Collapse survey group: Saved original group')); await prepareRendererUpdate()
    const state = useAppStore.getState()
    await new AgentMuxSpatialStateStore(path + '.spatial.json').commit({ expectedRevision: 0, graph: desktopSpatialGraph(state, []) })
    await writeFile(path, JSON.stringify({ pid: process.pid, record: localStorage.getItem('agentmux-workbench-v1'), config: state.config,
      organization: organization(), zones: fixture.zones, selection: state.surveyZoneSelection, protected: protectedFacts() }))
  } else {
    const saved = JSON.parse(await readFile(path, 'utf8')); expect(saved.pid).not.toBe(process.pid)
    const client = JSON.parse(saved.record).state
    const restored = restorePersistedUiState(saved.config, client)
    useAppStore.setState({ tabs: {}, layouts: {}, agentComposerDrafts: {}, surveyOrganization: { ungrouped: [], groups: [] }, surveyZoneSelection: null })
    const spatial = await new AgentMuxSpatialStateStore(path + '.spatial.json').readForLayout(); expect(spatial).not.toBeNull()
    const workbench = restorePersistedWorkbench({ config: saved.config, sessions: saved.protected.sessions,
      persisted: desktopWorkbenchFromSpatial(spatial!.graph), createTabGroupId: () => 'unused-empty-group' })
    useAppStore.setState({ ...restored, ...workbench, sessions: saved.protected.sessions, agentComposerDrafts: client.agentComposerDrafts, mainSurface: 'survey' })
    expect(organization()).toEqual(saved.organization); expect(useAppStore.getState().surveyZoneSelection).toEqual(saved.selection)
    await render()
    expect(group(saved.organization.groups[0].groupId).dataset.collapsed).toBe('true')
    expect(row(0).closest('[hidden]')).not.toBeNull(); expect(row(1).closest('[hidden]')).not.toBeNull(); expect(row(2).closest('[hidden]')).toBeNull()
    expect(dom.container.querySelector('[data-original-terminal="survey-session-0"]')).not.toBeNull()
    expect(useAppStore.getState().agentComposerDrafts).toEqual(saved.protected.drafts)
    expect(Object.keys(useAppStore.getState().tabs)).toEqual(Object.keys(saved.protected.tabs)); expect(useAppStore.getState().layouts).toEqual(saved.protected.layouts)
    for (const [index, [id, original]] of Object.entries(saved.protected.tabs).entries()) {
      const { space, ...originalContent } = useAppStore.getState().tabs[id]!
      expect(originalContent).toEqual(original)
      // The authoritative Core restore materializes the original resource binding on an initially unbound fixture Tab.
      expect(space?.zoneId).toBe(saved.zones[index]); expect(spatial!.graph.zones.some(zone => zone.zoneId === space?.zoneId)).toBe(true)
      expect(spatial!.graph.spaces.some(original => original.spaceId === space?.spaceId)).toBe(true)
    }
    for (const session of saved.protected.sessions) expect(spatial!.graph.regions.some(region => region.agentSessionId === session.id && region.runId === session.control.run.runId)).toBe(true)
    await click(button('Expand survey group: Saved original group'))
    expect([...group(saved.organization.groups[0].groupId).querySelectorAll<HTMLElement>('[data-survey-zone-id]')].map(item => item.dataset.surveyZoneId)).toEqual([saved.zones[0], saved.zones[1]])
    expect(useAppStore.getState().surveyZoneSelection).toEqual(saved.selection); fixture.noLifecycle()
    await writeFile(path + '.read-proof.json', JSON.stringify({ pid: process.pid, writerPid: saved.pid, organization: saved.organization,
      selected: useAppStore.getState().surveyZoneSelection, originalSessionIds: saved.protected.sessions.map((session: { id: string }) => session.id) }))
  }
})
