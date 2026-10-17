// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { composeAgentPrompt } from '@agentmux/core/agent-outbound-message'
import * as messageRender from '@agentmux/core/agent-message-render'
import type { BrowserInputContext } from '@agentmux/core/browser-input-context'
import { nativeHistoryFixture, jsonl } from '../../../packages/core/test/fixtures/native-history-session'
import { fixtureEpoch } from '../../../test/fixture-values.mjs'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { api } from '../src/renderer/src/lib/api'
import { createClientUiRoot } from './helpers/client-ui-render'
import { activityReadingProps } from './helpers/activity-reading-props'
import { desktopConversationReadBridge } from './helpers/conversation-read-bridge'

// Fixed source records qualify Desktop reading only, not capture production or input delivery.
// The real public Reader, RPC/IPC bridge, Activity, shared readers and Copy adapter stay mounted.
const context: BrowserInputContext = {
  kind: 'browser', version: 1, capturedAt: fixtureEpoch(1, 2),
  browser: { hostId: 'local', browserId: 'captured-browser', navigationId: 'captured-navigation' },
  page: { title: 'Captured review page', url: 'https://sample.invalid/review' },
  activity: { operationId: 'original-browser-operation', stepSequence: 4, phase: 'running', observedAt: fixtureEpoch(1, 2) }
}
const authored = composeAgentPrompt('Keep this complete amux example in the original body.', undefined,
  { ...context, page: { title: 'Literal authored example', url: 'https://literal.invalid/example' } }).text
const nativeBody = 'Read this original native request.'
const nativeWire = composeAgentPrompt(nativeBody, undefined, context).text
const closes: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  getSelection()?.removeAllRanges()
  try { for (const close of closes.splice(0).reverse()) await close() }
  finally { vi.restoreAllMocks(); vi.unstubAllGlobals() }
})

async function fixture() {
  const f = await nativeHistoryFixture('claude', jsonl([{ type: 'user', uuid: 'native-original', sessionId: 'native-main',
    message: { role: 'user', content: nativeWire } }]))
  const before = await f.bytes()
  closes.push(async () => {
    try {
      expect(f.controls.flatMap(control => control.mock.calls)).toEqual([])
      expect((await f.bytes()).native.equals(before.native)).toBe(true)
      const original = (await f.store.load()).find(session => session.agentSessionId === f.session.agentSessionId)
      expect(original).toMatchObject({ run: f.session.run, nativeHandle: f.session.nativeHandle })
    }
    finally { await f.close() }
  })
  for (const control of f.controls) control.mockImplementation(() => { throw Error('Reading must not control a Runtime') })
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.session.agentSessionId, item: {
    id: 'captured-original', agentSessionId: f.session.agentSessionId, kind: 'user_message', source: 'user', status: 'complete',
    title: 'Original captured input', content: authored, publicContent: 'confirmed', inputContext: context, inputContextSource: 'host-capture',
    createdAt: fixtureEpoch(1, 3), updatedAt: fixtureEpoch(1, 3)
  } })
  const read = vi.spyOn(f.client, 'readAgentConversation')
  await desktopConversationReadBridge(f, closes)
  const parse = vi.spyOn(messageRender, 'parseAgentMuxMessagePrefix')
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  const host = document.createElement('div'); document.body.append(host)
  const root = createClientUiRoot(host)
  closes.push(async () => { await act(async () => root.unmount()); host.remove() })
  await act(async () => root.render(<ActivityView {...activityReadingProps({
    control: { hostId: 'local', agentSessionId: f.session.agentSessionId, run: f.session.run }
  })} />))
  await vi.waitFor(async () => {
    await act(async () => {})
    expect(host.querySelector('[data-native-record-id="native-original"] .log-turn')).not.toBeNull()
    expect(host.querySelector('[data-submission-id="captured-original"] > .message-disclosure > summary')).not.toBeNull()
  }, { timeout: 8_000 })
  await act(async () => find(host, '[data-submission-id="captured-original"] > .message-disclosure > summary').click())
  await vi.waitFor(async () => { await act(async () => {}); expect(host.querySelectorAll('.log-turn')).toHaveLength(2) })
  expect(read).toHaveBeenCalled()
  return { host, read, parse, copy }
}
function find(parent: ParentNode, selector: string): HTMLElement {
  const element = parent.querySelector<HTMLElement>(selector)
  expect(element, `Actual mounted ${selector}`).not.toBeNull(); expect(element!.isConnected).toBe(true)
  return element!
}
async function assertUnknownAuthor(row: HTMLElement) {
  const record = row.closest<HTMLElement>('[data-conversation-author]') ?? row.querySelector<HTMLElement>('[data-conversation-author]')
  expect(record?.dataset.conversationAuthor).toBe(JSON.stringify({ kind: 'unknown' }))
  await act(async () => find(row, '[aria-label="Message details"]').click())
  const label = [...row.querySelectorAll('dt')].find(element => element.textContent === 'Recorded author')
  expect(label).toBeDefined(); expect(label!.nextElementSibling?.textContent).toContain('Not recorded')
  expect(label!.nextElementSibling?.textContent).not.toContain('human')
}

it('actual Activity captured consumer retains the Host observation and opaque confirmed body without guessing its author', async () => {
  const { host, copy, parse } = await fixture()
  const row = find(host, '[data-message-id="captured:captured-original"]')
  const observation = find(row, '.conversation-browser-context')
  expect(observation.dataset.browserContextSource).toBe('host-capture')
  expect(row.querySelectorAll('.conversation-browser-context')).toHaveLength(1)
  expect(observation.querySelector('summary')?.textContent).toContain('Browser capture')
  expect(observation.textContent).toContain('original-browser-operation')
  expect(observation.textContent).toContain('4 · running')
  expect(row.querySelector('.log-turn__text')?.textContent).toContain('<amux>')
  expect(row.querySelector('.log-turn__text')?.textContent).toContain('Literal authored example')
  expect(parse.mock.calls.some(([text]) => text === authored)).toBe(false)
  await assertUnknownAuthor(row)
  await act(async () => find(row, '[aria-label="Copy message"]').click())
  expect(copy).toHaveBeenCalledExactlyOnceWith(authored)
}, 15_000)

it('actual Activity native consumer keeps unknown wire on the shared Core parser and copies every original byte', async () => {
  const { host, copy, parse } = await fixture()
  const row = find(host, '[data-native-record-id="native-original"] .log-turn')
  const observation = find(row, '.conversation-browser-context')
  expect(observation.dataset.browserContextSource).toBe('caller-declared')
  expect(observation.querySelector('summary')?.textContent).toContain('Declared context')
  expect(parse).toHaveBeenCalledWith(nativeWire)
  expect(row.querySelector('.log-turn__text .md-paragraph')?.textContent).toBe(nativeBody)
  await assertUnknownAuthor(row)
  await act(async () => find(row, '[aria-label="Copy message"]').click())
  expect(copy).toHaveBeenCalledExactlyOnceWith(nativeWire)
}, 15_000)
