// @vitest-environment happy-dom
import { fixtureEpoch as _newTailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryItem, AgentSessionHistoryPage } from '@agentmux/core'
import { StaticConversationView as ConversationView } from './helpers/conversation-static-fixture'
import { NativeProcessObservation } from '@agentmux/client-ui/components/NativeProcessObservation'
import type { ConversationPresentationController } from '@agentmux/client-ui/use-conversation-record-layout'
import { projectConversationReading } from '@agentmux/client-ui/conversation-records'
const controller: { current: ConversationPresentationController | null } = { current: null }
const candidate = (page: AgentSessionHistoryPage) => projectConversationReading({ agentSessionId: reference.agentSessionId, historyPage: page })
import { ActivityView as ReaderActivityView } from '../src/renderer/src/components/ActivityView'
import { api } from '../src/renderer/src/lib/api'
import { createClientUiRoot } from './helpers/client-ui-render'
import { conversationPagePortFixture } from './helpers/conversation-page-port-fixture'
import { activityReadingProps } from './helpers/activity-reading-props'

const reference = { hostId: 'local', agentSessionId: 'selected-head-session' }
const source = { providerId: 'codex', nativeSessionId: 'selected-head-native' }
const activity = (id: string): AgentSessionHistoryItem => ({ id, kind: 'activity', contentParts: [{ kind: 'text', text: id }] })
const user = (id: string): AgentSessionHistoryItem => ({ id, kind: 'user-message', contentParts: [{ kind: 'text', text: id }] })
const page = (items: AgentSessionHistoryItem[], nextCursor: string | null = null): AgentSessionHistoryPage => ({
  agentSessionId: reference.agentSessionId, source, items, nextCursor
})
const closes:Array<()=>Promise<void>>=[]
let host: HTMLDivElement, root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  host = document.createElement('div'); document.body.append(host); root = createClientUiRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); window.getSelection()?.removeAllRanges()
  for(const close of closes.splice(0).reverse())await close();vi.restoreAllMocks(); vi.unstubAllGlobals()
})
const bounds = (top: number, height: number) => ({ x: 0, y: top, top, bottom: top + height, left: 0, right: 500, width: 500, height, toJSON() {} })
async function render(next: AgentSessionHistoryPage, beforeRecordId?: string) {
  await act(async () => root.render(<ConversationView page={next} sessionId={reference.agentSessionId}
    presentation={{ controller, pending: false, onRelease: () => {} }} renderProcess={props => <NativeProcessObservation {...props} compact />}
    {...(beforeRecordId ? { recordBoundary: { beforeRecordId, content: <div role="separator">Original history boundary</div> } } : {})} />))
}
function selectHead(viewport: HTMLElement = host, count = false) {
  viewport.getBoundingClientRect = () => bounds(0, 500)
  const head = viewport.querySelector<HTMLElement>('.wf-head')!
  head.getBoundingClientRect = () => bounds(100, 30)
  const text = head.querySelector(count ? '.log-fold__steps' : '.wf-observation__recorded')!.firstChild!
  const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, text.textContent!.length)
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
  return { head, text, selection, originalText: selection.toString(), group: head.closest<HTMLElement>('[data-native-record-ids]')! }
}
function expectRetained(selected: ReturnType<typeof selectHead>) {
  expect(selected.head.isConnected).toBe(true)
  expect(selected.group.querySelector('.wf-head')).toBe(selected.head)
  expect(selected.text.isConnected).toBe(true)
  expect(selected.selection.getRangeAt(0).startContainer).toBe(selected.text)
  expect(selected.selection.toString()).toBe(selected.originalText)
}

it('selected process head permits user-separated earlier records and retains its actual head, TextNode and Range', async () => {
  const current = page([activity('current-first'), activity('current-second')])
  await render(current)
  const selected = selectHead()
  const next = page([activity('older-process'), user('earlier-user'), ...current.items])
  expect(!controller.current!.canPresent(candidate(next))).toBe(false)
  await render(next)
  expectRetained(selected)
  expect(selected.group.dataset.nativeRecordIds).toBe(JSON.stringify(current.items.map(item => item.id)))
})

it('selected process head protects a contiguous merge that would change its selected count while retaining every raw ID', async () => {
  const current = page([activity('current-first'), activity('current-second')])
  await render(current)
  const selected = selectHead(host, true)
  const next = page([activity('older-process'), ...current.items])
  expect(!controller.current!.canPresent(candidate(next))).toBe(true)
  expectRetained(selected)
  expect(selected.head.querySelector('.log-fold__steps')?.textContent).toBe('2 条已加载记录')
  expect(selected.group.dataset.nativeRecordIds).toBe(JSON.stringify(current.items.map(item => item.id)))
})

it('selected process head uses the next actual record boundary to preserve a separate mounted process card', async () => {
  const current = page([activity('current-first'), activity('current-second')])
  await render(current)
  const selected = selectHead(host, true), next = page([activity('older-process'), ...current.items])
  const recordBoundary = { beforeRecordId: current.items[0]!.id }
  expect(!controller.current!.canPresent(candidate(next), recordBoundary)).toBe(false)
  await render(next, recordBoundary.beforeRecordId)
  expectRetained(selected)
  expect(host.querySelectorAll('.wf-head')).toHaveLength(2)
})

it.each(['clipped', 'changed-record', 'changed-source'] as const)('selected process head still protects %s reading data', async mode => {
  const current = page([activity('current-first'), activity('current-second')])
  await render(current)
  const selected = selectHead()
  const next = mode === 'clipped' ? page(current.items.slice(1))
    : mode === 'changed-record' ? page([{ ...current.items[0]!, title: 'Changed original record' }, current.items[1]!])
    : mode === 'changed-source' ? { ...current, source: { ...source, nativeSessionId: 'other-native' } } : current
  expect(!controller.current!.canPresent(candidate(next))).toBe(true)
  expectRetained(selected)
})

it('actual Activity earlier read keeps a selected unchanged head and commits its original cursor through the common guard', async () => {
  const current = page([{ ...activity('current-first'), startedAt: _newTailFixtureEpoch(0, 0, 1) }, { ...activity('current-second'), startedAt: _newTailFixtureEpoch(0, 0, 2) },
    { id: 'current-reply', kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'Original current reply' }], startedAt: 25 * 3_600_000 }], 'original-earlier-cursor')
  const older = page([activity('older-process'), user('earlier-user')])
  const f=await conversationPagePortFixture(reference,source,async (_target, options)=>options?.cursor ? older : current);closes.push(f.close)
  const read=f.nativeRead,raw=vi.spyOn(api.sessions,'historyPage')
  const controls = [vi.spyOn(api.sessions, 'submitPrompt'), vi.spyOn(api.sessions, 'resume'), vi.spyOn(api.sessions, 'replyQuestion')]
  await act(async () => root.render(<ReaderActivityView {...activityReadingProps({ control: reference })} nativeHistoryPage={current} />))
  await vi.waitFor(async()=>{await act(async()=>{});expect(host.querySelector('.wf-head')).not.toBeNull()});expect(read).toHaveBeenCalledTimes(1)
  const viewport = host.querySelector<HTMLElement>('.activity-feed')!, selected = selectHead(viewport)
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Earlier')!.click())
  await vi.waitFor(async()=>{await act(async()=>{});expect(host.textContent).toContain('earlier-user')});expect(read).toHaveBeenCalledTimes(2)
  expect(read.mock.calls.at(-1)).toMatchObject([reference.agentSessionId, { limit: 100, cursor: 'original-earlier-cursor' }])
  expect(raw).not.toHaveBeenCalled();expect(f.controls.map(control=>control.mock.calls.length)).toEqual([0,0,0,0,0,0])
  expect(host.textContent).toContain('earlier-user')
  expect(host.textContent).not.toContain('Move your reading position or clear the selection')
  expectRetained(selected)
  expect(host.querySelectorAll('.wf-head')).toHaveLength(2)
  for (const control of controls) expect(control).not.toHaveBeenCalled()
})
