// @vitest-environment happy-dom
import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryItem, AgentSessionUserMessage, AgentTimelineItem } from '@agentmux/core'
import { projectConversationReading, type ConversationInputEntity } from '@agentmux/core/conversation'
import { projectSessionUserMessages } from '@agentmux/core/session-user-messages'
import type { AgentSessionControl } from '../src/shared/contracts'
import { userInputHistoryMessages } from '../src/renderer/src/lib/user-input-history'
import { useComposerInputHistory } from '../src/renderer/src/lib/use-composer-input-history'

const runtime = vi.hoisted(() => ({ read: vi.fn(), native: { messages: [] as ConversationInputEntity[], sourceMessages: [] as AgentSessionUserMessage[], loading: false } }))
vi.mock('../src/renderer/src/lib/session-user-messages', () => ({ useSessionUserMessages: () => runtime.native }))
vi.mock('../src/renderer/src/store', () => ({ useAppStore: (selector: (state: unknown) => unknown) => selector({ agentComposerHistory: {} }) }))
vi.mock('../src/renderer/src/lib/api', () => ({ api: { sessions: { readHistory: (...args: unknown[]) => runtime.read(...args) }, ui: { writeClipboardText: vi.fn() } } }))

const scope = { hostId: 'route', agentSessionId: 'recipient' }, sourceHostId = 'original-host'
function fixture(id = 'original-native') {
  const source = { providerId: 'codex', nativeSessionId: 'original-thread' }
  const captured: AgentTimelineItem = { id: 'captured-' + id, agentSessionId: scope.agentSessionId, kind: 'user_message', source: 'user',
    status: 'complete', title: 'Original input', content: 'Original needle body 中🙂', authorAgentSessionId: 'sender', createdAt: _tailFixtureEpoch(0, 0, 1), updatedAt: _tailFixtureEpoch(0, 0, 1),
    conversation: { sameEvent: { hostId: sourceHostId, agentSessionId: scope.agentSessionId, source: { kind: 'native', ...source, recordId: id } } } }
  const native: AgentSessionHistoryItem = { id, kind: 'user-message', title: 'Original input', contentParts: [{ kind: 'text', text: captured.content! }] }
  const historyPage = { agentSessionId: scope.agentSessionId, sourceHostId, source, items: [native], nextCursor: null }
  const reading = projectConversationReading({ agentSessionId: scope.agentSessionId, executionHostId: sourceHostId, routeHostId: scope.hostId, historyPage,
    timeline: { agentSessionId: scope.agentSessionId, sourceHostId, revision: 1, items: [captured] } })
  expect(reading.inputs).toHaveLength(1)
  const entity = reading.inputs[0]!, record = entity.records.find(record => record.original.kind === 'native')!
  expect(entity.event.author).toEqual({ kind: 'agent', agentSessionId: 'sender' })
  const raw: AgentSessionUserMessage = { ...projectSessionUserMessages({ agentSessionId: scope.agentSessionId, historyPage })[0]!,
    sourceRecord: { record: record.reference!, revision: record.revision } }
  expect(raw.author).toEqual({ kind: 'unknown' })
  return { raw, entity }
}

it('excludes only an exact accepted Agent source version while retaining the raw record untouched', () => {
  const { raw, entity } = fixture(), before = structuredClone(raw)
  expect(userInputHistoryMessages([raw], [entity], scope)).toEqual([])
  expect(raw).toEqual(before)
  expect(userInputHistoryMessages([raw], [], scope)[0]).toBe(raw)
})

it.each(['route', 'session', 'original-host', 'native-source', 'version', 'missing-version'] as const)('keeps an unknown original across a %s mismatch', mismatch => {
  const { raw, entity } = fixture()
  if (mismatch === 'route') entity.hostId = 'different-route'
  if (mismatch === 'session') entity.agentSessionId = 'different-session'
  if (mismatch === 'original-host') raw.sourceRecord = { ...raw.sourceRecord!, record: { ...raw.sourceRecord!.record, hostId: 'different-original' } }
  if (mismatch === 'native-source') {
    if (raw.source.kind !== 'native') throw new Error('This fixture is a native source')
    const source = { ...raw.source, nativeSessionId: 'different-thread' }
    raw.source = source
    raw.sourceRecord = { ...raw.sourceRecord!, record: { ...raw.sourceRecord!.record, source } }
  }
  if (mismatch === 'version') raw.sourceRecord = { ...raw.sourceRecord!, revision: '0'.repeat(64) }
  if (mismatch === 'missing-version') delete raw.sourceRecord
  expect(userInputHistoryMessages([raw], [entity], scope)[0]).toBe(raw)
})

it('retains equal bodies with another record and rejects mismatched reference metadata', () => {
  const { raw, entity } = fixture(), other = fixture('different-native').raw
  expect(other.content).toBe(raw.content)
  expect(userInputHistoryMessages([other], [entity], scope)[0]).toBe(other)
  const stale = { ...other, sourceRecord: raw.sourceRecord }
  expect(userInputHistoryMessages([stale], [entity], scope)[0]).toBe(stale)
})

it('does not turn a current unknown or withdrawn membership into an Agent classification', () => {
  const { raw, entity } = fixture()
  const unknown = { ...entity, author: { kind: 'unknown' as const }, event: { ...entity.event, author: { kind: 'unknown' as const } } }
  expect(userInputHistoryMessages([raw], [unknown], scope)[0]).toBe(raw)
  const withdrawn = { ...entity, records: entity.records.filter(record => record.original.kind !== 'native') }
  expect(userInputHistoryMessages([raw], [withdrawn], scope)[0]).toBe(raw)
})

let root: Root | undefined, container: HTMLDivElement
let current: ReturnType<typeof useComposerInputHistory>
const renderedLoading: boolean[] = []
const control = { ...scope, run: { runId: 'original-run' } } as AgentSessionControl
const insertion = { current: null }
function Probe() {
  current = useComposerInputHistory({ sessionId: scope.agentSessionId, control, visible: true, readOnly: false, insertion })
  renderedLoading.push(current.history.loading)
  return <div>{current.history.messages.map(message => message.content).join('|')}</div>
}
const wait = async (check: () => void) => vi.waitFor(async () => { await act(async () => { await Promise.resolve() }); check() })
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); runtime.native.messages = []; runtime.native.sourceMessages = []; runtime.native.loading = false; runtime.read.mockReset() })
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; container?.remove(); vi.unstubAllGlobals() })

it('reports a newly enabled original read as busy before passive effects can make an empty page look settled', async () => {
  const pending: Array<() => void> = []
  runtime.read.mockImplementation((_reference, input) => new Promise(resolve => pending.push(() => resolve({ ...scope, sourceHostId,
    source: input.source, kind: 'user-message', items: [], userMessages: [], scan: { examined: 0, complete: true }, nextCursor: null }))))
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => root!.render(<Probe />))
  renderedLoading.length = 0
  await act(async () => current.setMailboxOpen(true))
  expect(renderedLoading[0]).toBe(true)
  expect(current.history.loading).toBe(true)
  expect(pending).toHaveLength(2)
  await act(async () => pending.forEach(resolve => resolve()))
  await wait(() => { expect(current.history.loading).toBe(false); expect(current.history.complete).toBe(true) })
})

it('the mounted history consumer filters nonempty search and later pages without changing original query coverage or arrow entries', async () => {
  const first = fixture('first'), later = fixture('later'), unknown = fixture('unknown').raw
  runtime.native.messages = [first.entity, later.entity]
  runtime.read.mockImplementation(async (_reference, input) => ({ ...scope, sourceHostId, source: input.source, kind: 'user-message', items: [],
    userMessages: input.source === 'captured' ? [] : input.cursor ? [later.raw, unknown] : [first.raw],
    scan: { examined: input.cursor ? 2 : 1, complete: input.source === 'captured' || Boolean(input.cursor) },
    nextCursor: input.source === 'captured' || input.cursor ? null : 'original-query-next' }))
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => root!.render(<Probe />))
  await act(async () => current.setMailboxOpen(true))
  await wait(() => expect(current.history.loading).toBe(false))
  await act(async () => current.history.search('needle'))
  await wait(() => { expect(current.history.query).toBe('needle'); expect(current.history.loading).toBe(false) })
  expect(current.history.messages).toEqual([])
  expect(current.history.pages.find(page => page.source === 'native')!.messages[0]).toBe(first.raw)
  await act(async () => current.history.loadMore('native'))
  await wait(() => { expect(current.history.complete).toBe(true); expect(current.history.messages).toEqual([unknown]) })
  expect(current.entries).toEqual([unknown.content])
  expect(current.history.pages.find(page => page.source === 'native')).toMatchObject({ examined: 3, cursor: null, messages: [first.raw, later.raw, unknown] })
  runtime.native.messages = []
  await act(async () => root!.render(<Probe />))
  expect(current.history.messages).toEqual([first.raw, later.raw, unknown])
  expect(first.raw.author).toEqual({ kind: 'unknown' })
})
