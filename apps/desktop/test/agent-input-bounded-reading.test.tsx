// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { appendFile } from 'node:fs/promises'
import type { AgentTimelineItem } from '@agentmux/core'
import { consumeConversationWindowPage } from '@agentmux/core/conversation'
import { nativeHistoryFixture, jsonl } from '../../../packages/core/test/fixtures/native-history-session'
import { fixtureEpoch } from '../../../test/fixture-values.mjs'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { desktopConversationReadBridge } from './helpers/conversation-read-bridge'
import { AgentInputRecap } from '../src/renderer/src/components/AgentInputRecap'
import type { AgentInformationPreview } from '../src/renderer/src/lib/agent-information-preview'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'

const wait = (check: () => void) => vi.waitFor(async () => {
  await act(async () => { await new Promise(done => setTimeout(done, 20)) }); check()
}, { timeout: 8000, interval: 20 })
const dom = composerDOM(), closes: Array<() => unknown | Promise<unknown>> = []
const native = (kind: 'user' | 'assistant', id: string, text: string) => ({ type: kind, uuid: id, sessionId: 'native-main',
  timestamp: new Date(fixtureEpoch(0, 0, 1)).toISOString(), message: { role: kind, content: text } })
let request: AgentInformationPreview, f: Awaited<ReturnType<typeof nativeHistoryFixture>>
const inputs = () => [...dom.container.querySelectorAll<HTMLElement>('[data-hover-input-id]')]
const render = (enabled = true) => dom.render(<AgentInputRecap request={request} enabled={enabled} available />)
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })
async function seed(source: 'native' | 'captured', tail: number, bodyBytes = 0) {
  const rows = [native('user', 'older-input', 'Original earlier request'), ...Array.from({ length: tail }, (_, i) => native('assistant', 'process-' + i, bodyBytes && source === 'native' ? 'x'.repeat(bodyBytes) : 'Recorded process ' + i))]
  f = await nativeHistoryFixture('claude', jsonl(source === 'native' ? rows : [])); closes.push(f.close)
  if (source === 'captured') for (let i = 0; i < rows.length; i++) {
    const item: AgentTimelineItem = { id: i ? 'captured-process-' + i : 'captured-input', agentSessionId: f.session.agentSessionId,
      kind: i ? 'assistant_message' : 'user_message', source: i ? 'native-hook' : 'user', status: 'complete', title: 'Original record',
      content: i ? bodyBytes ? 'x'.repeat(bodyBytes) : 'Recorded captured process ' + i : 'Original earlier request', createdAt: fixtureEpoch(0, 0, 1), updatedAt: fixtureEpoch(0, 0, 1) }
    await f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.session.agentSessionId, item })
  }
  const session = { ...composerSession(f.session.agentSessionId, 'claude'), control: { kind: 'agent' as const, hostId: 'local', agentSessionId: f.session.agentSessionId, run: f.session.run } }
  useAppStore.setState({ sessions: [session], timelines: {}, config: composerConfig, agentNames: {}, demands: {} })
  await desktopConversationReadBridge(f, closes)
  request = { token: {}, id: 'bounded-input-reader', control: session.control, anchor: document.createElement('button'), pinned: false,
    sourceKey: 'original-source', context: { kind: 'agent' } } as AgentInformationPreview
}
async function frames() {
  let assembly: Parameters<typeof consumeConversationWindowPage>[1]
  const result = []
  for (const call of vi.mocked(api.conversation.readAgentConversation).mock.results) {
    let page
    try { page = await call.value } catch { continue }
    const next = consumeConversationWindowPage(page, assembly)
    if (next.kind === 'pending') assembly = next.pending
    else { result.push(next.snapshot); assembly = undefined }
  }
  return result
}
it.each(['native', 'captured'] as const)('finds original %s inputs behind a long process tail through bounded original frames', async source => {
  await seed(source, 220); await render()
  await wait(() => { expect(inputs()).toHaveLength(1); expect(dom.container.textContent).not.toContain('Loading recent messages') })
  const accepted = await frames()
  expect(accepted).toHaveLength(3)
  expect(new Set(accepted.map(frame => frame.window.id)).size).toBe(1)
  expect(accepted.every(frame => !frame.window.navigation.newer && !frame.window.outside.newer)).toBe(true)
  expect(vi.mocked(api.conversation.readAgentConversation).mock.calls.filter(([input]) => input.preserveCurrent).length).toBeGreaterThanOrEqual(2)
  const original = inputs()[0]!
  await appendFile(f.path, jsonl([native('user', 'live-input', 'Current live request')]))
  await wait(() => expect(inputs()).toHaveLength(2))
  expect(inputs()[0]).toBe(original)
  expect((await frames())).toHaveLength(3)
  expect(f.controls.every(control => !control.mock.calls.length)).toBe(true)
})
it('reports the actual window boundary as partial coverage and keeps live input in the same accepted view', async () => {
  await seed('captured', 300, 110 * 1024); await render()
  await wait(() => expect(dom.container.querySelector('button[aria-label="Load earlier inputs"]')).not.toBeNull())
  const accepted = await frames()
  expect(accepted.length).toBeGreaterThan(0)
  expect(accepted.length).toBeLessThan(3)
  const outcomes = await Promise.allSettled(vi.mocked(api.conversation.readAgentConversation).mock.results.map(result => result.value))
  const failures = outcomes.flatMap(result => result.status === 'rejected' ? [result.reason as Error & { code?: string }] : [])
  expect(failures.map(error => error.code), JSON.stringify(failures.map(error => ({ code: error.code, message: error.message })))).toContain('AGENT_CONVERSATION_WINDOW_FULL')
  expect(inputs()).toHaveLength(0)
  expect(dom.container.textContent).toContain('No inputs in this range')
  expect(dom.container.textContent).not.toContain('unavailable')
  await appendFile(f.path, jsonl([native('user', 'live-after-boundary', 'Live input after the bounded expansion')]))
  await wait(() => expect(inputs()).toHaveLength(1))
  const changes = vi.mocked(api.conversation.readConversationChanges).mock.results
  const page = await changes.at(-1)!.value
  expect(page.window.id).toBe(accepted[0]!.window.id)
  expect((await frames())).toHaveLength(accepted.length)
  const original = inputs()[0]!
  vi.spyOn(f.client, 'readSessionHistoryChanges').mockRejectedValue(new Error('The original native source cannot be read'))
  await appendFile(f.path, jsonl([native('assistant', 'later-process', 'Later source observation')]))
  await wait(() => expect(dom.container.textContent).toContain('Recent message reading unavailable'))
  expect(inputs()[0]).toBe(original)
  expect(f.controls.every(control => !control.mock.calls.length)).toBe(true)
}, 30000)
it('stops hidden initial demand and never attaches a late older response or reads another source batch', async () => {
  await seed('native', 350)
  const read = vi.mocked(api.conversation.readAgentConversation).getMockImplementation()!
  let release!: () => void
  vi.mocked(api.conversation.readAgentConversation).mockImplementation(async (input, options) => {
    const page = await read(input, options)
    if (input.preserveCurrent && !release) await new Promise<void>(done => { release = done })
    return page
  })
  closes.push(() => release?.())
  await render()
  await wait(() => expect(release).toBeTypeOf('function'))
  await render(false)
  const reads = vi.mocked(api.conversation.readAgentConversation).mock.calls.length
  const observations = vi.mocked(api.conversation.observeConversation).mock.calls.length
  await act(async () => release())
  await act(async () => { await new Promise(done => setTimeout(done, 180)) })
  expect(api.conversation.readAgentConversation).toHaveBeenCalledTimes(reads)
  expect(api.conversation.observeConversation).toHaveBeenCalledTimes(observations)
  expect(inputs()).toHaveLength(0)
  expect(dom.container.querySelector('button[aria-label="Load earlier inputs"]')).toBeNull()
  expect(f.controls.every(control => !control.mock.calls.length)).toBe(true)
})
it('protects an accepted input during initial preloading, then settles its indicator without replacing selected original text', async () => {
  await seed('native', 220)
  await appendFile(f.path, jsonl([native('user', 'current-input', 'Keep this selected original input')]))
  const read = vi.mocked(api.conversation.readAgentConversation).getMockImplementation()!
  let release!: () => void
  vi.mocked(api.conversation.readAgentConversation).mockImplementation(async (input, options) => {
    const page = await read(input, options)
    if (input.preserveCurrent && !release) await new Promise<void>(done => { release = done })
    return page
  })
  closes.push(() => release?.())
  await render()
  await wait(() => { expect(inputs()).toHaveLength(1); expect(release).toBeTypeOf('function') })
  const original = inputs()[0]!, range = document.createRange()
  range.selectNodeContents(original.querySelector('p')!); document.getSelection()!.addRange(range)
  const selected = document.getSelection()!.toString()
  request = { ...request, pinned: true, bookmark: { key: 'protected-inputs', hostId: 'local', agentSessionId: f.session.agentSessionId,
    presentationId: f.session.agentSessionId, label: 'Original Agent', workspaceName: 'Project', bounds: { x: 0, y: 0, width: 400, height: 600 } } }
  await render(); await act(async () => release())
  await wait(() => expect(dom.container.textContent).toContain('Earlier inputs in History'))
  expect(dom.container.textContent).not.toContain('Loading recent messages')
  expect(inputs()).toEqual([original])
  expect(document.getSelection()!.getRangeAt(0)).toBe(range)
  expect(document.getSelection()!.toString()).toBe(selected)
  expect(dom.container.querySelector('button[aria-label="Load earlier inputs"]')).toBeNull()
  expect(api.conversation.releaseConversationView).not.toHaveBeenCalled()
  document.getSelection()!.removeAllRanges()
  expect(f.controls.every(control => !control.mock.calls.length)).toBe(true)
})
it('stops after three source batches, marks partial empty coverage and continues explicitly through the original reader', async () => {
  await seed('native', 350); await render()
  await wait(() => expect(dom.container.querySelector('button[aria-label="Load earlier inputs"]')).not.toBeNull())
  expect(inputs()).toHaveLength(0)
  expect(dom.container.textContent).toContain('No inputs in this range')
  expect((await frames())).toHaveLength(3)
  await appendFile(f.path, jsonl([native('assistant', 'live-process', 'More current progress')]))
  await wait(() => expect(api.conversation.readConversationChanges).toHaveBeenCalled())
  await act(async () => { await new Promise(done => setTimeout(done, 180)) })
  expect((await frames())).toHaveLength(3)
  await act(async () => dom.container.querySelector<HTMLButtonElement>('button[aria-label="Load earlier inputs"]')!.click())
  await wait(() => expect(inputs()).toHaveLength(1))
  const accepted = await frames()
  expect(accepted).toHaveLength(4)
  expect(new Set(accepted.map(frame => frame.window.id)).size).toBe(1)
  expect(vi.mocked(api.conversation.readAgentConversation).mock.calls.at(-1)![0].preserveCurrent).not.toBe(true)
  expect(f.controls.every(control => !control.mock.calls.length)).toBe(true)
})
