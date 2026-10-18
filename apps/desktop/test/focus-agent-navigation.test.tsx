// @vitest-environment happy-dom
import { act, createElement, Profiler } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { createWorkspaceLayout } from '@agentmux/layout'
import { parseAgentMuxControlRequest, parseAgentMuxControlReceipt, type AgentMuxControlResult, type AgentMuxDesktopFocusResult } from '@agentmux/core'
import { composerDOM, composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { installCollaborationCanvasGeometry } from './helpers/collaboration-canvas-dom'
import { installCollaborationLayoutLoopback, settleCollaborationCanvas } from './helpers/collaboration-layout-loopback'
vi.mock('react-resizable-panels', () => createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js'))
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: ({ sessionId }: { sessionId: string }) => <textarea aria-label="Original draft" value={useAppStore(state => state.agentComposerDrafts[sessionId] ?? '')} readOnly /> }))
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
import { App } from '../src/renderer/src/App'
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { readFocusAgentPresentation } from '../src/renderer/src/lib/desktop-presentation'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { fixturePath } from '../../../test/fixture-values.mjs'
const dom = composerDOM({ agentInformation: true }), initial = useAppStore.getState(), workspace = composerConfig.workspaces[0]!
const working = (id: string) => ({ ...composerSession(id), status: { state: 'working' as const, source: 'native-hook' as const, observedAt: Date.now() } })
beforeEach(() => {
 installCollaborationCanvasGeometry(); installCollaborationLayoutLoopback()
 vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
 vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900)
 vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(500)
 vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
  if (this.dataset.focusCardKey) {
   const index = [...this.parentElement!.children].indexOf(this), rows = this.closest<HTMLElement>('.focus-project-lanes__rows')
   return new DOMRect(index % 3 * 250, Math.floor(index / 3) * 110 - (rows?.scrollTop ?? 0), 250, 94)
  }
  return new DOMRect(0, 0, 900, 500)
 })
 vi.spyOn(HTMLElement.prototype, 'scrollBy').mockImplementation(function (this: HTMLElement, input: number | ScrollToOptions, y?: number) { this.scrollTop += typeof input === 'number' ? y ?? 0 : input.top ?? 0; this.scrollLeft += typeof input === 'number' ? input : input.left ?? 0 })
 const tab = createWorkbenchTab('original-tab', { kind: 'agent', phase: 'attached', regionId: 'original-region', workspaceId: workspace.id, sessionId: 'original' })
 useAppStore.setState({ ...initial, loading: false, initialize: async () => () => {}, config: composerConfig, sessions: [working('original'), working('target')],
  agentNames: { original: 'Original task', target: 'Target task' }, tabs: { [tab.id]: tab }, layouts: { [workspace.id]: createWorkspaceLayout('original-group', [tab.id]) }, activeWorkspaceId: workspace.id,
  workbenchSpaceSelection: null, mainSurface: 'agents', focusView: 'list', focusAgentReveal: null, toolsOpen: false, projectRailOpen: false,
  agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } }, timelines: {}, agentComposerDrafts: { original: 'Original unsent draft' } }, true)
 vi.spyOn(api.sessions, 'historySources').mockResolvedValue([])
 vi.spyOn(api.sessions, 'messageEvents').mockImplementation(async (subject, options) => ({ ...subject, participantSessionId: subject.agentSessionId, latest: options?.latest ?? false, beforeSequence: null, afterSequence: options?.afterSequence ?? 0, throughSequence: 0, incarnation: 'focus-nav-journal', messageId: null, broadcastOperationId: null, events: [], nextAfterSequence: null, nextBeforeSequence: null }))
 vi.spyOn(api.sessions, 'spawns').mockImplementation(async (subject, options) => ({ ...subject, participantSessionId: subject.agentSessionId, direction: options.direction, creatorRuntimeId: null, records: [], nextCursor: null, coverage: { scope: 'selected-owner', history: 'recorded-creations' } }))
 vi.spyOn(api.sessions, 'onEvent').mockReturnValue(() => {})
 vi.spyOn(api.sessions, 'readMessage').mockRejectedValue(Error('No body read authorized'))
 vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
})
const card = (id: string) => document.querySelector<HTMLElement>(`.global-focus-surface .focus-context[data-session-id="${id}"]`)
async function query(value: string) {
 const input = document.querySelector<HTMLInputElement>('[aria-label="Search contexts"]')!
 await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
}
it('reveals the exact Host through the actual App without a Region and never substitutes another Host', async () => {
 const original = useAppStore.getState(), remote = { ...working('other-host'), control: { ...working('target').control, hostId: 'remote' } }
 useAppStore.setState({ sessions: [working('original'), remote, working('target')] })
 await dom.render(createElement(App))
 await act(async () => useAppStore.getState().revealFocusAgent({ hostId: 'local', agentSessionId: 'target' }))
 expect(card('target')?.getAttribute('aria-pressed')).toBe('true')
 expect(card('other-host')?.getAttribute('aria-pressed')).toBe('false')
 expect(readFocusAgentPresentation(useAppStore.getState().focusAgentReveal)).toMatchObject({ hostId: 'local', agentSessionId: 'target', presentationSessionId: 'target', state: 'visible' })
 expect(useAppStore.getState().tabs).toBe(original.tabs); expect(useAppStore.getState().agentComposerDrafts).toBe(original.agentComposerDrafts)
 expect(api.sessions.readMessage).not.toHaveBeenCalled()
})
it('temporarily reveals a filtered and lazy target while preserving the original filters and view reading', async () => {
 await dom.render(createElement(App)); await query('Original task')
 expect(card('target')).toBeNull()
 await act(async () => useAppStore.getState().revealFocusAgent({ hostId: 'local', agentSessionId: 'target' }))
 expect(card('target')?.getAttribute('aria-pressed')).toBe('true')
 expect(document.querySelector('[aria-label="Focus Agent reveal"]')?.textContent).toContain('outside current filters')
 expect(document.querySelector<HTMLInputElement>('[aria-label="Search contexts"]')?.value).toBe('Original task')
 const held = card('target'), request = useAppStore.getState().focusAgentReveal
 expect(request?.pending).toBe(false)
 await act(async () => useAppStore.getState().setFocusView('map'))
 await act(async () => useAppStore.getState().setFocusView('list'))
 expect(useAppStore.getState().focusAgentReveal).toBe(request); expect(card('target')).toBe(held)
 await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'End reveal')!.click())
 expect(card('target')).toBeNull(); expect(document.querySelector<HTMLInputElement>('[aria-label="Search contexts"]')?.value).toBe('Original task')
})
it('routes View in Focus through the actual Map and App and preserves ordinary view selections', async () => {
 await dom.render(createElement(App))
 await act(async () => useAppStore.getState().openCollaborationMap({ kind: 'focus', subject: { hostId: 'local', agentSessionId: 'target' }, name: 'Target task' }))
 await settleCollaborationCanvas(() => expect(document.querySelector('.collaboration-map .focus-context[data-session-id="target"]')).not.toBeNull())
 await act(async () => document.querySelector<HTMLButtonElement>('.collaboration-map .focus-context[data-session-id="target"]')!.click())
 const button = [...document.querySelectorAll<HTMLButtonElement>('.collaboration-map button')].find(button => button.textContent?.startsWith('View in Focus'))!
 expect(button).toBeTruthy(); await act(async () => button.click())
 expect(useAppStore.getState()).toMatchObject({ mainSurface: 'agents', focusView: 'list' })
 expect(card('target')?.getAttribute('aria-pressed')).toBe('true')
 const map = document.querySelector('.collaboration-map')
 await act(async () => useAppStore.getState().setFocusView('map'))
 expect(document.querySelector('.collaboration-map')).toBe(map)
 expect(map?.querySelector('h3')?.textContent).toBe('Target task')
 expect(useAppStore.getState().agentComposerDrafts.original).toBe('Original unsent draft')
 expect(api.sessions.readMessage).not.toHaveBeenCalled()
})
async function focusAgent(hostId: string, agentSessionId: string) {
 let pending!: Promise<AgentMuxControlResult>
 await act(async () => {
  pending = useAppStore.getState().executeControl(parseAgentMuxControlRequest({ schemaVersion: 5, requestId: crypto.randomUUID(),
   operation: 'focus', target: { kind: 'focus-agent', hostId, agentSessionId }, inputPolicy: 'preserve' }))
  await Promise.resolve()
 })
 let result!: AgentMuxDesktopFocusResult
 await act(async () => { result = await pending as AgentMuxDesktopFocusResult })
 const { operation, ...body } = result
 expect(parseAgentMuxControlReceipt({ schemaVersion: 5, requestId: 'navigation-observed', operation, ok: true, result: body })).toMatchObject({ result: body })
 return result
}
it('mounts and scrolls a real offscreen lazy card before the public receipt confirms it', async () => {
 const sessions = Array.from({ length: 72 }, (_, index) => working(`task-${String(index).padStart(2, '0')}`))
 useAppStore.setState({ sessions, agentNames: Object.fromEntries(sessions.map(session => [session.id, session.id])) })
 await dom.render(createElement(App))
 const target = document.querySelector<HTMLElement>('[data-focus-agent-session="task-71"]')!
 expect(target).toBeTruthy(); expect(target.dataset.focusCardBody).toBe('pending')
 const completions: ReturnType<typeof readFocusAgentPresentation>[] = []
 const stop = useAppStore.subscribe((state, previous) => {
  if (previous.focusAgentReveal?.pending && state.focusAgentReveal?.pending === false) completions.push(readFocusAgentPresentation(state.focusAgentReveal))
 })
 const result = await focusAgent('local', 'task-71')
 stop()
 expect(completions).toEqual([{ hostId: 'local', agentSessionId: 'task-71', presentationSessionId: 'task-71', state: 'visible' }])
 expect(result.navigation.state).toBe('applied')
 expect(result.focus.agent).toMatchObject({ hostId: 'local', agentSessionId: 'task-71', presentationSessionId: 'task-71', state: 'visible' })
 expect(target.dataset.focusCardBody).toBe('mounted')
 expect(target.closest<HTMLElement>('.focus-project-lanes__rows')!.scrollTop).toBeGreaterThan(0)
 const inspected = await useAppStore.getState().executeControl({ schemaVersion: 5, requestId: 'navigation-inspect', operation: 'inspect.client' })
 expect(inspected).toMatchObject({ operation: 'inspect.client', observation: { desktop: { focus: { agent: result.focus.agent } } } })
})
it('keeps unknown and ambiguous identities unconfirmed without replacing original work or guessing an alias', async () => {
 const target = working('target'), alias = { ...target, id: 'alias' }
 useAppStore.setState({ sessions: [working('original'), target, alias] })
 await dom.render(createElement(App))
 const original = useAppStore.getState()
 for (const id of ['missing', 'target']) {
  const result = await focusAgent('local', id)
  expect(result.navigation.state).toBe('unconfirmed')
  expect(result.focus.agent).toMatchObject({ agentSessionId: id, presentationSessionId: null, state: 'unconfirmed' })
  expect(useAppStore.getState().focusAgentReveal?.pending).toBe(false)
  expect(useAppStore.getState().sessions).toBe(original.sessions); expect(useAppStore.getState().tabs).toBe(original.tabs)
 }
 await act(async () => useAppStore.getState().revealFocusAgent({ hostId: 'local', agentSessionId: 'target' }, 'alias'))
 expect(card('alias')?.getAttribute('aria-pressed')).toBe('true')
 expect(readFocusAgentPresentation(useAppStore.getState().focusAgentReveal)).toMatchObject({ presentationSessionId: 'alias', state: 'visible' })
})
it('reveals a retained original descriptor without inventing a live Session or execution history', async () => {
 vi.mocked(api.sessions.historySources).mockResolvedValue([{ hostId: 'remote', agentSessionId: 'retained', state: 'retired' }])
 await dom.render(createElement(App))
 const original = useAppStore.getState()
 const result = await focusAgent('remote', 'retained')
 expect(result.navigation.state).toBe('applied')
 expect(result.focus.agent).toMatchObject({ hostId: 'remote', agentSessionId: 'retained', state: 'visible' })
 expect(card('retained')?.textContent).toContain('Retired')
 expect(useAppStore.getState().sessions).toBe(original.sessions)
 expect(useAppStore.getState().agentFocus.execution).toBe(original.agentFocus.execution)
 expect(api.sessions.readMessage).not.toHaveBeenCalled()
})
it('reports a retained card clipped by its original Focus workface as hidden', async () => {
 vi.mocked(api.sessions.historySources).mockResolvedValue([{ hostId: 'remote', agentSessionId: 'retained', state: 'retired' }])
 await dom.render(createElement(App)); await focusAgent('remote', 'retained')
 const main = document.querySelector<HTMLElement>('.global-focus-main')!
 main.style.overflowY = 'hidden'
 vi.spyOn(main, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 900, 120))
 const slot = document.querySelector<HTMLElement>('[data-focus-agent-session="retained"]')!
 vi.spyOn(slot, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 180, 250, 94))
 expect(readFocusAgentPresentation(useAppStore.getState().focusAgentReveal)).toMatchObject({ presentationSessionId: 'retained', state: 'hidden' })
 expect(useAppStore.getState().sessions.some(session => session.id === 'retained')).toBe(false)
})
it('keeps a hidden Focus reader stable when unrelated Session snapshots change', async () => {
 const render = vi.fn()
 await dom.render(<Profiler id="original-focus" onRender={render}><GlobalFocusSurface /></Profiler>)
 await query('Target task')
 expect(card('original')).toBeNull()
 await act(async () => useAppStore.getState().revealFocusAgent({ hostId: 'local', agentSessionId: 'target' }))
 await act(async () => useAppStore.getState().setFocusView('map'))
 render.mockClear()
 await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === 'original' ? { ...session, latestOutputBytes: session.latestOutputBytes + 1 } : session) })))
 expect(render).not.toHaveBeenCalled()
 expect(useAppStore.getState().focusAgentReveal).toMatchObject({ agentSessionId: 'target', pending: false })
})
it('reveals a Mote card without selecting it as an execution task or navigating Space', async () => {
 const directory = fixturePath('scratch'), path = `${directory}/topic--launcher--leader`
 const permission = (id: string) => ({ kind: 'permission' as const, id: `permission-${id}`, agentSessionId: id,
  title: `Read ${id} source?`, options: [{ id: 'once', label: 'Allow once', kind: 'allow-once' as const }],
  evidence: { source: 'native-hook' as const, observedAt: Date.now(), run: working(id).control.run, hookReceiptId: `request-${id}` } })
 const mote = { ...working('mote-agent'), workspacePath: path, pendingInteraction: permission('mote-agent') }
 const topic = { id: PMO_TEAMS_TOPIC_ID, title: 'Mote', summary: '', collaborators: [], directoryPath: path, topicPath: `${path}/topic.md`,
  soul: { path: `${path}/SOUL.md`, content: '# Mote', version: 'mote-identity' } }
 useAppStore.setState({ config: { ...composerConfig, workspaces: [...composerConfig.workspaces, { id: SCRATCH_WORKSPACE_ID, name: 'Topics', hostId: 'local', path: directory, kind: 'folder' }] },
  agentNames: { original: 'Original task', 'mote-agent': 'Mote discussion' },
  agentFocus: { execution: { sessionId: 'original', history: [], reference: { displayWorkspaceId: workspace.id, groupId: 'original-group', tabId: 'original-tab', regionId: 'original-region' } }, pmo: { sessionId: null } },
  sessions: [{ ...working('original'), pendingInteraction: permission('original') }, mote], scratchTopicSnapshots: { [SCRATCH_WORKSPACE_ID]: { scope: JSON.stringify(['local', directory]), revision: 1, topics: [topic], error: null, reading: false } } })
 expect(useAppStore.getState().focusExecutionSession('original', { displayWorkspaceId: workspace.id, groupId: 'original-group', tabId: 'original-tab', regionId: 'original-region' })).toBe(true)
 await dom.render(createElement(App))
 const original = useAppStore.getState()
 const result = await focusAgent('local', mote.id)
 expect(result.navigation.state).toBe('applied')
 expect(result.focus.agent).toMatchObject({ agentSessionId: mote.id, state: 'visible' })
 expect(useAppStore.getState().agentFocus.execution).toBe(original.agentFocus.execution)
 expect(useAppStore.getState().agentFocus.pmo.sessionId).toBe(mote.id)
 expect(useAppStore.getState().workbenchSpaceSelection).toBe(original.workbenchSpaceSelection)
 const review = document.querySelector<HTMLButtonElement>('.focus-toolbar__review')!
 expect(review.getAttribute('aria-label')).toBe('Review request for Agent Original task')
 expect(document.querySelector('[aria-label="Review request for Agent Mote discussion"]')).toBeNull()
 await act(async () => review.click())
 expect(document.querySelector('.attention-request-panel')?.textContent).toContain('Read original source?')
 expect(document.querySelector('.attention-request-panel')?.textContent).not.toContain('Read mote-agent source?')
})
