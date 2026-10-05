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
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { installNativePopover } from './fixtures/mote-workface'
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
    expect(trigger()).not.toBeNull()
    await act(async () => mode === 'hover' ? trigger().dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', buttons: 0 })) : trigger().dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' })))
    await vi.waitFor(async () => { await act(async () => {}); expect(document.querySelector('.focus-filter-menu [role="menuitemradio"]')).not.toBeNull() })
  }
  const menu = () => document.querySelector<HTMLElement>('.focus-filter-menu')!
  async function choose(kind: 'project' | 'state', value: string) {
    await open(); const key=kind==='project'&&value!=='all'?JSON.stringify([alpha.hostId,value]):value; const target = [...menu().querySelectorAll<HTMLElement>(`[data-focus-${kind}]`)].find(node=>node.getAttribute(`data-focus-${kind}`)===key); expect(target).not.toBeNull()
    await act(async () => target!.click()); await act(async () => {})
  }
  async function escape() { expect(menu()).not.toBeNull(); await act(async () => menu().dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }))); await act(async () => {}) }
  async function query(value: string) { const input = search(); expect(input).not.toBeNull(); await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value); input.dispatchEvent(new Event('input',{bubbles:true})) }) }
  const ids = () => [...container.querySelectorAll<HTMLElement>('.focus-context[data-session-id]')].map(node => node.dataset.sessionId).sort()
  return { container, alpha, trigger, search, open, menu, choose, escape, query, ids, async close() {
    await act(async () => root.unmount()); container.remove(); restorePopover(); useAppStore.setState(initial, true); window.localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals()
  } }
}
it('actual App uses one shared filter entry, all real projects and four task group counts, without a hidden native select', async () => {
  const f=await fixture();try {
    expect(f.trigger()).not.toBeNull(); expect(f.container.querySelectorAll('.focus-filters select')).toHaveLength(0)
    expect(f.container.querySelectorAll('[aria-label="Search contexts"]')).toHaveLength(1); await f.open()
    expect([...f.menu().querySelectorAll('[data-focus-project]')].map(node=>[node.getAttribute('data-focus-project'),node.textContent])).toEqual([['all','All projects'],[JSON.stringify([f.alpha.hostId,'alpha']),f.alpha.name],[JSON.stringify([f.alpha.hostId,'beta']),'Beta']])
    const counts=[...f.menu().querySelectorAll('[data-focus-state]')].map(node=>node.textContent)
    expect(counts,JSON.stringify({counts,statuses:useAppStore.getState().sessions.map(session=>[session.id,session.status.state])})).toEqual(['All states','Attention · 1','Working · 2','Results · 1','Idle / Recovery · 3'])
    expect(f.menu().querySelectorAll('[aria-checked="true"]')).toHaveLength(2)
    await f.escape(); expect(f.ids()).toEqual(['attention','beta-agent','healthy-lost','idle','offline','results','working'])
  } finally {await f.close()}
})
it('project and Recovery filters cross original search without hiding interrupted tasks in another directory', async()=>{
  const f=await fixture();try {
    await f.choose('project','alpha');await f.choose('state','working');await f.query('parser')
    expect(f.ids()).toEqual(['working']);expect(f.trigger().getAttribute('aria-description')).toBe(`${f.alpha.name} · Working`)
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
    const row=[...f.menu().querySelectorAll<HTMLElement>('[data-focus-project]')].find(node=>node.getAttribute('data-focus-project')===JSON.stringify([f.alpha.hostId,'alpha']))!;expect(row.textContent).toBe(f.alpha.name)
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
    expect(f.container.querySelector('[aria-label="Focus context actions"]')).not.toBeNull();expect(f.container.querySelector('[aria-label="Close Focus workspace"]')).not.toBeNull()
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
