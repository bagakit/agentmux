const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { createRequire } from 'node:module'
import { act, createElement, useEffect } from 'react'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
vi.mock('react-resizable-panels', () => createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js'))
const leaves = vi.hoisted(() => ({ mounts: [] as string[], unmounts: [] as string[] }))
// Only PTY painting is isolated. The App/Global/Store/Workbench and shared menu stay actual.
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: ({ sessionId }: { sessionId: string }) => {
  useEffect(() => { leaves.mounts.push(sessionId); return () => { leaves.unmounts.push(sessionId) } }, [sessionId])
  const draft = useAppStore(state => state.agentComposerDrafts[sessionId] ?? '')
  return createElement('textarea', { 'aria-label': 'Original draft', value: draft, readOnly: true })
} }))
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
import { App } from '../src/renderer/src/App'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { addWorkbenchRegion, createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { installNativePopover, moteAgent, moteTopics, scratchWorkspace, customMoteId, quietMoteId } from './fixtures/mote-workface'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { directoryIdentity, homeZoneId } from '../src/shared/space-addresses'
import { readPmoTeamsTopicFloatingState, requestPmoTeamsTopicFloatingClose } from '../src/renderer/src/lib/pmo-teams-topic-floating'
const initial = useAppStore.getState()
async function fixture() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); window.localStorage.clear(); leaves.mounts = []; leaves.unmounts = []
  const restorePopover = installNativePopover(), config = await api.config.get(), snapshot = await api.sessions.snapshot()
  const base = snapshot.sessions.find(session => session.kind === 'agent')!; expect(base.kind).toBe('agent')
  const { repoPath: _repoPath, ...workspaceBase } = config.workspaces[0]!
  const { pendingInteraction: _pendingInteraction, ...agentBase } = base
  const alpha = { ...workspaceBase, id: 'alpha', path: _hygiene_fixturePath("private/alpha"), name: '长中文项目：连续输入与性能研究，保留完整名称' }
  const beta = { ...alpha, id: 'beta', path: _hygiene_fixturePath("private/beta"), name: 'Beta' }
  const states = ['working', 'error', 'done', 'running', 'disconnected', 'disconnected'] as const
  const sessions = states.map((state, i) => ({ ...agentBase, id: ['working','attention','results','idle','offline','healthy-lost'][i]!,
    label: ['Repair parser','Review permission','Reviewed change','Idle context','Archived context','Healthy observation lost'][i]!,
    workspacePath: alpha.path, processState: i === 4 ? 'interrupted' as const : 'running' as const,
    status: { state, source: 'native-hook' as const, observedAt: Date.now() }, control: { ...base.control, run: { runId: `private-${i}` } } }))
  sessions.push({ ...sessions[0]!, id: 'beta-agent', workspacePath: beta.path, label: 'Beta parser' })
  const tab = createWorkbenchTab('original', { regionId: 'original-region', workspaceId: alpha.id, kind: 'agent', phase: 'attached', sessionId: 'working' }, 'Original work')
  useAppStore.setState({ ...initial, initialize: async () => () => {}, loading: false, config: { ...config, workspaces: [alpha, beta] }, sessions,
    tabs: { original: tab }, layouts: { alpha: createWorkspaceLayout('original-group', [tab.id]), beta: createWorkspaceLayout('beta-group') },
    activeWorkspaceId: alpha.id, mainSurface: 'workbench', toolsOpen: false, projectRailOpen: false, timelines: { results: { agentSessionId:'results', revision:1,
      items:[{id:'answer',agentSessionId:'results',kind:'assistant_message',source:'native-hook',status:'complete',title:'Answer',content:'Reviewed and complete',createdAt:1,updatedAt:1}] } },
    agentNames: Object.fromEntries(sessions.map(session => [session.id, session.label])), agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } }, agentComposerDrafts: { working: 'Original unsent draft' } }, true)
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  await act(async () => root.render(createElement(App)))
  await act(async () => { useAppStore.getState().focusRegion(alpha.id, tab.id, 'original-region', 'pointer', 'original-group'); useAppStore.getState().setMainSurface('agents') })
  expect(container.querySelector('.global-focus-surface')).not.toBeNull()
  const trigger = () => container.querySelector<HTMLButtonElement>('[aria-label="Focus filters"]')!
  const search = () => container.querySelector<HTMLInputElement>('[aria-label="Search contexts"]')!
  async function open(mode: 'keyboard' | 'hover' = 'keyboard') {
    if (document.querySelector('.focus-filter-menu')) return
    expect(trigger()).not.toBeNull()
    await act(async () => mode === 'hover' ? trigger().dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', buttons: 0 })) : trigger().dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' })))
    await vi.waitFor(async () => { await act(async () => {}); expect(document.querySelector('.focus-filter-menu [role="menuitemcheckbox"]')).not.toBeNull() })
  }
  const menu = () => document.querySelector<HTMLElement>('.focus-filter-menu')!
  async function choose(kind: 'project' | 'state', value: string) {
    await open(); const all = menu().querySelector<HTMLElement>(`[data-focus-${kind}="all"]`)!;await act(async()=>all.click())
    const key=kind==='project'&&value!=='all'?JSON.stringify([alpha.hostId,value]):value; const target = [...menu().querySelectorAll<HTMLElement>(`[data-focus-${kind}]`)].find(node=>node.getAttribute(`data-focus-${kind}`)===key); expect(target).not.toBeNull()
    await act(async () => target!.click()); await act(async () => {})
    await escape()
  }
  async function escape() { expect(menu()).not.toBeNull(); await act(async () => menu().dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }))); await act(async () => {}) }
  async function query(value: string) { const input = search(); expect(input).not.toBeNull(); await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value); input.dispatchEvent(new Event('input',{bubbles:true})) }) }
  const ids = () => [...container.querySelectorAll<HTMLElement>('.focus-context[data-session-id]')].map(node => node.dataset.sessionId).sort()
  return { container, alpha, trigger, search, open, menu, choose, escape, query, ids, async close() {
    await act(async () => requestPmoTeamsTopicFloatingClose());
    await act(async () => root.unmount()); container.remove(); restorePopover(); useAppStore.setState(initial, true); window.localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals()
  } }
}
it('actual App uses one shared filter entry, all real projects and four task group counts, without a hidden native select', async () => {
  const f=await fixture();try {
    expect(f.trigger()).not.toBeNull(); expect(f.container.querySelectorAll('.focus-filters select')).toHaveLength(0)
    expect(f.container.querySelectorAll('[aria-label="Search contexts"]')).toHaveLength(1); await f.open()
    expect([...f.menu().querySelectorAll('[data-focus-project]')].map(node=>[node.getAttribute('data-focus-project'),node.querySelector('.focus-filter-menu__name')?.textContent])).toEqual([['all','All projects'],[JSON.stringify([f.alpha.hostId,'alpha']),f.alpha.name],[JSON.stringify([f.alpha.hostId,'beta']),'Beta']])
    const counts=[...f.menu().querySelectorAll('[data-focus-state]')].map(node=>[node.querySelector('.focus-filter-menu__name')?.textContent,node.querySelector('.focus-filter-menu__count')?.textContent??null])
    expect(counts).toEqual([['All states',null],['Attention','1'],['Working','2'],['Results','1'],['Idle / Recovery','3'],['Activity unknown','2'],['Needs recovery','1']])
    expect([...f.menu().querySelectorAll('[role="menuitem"]')].map(node => node.textContent)).toEqual(['Clear filters', 'Search all retained conversation text', 'Done'])
    expect(f.menu().querySelectorAll('[aria-checked="true"]')).toHaveLength(3)
    await f.escape(); expect(f.ids()).toEqual(['attention','beta-agent','healthy-lost','idle','offline','results','working'])
  } finally {await f.close()}
})
it('project and Recovery filters cross original search without hiding interrupted tasks in another directory', async()=>{
  const f=await fixture();try {
    await f.choose('project','alpha');await f.choose('state','working');await f.query('parser')
    expect(f.ids()).toEqual(['working']);expect(f.trigger().getAttribute('aria-description')).toBe(`${f.alpha.name} · Working · All types`)
    await f.choose('project','beta');expect(f.ids()).toEqual(['beta-agent']);await f.choose('state','idle');expect(f.ids()).toEqual([])
    await f.choose('project','alpha');await f.query('Archived');expect(f.ids()).toEqual(['offline'])
    expect(f.container.querySelector('[data-session-id="offline"]')?.closest('[data-bucket="idle"]')).not.toBeNull()
    expect(f.container.querySelector('[aria-label="Disconnected projects"]')).toBeNull()
    await f.query('');expect(f.ids()).toEqual(['healthy-lost','idle','offline'])
  } finally {await f.close()}
})

it('hover reads all full values without stealing the original query input, caret or the next key', async () => {
  const f=await fixture();try {
    await f.query('parser');const input=f.search();input.focus();input.setSelectionRange(2,5)
    await f.open('hover');expect(document.activeElement).toBe(input);expect(input.selectionStart).toBe(2);expect(input.selectionEnd).toBe(5)
    const row=[...f.menu().querySelectorAll<HTMLElement>('[data-focus-project]')].find(node=>node.getAttribute('data-focus-project')===JSON.stringify([f.alpha.hostId,'alpha']))!;expect(row.querySelector('.focus-filter-menu__name')?.textContent).toBe(f.alpha.name)
    await act(async()=>row.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerType:'mouse',buttons:0})))
    expect(document.activeElement).toBe(input);await f.escape();expect(document.activeElement).toBe(input)
    await f.query('parser next');expect(f.search()).toBe(input);expect(input.value).toBe('parser next')
  } finally {await f.close()}
})
it('keyboard menu and Escape return to this same trigger while a later deliberate control keeps focus', async () => {
  const f=await fixture();try {
    expect(f.trigger()).not.toBeNull();f.trigger().focus();await f.open();expect(f.menu().contains(document.activeElement)).toBe(true)
    await f.escape();await vi.waitFor(()=>expect(document.activeElement).toBe(f.trigger()))
    await f.open();await act(async()=>{f.menu().dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Escape'}));f.search().focus()});await act(async()=>{});expect(document.activeElement).toBe(f.search())
    expect(f.container.querySelector('[aria-label="Tab actions"]')).not.toBeNull();expect(f.container.querySelector('[aria-label="Close Focus workspace"]')).not.toBeNull()
  } finally {await f.close()}
})
it('filtering and width changes preserve original work, query DOM, Range, draft, exact Run and layout', async () => {
  const f=await fixture();try {
    const before=useAppStore.getState(),input=f.search(),trigger=f.trigger(),draft=f.container.querySelector<HTMLTextAreaElement>('[aria-label="Original draft"]')!
    expect(draft).not.toBeNull();draft.setSelectionRange(7,15);const runs=before.sessions.map(session=>session.control.run),mounts=[...leaves.mounts]
    await f.choose('state','attention');await act(async()=>{ window.dispatchEvent(new Event('resize')) })
    expect(f.search()).toBe(input);expect(f.trigger()).toBe(trigger);expect(f.container.querySelector('[aria-label="Original draft"]')).toBe(draft);expect([draft.selectionStart,draft.selectionEnd]).toEqual([7,15]);expect(draft.value).toBe('Original unsent draft')
    const after=useAppStore.getState();expect(after.tabs).toBe(before.tabs);expect(after.layouts).toBe(before.layouts);expect(after.agentFocus).toBe(before.agentFocus);expect(after.agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(after.sessions.map(session=>session.control.run)).toEqual(runs);expect(leaves.mounts).toEqual(mounts);expect(leaves.unmounts).toEqual([])
  } finally {await f.close()}
})
it('twenty irrelevant outputs add no read, filesystem, appearance, fit, control or original leaf mount', async () => {
  const f=await fixture();try {
    const reads=[vi.spyOn(api.sessions,'historyPage'),vi.spyOn(api.sessions,'timeline'),vi.spyOn(api.sessions,'historySources'),vi.spyOn(api.scratch,'listTopics'),vi.spyOn(api.workspaces,'appearance'),vi.spyOn(api.sessions,'stop'),vi.spyOn(api.sessions,'resume'),vi.spyOn(api.sessions,'write')]
    const mounts=[...leaves.mounts],input=f.search();expect(f.ids()).toEqual(['attention','beta-agent','healthy-lost','idle','offline','results','working'])
    for(let i=0;i<20;i++)await act(async()=>useAppStore.setState(state=>({sessions:state.sessions.map(session=>session.id==='beta-agent'?{...session,latestOutputBytes:session.latestOutputBytes+10,status:{...session.status,observedAt:i+2}}:session)})))
    reads.forEach(read=>expect(read).not.toHaveBeenCalled());expect(leaves.mounts).toEqual(mounts);expect(leaves.unmounts).toEqual([]);expect(f.search()).toBe(input)
  } finally {await f.close()}
})

it('combines projects and states with OR within each dimension and keeps types as a separate AND condition', async () => {
  const f = await fixture(); try {
    await f.open()
    const toggle = async (kind: string, id: string) => {
      const item = [...f.menu().querySelectorAll<HTMLElement>(`[data-focus-${kind}]`)].find(node => node.getAttribute(`data-focus-${kind}`) === id)!
      expect(item).not.toBeNull(); await act(async () => item.click())
      expect(f.menu()).not.toBeNull()
    }
    await toggle('project', JSON.stringify([f.alpha.hostId, 'alpha']))
    await toggle('project', JSON.stringify([f.alpha.hostId, 'beta']))
    await toggle('state', 'attention'); await toggle('state', 'working')
    expect(f.ids()).toEqual(['attention', 'beta-agent', 'working'])
    await toggle('type', 'project'); expect(f.ids()).toEqual(['attention', 'beta-agent', 'working'])
    await toggle('type', 'survey'); expect(f.ids()).toEqual(['attention', 'beta-agent', 'working'])
    await toggle('type', 'project'); expect(f.ids()).toEqual([])
    expect(f.trigger().getAttribute('aria-description')).toContain('Survey')
    await f.escape()
    const clear = f.container.querySelector<HTMLButtonElement>('.focus-project-lanes__clear')!
    expect(clear).not.toBeNull(); await act(async () => clear.click())
    expect(f.ids()).toEqual(['attention','beta-agent','healthy-lost','idle','offline','results','working'])
  } finally { await f.close() }
})

it('searches menu options without changing filters, and state selection preserves project, type and text', async () => {
  const f = await fixture(); try {
    await f.choose('project', 'alpha'); await f.query('parser'); await f.open()
    const input = f.menu().querySelector<HTMLInputElement>('[aria-label="Find Focus filter options"]')!
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Project'); input.dispatchEvent(new Event('input', {bubbles:true})) })
    expect(f.ids()).toEqual(['working']); expect(f.search().value).toBe('parser')
    expect([...f.menu().querySelectorAll('[data-focus-type]')].map(node=>node.getAttribute('data-focus-type'))).toEqual(['all','project'])
    const type = f.menu().querySelector<HTMLElement>('[data-focus-type="project"]')!; await act(async()=>type.click())
    await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Attention');input.dispatchEvent(new Event('input', {bubbles:true}))})
    const attention = f.menu().querySelector<HTMLElement>('[data-focus-state="attention"]')!;expect(attention).not.toBeNull();await act(async()=>attention.click())
    expect(f.menu()).not.toBeNull();expect(attention.getAttribute('aria-checked')).toBe('true')
    expect(f.ids()).toEqual([]);expect(f.search().value).toBe('parser')
    expect(f.trigger().getAttribute('aria-description')).toBe(`${f.alpha.name} · Attention · Project`)
  } finally { await f.close() }
})

let coordinationFixtureSequence = 0
async function addCoordination(f: Awaited<ReturnType<typeof fixture>>, positions: 'one' | 'multiple' | 'none' = 'one') {
  const sequence = ++coordinationFixtureSequence
  const first = moteAgent('mote-one', customMoteId, 'waiting'), second = moteAgent('mote-two', quietMoteId)
  const firstTopic = moteTopics.find(topic => topic.id === customMoteId)!, secondTopic = moteTopics.find(topic => topic.id === quietMoteId)!
  const zone = homeZoneId(directoryIdentity(scratchWorkspace.hostId, firstTopic.directoryPath))
  const tab = createWorkbenchTab(`mote-tab-${sequence}`, { regionId: 'mote-target-region', workspaceId: scratchWorkspace.id, kind: 'agent', phase: 'attached', sessionId: first.id }, 'Original Mote location')
  tab.topicId = customMoteId; tab.space = { spaceId: directoryIdentity('local', firstTopic.directoryPath), zoneId: zone }
  const withNeighbor = addWorkbenchRegion(tab, 'mote-target-region', 'right', { regionId: 'other-active-region', workspaceId: f.alpha.id, kind: 'agent', phase: 'attached', sessionId: 'working' })
  const another = createWorkbenchTab(`other-mote-tab-${sequence}`, { regionId: 'other-mote-region', workspaceId: scratchWorkspace.id, kind: 'agent', phase: 'attached', sessionId: second.id }, secondTopic.title)
  another.topicId = quietMoteId
  const duplicate = { ...tab, id: `second-location-${sequence}`, name: 'Second original Mote location' }
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue(moteTopics)
  await act(async () => useAppStore.setState(state => ({
    config: { ...state.config!, workspaces: [...state.config!.workspaces, scratchWorkspace] },
    sessions: [...state.sessions, first, second], agentNames: { ...state.agentNames, [first.id]: 'Mote analyst', [second.id]: 'Mote writer' },
    tabs: { ...state.tabs, ...(positions === 'none' ? {} : { [tab.id]: withNeighbor }), [another.id]: another, ...(positions === 'multiple' ? { [duplicate.id]: duplicate } : {}) },
    layouts: { ...state.layouts, [scratchWorkspace.id]: createWorkspaceLayout('coordination-group', [...(positions === 'none' ? [] : [tab.id]), another.id, ...(positions === 'multiple' ? [duplicate.id] : [])]) },
    scratchTopicSnapshots: { ...state.scratchTopicSnapshots, [scratchWorkspace.id]: { scope: scratchTopicsScope(scratchWorkspace), revision: 1, reading: false, error: null, topics: moteTopics } },
    spaceZoneBindings: { ...state.spaceZoneBindings, [zone]: { spaceId: directoryIdentity('local', firstTopic.directoryPath), workspaceId: scratchWorkspace.id, topicId: customMoteId, contentKind: 'mote', directoryPath: firstTopic.directoryPath } },
    surveyCollectedZones: { [zone]: true }, surveyOrganization: { ungrouped: [zone], groups: [] }
  })))
  const toggle = async (dimension: string, id: string) => {
    await f.open(); const item = [...f.menu().querySelectorAll<HTMLElement>(`[data-focus-${dimension}]`)].find(node => node.getAttribute(`data-focus-${dimension}`) === id)
    expect(item).not.toBeNull(); await act(async () => item!.click())
  }
  const coordinationIds = () => [...f.container.querySelectorAll<HTMLElement>('.focus-coordination-results .focus-context[data-session-id]')].map(node => node.dataset.sessionId).sort()
  return { tab, duplicate, first, second, toggle, coordinationIds }
}
it('actual App exposes useful Mote facets and independently combines coordination source, project, state and text', async () => {
  const f = await fixture(); try {
    const c = await addCoordination(f), before = useAppStore.getState(), draft = f.container.querySelector<HTMLTextAreaElement>('[aria-label="Original draft"]')!
    draft.setSelectionRange(3, 8)
    expect(c.coordinationIds()).toEqual([])
    await f.open()
    expect(f.menu().querySelector('[data-focus-type="mote"] .focus-filter-menu__count')?.textContent).toBe('2')
    expect(c.coordinationIds()).toEqual([]) // Inspecting counts is not a filter edit.
    await c.toggle('type', 'mote'); expect(c.coordinationIds()).toEqual(['mote-one', 'mote-two'])
    expect(f.container.querySelector('.focus-project-lanes__row .focus-context')).toBeNull()
    await c.toggle('type', 'survey'); expect(c.coordinationIds()).toEqual(['mote-one', 'mote-two'])
    await c.toggle('type', 'mote'); expect(c.coordinationIds()).toEqual(['mote-one'])
    await c.toggle('project', JSON.stringify(['local', scratchWorkspace.id])); await c.toggle('state', 'attention')
    await f.escape(); await f.query('Mote analyst'); expect(c.coordinationIds()).toEqual(['mote-one'])
    await f.query('Mote writer'); expect(c.coordinationIds()).toEqual([])
    await f.query('Mote analyst'); expect(c.coordinationIds()).toEqual(['mote-one'])
    const after = useAppStore.getState()
    expect(after.agentFocus).toBe(before.agentFocus); expect(after.tabs).toBe(before.tabs); expect(after.layouts).toBe(before.layouts)
    expect(after.agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(f.container.querySelector('[aria-label="Original draft"]')).toBe(draft)
    expect([draft.selectionStart, draft.selectionEnd]).toEqual([3, 8])
    await f.open(); const clear = [...f.menu().querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent === 'Clear filters')!
    await act(async () => clear.click()); expect(c.coordinationIds()).toEqual([])
    expect(f.ids()).toEqual(['attention','beta-agent','healthy-lost','idle','offline','results','working'])
  } finally { await f.close() }
})
it('Mote result navigation selects its original inactive Region and preserves execution focus and draft', async () => {
  const f = await fixture(); try {
    const c = await addCoordination(f), before = useAppStore.getState()
    await c.toggle('type', 'mote'); await f.escape()
    const row = f.container.querySelector<HTMLButtonElement>('.focus-coordination-results [data-session-id="mote-one"]')!
    expect(row).not.toBeNull(); await act(async () => row.click())
    expect(readPmoTeamsTopicFloatingState()?.reference).toMatchObject({ tabId: c.tab.id, regionId: 'mote-target-region' })
    expect(useAppStore.getState().agentFocus.pmo.sessionId).toBe('mote-one')
    expect(useAppStore.getState().agentFocus.execution).toBe(before.agentFocus.execution)
    expect(useAppStore.getState().agentComposerDrafts.working).toBe('Original unsent draft')
    expect(useAppStore.getState().sessions.find(session => session.id === 'working')?.control.run).toBe(before.sessions.find(session => session.id === 'working')?.control.run)
  } finally { await f.close() }
})
it('Mote multiple and missing locations keep the original execution work until an exact location is chosen', async () => {
  const f = await fixture(); try {
    const c = await addCoordination(f, 'multiple'), before = useAppStore.getState()
    await c.toggle('type', 'mote'); await f.escape()
    await act(async () => f.container.querySelector<HTMLButtonElement>('.focus-coordination-results [data-session-id="mote-one"]')!.click())
    let choices = f.container.querySelector('[aria-label="Choose original Mote location"]')!
    expect(choices).not.toBeNull(); expect(choices.querySelectorAll('.focus-location-choice')).toHaveLength(2)
    const dismiss = [...choices.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Dismiss location choices')!
    dismiss.focus(); await act(async () => dismiss.click())
    expect([f.trigger(), f.search()]).toContain(document.activeElement)
    await act(async () => f.container.querySelector<HTMLButtonElement>('.focus-coordination-results [data-session-id="mote-one"]')!.click())
    choices = f.container.querySelector('[aria-label="Choose original Mote location"]')!
    expect(choices.querySelectorAll('.focus-location-choice')).toHaveLength(2)
    expect(useAppStore.getState().agentFocus).toBe(before.agentFocus)
    const second = [...choices.querySelectorAll<HTMLButtonElement>('.focus-location-choice')].find(button => button.textContent?.includes('Second original Mote location'))!
    expect(second).not.toBeNull(); await act(async () => second.click())
    expect(readPmoTeamsTopicFloatingState()?.reference).toMatchObject({ tabId: c.duplicate.id, regionId: 'mote-target-region' })
    expect(useAppStore.getState().agentFocus.execution).toBe(before.agentFocus.execution)
    await act(async () => useAppStore.setState(state => { const { [c.tab.id]: _first, [c.duplicate.id]: _second, ...tabs } = state.tabs; return { tabs } }))
    await act(async () => f.container.querySelector<HTMLButtonElement>('.focus-coordination-results [data-session-id="mote-one"]')!.click())
    expect(f.container.querySelector('[aria-label="Choose original Mote location"]')?.textContent).toContain('No original Mote location is confirmed')
    expect(useAppStore.getState().agentFocus.execution).toBe(before.agentFocus.execution)
    expect(useAppStore.getState().agentComposerDrafts.working).toBe('Original unsent draft')
  } finally { await f.close() }
})

it('a stale Mote location choice cannot retarget coordination after its original content becomes a Topic', async () => {
  const f = await fixture(); try {
    const c = await addCoordination(f, 'multiple')
    await c.toggle('type', 'mote'); await f.escape()
    await act(async () => f.container.querySelector<HTMLButtonElement>('.focus-coordination-results [data-session-id="mote-one"]')!.click())
    expect(f.container.querySelector('[aria-label="Choose original Mote location"]')).not.toBeNull()
    await act(async () => useAppStore.setState(state => ({ scratchTopicSnapshots: { ...state.scratchTopicSnapshots,
      [scratchWorkspace.id]: { ...state.scratchTopicSnapshots[scratchWorkspace.id]!, revision: 2,
        topics: moteTopics.map(topic => topic.id === customMoteId ? { ...topic, kind: 'topic' as const } : topic) }
    } })))
    const before = useAppStore.getState(), floating = readPmoTeamsTopicFloatingState()
    const button = f.container.querySelector<HTMLButtonElement>('[aria-label="Choose original Mote location"] .focus-location-choice')!
    expect(button).not.toBeNull(); await act(async () => button.click())
    expect(useAppStore.getState().agentFocus).toBe(before.agentFocus)
    expect(readPmoTeamsTopicFloatingState()).toBe(floating)
    expect(useAppStore.getState().agentComposerDrafts.working).toBe('Original unsent draft')
  } finally { await f.close() }
})
it('a Mote-only candidate set with no local match exposes the same clear-filter action', async () => {
  const f = await fixture(); try {
    const c = await addCoordination(f)
    await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.filter(session => session.id === c.first.id || session.id === c.second.id),
      agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } } })))
    await c.toggle('type', 'mote'); await f.escape(); expect(c.coordinationIds()).toEqual(['mote-one', 'mote-two'])
    await f.query('no original metadata matches this query')
    expect(c.coordinationIds()).toEqual([])
    expect(f.container.textContent).toContain('No contexts match these local filters.')
    expect(f.container.textContent).not.toContain('No execution contexts yet')
    expect(f.container.querySelector('.focus-project-lanes__clear')).not.toBeNull()
  } finally { await f.close() }
})

it('actual Mote filter and card path does not reread accepted conversation text', async () => {
  const f = await fixture(); try {
    const c = await addCoordination(f)
    let bodyReads = 0
    const message = { id: 'retained-mote-reply', agentSessionId: c.first.id, kind: 'assistant_message' as const, source: 'native-hook' as const,
      status: 'complete' as const, title: 'Original reply', content: 'Accepted Mote content outside metadata filtering', createdAt: 1, updatedAt: 1 }
    Object.defineProperty(message, 'content', { get() { bodyReads++; return 'Accepted Mote content outside metadata filtering' } })
    await act(async () => useAppStore.setState(state => ({ timelines: { ...state.timelines, [c.first.id]: { agentSessionId: c.first.id, revision: 1, items: [message] } } })))
    bodyReads = 0
    await c.toggle('type', 'mote'); await f.escape(); expect(c.coordinationIds()).toEqual(['mote-one', 'mote-two'])
    await f.query('Mote analyst'); expect(c.coordinationIds()).toEqual(['mote-one'])
    await c.toggle('state', 'attention'); await f.escape(); expect(c.coordinationIds()).toEqual(['mote-one'])
    expect(bodyReads).toBe(0)
  } finally { await f.close() }
})
