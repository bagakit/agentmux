// @vitest-environment happy-dom
import { fixtureEpoch as _privacyFixtureEpoch } from "../../../test/fixture-values.mjs"
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import type { AgentTimelineItem } from '@agentmux/core'
import { DurableAgentMuxMessageQueue } from '../../../packages/core/src/agent-global-message-queue'
import { normalizeStoredAgentSession } from '../../../packages/core/src/agent-session-store'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client'
import { nativeHistoryFixture, jsonl } from '../../../packages/core/test/fixtures/native-history-session'
import { desktopConversationReadBridge } from './helpers/conversation-read-bridge'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { mailboxInputMessages } from '../src/renderer/src/lib/session-mailbox-messages'

const dom = composerDOM(), closes: Array<() => unknown | Promise<unknown>> = []
let sequence = 0
const text = 'Keep this original request', nativeText = 'Native context\n' + text
const wait = (check: () => unknown) => vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) }); check() }, { timeout: 6000 })
beforeEach(() => vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', ''))
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.unstubAllEnvs() })
async function scene(withJournal = true, linked = true) {
  const f = await nativeHistoryFixture('claude', jsonl([{ type: 'user', uuid: 'native-original', sessionId: 'native-main',
    timestamp: new Date(_privacyFixtureEpoch(20454, 0)).toISOString(), message: { role: 'user', content: nativeText } }]), { agentSessionId: `input-group-${++sequence}` }); closes.push(f.close)
  const key = { kind: 'prompt' as const, agentSessionId: f.session.agentSessionId, expectedRun: f.session.run, submissionId: 'original-request' }
  const item: AgentTimelineItem = { id: 'captured-original', agentSessionId: key.agentSessionId, kind: 'user_message', source: 'user', status: 'complete',
    title: 'Original', content: text, createdAt: 1, updatedAt: 1, authorHuman: true, publicContent: 'confirmed', inputRef: key,
    ...(linked ? { conversation: { sameEvent: { hostId: 'local', agentSessionId: key.agentSessionId,
      source: { kind: 'native' as const, providerId: 'claude', nativeSessionId: 'native-main', recordId: 'native-original' } } } } : {}) }
  const persist = async (value = item) => Reflect.get(f.client, 'persistAndPublishTimeline').call(f.client,
    { type: 'upsert', agentSessionId: key.agentSessionId, item: value }, { source: 'agentmux', observedAt: 1 }, 'local')
  await persist()
  const queue = new DurableAgentMuxMessageQueue(f.client.agentMessageQueuePath())
  expect(f.client.agentMessageQueuePath()).toBe(join(f.root, 'global-messages.ndjson'))
  if (withJournal) await queue.recordInputSubmission(key, 1)
  await desktopConversationReadBridge(f, closes)
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(f.root, 'conversation.sock') } }); closes.push(() => rpc.dispose())
  const history = vi.spyOn(api.sessions, 'readHistory').mockImplementation((scope, input) => rpc.call('agent.history', { ...scope, ...input }))
  const mailbox = vi.spyOn(api.sessions, 'inputMailbox').mockImplementation(async (scope, input) => {
    const { limit, cursor, maxBytes } = input ?? {}
    const { hostId, ...page } = await rpc.call('agent.input.ls', { hostId: scope.hostId, agentSessionId: scope.agentSessionId,
      ...(limit === undefined ? {} : { limit }), ...(cursor === undefined ? {} : { cursor }), ...(maxBytes === undefined ? {} : { maxBytes }) })
    expect(hostId).toBe(scope.hostId)
    return page
  })
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  const submit = vi.spyOn(f.client, 'submitAgentPrompt'), rejoin = vi.spyOn(f.client, 'rejoinAgentInputWaiting')
  const session = { ...composerSession(f.session.agentSessionId, 'claude'), control: { kind: 'agent' as const, hostId: 'local', agentSessionId: key.agentSessionId, run: f.session.run }, nativeHandle: f.session.nativeHandle! }
  useAppStore.setState({ config: composerConfig, sessions: [session], timelines: {}, demands: {}, agentComposerDrafts: { [session.id]: 'Unsent draft' } })
  const render = () => dom.render(<AgentSessionComposer sessionId={session.id} reading={{ describeSpeaker: () => ({ name: 'You' }) }} />)
  await render()
  const panel = dom.container.querySelector<HTMLElement>('.composer-mailbox')!
  const event = new Event('toggle'); Object.defineProperty(event, 'newState', { value: 'open' })
  await act(async () => panel.dispatchEvent(event)); await dom.click('[role="tab"][id$="-user-tab"]')
  await wait(() => { expect(history).toHaveBeenCalled(); expect(mailbox).toHaveBeenCalled(); expect(rows(panel).length).toBeGreaterThan(0) })
  if (withJournal) await wait(() => expect(panel.querySelector('[data-input-mailbox-key]'), panel.textContent).not.toBeNull())
  return { ...f, key, item, persist, queue, copy, submit, rejoin, session, panel, render, history, mailbox }
}
const rows = (panel: HTMLElement) => panel.querySelectorAll('.composer-mailbox__messages > li')
const button = (element: ParentNode, label: string) => [...element.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label || item.getAttribute('aria-label') === label)!
const click = async (target: HTMLElement) => { expect(target).toBeTruthy(); await act(async () => target.click()) }
const expand = async (target: HTMLDetailsElement) => { expect(target).toBeTruthy(); await act(async () => { target.open = true; target.dispatchEvent(new Event('toggle')) }) }
async function search(panel: HTMLElement, query: string) {
  const input = panel.querySelector<HTMLInputElement>('input[type="search"]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, query); input.dispatchEvent(new Event('input', { bubbles: true })) })
  await click(button(panel, '查询当前 Agent 输入历史'))
}

it('actual Core RPC → Composer → Inputs shows one input, with original journal uncertainty and exact source actions', async () => {
  const f = await scene()
  await wait(() => expect(rows(f.panel)).toHaveLength(1))
  expect(f.panel.querySelectorAll('[data-input-mailbox-key]')).toHaveLength(1)
  const main = f.panel.querySelector<HTMLElement>('[data-input-mailbox-key]')!
  expect(main.textContent).toContain('You')
  expect(main.textContent).toContain(nativeText)
  await click(main.querySelector<HTMLElement>('[data-record-key]')!)
  await wait(() => expect(f.panel.querySelectorAll('.input-history__original')).toHaveLength(2))
  expect(f.panel.textContent).toContain('原输入身份与回执')
  const originals = [...f.panel.querySelectorAll<HTMLDetailsElement>('.input-history__original')]
  for (const original of originals) await expand(original)
  const native = originals.find(original => original.textContent?.includes('Native context'))!
  await click(button(native, '复制正文')); expect(f.copy).toHaveBeenLastCalledWith(nativeText)
  await click(button(native, '填入草稿')); expect(dom.draft(f.session.id)).toContain(nativeText)
  expect(f.submit).not.toHaveBeenCalled(); expect(f.rejoin).not.toHaveBeenCalled()
  expect(f.controls.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})

it('search retains a journal whose native contribution matches, without inserting nonmatching canonical history bodies', async () => {
  const f = await scene()
  await wait(() => expect(rows(f.panel)).toHaveLength(1))
  await search(f.panel, 'Native context')
  await wait(() => expect(f.history.mock.calls.some(([, input]) => input.query === 'Native context')).toBe(true))
  await wait(() => expect(rows(f.panel)).toHaveLength(1))
  const main = f.panel.querySelector<HTMLElement>('[data-input-mailbox-key]')!
  await click(main.querySelector<HTMLElement>('[data-record-key]')!)
  await wait(() => expect(f.panel.querySelectorAll('.input-history__original')).toHaveLength(1))
  await expand(f.panel.querySelector('.input-history__original')!)
  expect(f.panel.textContent).toContain('Native context'); expect(dom.draft(f.session.id)).toBe('Unsent draft')
  expect(f.submit).not.toHaveBeenCalled()
})

it('without a journal one confirmed primary retains both originals, and equal text with an independent key stays separate', async () => {
  const f = await scene(false)
  const page = await f.client.readAgentSessionHistory({ hostId: 'local', agentSessionId: f.session.id, source: 'native', kind: 'user-message' })
  const raw = page.userMessages![0]!
  const originalRef = { ...raw.sourceRecord!.record, hostId: 'original-host' }
  const message = { ...raw, sourceRecord: { ...raw.sourceRecord!, record: originalRef } }
  const group = { id: message.id, primary: message, messages: [message], mailbox: [], author: message.author }
  expect(mailboxInputMessages([group], 'route-host')[0]!.reference).toBe(originalRef)
  const { sourceRecord: _boundary, ...unqualified } = raw
  expect(mailboxInputMessages([{ ...group, primary: unqualified }])[0]!.reference).toBeNull()
  await wait(() => expect(rows(f.panel)).toHaveLength(1))
  expect(rows(f.panel)[0]!.textContent).toContain('You')
  await click(rows(f.panel)[0]!.querySelector<HTMLElement>('[data-record-key]')!)
  expect(f.panel.querySelectorAll('.input-history__original')).toHaveLength(1)
  await expand(f.panel.querySelector('.input-history__original')!)
  expect(f.panel.textContent).toContain(text)
  await click(button(f.panel, 'Back to Inputs'))
  const { conversation: _relation, ...original } = f.item
  await f.persist({ ...original, id: 'independent-original', inputRef: { ...f.key, submissionId: 'another-request' }, content: nativeText })
  await click(button(f.panel, 'Refresh inputs'))
  await wait(() => expect(rows(f.panel)).toHaveLength(2))
  expect(f.submit).not.toHaveBeenCalled()
})

it('late coalescence preserves the selected original DOM and reading range while its list collapses', async () => {
  const f = await scene(false, false)
  await wait(() => expect(rows(f.panel)).toHaveLength(2))
  const captured = [...rows(f.panel)].find(row => !row.textContent?.includes('Native context'))!
  await click(captured.querySelector<HTMLElement>('[data-record-key]')!)
  const body = f.panel.querySelector<HTMLElement>('.composer-mailbox__detail p')!
  const range = document.createRange(); range.selectNodeContents(body); window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range)
  await persistAndObserve(f, { ...f.item, conversation: { sameEvent: { hostId: 'local', agentSessionId: f.session.id,
    source: { kind: 'native', providerId: 'claude', nativeSessionId: 'native-main', recordId: 'native-original' } } }, updatedAt: 2 })
  // The old reading version cannot borrow the new revision's same-event proof.
  expect(f.panel.querySelectorAll('.input-history__original')).toHaveLength(0)
  expect(f.panel.querySelector('.composer-mailbox__detail p')).toBe(body)
  expect(body.textContent).toBe(text)
  expect(window.getSelection()!.getRangeAt(0)).toBe(range)
  window.getSelection()!.removeAllRanges()
  await click(button(f.panel, 'Back to Inputs'))
  await wait(() => expect(rows(f.panel)).toHaveLength(1)); expect(f.submit).not.toHaveBeenCalled()
})

it('an Agent journal conflicting with an exact Human original remains one unknown-author input', async () => {
  const f = await scene(false)
  await wait(() => expect(rows(f.panel)).toHaveLength(1))
  const stored = (await f.store.load()).map(normalizeStoredAgentSession).find(item => item.agentSessionId === f.key.agentSessionId)!
  const source = { providerId: 'claude', nativeSessionId: 'native-main' }
  const plan = { kind: 'native-rpc' as const, protocolId: 'original-protocol', actorId: 'original-actor',
    sourceId: JSON.stringify(['claude', 'native-main']), threadId: 'native-main', operation: 'start-or-steer' as const }
  const journalBody = 'Original Agent journal body'
  const admission: NonNullable<import('../../../packages/core/src/types').AgentPromptSubmissionRecord['admission']> = {
    submissionId: f.key.submissionId, operationId: f.key.submissionId, inputKey: f.key, transport: 'native', acknowledged: true,
    intent: { run: f.key.expectedRun, ownerInstanceId: 'original-owner', prompt: journalBody, plan, execution: 'immediate',
      message: { userContent: journalBody, authorAgentSessionId: 'original-sender' },
      admissionIntent: { kind: 'native-conversation', source, expectedRun: f.key.expectedRun } },
    native: { plan, outcome: 'admitted', turnId: 'original-turn' }
  }
  await f.store.compareAndSwap(stored, { ...stored, promptCompletionAdmission: admission })
  await f.queue.recordInputSubmission(f.key, 2)
  expect(await f.client.inspectAgentPromptSubmission(f.key)).toMatchObject({ admission: { intent: { message: { authorAgentSessionId: 'original-sender' } } } })
  expect((await f.client.readAgentInputMailbox({ agentSessionId: f.key.agentSessionId })).items).toMatchObject([
    { kind: 'item', item: { record: { admission: { intent: { message: { authorAgentSessionId: 'original-sender' } } } } } }
  ])
  await wait(() => expect(button(f.panel, 'Refresh inputs').disabled).toBe(false))
  await click(button(f.panel, 'Refresh inputs'))
  await wait(() => {
    expect(rows(f.panel)).toHaveLength(1)
    expect(f.panel.querySelector('[data-input-mailbox-key]')?.textContent).toContain('Author unknown')
  })
  const main = f.panel.querySelector<HTMLElement>('[data-input-mailbox-key]')!
  expect(main.textContent).toContain(journalBody)
  await click(main.querySelector<HTMLElement>('[data-record-key]')!)
  await wait(() => expect(f.panel.querySelectorAll('.input-history__original')).toHaveLength(2))
  await click(button(f.panel, 'Message details'))
  expect(f.panel.textContent).toContain('original-sender')
  const originals = [...f.panel.querySelectorAll<HTMLDetailsElement>('.input-history__original')]
  for (const original of originals) await expand(original)
  expect(f.panel.textContent).toContain(nativeText)
  const captured = originals.find(original => !original.textContent?.includes('Native context'))!
  expect(captured.textContent).toContain(text)
  await click(button(captured, '复制正文')); expect(f.copy).toHaveBeenLastCalledWith(text)
  const body = captured.querySelector('p')!
  const range = document.createRange(); range.selectNodeContents(body)
  window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range)
  const { authorHuman: _originalHuman, ...sameInput } = f.item
  await persistAndObserve(f, { ...sameInput, authorAgentSessionId: 'original-sender', content: 'Revised Agent contribution', updatedAt: 2 })
  expect(captured.isConnected).toBe(true); expect(captured.open).toBe(true)
  expect(captured.querySelector('p')).toBe(body); expect(body.textContent).toBe(text)
  expect(window.getSelection()!.getRangeAt(0)).toBe(range)
  await click(button(captured, '复制正文')); expect(f.copy).toHaveBeenLastCalledWith(text)
  await click(button(captured, '填入草稿')); expect(dom.draft(f.session.id)).toContain(text)
  expect(dom.draft(f.session.id)).not.toContain('Revised Agent contribution')
  window.getSelection()!.removeAllRanges()
  await click(button(f.panel, 'Back to Inputs'))
  await wait(() => expect(rows(f.panel)).toHaveLength(0))
  expect(f.submit).not.toHaveBeenCalled(); expect(f.rejoin).not.toHaveBeenCalled()
  expect(f.controls.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})

async function persistAndObserve(f: Awaited<ReturnType<typeof scene>>, item: AgentTimelineItem) {
  const changes = vi.mocked(api.conversation.readConversationChanges), before = changes.mock.calls.length
  await act(async () => { await f.persist(item) })
  await vi.waitFor(async () => {
    let seen = false
    await act(async () => {
      const pages: Awaited<ReturnType<typeof f.client.readConversationChanges>>[] = await Promise.all(changes.mock.results.slice(before).map(result => result.value))
      seen = pages.some(page => page.items.some(entry => entry.kind === 'item' && entry.item.records.some(record =>
        record.original.kind === 'captured' && record.original.item.id === item.id && record.original.item.updatedAt === item.updatedAt)))
    })
    expect(seen, 'The actual strict Renderer change response contains the new captured revision').toBe(true)
  }, { timeout: 6000 })
}

it('an opened original survives same-record body and author revisions until explicitly returning to the current list', async () => {
  const f = await scene(false, false)
  await wait(() => expect(rows(f.panel)).toHaveLength(2))
  const captured = [...rows(f.panel)].find(row => !row.textContent?.includes('Native context'))!
  await click(captured.querySelector<HTMLElement>('[data-record-key]')!)
  const body = f.panel.querySelector<HTMLElement>('.composer-mailbox__detail p')!
  const range = document.createRange(); range.selectNodeContents(body); window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range)
  const assertOriginal = () => {
    expect(f.panel.querySelector('.composer-mailbox__detail p')).toBe(body)
    expect(body.textContent).toBe(text)
    expect(window.getSelection()!.getRangeAt(0)).toBe(range)
    expect(f.panel.textContent).not.toContain('Revised original body')
  }
  await persistAndObserve(f, { ...f.item, content: 'Revised original body', updatedAt: 2 })
  assertOriginal()
  await click(button(f.panel, 'Copy message')); expect(f.copy).toHaveBeenLastCalledWith(text)
  const { authorHuman: _previousAuthor, ...original } = f.item
  await persistAndObserve(f, { ...original, content: 'Revised original body by Agent', authorAgentSessionId: 'new-recorded-author', updatedAt: 3 })
  assertOriginal()
  await click(button(f.panel, '填入草稿')); expect(dom.draft(f.session.id)).toContain(text)
  expect(dom.draft(f.session.id)).not.toContain('Revised original body')
  window.getSelection()!.removeAllRanges()
  await click(button(f.panel, 'Back to Inputs'))
  await wait(() => expect(rows(f.panel)).toHaveLength(1))
  expect(rows(f.panel)[0]!.textContent).toContain(nativeText)
  expect(f.submit).not.toHaveBeenCalled(); expect(f.rejoin).not.toHaveBeenCalled()
  expect(f.controls.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})

it('an expanded journal contribution preserves its original DOM, range and actions across revision and withdrawal until closed', async () => {
  const f = await scene()
  await wait(() => expect(rows(f.panel)).toHaveLength(1))
  await click(f.panel.querySelector<HTMLElement>('[data-input-mailbox-key] [data-record-key]')!)
  await wait(() => expect(f.panel.querySelectorAll('.input-history__original')).toHaveLength(2))
  const original = [...f.panel.querySelectorAll<HTMLDetailsElement>('.input-history__original')]
    .find(item => item.querySelector('summary')?.textContent?.includes('渠道未记录'))!
  await expand(original)
  const body = original.querySelector('p')!
  expect(body.textContent).toBe(text)
  const range = document.createRange(); range.selectNodeContents(body)
  window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range)
  const assertOriginal = () => {
    expect(original.isConnected).toBe(true); expect(original.open).toBe(true)
    expect(original.querySelector('p')).toBe(body); expect(body.textContent).toBe(text)
    expect(window.getSelection()!.getRangeAt(0)).toBe(range)
  }
  const revised = { ...f.item, content: 'Revised journal contribution', updatedAt: 2 }
  await persistAndObserve(f, revised)
  assertOriginal()
  const { conversation: _relation, ...unlinked } = revised
  await persistAndObserve(f, { ...unlinked, inputRef: { ...f.key, submissionId: 'independent-revision' }, updatedAt: 3 })
  await wait(() => expect(f.panel.querySelectorAll('.input-history__original')).toHaveLength(1))
  assertOriginal()
  await click(button(original, '复制正文')); expect(f.copy).toHaveBeenLastCalledWith(text)
  await click(button(original, '填入草稿')); expect(dom.draft(f.session.id)).toContain(text)
  expect(dom.draft(f.session.id)).not.toContain(revised.content)
  window.getSelection()!.removeAllRanges()
  await act(async () => { original.open = false; original.dispatchEvent(new Event('toggle')) })
  await wait(() => expect(f.panel.querySelectorAll('.input-history__original')).toHaveLength(0))
  await persistAndObserve(f, { ...revised, updatedAt: 4 })
  await wait(() => expect(f.panel.querySelectorAll('.input-history__original')).toHaveLength(2))
  const latest = [...f.panel.querySelectorAll<HTMLDetailsElement>('.input-history__original')]
    .find(item => item.querySelector('summary')?.textContent?.includes('渠道未记录'))!
  expect(latest.open).toBe(false)
  await expand(latest)
  expect(latest.querySelector('p')?.textContent).toBe(revised.content)
  await click(button(latest, '复制正文')); expect(f.copy).toHaveBeenLastCalledWith(revised.content)
  expect(f.submit).not.toHaveBeenCalled(); expect(f.rejoin).not.toHaveBeenCalled()
  expect(f.controls.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})
