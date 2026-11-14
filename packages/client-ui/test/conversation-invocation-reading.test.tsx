// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { consumeConversationWindowPage, type ConversationWindowAssembly, type ConversationWindowSnapshot } from '@agentmux/core/conversation'
import { nativeHistoryFixture, jsonl } from '../../core/test/fixtures/native-history-session'
import { projectConversationWindow } from '../src/lib/conversation-records'
import { conversationMessageSourceKey } from '../src/lib/conversation-message-location'
import { readConversationProcessDetail } from '../src/lib/read-conversation-process-detail'
import { ConversationView } from '../src/components/ConversationView'
import { NativeProcessObservation, NativeProcessStep } from '../src/components/NativeProcessObservation'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform'
import { ActivityView } from '../../../apps/desktop/src/renderer/src/components/ActivityView'
import { api } from '../../../apps/desktop/src/renderer/src/lib/api'
import { activityReadingProps } from '../../../apps/desktop/test/helpers/activity-reading-props'
import { createClientUiRoot } from '../../../apps/desktop/test/helpers/client-ui-render'

const source = { providerId: 'claude', nativeSessionId: 'native-main' }
const platform: ClientUiPlatform = { copyText: async () => true, overlayContainer: () => document.body, bindComposerFocus: () => () => {},
  renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
const closes: Array<() => Promise<unknown>> = []
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(async () => { getSelection()?.removeAllRanges(); for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const native = (id: string, timestamp: number, content: unknown[]) => ({ type: id === 'native-call' ? 'assistant' : 'user', uuid: id,
  sessionId: source.nativeSessionId, timestamp: new Date(timestamp).toISOString(), message: { role: id === 'native-call' ? 'assistant' : 'user', content } })
async function fixture(options: { correlated?: boolean; subject?: 'main' | 'child'; scope?: 'turn'; interleaved?: boolean; failed?: boolean; errorText?: boolean } = {}) {
  const f = await nativeHistoryFixture('claude', jsonl([
    native('native-call', 1000, [{ type: 'tool_use', id: 'original-call', name: 'inspect', input: { exact: 'native input' } }]),
    ...(options.interleaved ? [native('other-call', 2500, [{ type: 'tool_result', tool_use_id: 'different-call', content: 'Interleaved result' }])] : []),
    native('native-result', 3000, [{ type: 'tool_result', tool_use_id: 'original-call',
      content: options.errorText ? 'Failure and error are words in this original output.' : 'Original native result',
      ...(options.failed === undefined ? {} : { is_error: options.failed }) }])
  ]))
  closes.push(f.close)
  const ref = { hostId: 'local', agentSessionId: f.session.agentSessionId }
  const captured = (correlated = true) => f.store.applyTimelineMutation({ type: 'upsert', agentSessionId: ref.agentSessionId, item: {
    id: 'captured-hook', agentSessionId: ref.agentSessionId, kind: 'tool_call', source: 'native-hook', status: 'complete',
    title: 'inspect', toolName: 'inspect', toolInput: '{"exact":"hook input"}', toolOutput: 'Original Hook result', createdAt: 2000, updatedAt: correlated ? 2001 : 2000,
    ...(correlated ? { conversation: { invocations: [{ selector: { kind: 'captured-field', field: 'toolInput' },
      invocation: { source, subject: options.subject === 'child' ? { kind: 'child', nativeActorId: 'other-child' } : 'main', scope: options.scope === 'turn' ? { kind: 'turn', nativeTurnId: 'other-turn' } : { kind: 'session' }, callId: 'original-call' } }] } } : {})
  } })
  await captured(options.correlated ?? true)
  const read = async (deferred = false) => {
    let pending: ConversationWindowAssembly | undefined, cursor: string | undefined
    for (;;) {
      const page = await f.client.readAgentConversation({ ...ref, limit: 100, ...(deferred ? { processDetails: 'deferred' } : {}), ...(cursor ? { cursor } : {}) })
      const value = consumeConversationWindowPage(page, pending)
      if (value.kind === 'complete') return value.snapshot
      pending = value.pending; cursor = page.nextCursor!
    }
  }
  return { ...f, ref, read, captured }
}
function surface(desktop = false) {
  const host = document.createElement('div'); document.body.append(host)
  const root = desktop ? createClientUiRoot(host) : createRoot(host)
  closes.push(async () => { await act(async () => root.unmount()); host.remove() })
  return { host, render: async (node: ReactNode) => act(async () => root.render(desktop ? node : <ClientUiProvider platform={platform}>{node}</ClientUiProvider>)) }
}
function view(f: Awaited<ReturnType<typeof fixture>>, snapshot: ConversationWindowSnapshot, located?: string) {
  const projection = projectConversationWindow(snapshot)
  return <ConversationView sessionId={f.ref.agentSessionId} executionHostId="local" records={projection.records} originalRecords={projection.originalRecords}
    page={projection.historyPage} timeline={projection.captured} readProcessDetail={(anchor, signal) => readConversationProcessDetail(f.client, anchor, signal)}
    {...(located ? { locatedMessageKey: located } : {})} renderProcess={props => <NativeProcessObservation {...props} />} />
}
const rows = (host: HTMLElement) => [...host.querySelectorAll<HTMLButtonElement>('.wf-tool-row--observation')]
const visibleRows = (host: HTMLElement) => rows(host).filter(row => !row.hidden)
async function settle(assertion: () => void) {
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }); assertion() }, { timeout: 5000, interval: 10 })
}

it.each([false, true])('the real Core and shared View give one disclosure to adjacent native/Hook originals, deferred %s', async deferred => {
  const f = await fixture(), snapshot = await f.read(deferred), { host, render } = surface()
  const records = projectConversationWindow(snapshot).records
  expect(records).toHaveLength(3)
  expect(new Set(records.map(record => record.invocationKey)).size).toBe(1)
  expect(records[0]!.invocationKey).toBeTypeOf('string')
  await render(view(f, snapshot))
  expect(rows(host)).toHaveLength(3)
  expect(visibleRows(host)).toHaveLength(1)
  const controls = visibleRows(host)[0]!.getAttribute('aria-controls')!.split(' ')
  expect(controls).toHaveLength(3)
  expect(rows(host).slice(1).map(row => row.getAttribute('aria-controls')!.split(' ').length)).toEqual([3, 3])
  expect(controls.map(id => document.getElementById(id))).not.toContain(null)
  await act(async () => visibleRows(host)[0]!.click())
  await settle(() => { expect(host.textContent).toContain('Original Hook result'); expect(host.textContent).toContain('Original native result') })
  const original = host.querySelector('[data-native-record-id="native-result"]')!
  expect(original).not.toBeNull()
  const body = document.getElementById(controls[2]!)!
  const originalText = body.querySelector('pre')?.firstChild
  expect(originalText).toBeTruthy()
  await act(async () => visibleRows(host)[0]!.click())
  await act(async () => visibleRows(host)[0]!.click())
  expect(host.querySelector('[data-native-record-id="native-result"]')).toBe(original)
  expect(body.querySelector('pre')?.firstChild).toBe(originalText)
  expect(f.controls.length).toBeGreaterThan(0)
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
})

it.each([false, true])('the original failed result keeps a visible shared disclosure, deferred %s', async deferred => {
  const f = await fixture({ failed: true }), snapshot = await f.read(deferred), { host, render } = surface()
  await render(view(f, snapshot))
  expect(visibleRows(host)).toHaveLength(2)
  const failed = visibleRows(host).find(row => row.dataset.observationStepId === 'native-result')!
  if (deferred) {
    // The existing deferred header expresses its original result flag as a recorded row status.
    expect(failed.textContent).toContain('Failed')
    expect(failed.getAttribute('data-status')).toBe('failed')
  } else {
    expect(failed.textContent).toContain('含失败结果')
    expect(failed.hasAttribute('data-status')).toBe(false)
  }
  const controls = failed.getAttribute('aria-controls')!.split(' ')
  expect(controls).toEqual(visibleRows(host)[0]!.getAttribute('aria-controls')!.split(' '))
  expect(controls).toHaveLength(3)
  await act(async () => failed.click())
  await settle(() => { expect(host.textContent).toContain('Original Hook result'); expect(host.textContent).toContain('Original native result') })
  expect(controls.map(id => document.getElementById(id)?.hidden)).toEqual([false, false, false])
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
})

it.each([false, undefined])('failure words do not reveal or label an unflagged result, flag %s', async failed => {
  const f = await fixture({ failed, errorText: true }), snapshot = await f.read(), { host, render } = surface()
  await render(view(f, snapshot))
  expect(visibleRows(host)).toHaveLength(1)
  expect(host.querySelector('.log-row__issue')).toBeNull()
  await act(async () => visibleRows(host)[0]!.click())
  await settle(() => expect(host.textContent).toContain('Failure and error are words in this original output.'))
})

it('a later failed part remains visible when an earlier result in the same original has no failure flag', async () => {
  const { host, render } = surface()
  await render(<NativeProcessStep item={{ id: 'multiple-results', kind: 'activity', contentParts: [
    { kind: 'tool-result', output: 'First original result' }, { kind: 'tool-result', output: 'Later original result', failed: true }
  ] }} stepGroup={{ headerHidden: true, bodyId: 'original-result-body', controls: 'original-result-body' }}>
    <p>Both originals remain available.</p>
  </NativeProcessStep>)
  expect(visibleRows(host)).toHaveLength(1)
  expect(visibleRows(host)[0]!.textContent).toContain('含失败结果')
  expect(visibleRows(host)[0]!.hasAttribute('data-status')).toBe(false)
})

it.each([{ correlated: false }, { subject: 'child' as const }, { scope: 'turn' as const }, { interleaved: true }])('unknown, different scoped subjects and interleaved calls retain original steps: %j', async options => {
  const f = await fixture(options), snapshot = await f.read(), { host, render } = surface()
  await render(view(f, snapshot))
  expect(visibleRows(host)).toHaveLength(3)
  expect(projectConversationWindow(snapshot).records.map(record => record.rawId)).toEqual(options.interleaved
    ? ['native-call', 'captured-hook', 'other-call', 'native-result'] : ['native-call', 'captured-hook', 'native-result'])
})

it('locating an exact member opens its shared invocation and keeps that member source target', async () => {
  const f = await fixture(), snapshot = await f.read(true), { host, render } = surface()
  const located = conversationMessageSourceKey(f.ref.agentSessionId, { kind: 'native', ...source, recordId: 'native-result' })
  await render(view(f, snapshot, located))
  await settle(() => expect(host.querySelector('[data-native-record-id="native-result"]')).not.toBeNull())
  expect(visibleRows(host)).toHaveLength(1)
  expect(host.textContent).toContain('Original native result')
})

it.each(['focus', 'selection'])('late confirmed membership retains the same protected original header until %s leaves it', async protection => {
  const f = await fixture({ correlated: false }), { host, render } = surface()
  await render(view(f, await f.read()))
  const header = rows(host).find(row => row.dataset.observationStepId === 'native-result')!
  await act(async () => {
    if (protection === 'focus') header.focus()
    else { const range = document.createRange(); range.selectNodeContents(header.querySelector('.log-row__title')!); getSelection()!.addRange(range) }
  })
  const selected = getSelection()?.toString()
  await f.captured(true)
  await render(view(f, await f.read()))
  expect(rows(host).find(row => row.dataset.observationStepId === 'native-result')).toBe(header)
  if (protection === 'focus') expect(document.activeElement).toBe(header)
  else expect(getSelection()?.toString()).toBe(selected)
  expect(header.hidden).toBe(false)
  await act(async () => { header.blur(); getSelection()?.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')) })
  expect(header.hidden).toBe(true)
  expect(visibleRows(host)).toHaveLength(1)
})

it('the actual Desktop Activity consumer renders the same grouped deferred originals', async () => {
  const f = await fixture(), { host, render } = surface(true)
  vi.spyOn(api.conversation, 'readAgentConversation').mockImplementation(input => f.client.readAgentConversation(input))
  vi.spyOn(api.conversation, 'readConversationChanges').mockImplementation(input => f.client.readConversationChanges(input))
  vi.spyOn(api.conversation, 'observeConversation').mockImplementation((input, listener) => f.client.observeConversation(input, listener))
  vi.spyOn(api.conversation, 'releaseConversationView').mockImplementation(input => f.client.releaseConversationView(input))
  await render(<ActivityView {...activityReadingProps({ control: { ...f.ref, run: f.session.run } })} />)
  await settle(() => expect(host.querySelector('.wf-head')).not.toBeNull())
  const fold = host.querySelector<HTMLButtonElement>('.wf-head')!
  await act(async () => fold.click())
  await settle(() => expect(host.querySelectorAll('[data-deferred-process-id]')).toHaveLength(3))
  expect(visibleRows(host)).toHaveLength(1)
  await act(async () => visibleRows(host)[0]!.click())
  await settle(() => expect(host.textContent).toContain('Original native result'))
})
