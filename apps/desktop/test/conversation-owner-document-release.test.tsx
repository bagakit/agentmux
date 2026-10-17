// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentTimelineItem } from '@agentmux/core'
import { fixtureEpoch } from '../../../test/fixture-values.mjs'
import { nativeHistoryFixture, jsonl } from '../../../packages/core/test/fixtures/native-history-session'
import { desktopConversationReadBridge } from './helpers/conversation-read-bridge'
import { activityReadingProps } from './helpers/activity-reading-props'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { DesktopClientUiProvider } from '../src/renderer/src/components/DesktopClientUiProvider'
import { WorkbenchDocumentContext } from '../src/renderer/src/lib/workbench-document'
import { useSessionConversationWindow } from '../src/renderer/src/lib/session-conversation-window'
import { inspectConversationConsumers } from '../src/renderer/src/lib/conversation-consumer-observation'
import { useAppStore } from '../src/renderer/src/store'

const closes: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const close of closes.splice(0).reverse()) try { await close() } catch (error) { failures.push(error) }
  vi.restoreAllMocks(); vi.unstubAllGlobals()
  if (failures.length) throw new AggregateError(failures, 'Private document reading cleanup failed')
})
const pause = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
const wait = (assertion: () => void) => vi.waitFor(async () => { await pause(); assertion() }, { timeout: 7000, interval: 20 })
function selectionListeners(owner: Document) {
  const active = new Set<EventListenerOrEventListenerObject>()
  const add = owner.addEventListener.bind(owner), remove = owner.removeEventListener.bind(owner)
  vi.spyOn(owner, 'addEventListener').mockImplementation((type, listener, options) => {
    if (type === 'selectionchange' && listener) active.add(listener)
    add(type, listener, options)
  })
  vi.spyOn(owner, 'removeEventListener').mockImplementation((type, listener, options) => {
    if (type === 'selectionchange' && listener) active.delete(listener)
    remove(type, listener, options)
  })
  return active
}

it('actual Activity releases a protected frame from its owner document while retaining its original Range', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  const f = await nativeHistoryFixture('claude', jsonl([
    { type: 'user', uuid: 'original-context', sessionId: 'native-main', message: { role: 'user', content: 'Original context' } }
  ]))
  closes.push(f.close)
  const original: AgentTimelineItem = { id: 'selected-original', agentSessionId: f.session.agentSessionId,
    kind: 'assistant_message', source: 'native-hook', status: 'complete', title: 'Original answer',
    content: 'Original selected body.', createdAt: fixtureEpoch(0, 0, 1), updatedAt: fixtureEpoch(0, 0, 1) }
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.session.agentSessionId, item: original })
  const metadata = await f.store.readMetadata(f.session.agentSessionId), store = useAppStore.getState()
  useAppStore.setState({ agentComposerDrafts: { [f.session.agentSessionId]: 'Unsent original draft' } })
  closes.push(() => useAppStore.setState(store, true))
  await desktopConversationReadBridge(f, closes)
  const frames = [document.createElement('iframe'), document.createElement('iframe')]
  for (const frame of frames) document.body.append(frame)
  closes.push(() => { for (const frame of frames) frame.remove() })
  const first = frames[0]!.contentDocument!, second = frames[1]!.contentDocument!
  expect(first).not.toBe(document); expect(second).not.toBe(first)
  const host = first.createElement('div'); first.body.append(host)
  const root = createRoot(host)
  let mounted = true
  const unmount = async () => { if (mounted) { mounted = false; await act(async () => root.unmount()) } }
  closes.push(async () => { await unmount(); host.remove() })
  const render = (owner = first, enabled = true) => act(async () => root.render(
    <WorkbenchDocumentContext.Provider value={{ document: owner, window: null }}>
      <DesktopClientUiProvider document={owner}><ActivityView {...activityReadingProps({
        control: { hostId: 'local', agentSessionId: f.session.agentSessionId, run: f.session.run }, workspaceRoot: f.root, visible: enabled
      })} /></DesktopClientUiProvider>
    </WorkbenchDocumentContext.Provider>))
  const consumer = () => inspectConversationConsumers({ hostId: 'local', agentSessionId: f.session.agentSessionId, records: [] }).consumers[0]
  const body = () => host.querySelector<HTMLElement>('[data-message-id="selected-original"] .log-turn__body')
  const disclosure = () => host.querySelector<HTMLButtonElement>('[data-captured-reply-observation="selected-original"] .conversation-reply-observation__toggle')
  const changeSelection = (owner: Document) => owner.dispatchEvent(new owner.defaultView!.Event('selectionchange'))
  const selectBody = (owner: Document) => {
    const node = body()!.querySelector('p')!.firstChild!, range = owner.createRange(), selection = owner.defaultView!.getSelection()!
    range.selectNodeContents(node); selection.removeAllRanges(); selection.addRange(range)
    return { node, range, selection }
  }
  const publish = async (version: number) => {
    const changed = { ...original, content: `Qualified captured version ${version}.`, updatedAt: fixtureEpoch(0, 0, version) }
    await act(async () => Reflect.get(f.client, 'persistAndPublishTimeline').call(f.client,
      { type: 'upsert', agentSessionId: f.session.agentSessionId, item: changed }, { source: 'agentmux', observedAt: changed.updatedAt }, 'local'))
    await wait(() => { expect(consumer()?.held).toBe(true); expect(consumer()?.pending).not.toBeNull(); expect(consumer()?.inFlight).toBe(false) })
    return changed.content
  }
  await render()
  await wait(() => expect(disclosure()).not.toBeNull())
  await act(async () => disclosure()!.click())
  await wait(() => { expect(body()?.textContent).toBe(original.content); expect(consumer()?.inFlight).toBe(false) })
  // Existing Find deliberately stops follow without requesting another source page.
  await act(async () => host.querySelector<HTMLButtonElement>('button[title="Find in loaded text (Ctrl/\u2318+F)"]')!.click())
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Close find"]')!.click())
  const selected = selectBody(first), originalBody = body()!, originalTop = host.querySelector('.activity-feed')!.scrollTop
  const nextBody = await publish(2), pendingView = consumer()!.pending!.id
  await act(async () => changeSelection(document))
  expect(consumer()?.held).toBe(true); expect(body()).toBe(originalBody); expect(selected.node.isConnected).toBe(true)
  expect(selected.selection.getRangeAt(0)).toBe(selected.range); expect(selected.range.toString()).toBe(original.content)
  await render(first, false)
  expect(body()).toBe(originalBody); expect(selected.range.toString()).toBe(original.content)
  await render()
  await wait(() => { expect(consumer()?.held).toBe(true); expect(consumer()?.inFlight).toBe(false) })
  await act(async () => { selected.selection.removeAllRanges(); changeSelection(first) })
  await wait(() => expect(body()?.textContent, 'Clearing the host selection admits its original held frame without a primary-document event').toBe(nextBody))
  expect(consumer()?.accepted?.id).toBe(pendingView); expect(consumer()?.held).toBe(false)
  expect(disclosure()?.getAttribute('aria-expanded')).toBe('true')
  expect(host.querySelector('.activity-feed')!.scrollTop).toBe(originalTop)

  await unmount()
  expect(await f.store.readMetadata(f.session.agentSessionId)).toEqual(metadata)
  expect(useAppStore.getState().agentComposerDrafts[f.session.agentSessionId]).toBe('Unsent original draft')
  expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})


it('the original window Hook removes its held subscription on disable, document replacement and unmount', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const f = await nativeHistoryFixture('claude', jsonl([
    { type: 'user', uuid: 'original-context', sessionId: 'native-main', message: { role: 'user', content: 'Original context' } }
  ]))
  closes.push(f.close)
  const original: AgentTimelineItem = { id: 'protected-original', agentSessionId: f.session.agentSessionId,
    kind: 'assistant_message', source: 'native-hook', status: 'complete', title: 'Original answer',
    content: 'Original retained body.', createdAt: fixtureEpoch(0, 0, 1), updatedAt: fixtureEpoch(0, 0, 1) }
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.session.agentSessionId, item: original })
  const metadata = await f.store.readMetadata(f.session.agentSessionId)
  await desktopConversationReadBridge(f, closes)
  const frames = [document.createElement('iframe'), document.createElement('iframe')]
  for (const frame of frames) document.body.append(frame)
  closes.push(() => { for (const frame of frames) frame.remove() })
  const first = frames[0]!.contentDocument!, second = frames[1]!.contentDocument!
  const host = first.createElement('div'); first.body.append(host)
  const root = createRoot(host)
  // This minimal Hook host has no other selection observer. Start after React's
  // root delegate is installed; no callback names or implementation inspection.
  const firstListeners = selectionListeners(first), secondListeners = selectionListeners(second)
  let mounted = true, allow = true, view!: ReturnType<typeof useSessionConversationWindow>
  const unmount = async () => { if (mounted) { mounted = false; await act(async () => root.unmount()) } }
  closes.push(async () => { await unmount(); host.remove() })
  function Consumer({ enabled }: { enabled: boolean }) {
    view = useSessionConversationWindow({ reference: { hostId: 'local', agentSessionId: f.session.agentSessionId },
      identity: f.session.agentSessionId, enabled }, () => true, Infinity, () => allow)
    return <output>{view.capturedSnapshot?.items.find(item => item.id === original.id)?.content}</output>
  }
  const render = (owner = first, enabled = true) => act(async () => root.render(
    <WorkbenchDocumentContext.Provider value={{ document: owner, window: null }}><Consumer enabled={enabled} /></WorkbenchDocumentContext.Provider>))
  const changed = (owner: Document) => owner.dispatchEvent(new owner.defaultView!.Event('selectionchange'))
  const publish = async (version: number) => {
    allow = false
    const item = { ...original, content: `Qualified retained version ${version}.`, updatedAt: fixtureEpoch(0, 0, version) }
    await act(async () => Reflect.get(f.client, 'persistAndPublishTimeline').call(f.client,
      { type: 'upsert', agentSessionId: f.session.agentSessionId, item }, { source: 'agentmux', observedAt: item.updatedAt }, 'local'))
    await wait(() => { expect(view.held).toBe(true); expect(view.inspect().inFlight).toBe(false) })
    return item.content
  }
  await render()
  await wait(() => { expect(host.textContent).toBe(original.content); expect(view.inspect().inFlight).toBe(false) })
  expect(firstListeners.size + secondListeners.size).toBe(0)
  const nextBody = await publish(2)
  expect(firstListeners.size).toBe(1); expect(secondListeners.size).toBe(0)
  await render(first, false)
  expect(firstListeners.size + secondListeners.size, 'A reading-disabled held window keeps no selection subscription').toBe(0)
  allow = true; await act(async () => changed(first))
  expect(view.held).toBe(true); expect(host.textContent).toBe(original.content)
  allow = false; await render()
  await wait(() => { expect(view.held).toBe(true); expect(view.inspect().inFlight).toBe(false) })
  expect(firstListeners.size).toBe(1)
  second.body.append(second.adoptNode(host)); await render(second)
  expect(firstListeners.size, 'Changing the owning document removes the original subscription').toBe(0)
  expect(secondListeners.size).toBe(1)
  allow = true; await act(async () => changed(first))
  expect(view.held).toBe(true); expect(host.textContent).toBe(original.content)
  await act(async () => changed(second))
  await wait(() => expect(host.textContent).toBe(nextBody))
  expect(view.held).toBe(false); expect(firstListeners.size + secondListeners.size).toBe(0)
  await publish(3)
  expect(secondListeners.size).toBe(1)
  await unmount()
  expect(firstListeners.size + secondListeners.size, 'Unmount releases the original Hook subscription').toBe(0)
  expect(await f.store.readMetadata(f.session.agentSessionId)).toEqual(metadata)
  expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})
