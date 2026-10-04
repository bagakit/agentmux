import { fixtureData as _hygiene_fixtureData, fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import type { AgentSessionHistoryPage, AgentTimelineSnapshot } from '@agentmux/core'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts'
import * as UserMessages from '@agentmux/core/session-user-messages'
import { RecentFocusTimeline } from '../src/renderer/src/components/RecentFocusTimeline'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { createFocusProjectionSelector } from '../src/renderer/src/lib/focus-context'
import { deriveFocusProjectLanes } from '../src/renderer/src/lib/focus-project-lanes'
import { focusVisitFacts, focusWorkingFacts, focusGapFacts } from '../src/renderer/src/lib/focus-timeline-event-facts'
import { createFocusTimeFormatters } from '../src/renderer/src/lib/focus-timeline-ruler'
import type { FocusContext } from '../src/renderer/src/lib/focus-context'
import type { AgentFocusHistoryEntry } from '../src/renderer/src/lib/agent-focus'
import { HOUR_MS } from '../src/renderer/src/lib/focus-time-window'
import { composerDOM } from './helpers/composer-dom-fixture'

const producer = _hygiene_fixtureData(JSON.parse(readFileSync('apps/desktop/scripts/fixtures/focus-timeline-hover-inspection/public-producer.json', 'utf8'))) as {
  schema: string; captured: AgentTimelineSnapshot; nativePage: AgentSessionHistoryPage; sessions: SessionSnapshot[]
  config: AppConfig; sessionId: string; senderId: string; now: number; agentNames: Record<string, string>
}
const dom = composerDOM(), NOW = producer.now, ID = producer.sessionId
const BODY = producer.captured.items[0]!.content!
const marker = (role = 'human') => dom.container.querySelector<HTMLButtonElement>(`.recent-focus__message[data-message-author="${role}"]`)!
const preview = () => document.querySelector<HTMLElement>('.recent-focus__message-preview')
const tooltip = () => document.querySelector<HTMLElement>('.recent-focus__message-preview[role="tooltip"]')
const wait = async (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
const enter = async (node: HTMLElement) => act(async () => node.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
const leave = async (node: HTMLElement, relatedTarget: EventTarget | null = null) => act(async () => node.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget })))
const click = async (node: HTMLElement) => act(async () => node.click())
let page: MockInstance<typeof api.sessions.historyPage>, catalog: MockInstance<typeof api.sessions.historySources>, timeline: MockInstance<typeof api.sessions.timeline>, projector: MockInstance<typeof UserMessages.projectSessionUserMessages>, image: MockInstance<typeof api.ui.readPastedImage>
const onSelect = vi.fn()
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); vi.setSystemTime(NOW)
  expect(producer.schema).toBe('agentmux.focus-author-public-producer.v1')
  const projected = UserMessages.projectSessionUserMessages({ agentSessionId: ID, timeline: producer.captured, historyPage: producer.nativePage })
  expect(projected.map(item => item.author.kind)).toEqual(['unknown', 'unknown', 'human', 'agent', 'unknown'])
  expect(new Set(projected.map(item => item.id)).size).toBe(5)
  page = vi.spyOn(api.sessions, 'historyPage').mockResolvedValue(producer.nativePage)
  catalog = vi.spyOn(api.sessions, 'historySources').mockResolvedValue([])
  timeline = vi.spyOn(api.sessions, 'timeline').mockResolvedValue(producer.captured)
  image = vi.spyOn(api.ui, 'readPastedImage').mockResolvedValue(null)
  projector = vi.spyOn(UserMessages, 'projectSessionUserMessages')
  onSelect.mockClear()
  useAppStore.setState({ config: producer.config, sessions: producer.sessions, agentNames: producer.agentNames,
    timelines: { [ID]: producer.captured }, agentComposerDrafts: { [ID]: 'Keep this draft' }, agentFocus: { execution: { sessionId: ID, history: [] }, pmo: { sessionId: null } } })
})
// Restoring real time happens after composerDOM unmount has cancelled local timers.
afterEach(() => vi.useRealTimers())
async function render(entries: AgentFocusHistoryEntry[] = [], currentId: string | null = ID, main: Pick<FocusContext, 'id' | 'hostId'> | null = { id: ID, hostId: 'local' }) {
  const contexts = createFocusProjectionSelector()(useAppStore.getState()).contexts.map(context => ({ ...context, detail: context.id === ID ? 'Reviewing the timeline interaction' : context.detail }))
  const lanes = deriveFocusProjectLanes(contexts, producer.config).map(lane => ({ ...lane, summary: 'Topic summary from the already-read snapshot' }))
  await dom.render(<><input aria-label="Late active input" defaultValue="Keep input" /><RecentFocusTimeline entries={entries} currentSessionId={currentId} currentContext={main} contexts={contexts} lanes={lanes} onSelect={onSelect} /></>)
  await wait(1)
  expect(dom.container.querySelectorAll('.recent-focus__message').length).toBeGreaterThan(0)
}
function selectedBody() {
  const body = preview()!.querySelector<HTMLElement>('.recent-focus__message-body')!
  expect(body).not.toBeNull()
  const text = body.querySelector('.log-turn__text')!.firstChild!
  const range = document.createRange(); range.selectNodeContents(text)
  document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range)
  expect(document.getSelection()!.toString()).toBe(BODY)
  return { body, range }
}
const counts = () => [page.mock.calls.length, catalog.mock.calls.length, timeline.mock.calls.length, projector.mock.calls.length]


const eventTooltip = () => document.querySelector<HTMLElement>('.recent-focus__event-preview')
const live = (id = ID) => dom.container.querySelector<HTMLElement>(`[data-focus-timeline-id="${id}"] .recent-focus__live`)!
const row = (id = ID) => dom.container.querySelector<HTMLElement>(`[data-focus-timeline-id="${id}"]`)!
const locate = () => dom.container.querySelector<HTMLButtonElement>('[aria-label="Locate current Context track"]')!
const time = createFocusTimeFormatters('UTC')

it('marks the accurate main Context independently of execution MRU and retains only its current project track', async () => {
  await render([{ sessionId: producer.senderId, focusedAt: NOW - HOUR_MS,
    identity: { name: 'Observed sender', kind: 'agent', hostId: 'local', providerId: 'claude', workspacePath:_hygiene_fixturePath("observed"), project: { id: 'historical-project', name: 'Historical project' } } }], producer.senderId)
  expect(row().dataset.focusCurrent).toBe('true')
  expect(row().querySelector('[aria-label="Current Context"]')).not.toBeNull()
  expect(row(producer.senderId).dataset.focusCurrent).toBeUndefined()
  expect(locate().disabled).toBe(false)
  const before = counts(), window = dom.container.querySelector('.recent-focus')!.getAttribute('data-window-start')
  await click(locate())
  expect(dom.container.querySelector('.recent-focus')!.getAttribute('data-window-start')).toBe(window)
  expect(onSelect).not.toHaveBeenCalled(); expect(counts()).toEqual(before)
  await render([], producer.senderId, null)
  expect(dom.container.querySelectorAll('[data-focus-current="true"]')).toHaveLength(0)
  expect(locate().disabled).toBe(true)
})

it('does not borrow a different host or invent a current track in a history window with no recorded facts', async () => {
  await render([], ID, { id: ID, hostId: 'different-host' })
  expect(dom.container.querySelectorAll('[data-focus-current="true"]')).toHaveLength(0); expect(locate().disabled).toBe(true)
  await render(); const before = counts()
  await dom.render(<RecentFocusTimeline entries={[]} currentSessionId={ID} currentContext={{ id: ID, hostId: 'local' }} contexts={createFocusProjectionSelector()(useAppStore.getState()).contexts} onSelect={onSelect} historyWindowRequest={{at: NOW - 48 * HOUR_MS, sequence:1}} />)
  await wait(1)
  expect(dom.container.querySelectorAll('[data-focus-current="true"]')).toHaveLength(0)
  expect(locate().disabled).toBe(true)
  const settled = counts(); await wait(200); expect(counts()).toEqual(settled)
})

it('shows original focus identity and next-focus duration, with unknown open end and finite zero timestamps', async () => {
  const identity = {name:'Historical reviewer',kind:'agent' as const,hostId:'local',providerId:'claude',workspacePath:_hygiene_fixturePath("observed"),project:{id:'past',name:'Observed project'}}
  await render([{sessionId:ID,focusedAt:NOW-HOUR_MS,identity},{sessionId:producer.senderId,focusedAt:NOW-30*60_000}])
  const segment = dom.container.querySelector<HTMLElement>(`[data-focused-at="${NOW-HOUR_MS}"]`)!
  expect(segment.hasAttribute('title')).toBe(false)
  await enter(segment); await wait(181)
  expect(eventTooltip()!.textContent).toContain('Historical reviewer')
  expect(eventTooltip()!.textContent).toContain('30m00s')
  expect(eventTooltip()!.textContent).toContain('Observed project')
  expect(eventTooltip()!.textContent).toContain('not Run duration')
  const zero = focusVisitFacts({sessionId:ID,focusedAt:0,end:60_000,left:0,width:1,identity},time)
  expect(zero.duration).toBe('1m00s'); expect(zero.time).toContain('1970')
  const open = focusVisitFacts({sessionId:ID,focusedAt:0,end:undefined,left:0,width:undefined,identity},time)
  expect(open.duration).toBeUndefined(); expect(open.time).toContain('Next focus not recorded')
})

it('keeps unknown working boundaries and historical projects honest, rather than extending old states to Now', () => {
  const history={name:'Past owner',kind:'agent' as const,hostId:'local',providerId:'claude',workspacePath:_hygiene_fixturePath("observed"),project:{id:'past',name:'Past project'}}
  const ended=focusWorkingFacts({startAt:0,startKnown:true,endAt:60_000,end:'state-change'},time,history,{name:'Live owner',project:'Live project'},NOW)
  expect(ended.duration).toBe('1m00s'); expect(ended.name).toBe('Past owner'); expect(ended.project).toContain('Past project');expect(ended.time).not.toContain('Now')
  for (const end of ['unknown','observation-gap'] as const) {
    const unknown=focusWorkingFacts({startAt:0,startKnown:false,endAt:null,end},time,undefined,undefined,NOW)
    expect(unknown.duration).toBeUndefined();expect(unknown.time).toContain('End not recorded');expect(unknown.note).toContain('Start not recorded')
  }
  const active=focusWorkingFacts({startAt:0,startKnown:false,endAt:null,end:'current'},time,undefined,{name:'Live owner',project:'Live project'},60_000)
  expect(active.duration).toBe('Observed for at least 1m00s');expect(active.project).toContain('Current project')
  expect(focusGapFacts('Owner',0,time).note).toContain('does not prove inactivity')
})

it('cancels fly-by intent and permits a passive crossing without stealing later input or reading any source', async () => {
  await render(); const target=live(), input=dom.container.querySelector<HTMLInputElement>('input')!
  expect(target).not.toBeNull();expect(target.hasAttribute('title')).toBe(false)
  await act(async()=>input.focus());const before=counts()
  await enter(target); await wait(100); expect(eventTooltip()).toBeNull(); await leave(target); await wait(220);expect(eventTooltip()).toBeNull()
  await enter(target);await wait(181);const facts=eventTooltip()!
  expect(facts).not.toBeNull();expect(facts.textContent).toContain('Run online now');expect(facts.textContent).toContain('Run start not recorded')
  expect(facts.querySelectorAll('button,input,a,[tabindex]')).toHaveLength(0);expect(target.getAttribute('aria-describedby')).toBe(facts.id)
  await leave(target,facts);await enter(facts);await wait(200)
  expect(eventTooltip()).toBe(facts);expect(document.activeElement).toBe(input);expect(counts()).toEqual(before);expect(image).not.toHaveBeenCalled()
  await act(async()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})))
  expect(eventTooltip()).toBeNull();expect(document.activeElement).toBe(input)
})

it('does not replace a fixed message Reader, Range, draft or reading source when another event is hovered', async () => {
  await render();await click(marker('human'));const pinned=preview()!, {body}=selectedBody(),before=counts()
  const draft=useAppStore.getState().agentComposerDrafts[ID]
  await enter(live());await wait(181);await leave(live());await wait(200)
  expect(preview()).toBe(pinned);expect(eventTooltip()).toBeNull();expect(pinned.querySelector('.recent-focus__message-body')).toBe(body)
  expect(document.getSelection()!.toString()).toBe(BODY);expect(useAppStore.getState().agentComposerDrafts[ID]).toBe(draft);expect(counts()).toEqual(before)
  await render([],ID,null)
  expect(preview()).toBe(pinned);expect(document.getSelection()!.toString()).toBe(BODY)
})

it('expires the hovered track intent on its own Run change even when the connected marker is not the Reader MRU', async () => {
  await render([],producer.senderId);const target=live()
  await enter(target);await wait(100)
  const before=counts()
  await act(async()=>useAppStore.setState(state=>({sessions:state.sessions.map(session=>session.id===ID&&session.kind==='agent'?{...session,control:{...session.control,run:{runId:'different-actual-run'}}}:session)})))
  expect(target.isConnected).toBe(true);await wait(181);expect(eventTooltip()).toBeNull();expect(counts()).toEqual(before)
  await enter(target);await wait(181);expect(eventTooltip()).not.toBeNull()
  await act(async()=>useAppStore.setState(state=>({sessions:state.sessions.map(session=>session.id===ID&&session.kind==='agent'?{...session,semanticStatus:{state:'done' as const,source:'native-hook' as const,observedAt:NOW}}:session)})))
  expect(eventTooltip()).toBeNull()
})

it('keeps unrelated output cheap and cancels hidden or collapsed late intent', async () => {
  await render();const target=live(),before=counts();await enter(target);await wait(100)
  await act(async()=>useAppStore.setState(state=>({timelines:{...state.timelines,'unrelated-session':{agentSessionId:'unrelated-session',revision:1,items:[]}}})))
  await wait(81);expect(eventTooltip()).not.toBeNull();expect(live()).toBe(target);expect(counts()).toEqual(before)
  await leave(target);await wait(161);await enter(target);await wait(100)
  await click(dom.container.querySelector<HTMLButtonElement>('[aria-label="Collapse focus history"]')!)
  await wait(181);expect(eventTooltip()).toBeNull();expect(counts().slice(0,3)).toEqual(before.slice(0,3))
})

it('uses real Core work observations for a current hover without clipping its true start to the displayed window', async () => {
 const start=NOW-2*HOUR_MS,agent=producer.sessions.find(item=>item.id===ID)!;expect(agent.kind).toBe('agent');if(agent.kind!=='agent')throw Error('Actual Agent control required')
 const working={state:'working' as const,source:'native-hook' as const,observedAt:NOW,stateEnteredAt:start}
 const item={id:'typed-current-work',agentSessionId:ID,kind:'lifecycle' as const,status:'complete' as const,source:'native-hook' as const,createdAt:start,updatedAt:start,title:'Typed semantic observation',activityState:{run:agent.control.run,state:'working' as const,stateEnteredAt:start}}
 await act(async()=>useAppStore.setState(state=>({sessions:state.sessions.map(session=>session.id===ID?{...session,status:working,semanticStatus:working}:session),timelines:{...state.timelines,[ID]:{...producer.captured,items:[...producer.captured.items,item]}}})))
 await render();const work=dom.container.querySelector<HTMLElement>('[data-work-end="current"]')!;expect(work).not.toBeNull();expect(work.dataset.workingEnteredAt).toBe(String(start));const before=counts()
 await enter(work);await wait(181)
 expect(eventTooltip()!.textContent).toContain('2h00m');expect(eventTooltip()!.textContent).toContain('Current project');expect(eventTooltip()!.textContent).toContain('State observation, not Run duration');expect(counts()).toEqual(before)
})

it('cancels hidden late event intent without any added source/page/resource read',async()=>{
 await render();const target=live(),before=counts();await enter(target);await wait(100)
 const original=Object.getOwnPropertyDescriptor(document,'visibilityState')
 try{
  Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'})
  await act(async()=>document.dispatchEvent(new Event('visibilitychange')));await wait(200)
  expect(eventTooltip()).toBeNull();expect(counts().slice(0,3)).toEqual(before.slice(0,3));expect(image).not.toHaveBeenCalled()
 }finally{if(original)Object.defineProperty(document,'visibilityState',original);else delete(document as unknown as {visibilityState?:string}).visibilityState}
})
