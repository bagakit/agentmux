// @vitest-environment happy-dom
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentTimelineItem } from '@agentmux/core'
import { nativeHistoryFixture, jsonl } from '../../../packages/core/test/fixtures/native-history-session'
import { desktopConversationReadBridge } from './helpers/conversation-read-bridge'
import { createClientUiRoot } from './helpers/client-ui-render'
import { activityReadingProps } from './helpers/activity-reading-props'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { ConversationView } from '@agentmux/client-ui/components/ConversationView'
import { useConversationView } from '@agentmux/client-ui/use-conversation-view'
import { projectConversationWindow } from '@agentmux/client-ui/conversation-records'
import { api } from '../src/renderer/src/lib/api'
import { fixtureEpoch } from '../../../test/fixture-values.mjs'

const closes: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { getSelection()?.removeAllRanges(); for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const wait = (check: () => void) => vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) }); check() }, { timeout: 8000 })
const prose = '同一份原始输入 **selected words**。\n\n完整第二段与长内容保持可读。'
const native = (id: string) => ({ type: 'user', uuid: id, sessionId: 'native-main', message: { role: 'user', content: prose } })
async function fixture(surface: 'desktop' | 'shared' = 'desktop', initiallyEmpty = false, anotherTarget = false) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  const f = await nativeHistoryFixture('claude', jsonl(initiallyEmpty ? [] : [native('unrelated-same-body')])); closes.push(f.close)
  const target = { hostId: 'local', agentSessionId: f.session.agentSessionId, source: { kind: 'native' as const, providerId: 'claude', nativeSessionId: 'native-main', recordId: 'exact-native' } }
  const item = (id: string, exact: boolean, status: AgentTimelineItem['status'] = 'complete'): AgentTimelineItem => ({ id, agentSessionId: f.session.agentSessionId, kind: 'user_message', source: 'user', status,
    title: 'Original submission', content: prose, authorHuman: true, createdAt: fixtureEpoch(0, 0, 2), updatedAt: fixtureEpoch(0, 0, 2), ...(exact ? { conversation: { sameEvent: id === 'failed-submission' || id === 'second-submission' ? { ...target, source: { ...target.source, recordId: id === 'failed-submission' ? 'failed-native' : 'second-native' } } : target } } : {}) })
  const submitted = item('exact-submission', true)
  for (const value of [submitted, item('unknown-submission', false), item('failed-submission', true, 'failed'), ...(anotherTarget ? [item('second-submission', true)] : [])]) await f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.session.agentSessionId, item: value })
  const bridge = await desktopConversationReadBridge(f, closes)
  const host = document.createElement('div'); document.body.append(host); const root = createClientUiRoot(host)
  closes.push(async () => { await act(async () => root.unmount()); host.remove() })
  let view!: ReturnType<typeof useConversationView>
  function SharedReader() {
    view = useConversationView(api.conversation, { hostId: 'local', agentSessionId: f.session.agentSessionId }, true)
    const projection = view.snapshot ? projectConversationWindow(view.snapshot) : null
    return <ConversationView sessionId={f.session.agentSessionId} executionHostId="local" records={projection?.records ?? []} originalRecords={projection?.originalRecords ?? []}
      coverage={projection?.timeline.coverage ?? []} page={projection?.historyPage} timeline={projection?.captured}
      readActivity={{ sourceRead: view.sourceRead, loading: view.loading }} />
  }
  await act(async () => root.render(surface === 'shared' ? <SharedReader /> : <ActivityView {...activityReadingProps({ control: { hostId: 'local', agentSessionId: f.session.agentSessionId, run: f.session.run }, workspaceRoot: f.root })} />))
  await wait(() => { expect(host.querySelector('[data-submission-id="exact-submission"]')).not.toBeNull(); expect(vi.mocked(api.conversation.observeConversation).mock.calls.length).toBeGreaterThan(0) })
  await wait(() => expect(vi.mocked(api.conversation.readConversationChanges).mock.calls.length).toBeGreaterThan(0))
  await act(async () => { await Promise.all(vi.mocked(api.conversation.readConversationChanges).mock.results.map(result => result.value)) })
  const row = (id = 'exact-submission') => host.querySelector<HTMLElement>(`[data-submission-id="${id}"]`)!
  const publish = () => Reflect.get(f.client, 'persistAndPublishTimeline').call(f.client, { type: 'upsert', agentSessionId: f.session.agentSessionId, item: { ...submitted, updatedAt: fixtureEpoch(0, 0, 3) } })
  return { f, bridge, host, root, row, publish, getView: () => view }
}

it('the actual source read drives only its exact unread submission, then preserves its facts on the readable native card', async () => {
  const s = await fixture()
  expect(s.row().querySelector('[data-icon-animation]')).toBeNull()
  expect(s.row('unknown-submission').querySelector('[data-icon-animation]')).toBeNull()
  const disclosure = s.row().querySelector<HTMLDetailsElement>('details')!
  expect(disclosure.open).toBe(true)
  const oldRef = s.row().dataset.conversationItemRef
  const initial = await vi.mocked(api.conversation.readAgentConversation).mock.results[0]!.value
  let settled: unknown
  let release!: () => void, entered!: () => void, hold = true
  const entry = new Promise<void>(resolve => { entered = resolve })
  closes.push(() => release?.())
  vi.mocked(api.conversation.readConversationChanges).mockImplementation(async (input, options) => {
    const result = await s.bridge.readConversationChanges(input, options)
    if (hold) settled = result
    if (hold) { hold = false; entered(); await new Promise<void>(resolve => { release = resolve }) }
    return result
  })
  await appendFile(s.f.path, jsonl([native('exact-native')]))
  await s.publish(); await entry
  await wait(() => expect(s.row().querySelector('[data-icon-animation="spin"]')).not.toBeNull())
  expect(s.row('unknown-submission').querySelector('[data-icon-animation]')).toBeNull()
  expect(s.row('failed-submission').querySelector('[data-icon-animation]')).toBeNull()
  expect(s.host.querySelector('[data-native-record-id="unrelated-same-body"]')).not.toBeNull()
  expect(s.host.querySelector('[data-native-record-id="exact-native"]')).toBeNull()
  await act(async () => release())
  await wait(() => expect(s.host.querySelector('[data-native-record-id="exact-native"] [data-submission-record]')).not.toBeNull())
  expect(s.row()).toBeNull()
  const card = s.host.querySelector('[data-native-record-id="exact-native"]')!
  expect(card.querySelectorAll('[data-submission-record]')).toHaveLength(1)
  expect(card.querySelector('[data-icon-animation]')).toBeNull()
  expect(s.row('failed-submission').textContent).toContain('提交失败')
  expect(card.querySelector('.log-turn__body')!.textContent).toContain('完整第二段')
  const original = card.querySelector<HTMLDetailsElement>('[data-original-contribution]')!
  await act(async () => { original.open = true; original.dispatchEvent(new Event('toggle')) })
  expect(original.querySelector('[data-conversation-item-ref]')?.getAttribute('data-conversation-item-ref')).toBe(oldRef)
  expect(s.row('unknown-submission')).not.toBeNull()
  expect(s.row('unknown-submission').querySelector('[data-icon-animation]')).toBeNull()
  expect(s.f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
  const output = process.env.AGENTMUX_SUBMISSION_SCENE_OUTPUT
  if (output) { await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify({ initial, settled, scope: 'Isolated Core FileStore public read and actual Unix RPC/IPC/preload/Renderer path; controlled captured source facts, no vendor writer or original App.' }, null, 2) + '\n') }
})

it('a real failed original read stops submission activity and preserves the original body and Retry', async () => {
  const s = await fixture()
  let reject!: (error: Error) => void, entered!: () => void
  const entry = new Promise<void>(resolve => { entered = resolve })
  vi.mocked(api.conversation.readConversationChanges).mockImplementationOnce(async () => { entered(); return new Promise((_resolve, decline) => { reject = decline }) })
  closes.push(() => reject?.(new Error('Fixture closed')))
  await appendFile(s.f.path, jsonl([native('unrelated-during-failed-read')]))
  await s.publish(); await entry
  await wait(() => expect(s.row().querySelector('[data-icon-animation="spin"]')).not.toBeNull())
  const body = s.row().querySelector('.log-turn__body')!, text = body.querySelector('strong')!.firstChild!, range = document.createRange()
  range.selectNodeContents(text); getSelection()!.addRange(range)
  await act(async () => reject(new Error('Original submission source read failed.')))
  await wait(() => { expect(s.host.textContent).toContain('Original submission source read failed.'); expect(s.row().querySelector('[data-icon-animation]')).toBeNull() })
  expect(s.row().querySelector('.log-turn__body')).toBe(body)
  expect(getSelection()!.toString()).toBe('selected words')
  expect([...s.host.querySelectorAll<HTMLButtonElement>('button')].some(button => button.textContent === 'Retry conversation records' && !button.disabled)).toBe(true)
  expect(s.row('unknown-submission').querySelector('[data-icon-animation]')).toBeNull()
  let release!: () => void
  const real = s.bridge.readConversationChanges
  vi.mocked(api.conversation.readConversationChanges).mockImplementationOnce(async (input, options) => {
    const result = await real(input, options); await new Promise<void>(resolve => { release = resolve }); return result
  })
  closes.push(() => release?.())
  await act(async () => [...s.host.querySelectorAll<HTMLButtonElement>('.conversation-read-issues button')].find(button => button.textContent === 'Retry conversation records')!.click())
  await wait(() => expect(s.row().querySelector('[data-icon-animation="spin"]')).not.toBeNull())
  expect(s.host.textContent).toContain('Original submission source read failed.')
  expect(s.row().querySelector('.log-turn__body')).toBe(body); expect(getSelection()!.getRangeAt(0)).toBe(range)
  await wait(() => expect(typeof release).toBe('function'))
  await act(async () => release())
  await wait(() => expect(s.row().querySelector('[data-icon-animation]')).toBeNull())
  expect(s.f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})


it('the shared Reader names only the actual latest request source, while a retained old scope and unknown selection stay static', async () => {
  const s = await fixture('shared')
  const gate = () => {
    let release!: () => void, entered!: () => void
    const entry = new Promise<void>(resolve => { entered = resolve })
    const hold = new Promise<void>(resolve => { release = resolve }); closes.push(release)
    vi.mocked(api.conversation.readAgentConversation).mockImplementationOnce(async (input, options) => {
      entered(); await hold; return s.bridge.readAgentConversation(input, options)
    })
    return { entry, release }
  }
  let hold = gate(), operation!: Promise<void>
  await act(async () => { operation = s.getView().selectSource({ providerId: 'claude', nativeSessionId: 'native-main' }) })
  await hold.entry
  await wait(() => expect(s.row().querySelector('[data-icon-animation="spin"]')).not.toBeNull())
  expect(s.getView().sourceRead?.nativeSource).toEqual({ providerId: 'claude', nativeSessionId: 'native-main' })
  await act(async () => { hold.release(); await operation })
  await wait(() => expect(s.row().querySelector('[data-icon-animation]')).toBeNull())
  hold = gate()
  await act(async () => { operation = s.getView().refresh() })
  await hold.entry
  expect(s.getView().sourceRead).toBeNull()
  expect(s.row().querySelector('[data-icon-animation]')).toBeNull()
  await act(async () => { hold.release(); await operation })
  hold = gate()
  await act(async () => { operation = s.getView().selectSource({ providerId: 'claude', nativeSessionId: 'different-native-source' }) })
  await hold.entry
  expect(s.getView().sourceRead?.nativeSource.nativeSessionId).toBe('different-native-source')
  expect(s.row().querySelector('[data-icon-animation]')).toBeNull()
  await act(async () => { hold.release(); await operation })
})

it('a selected original keeps its displayed row through a later accepted exact native body', async () => {
  const s = await fixture('shared', false, true)
  let release!: () => void, entered!: () => void, once = true
  const entry = new Promise<void>(resolve => { entered = resolve }); closes.push(() => release?.())
  vi.mocked(api.conversation.readConversationChanges).mockImplementation(async (input, options) => {
    const result = await s.bridge.readConversationChanges(input, options)
    if (once) { once = false; entered(); await new Promise<void>(resolve => { release = resolve }) }
    return result
  })
  await appendFile(s.f.path, jsonl([native('exact-native'), native('second-native')]))
  await s.publish(); await entry
  await wait(() => expect(s.row().querySelector('[data-icon-animation="spin"]')).not.toBeNull())
  const otherDetail = s.row('second-submission').querySelector<HTMLDetailsElement>('details')!, otherBody = s.row('second-submission').querySelector('.log-turn__body')!
  const row = s.row(), detail = row.querySelector<HTMLDetailsElement>('details')!, body = row.querySelector('.log-turn__body')!
  const text = body.querySelector('strong')!.firstChild!, range = document.createRange()
  range.selectNodeContents(text); getSelection()!.addRange(range)
  await act(async () => release())
  await wait(() => { expect(s.getView().loading).toBe(false); expect(s.getView().reading?.records.some(record => record.original.kind === 'native' && record.rawId === 'exact-native')).toBe(true) })
  expect(s.row()).toBe(row); expect(detail.open).toBe(true)
  expect(otherDetail.open).toBe(true); expect(s.row('second-submission').querySelector('.log-turn__body')).toBe(otherBody)
  expect(s.row().querySelector('.log-turn__body')).toBe(body); expect(getSelection()!.getRangeAt(0)).toBe(range)
  expect(s.host.querySelector('[data-native-record-id="exact-native"]')).toBeNull()
  expect(s.row().querySelector('[data-icon-animation]')).toBeNull()
  expect([...s.host.querySelectorAll('.conversation-metrics__notice')].some(notice => notice.textContent?.includes('保留选区'))).toBe(true)
  await act(async () => { getSelection()!.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')) })
  await wait(() => expect(s.host.querySelector('[data-native-record-id="exact-native"] [data-submission-record]')).not.toBeNull())
})


it('an unrelated first native card cannot fold an automatically expanded unknown submission around its Range', async () => {
  const s = await fixture('shared', true)
  const row = s.row('unknown-submission'), detail = row.querySelector<HTMLDetailsElement>('details')!, body = row.querySelector('.log-turn__body')!
  expect(detail.open).toBe(true)
  const text = body.querySelector('strong')!.firstChild!, range = document.createRange(); range.selectNodeContents(text); getSelection()!.addRange(range)
  await appendFile(s.f.path, jsonl([native('first-unrelated-native')]))
  await s.publish()
  await wait(() => expect(s.getView().reading?.records.some(record => record.rawId === 'first-unrelated-native')).toBe(true))
  expect(s.row('unknown-submission')).toBe(row); expect(row.querySelector('.log-turn__body')).toBe(body)
  expect(detail.open).toBe(true); expect(getSelection()!.getRangeAt(0)).toBe(range)
  expect(row.querySelector('[data-icon-animation]')).toBeNull()
  await act(async () => { getSelection()!.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')) })
  await wait(() => expect(detail.open).toBe(false))
})
