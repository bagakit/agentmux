// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
import { createWorkspaceLayout } from '@agentmux/layout'
import { MAX_AGENT_PROMPT_BYTES } from '@agentmux/core/agent-prompt-budget'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { useAppStore, type AgentSteerQueueEntry } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const sessionId = 'agent-1'
const clock = 1_790_832_000_000
let dispose: (() => void) | undefined
beforeEach(() => useAppStore.setState({ agentSteerInFlight: {}, noticeReadReceipts: {},
  timelines: { [sessionId]: { agentSessionId: sessionId, revision: 0, items: [] } } }))
afterEach(() => { dispose?.(); dispose = undefined; vi.useRealTimers() })
const queue = () => useAppStore.getState().agentSteerQueues[sessionId]!
const texts = () => queue().map(entry => entry.text)
const rows = () => [...dom.container.querySelectorAll<HTMLLIElement>('.composer-outbox li')]
const rowTexts = () => rows().map(row => row.querySelector('span')?.textContent)
function pending(id: string, overrides: Partial<AgentSteerQueueEntry> = {}): AgentSteerQueueEntry {
  return { operationId: id, runId: `run-${sessionId}`, text: id, status: 'queued', ...overrides }
}
function gate() {
  let resolve!: () => void
  return { promise: new Promise<void>(done => { resolve = done }), resolve: () => resolve() }
}
async function openOutbox() {
  await dom.render(<AgentSessionComposer sessionId={sessionId} />)
  const mailbox = dom.container.querySelector('.composer-mailbox')!
  expect(mailbox).not.toBeNull()
  const event = new Event('toggle')
  Object.defineProperty(event, 'newState', { value: 'open' })
  await act(async () => mailbox.dispatchEvent(event))
  await dom.click('[role="tab"][id$="-outbox-tab"]')
}
function moveButton(text: string, direction: 'up' | 'down') {
  const row = rows().find(value => value.querySelector('span')?.textContent === text)
  expect(row, `Missing actual pending message ${text}`).toBeDefined()
  const button = [...row!.querySelectorAll<HTMLButtonElement>('button')]
    .find(value => value.textContent === `Move ${direction}`)
  expect(button, `Missing actual Move ${direction} action`).toBeDefined()
  return button!
}
async function move(text: string, direction: 'up' | 'down') {
  await act(async () => moveButton(text, direction).click())
}
async function initialize(processState: 'running' | 'exited' = 'running') {
  const session = { ...composerSession(), processState }
  const tab = createWorkbenchTab('queue-tab', { regionId: 'queue-region', kind: 'agent', phase: 'attached',
    workspaceId: 'workspace', sessionId })
  useAppStore.setState({ loading: true, restoredWorkbench: { tabs: { [tab.id]: tab },
    layouts: { workspace: createWorkspaceLayout('queue-group', [tab.id]) } } })
  vi.spyOn(api.config, 'get').mockResolvedValue(composerConfig)
  vi.spyOn(api.providers, 'list').mockResolvedValue([])
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [session], timelines: {}, recoveryCandidates: [] })
  dispose = await useAppStore.getState().initialize()
  expect(useAppStore.getState().loading).toBe(false)
  expect(useAppStore.getState().tabs['queue-tab']).toBeDefined()
}

it('records the actual first accepted time and creates no intent for refused admission', () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(clock)
  expect(useAppStore.getState().enqueueAgentSteer(sessionId, 'first')).toBe(true)
  now.mockReturnValue(clock + 90_000)
  expect(useAppStore.getState().enqueueAgentSteer(sessionId, 'second')).toBe(true)
  const admitted = queue()
  expect(admitted).toEqual([
    { operationId: expect.any(String), enqueuedAt: clock, runId: `run-${sessionId}`, text: 'first', status: 'queued' },
    { operationId: expect.any(String), enqueuedAt: clock + 90_000, runId: `run-${sessionId}`, text: 'second', status: 'queued' }
  ])
  expect(admitted[0]!.operationId).not.toBe(admitted[1]!.operationId)
  const rejected = vi.fn()
  expect(useAppStore.getState().enqueueAgentSteer(sessionId, ' ', rejected)).toBe(false)
  expect(useAppStore.getState().enqueueAgentSteer('missing', 'message', rejected)).toBe(false)
  expect(useAppStore.getState().enqueueAgentSteer(sessionId, 'x'.repeat(MAX_AGENT_PROMPT_BYTES + 1), rejected)).toBe(false)
  expect(queue()).toBe(admitted)
  expect(rejected).toHaveBeenCalledTimes(1)
})

it('uses the actual mailbox controls and shows immutable known time next to an unknown old intent', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(clock + 300_000)
  const first = pending('first', { enqueuedAt: clock }), old = pending('old'), last = pending('last', { enqueuedAt: clock + 90_000 })
  useAppStore.setState({ agentSteerQueues: { [sessionId]: [first, old, last] } })
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue()
  const recover = vi.spyOn(api.sessions, 'recover')
  await openOutbox()
  expect(rowTexts()).toEqual(['first', 'old', 'last'])
  expect(rows().map(row => row.querySelector('time')?.getAttribute('datetime') ?? null)).toEqual([
    new Date(clock).toISOString(), null, new Date(clock + 90_000).toISOString()
  ])
  expect(rows()[1]!.textContent).toContain('Queued time unknown')
  expect(moveButton('first', 'up').disabled).toBe(true)
  expect(moveButton('last', 'down').disabled).toBe(true)
  await move('last', 'up')
  expect(rowTexts()).toEqual(['first', 'last', 'old'])
  expect(queue()).toEqual([first, last, old])
  expect(queue()[1]).toBe(last)
  await move('first', 'down')
  expect(rowTexts()).toEqual(['last', 'first', 'old'])
  expect(rows().map(row => row.querySelector('time')?.getAttribute('datetime') ?? null)).toEqual([
    new Date(clock + 90_000).toISOString(), new Date(clock).toISOString(), null
  ])
  expect(submit).not.toHaveBeenCalled()
  expect(recover).not.toHaveBeenCalled()
  expect(dom.draft()).toBe('Keep my draft')
})

it.each([undefined, NaN, Infinity, -1, 9e15, 'not-a-time'])(
  'keeps absent or invalid recorded admission time honestly unknown: %s', async value => {
    const old = pending('old', value === undefined ? {} : { enqueuedAt: value as number })
    useAppStore.setState({ agentSteerQueues: { [sessionId]: [old] } })
    await openOutbox()
    expect(rowTexts()).toEqual(['old'])
    expect(rows()[0]!.textContent).toContain('Queued time unknown')
    expect(rows()[0]!.querySelector('time')).toBeNull()
    expect(queue()).toEqual([old])
  })

it('lets the real consumer read edited tails after acknowledgement without moving its in-flight head', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(clock)
  for (const text of ['head', 'second', 'last']) expect(useAppStore.getState().enqueueAgentSteer(sessionId, text)).toBe(true)
  const admitted = queue()
  const held = gate()
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockImplementationOnce(() => held.promise).mockResolvedValue()
  const drain = useAppStore.getState().flushAgentSteerQueue(sessionId)
  await Promise.resolve()
  expect(submit.mock.calls.map(call => call[1])).toEqual(['head'])
  await openOutbox()
  expect(rowTexts()).toEqual(['head', 'second', 'last'])
  expect(moveButton('head', 'down').disabled).toBe(true)
  expect(moveButton('second', 'up').disabled).toBe(true)
  await move('last', 'up')
  expect(queue()).toEqual([admitted[0], admitted[2], admitted[1]])
  expect(queue()[0]).toBe(admitted[0])
  useAppStore.getState().moveAgentSteer(sessionId, admitted[0]!.operationId, 'down')
  useAppStore.getState().moveAgentSteer(sessionId, admitted[2]!.operationId, 'up')
  expect(texts()).toEqual(['head', 'last', 'second'])
  await act(async () => { held.resolve(); await drain })
  expect(submit.mock.calls.map(call => [call[1], call[2]])).toEqual([
    ['head', admitted[0]!.operationId], ['last', admitted[2]!.operationId], ['second', admitted[1]!.operationId]
  ])
  expect(useAppStore.getState().agentSteerQueues[sessionId]).toBeUndefined()
})

it('fences the in-flight identity at any array position and leaves invalid moves inert', async () => {
  const old = pending('old-run', { runId: 'old-run' }), head = pending('head'), tail = pending('tail'), last = pending('last')
  useAppStore.setState({ agentSteerQueues: { [sessionId]: [old, head, tail, last] } })
  const held = gate()
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockImplementationOnce(() => held.promise).mockResolvedValue()
  const drain = useAppStore.getState().flushAgentSteerQueue(sessionId)
  await Promise.resolve()
  expect(useAppStore.getState().agentSteerInFlight[sessionId]).toBe('head')
  await openOutbox()
  expect(rowTexts()).toEqual(['old-run', 'head', 'tail', 'last'])
  expect(moveButton('old-run', 'down').disabled).toBe(true)
  expect(moveButton('head', 'up').disabled).toBe(true)
  expect(moveButton('head', 'down').disabled).toBe(true)
  expect(moveButton('tail', 'up').disabled).toBe(true)
  for (const [id, direction] of [['old-run', 'up'], ['old-run', 'down'], ['head', 'up'], ['head', 'down'], ['tail', 'up'], ['last', 'down'], ['gone', 'up']] as const) {
    useAppStore.getState().moveAgentSteer(sessionId, id, direction)
  }
  expect(queue()).toEqual([old, head, tail, last])
  await move('last', 'up')
  expect(queue()).toEqual([old, head, last, tail])
  await act(async () => { held.resolve(); await drain })
  expect(submit.mock.calls.map(call => call[1])).toEqual(['head', 'last', 'tail'])
  expect(queue()).toEqual([old])
})

it('reconciles actual completed neighbors before a real DOM move and never resurrects a stale target', async () => {
  const delivered = pending('delivered'), first = pending('first'), last = pending('last')
  useAppStore.setState({ agentSteerQueues: { [sessionId]: [delivered, first, last] }, timelines: {
    [sessionId]: { agentSessionId: sessionId, revision: 1, items: [{ id: 'prompt:delivered', agentSessionId: sessionId,
      kind: 'user_message', title: 'Prompt', content: delivered.text, status: 'complete', source: 'user', createdAt: 1, updatedAt: 1 }] }
  } })
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue()
  await openOutbox()
  expect(rowTexts()).toEqual(['first', 'last'])
  await move('last', 'up')
  expect(queue()).toEqual([last, first])
  expect(rowTexts()).toEqual(['last', 'first'])
  useAppStore.getState().moveAgentSteer(sessionId, delivered.operationId, 'down')
  expect(queue()).toEqual([last, first])
  expect(submit).not.toHaveBeenCalled()
})

it('reordering retained historical intent neither grants execution nor changes its Run binding or failure', async () => {
  const old = pending('old', { runId: 'previous-run', status: 'deferred', error: 'Unknown delivery', errorCode: 'AGENT_EXECUTION_NOT_REQUESTED' })
  const unbound = pending('unbound', { status: 'restoring', error: 'Queued before restart', errorCode: 'AGENT_EXECUTION_NOT_REQUESTED' })
  delete unbound.runId
  const current = pending('current', { enqueuedAt: clock, status: 'deferred', error: 'Queued before restart', errorCode: 'AGENT_EXECUTION_NOT_REQUESTED' })
  useAppStore.setState({ agentSteerQueues: { [sessionId]: [old, unbound, current] } })
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue()
  const recover = vi.spyOn(api.sessions, 'recover')
  const drain = vi.spyOn(useAppStore.getState(), 'flushAgentSteerQueue')
  await openOutbox()
  await move('current', 'up')
  expect(queue()).toEqual([old, current, unbound])
  expect(submit).not.toHaveBeenCalled()
  expect(recover).not.toHaveBeenCalled()
  expect(drain).not.toHaveBeenCalled()
  await act(async () => { await useAppStore.getState().flushAgentSteerQueue(sessionId) })
  expect(queue()).toEqual([old, current, unbound])
  expect(submit).not.toHaveBeenCalled()
  expect(recover).not.toHaveBeenCalled()
})

it('retains the first time when an actual refusal is retried at a later clock', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(clock)
  expect(useAppStore.getState().enqueueAgentSteer(sessionId, 'retry')).toBe(true)
  const admitted = queue()[0]!
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockRejectedValueOnce(new Error('busy')).mockRejectedValueOnce(new Error('busy again'))
  await useAppStore.getState().flushAgentSteerQueue(sessionId)
  now.mockReturnValue(clock + 180_000)
  await useAppStore.getState().sendQueuedAgentSteer(sessionId, admitted.operationId)
  expect(queue()).toEqual([{ ...admitted, status: 'deferred', error: 'busy again' }])
  expect(submit.mock.calls.map(call => call[2])).toEqual([admitted.operationId, admitted.operationId])
  expect(queue()[0]!.enqueuedAt).toBe(clock)
})

it('preserves first admission time through real restoration, once-only binding and a delivery refusal', async () => {
  await initialize('exited')
  const now = vi.spyOn(Date, 'now').mockReturnValue(clock)
  expect(useAppStore.getState().enqueueAgentSteer(sessionId, 'restore')).toBe(true)
  const admitted = queue()[0]!
  expect(admitted.runId).toBeUndefined()
  const revived = { ...composerSession(), control: { ...composerSession().control, run: { runId: 'revived-run' } } }
  const recover = vi.spyOn(api.sessions, 'recover').mockResolvedValue({ kind: 'resumed', session: revived })
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue()
  vi.spyOn(api.sessions, 'submitPrompt').mockRejectedValue(new Error('busy after restoration'))
  now.mockReturnValue(clock + 180_000)
  await useAppStore.getState().flushAgentSteerQueue(sessionId)
  expect(queue()).toEqual([{ ...admitted, runId: 'revived-run', status: 'deferred', error: 'busy after restoration' }])
  expect(recover).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ agentSessionId: sessionId }), '/repo', admitted.operationId)
})

it('writes moved order and recorded or unknown time through the existing persistence owner and hydration', async () => {
  vi.useFakeTimers()
  window.localStorage.removeItem('agentmux-workbench-v1')
  await initialize()
  vi.setSystemTime(clock)
  expect(useAppStore.getState().enqueueAgentSteer(sessionId, 'first')).toBe(true)
  const first = queue()[0]!
  vi.setSystemTime(clock + 90_000)
  expect(useAppStore.getState().enqueueAgentSteer(sessionId, 'last')).toBe(true)
  const last = queue()[1]!, old = pending('old')
  useAppStore.setState({ agentSteerQueues: { [sessionId]: [first, old, last] } })
  useAppStore.getState().moveAgentSteer(sessionId, last.operationId, 'up')
  await vi.advanceTimersByTimeAsync(450)
  const serialized = window.localStorage.getItem('agentmux-workbench-v1')
  expect(serialized).toBeTypeOf('string')
  const durable = JSON.parse(serialized!)
  expect(durable.state.agentSteerQueues[sessionId]).toEqual([first, last, old])
  expect(durable.version).toBe(1)
  useAppStore.setState({ agentSteerQueues: {} })
  await useAppStore.persist.rehydrate()
  expect(queue()).toEqual([first, last, old])
  expect(queue()[2]!.enqueuedAt).toBeUndefined()
})
