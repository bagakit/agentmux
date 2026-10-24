// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import * as jsonc from 'jsonc-parser'
import { nativeHistoryFixture, jsonl } from '../../core/test/fixtures/native-history-session'
import { consumeConversationWindowPage, type ConversationWindowSnapshot, type ConversationVersionedAnchor } from '@agentmux/core/conversation'
import { projectConversationWindow } from '../src/lib/conversation-records'
import { readConversationProcessDetail } from '../src/lib/read-conversation-process-detail'
import { ConversationView } from '../src/components/ConversationView'
import { NativeProcessObservation } from '../src/components/NativeProcessObservation'
import { ConversationToolPayload } from '../src/components/ConversationToolPayload'
import { ConversationRetainedDetails } from '../src/components/ConversationRetainedDetails'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform'
import { useConversationView } from '../src/lib/use-conversation-view'

const copy = vi.fn(async (_text: string, _failed?: (error: unknown) => void) => true)
const platform: ClientUiPlatform = { copyText: copy, overlayContainer: () => document.body, bindComposerFocus: () => () => {}, renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
const closes: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); copy.mockClear() })
function surface() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
  closes.push(async () => { await act(async () => root.unmount()); host.remove() })
  return { host, render: async (node: ReactNode) => act(async () => root.render(<ClientUiProvider platform={platform}>{node}</ClientUiProvider>)) }
}
async function fixture() {
  const f = await nativeHistoryFixture('claude', jsonl([{ type: 'assistant', uuid: 'native-tool', sessionId: 'native-main', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'native-call', name: 'inspect-native', input: { exact: 'native body' } }] } }]))
  closes.push(f.close)
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.session.agentSessionId, item: { id: 'captured-tool', agentSessionId: f.session.agentSessionId,
    kind: 'tool_call', source: 'native-hook', status: 'failed', title: 'Captured tool', toolName: 'inspect-captured', toolInput: '{"exact":"captured body"}', toolOutput: '  complete output\n', createdAt: 1000, updatedAt: 1001 } })
  const ref = { hostId: 'local', agentSessionId: f.session.agentSessionId }
  const initial = consumeConversationWindowPage(await f.client.readAgentConversation({ ...ref, processDetails: 'deferred' }))
  if (initial.kind !== 'complete') throw Error('Small summary should complete')
  return { ...f, ref, snapshot: initial.snapshot }
}
function view(snapshot: ConversationWindowSnapshot, read: (anchor: ConversationVersionedAnchor, signal: AbortSignal) => Promise<ConversationWindowSnapshot>, active = true) {
  const projection = projectConversationWindow(snapshot)
  return <ConversationView sessionId={snapshot.agentSessionId} executionHostId={snapshot.hostId} active={active} records={projection.records} originalRecords={projection.originalRecords}
    page={projection.historyPage} timeline={projection.captured} readProcessDetail={read} renderProcess={props => <NativeProcessObservation {...props} />} />
}
async function eventually(assertion: () => void) {
  let failure: unknown
  for (let i = 0; i < 100; i++) { await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) }); try { assertion(); return } catch (error) { failure = error } }
  throw failure
}
async function click(host: HTMLElement, selector: string) { const button = host.querySelector<HTMLButtonElement>(selector); expect(button).not.toBeNull(); await act(async () => button!.click()) }
it('releases an offline reader without an observed client or retained view', async () => {
  const { host, render } = surface()
  function OfflineReader() { useConversationView(null, undefined, true); return <p>Original reader offline</p> }
  await render(<OfflineReader />)
  expect(host.textContent).toContain('Original reader offline')
  await render(null)
  expect(host.textContent).toBe('')
})
it('real shared reader requests deferred process bodies and expands both original native and captured source owners', async () => {
  const f = await fixture(), { host, render } = surface(), calls = vi.spyOn(f.client, 'readAgentConversation')
  function Consumer() {
    const owner = useConversationView(f.client, f.ref, true)
    return owner.snapshot ? view(owner.snapshot, owner.readProcessDetail) : <p>Opening {owner.error?.message}</p>
  }
  await render(<Consumer />)
  await eventually(() => expect(host.querySelector('[data-deferred-process-id="captured-tool"]'), host.textContent).not.toBeNull())
  expect(calls.mock.calls[0]?.[0].processDetails).toBe('deferred')
  expect(calls.mock.calls.filter(([input]) => input.anchor)).toHaveLength(0)
  expect(host.textContent).not.toContain('captured body')
  await click(host, '[data-deferred-process-id="captured-tool"] > button')
  await eventually(() => expect(host.textContent).toContain('captured body'))
  const pre = host.querySelector('[data-deferred-process-id="captured-tool"] pre')!, text = pre.firstChild
  await click(host, '[data-deferred-process-id="captured-tool"] [aria-label="Format JSON"]')
  await click(host, '[data-deferred-process-id="captured-tool"] [aria-label="Copy tool input"]')
  expect(copy.mock.calls[0]?.[0]).toBe('{"exact":"captured body"}')
  await click(host, '[data-deferred-process-id="captured-tool"] > button')
  await click(host, '[data-deferred-process-id="captured-tool"] > button')
  expect(host.querySelector('[data-deferred-process-id="captured-tool"] pre')).toBe(pre)
  expect(pre.firstChild).toBe(text) // Format changed text once; disclosure kept its node.
  expect(host.querySelector('[data-deferred-process-id="captured-tool"] [aria-label="Format JSON"]')?.getAttribute('aria-pressed')).toBe('true')
  expect(calls.mock.calls.filter(([input]) => input.anchor?.record.source.recordId === 'captured-tool')).toHaveLength(1)
  await click(host, '[data-deferred-process-id="native-tool"] > button')
  await eventually(() => expect(host.querySelector('[data-native-record-id="native-tool"]')).not.toBeNull())
  await click(host, '[data-native-record-id="native-tool"] .conversation-tool-trace__row')
  expect(host.textContent).toContain('native body')
  expect(calls.mock.calls.filter(([input]) => input.anchor?.record.source.recordId === 'native-tool')).toHaveLength(1)
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
})
it('unrelated frame changes retain an in-flight exact anchor; retry keeps its original version and inactive disclosure cancels', async () => {
  const f = await fixture(), { host, render } = surface()
  let reject!: (reason: unknown) => void
  const read = vi.fn((anchor: ConversationVersionedAnchor, signal: AbortSignal): Promise<ConversationWindowSnapshot> => read.mock.calls.length === 1
    ? new Promise((_resolve, fail) => { reject = fail }) : readConversationProcessDetail(f.client, anchor, signal))
  await render(view(f.snapshot, read)); await click(host, '[data-deferred-process-id="captured-tool"] > button')
  const anchor = read.mock.calls[0]![0], signal = read.mock.calls[0]![1]
  const changed = structuredClone(f.snapshot)
  changed.window.checkpoint.frontier.cuts = changed.window.checkpoint.frontier.cuts.map(cut => cut.kind === 'captured' ? { ...cut, sequence: cut.sequence + 1 } : cut)
  await render(view(changed, read))
  expect(read).toHaveBeenCalledTimes(1); expect(signal.aborted).toBe(false)
  await f.store.applyTimelineMutation({ type: 'update', agentSessionId: f.session.agentSessionId, itemId: 'captured-tool', updatedAt: 1002, toolInput: '{"replacement":"new version must not substitute old original"}' })
  await act(async () => reject(new Error('Original version temporarily unavailable')))
  await click(host, '[data-deferred-process-id="captured-tool"] p button')
  await eventually(() => expect(host.textContent).toContain('captured body'))
  expect(read).toHaveBeenCalledTimes(2); expect(read.mock.calls[1]![0]).toEqual(anchor)
  const stall = vi.fn((_anchor: ConversationVersionedAnchor, _signal: AbortSignal) => new Promise<ConversationWindowSnapshot>(() => {}))
  await render(view(changed, stall)); await click(host, '[data-deferred-process-id="native-tool"] > button')
  expect(stall).toHaveBeenCalledTimes(1)
  await render(view(changed, stall, false))
  expect(stall.mock.calls[0]![1].aborted).toBe(true)
})
it('raw nested details and JSON formatting perform their work only after the corresponding disclosure', async () => {
  const { host, render } = surface(), format = vi.spyOn(jsonc, 'format'), body = vi.fn(() => <ConversationToolPayload text={'{"n":900719925474099312345,"x":[1,2]}'} identity={platform} sourceIdentity={platform} copyLabel="Copy exact" />)
  await render(<ConversationRetainedDetails summary="Original details">{body}</ConversationRetainedDetails>)
  expect(body).not.toHaveBeenCalled(); expect(format).not.toHaveBeenCalled(); expect(host.querySelector('pre')).toBeNull()
  await act(async () => { const details = host.querySelector('details')!; details.open = true; details.dispatchEvent(new Event('toggle')) })
  expect(host.querySelector('pre')).not.toBeNull(); expect(format).not.toHaveBeenCalled()
  await click(host, '[aria-label="Format JSON"]'); expect(format).toHaveBeenCalledTimes(1)
  const pre = host.querySelector('pre')!
  await act(async () => { const details = host.querySelector('details')!; details.open = false; details.dispatchEvent(new Event('toggle')); details.open = true; details.dispatchEvent(new Event('toggle')) })
  expect(host.querySelector('pre')).toBe(pre); expect(format).toHaveBeenCalledTimes(1)
})

it('an unavailable exact version remains a retryable original target instead of accepting an empty body', async () => {
  const f = await fixture(), { host, render } = surface()
  const native = f.snapshot.units.flatMap(unit => unit.records).find(record => record.reference?.source.kind === 'native')!
  const anchor = { record: native.reference!, revision: native.revision, frontier: f.snapshot.window.checkpoint }
  const { writeFile } = await import('node:fs/promises')
  await writeFile(f.path, jsonl([{ type: 'assistant', uuid: 'native-tool', sessionId: 'native-main', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'native-call', name: 'inspect-native', input: { exact: 'changed native body' } }] } }]))
  await expect(readConversationProcessDetail(f.client, anchor, new AbortController().signal)).rejects.toThrow(/original native version/)
  const read = vi.fn((anchor: ConversationVersionedAnchor, signal: AbortSignal) => readConversationProcessDetail(f.client, anchor, signal))
  await render(view(f.snapshot, read)); await click(host, '[data-deferred-process-id="native-tool"] > button')
  await eventually(() => expect(host.textContent).toContain('Retry original details'))
  expect(host.querySelector('[data-deferred-process-id="native-tool"]')).not.toBeNull()
  expect(host.textContent).not.toContain('changed native body')
  await click(host, '[data-deferred-process-id="native-tool"] p button')
  await eventually(() => expect(read).toHaveBeenCalledTimes(2))
  expect(read.mock.calls[0]![0]).toEqual(read.mock.calls[1]![0])
})
