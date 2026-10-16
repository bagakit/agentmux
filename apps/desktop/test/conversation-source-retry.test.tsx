// @vitest-environment happy-dom
import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { appendFile } from 'node:fs/promises'
import { nativeHistoryFixture, jsonl } from '../../../packages/core/test/fixtures/native-history-session'
import { desktopConversationReadBridge } from './helpers/conversation-read-bridge'
import { createClientUiRoot } from './helpers/client-ui-render'
import { activityReadingProps } from './helpers/activity-reading-props'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import type { ConversationChangesPage } from '@agentmux/core/conversation'

const closes: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { window.getSelection()?.removeAllRanges(); for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const row = (id: string, content = id) => ({ type: 'user', uuid: id, sessionId: 'native-main', message: { role: 'user', content } })
const pause = async (ms = 100) => { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) }) }
const wait = async (assertion: () => void) => vi.waitFor(async () => { await pause(15); assertion() }, { timeout: 5000, interval: 15 })
type Fixture = Awaited<ReturnType<typeof nativeHistoryFixture>>
async function captured(f: Fixture, id: string) {
  // Persist and publish only this isolated source fixture. No Agent input path.
  await Reflect.get(f.client, 'persistAndPublishTimeline').call(f.client, { type: 'append', agentSessionId: f.session.agentSessionId,
    item: { id, agentSessionId: f.session.agentSessionId, kind: 'user_message', source: 'user', status: 'complete', title: 'Original captured input', content: id, createdAt: _tailFixtureEpoch(0, 0, 1), updatedAt: _tailFixtureEpoch(0, 0, 1) } },
  { source: 'agentmux', observedAt: _tailFixtureEpoch(0, 0, 1) }, 'local')
}
function retryButton(host: HTMLElement) {
  return [...host.querySelectorAll<HTMLButtonElement>('.conversation-read-issues button')].find(button => button.textContent === 'Retry conversation records')
}
const notice = (host: HTMLElement) => [...host.querySelectorAll('.conversation-read-issues')].map(node => node.textContent).join('\n')
function sourceCut(page: ConversationChangesPage, kind: 'native' | 'captured') {
  return page.checkpoint.frontier.cuts.find(cut => cut.kind === kind)
}

it.each(['native', 'captured'] as const)('actual Activity keeps a failed %s source cut observable and retries it in its original window', async failedSource => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  const f = await nativeHistoryFixture('claude', jsonl([row('original-selected-input', 'Original **selected words** stay readable.')]))
  closes.push(f.close); await captured(f, 'original-captured-input')
  const sessionBefore = await f.store.readMetadata(f.session.agentSessionId), initialStore = useAppStore.getState()
  useAppStore.setState({ agentComposerDrafts: { [f.session.agentSessionId]: 'Original unsent draft' } })
  closes.push(() => useAppStore.setState(initialStore, true))
  await desktopConversationReadBridge(f, closes)
  const oldReads = [vi.spyOn(api.sessions, 'historyPage'), vi.spyOn(api.sessions, 'timeline')]
  const initialReads = vi.spyOn(f.client, 'readAgentConversation'), frames: ConversationChangesPage[] = []
  const originalChanges = f.client.readConversationChanges.bind(f.client)
  const changes = vi.spyOn(f.client, 'readConversationChanges').mockImplementation(async (...args) => {
    const page = await originalChanges(...args); if (page.window.complete) frames.push(page); return page
  })
  const originalNative = f.client.readSessionHistoryChanges.bind(f.client), originalCaptured = f.store.readCapturedHistory.bind(f.store)
  let fail = false, attempts = 0, release: (() => void) | null = null
  const gate = async () => {
    attempts++
    if (fail) throw Error(`Isolated ${failedSource} source read unavailable`)
    if (release === null) await new Promise<void>(resolve => { release = resolve })
  }
  let holdRetry = false
  vi.spyOn(f.client, 'readSessionHistoryChanges').mockImplementation(async (...args) => {
    if (failedSource === 'native' && (fail || holdRetry)) await gate()
    return originalNative(...args)
  })
  vi.spyOn(f.store, 'readCapturedHistory').mockImplementation(async (id, input) => {
    if (failedSource === 'captured' && input?.afterSequence !== undefined && (fail || holdRetry)) await gate()
    return originalCaptured(id, input)
  })
  const host = document.createElement('div'); document.body.append(host); const root: Root = createClientUiRoot(host)
  closes.push(async () => { release?.(); await act(async () => root.unmount()); host.remove() })
  const control = { hostId: 'local', agentSessionId: f.session.agentSessionId, run: f.session.run }
  const render = async (visible = true) => { await act(async () => root.render(<ActivityView {...activityReadingProps({ control, visible, workspaceRoot: f.root })} />)) }
  await render()
  await wait(() => { expect(host.textContent).toContain('Original selected words stay readable.'); expect(frames.length).toBeGreaterThan(0) })
  await pause(120)
  const initialFrame = frames.at(-1)!, selected = host.querySelector('[data-native-record-id="original-selected-input"] strong')!
  expect(selected).not.toBeNull()
  const range = document.createRange(); range.selectNodeContents(selected); window.getSelection()!.addRange(range)
  const feed = host.querySelector<HTMLElement>('.activity-feed')!; expect(feed).not.toBeNull()
  Object.defineProperties(feed, { clientHeight: { configurable: true, value: 600 }, scrollHeight: { configurable: true, value: 2000 } })
  feed.scrollTop = 1400; await act(async () => feed.dispatchEvent(new Event('scroll')))
  feed.scrollTop = 300; await act(async () => feed.dispatchEvent(new Event('scroll')))
  fail = true
  await act(async () => {
    if (failedSource === 'native') await appendFile(f.path, jsonl([row('new-original-native-input')]))
    else await captured(f, 'new-original-captured-input')
  })
  await wait(() => {
    expect(attempts).toBeGreaterThan(0)
    expect(notice(host), 'Actual Activity must expose the original failed source read').toContain(`Isolated ${failedSource} source read unavailable`)
    expect(retryButton(host), 'The existing Activity Retry action must be reachable').toBeDefined()
  })
  const failedFrame = frames.at(-1)!, failedCoverage = failedFrame.coverage.find(source => source.source.kind === failedSource)!
  expect(failedCoverage.current).toBe('unavailable'); expect(failedCoverage.gaps).toHaveLength(1)
  expect(failedFrame.window.id).toBe(initialFrame.window.id); expect(failedFrame.scope).toEqual(initialFrame.scope)
  expect(sourceCut(failedFrame, failedSource)).toEqual(sourceCut(initialFrame, failedSource))
  expect(selected.isConnected).toBe(true); expect(window.getSelection()!.getRangeAt(0)).toBe(range); expect(window.getSelection()!.toString()).toBe('selected words')
  expect(feed.scrollTop).toBe(300)
  const quietReads = changes.mock.calls.length
  await act(async () => useAppStore.setState({ timelines: { unrelated: { agentSessionId: 'unrelated', revision: 1, items: [] } } }))
  await pause(180); expect(changes.mock.calls).toHaveLength(quietReads)
  expect(notice(host)).toContain(`Isolated ${failedSource} source read unavailable`)
  // Parking retains the failure and its original changes retry intent. The new
  // watch's checkpoint catch-up may repeat the failed cut, but never while hidden.
  await render(false); const parkedReads = changes.mock.calls.length
  await pause(160); expect(changes.mock.calls).toHaveLength(parkedReads)
  expect(notice(host)).toContain(`Isolated ${failedSource} source read unavailable`)
  await render(); await pause(200)
  await wait(() => { expect(retryButton(host)).toBeDefined(); expect(retryButton(host)!.disabled).toBe(false) })
  const retryFrame = frames.at(-1)!, priorCalls = changes.mock.calls.length, priorInitials = initialReads.mock.calls.length
  fail = false; holdRetry = true
  await act(async () => retryButton(host)!.click()); await pause(30)
  expect(changes.mock.calls.length, 'Retry must use the original changes operation, not a new latest window').toBe(priorCalls + 1)
  expect(initialReads.mock.calls).toHaveLength(priorInitials)
  const retryInput = changes.mock.calls.at(-1)![0]
  expect(retryInput.view).toBe(retryFrame.window.view); expect(retryInput.checkpoint).toEqual(retryFrame.window.checkpoint)
  expect(notice(host), 'An in-flight source retry must retain the previous failure').toContain(`Isolated ${failedSource} source read unavailable`)
  expect(selected.isConnected).toBe(true); expect(window.getSelection()!.getRangeAt(0)).toBe(range)
  expect(release).not.toBeNull(); await act(async () => release!()); holdRetry = false
  const target = `new-original-${failedSource}-input`
  await wait(() => { expect(host.textContent).toContain(target); expect(notice(host)).not.toContain(`Isolated ${failedSource} source read unavailable`) })
  const recovered = frames.at(-1)!
  expect(recovered.window.id).toBe(initialFrame.window.id); expect(recovered.scope).toEqual(initialFrame.scope)
  expect(sourceCut(recovered, failedSource)).not.toEqual(sourceCut(initialFrame, failedSource))
  expect(recovered.coverage.find(source => source.source.kind === failedSource)?.current).toBe('complete-through-cut')
  expect(selected.isConnected).toBe(true); expect(window.getSelection()!.getRangeAt(0)).toBe(range); expect(feed.scrollTop).toBe(300)
  expect(oldReads.map(read => read.mock.calls.length)).toEqual([0, 0]); expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
  expect(await f.store.readMetadata(f.session.agentSessionId)).toEqual(sessionBefore)
  expect(useAppStore.getState().agentComposerDrafts[f.session.agentSessionId]).toBe('Original unsent draft')
}, 15000)

it('a healthy Provider without durable native changes keeps captured reading available without a transient-failure Retry', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  // Pi's real Provider supports original history and observation, and does not
  // declare durable native changes. No error or capability is mocked here.
  const f = await nativeHistoryFixture('pi', root => jsonl([
    { type: 'session', version: 3, id: 'native-main', cwd: root },
    { type: 'message', id: 'supported-original-history', parentId: null, message: { role: 'user', content: [{ type: 'text', text: 'Readable original Provider history.' }] } }
  ])); closes.push(f.close)
  await captured(f, 'healthy-captured-input'); await desktopConversationReadBridge(f, closes)
  const frames: ConversationChangesPage[] = [], original = f.client.readConversationChanges.bind(f.client)
  vi.spyOn(f.client, 'readConversationChanges').mockImplementation(async (...args) => {
    const page = await original(...args); if (page.window.complete) frames.push(page); return page
  })
  const host = document.createElement('div'); document.body.append(host); const root = createClientUiRoot(host)
  closes.push(async () => { await act(async () => root.unmount()); host.remove() })
  const control = { hostId: 'local', agentSessionId: f.session.agentSessionId, run: f.session.run }
  await act(async () => root.render(<ActivityView {...activityReadingProps({ control, workspaceRoot: f.root })} />))
  await wait(() => {
    expect(host.textContent).toContain('Readable original Provider history.')
    expect(frames.length).toBeGreaterThan(0)
    expect(frames.at(-1)!.coverage.find(source => source.source.kind === 'native')?.current).toBe('unsupported')
  })
  expect(host.querySelector('[data-conversation-gap="AGENT_CONVERSATION_CHANGES_UNSUPPORTED"]')).not.toBeNull()
  expect(retryButton(host), 'Unsupported capabilities must not become a transient source-failure Retry').toBeUndefined()
  const windowId = frames.at(-1)!.window.id
  await act(async () => captured(f, 'later-healthy-captured-input'))
  await wait(() => expect(host.textContent).toContain('later-healthy-captured-input'))
  expect(frames.at(-1)!.window.id).toBe(windowId)
  expect(retryButton(host), 'Unsupported capabilities must not become a transient source-failure Retry').toBeUndefined()
  expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})
