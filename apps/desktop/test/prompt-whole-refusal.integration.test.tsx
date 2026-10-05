// @vitest-environment happy-dom
import { act } from 'react'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { useAppStore, type AgentSteerQueueEntry } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'

// Real first-party Card, Outbox and durable queue; only the public Core boundary
// supplies finite Session facts/receipts. Core finality itself has Native-boundary tests.
const dom = composerDOM(), sid = 'agent-1', operationId = 'wholly-refused'
const body = 'Original refused body\nKeep every byte.'
const condition = { expectedRun: { runId: 'run-agent-1' }, afterSubmissionId: 'old-predecessor' }
const draft = 'Independent newer draft'
const entry = (): AgentSteerQueueEntry => ({ operationId, runId: condition.expectedRun.runId,
  promptCondition: structuredClone(condition), text: body, execution: 'immediate', origin: 'manual',
  sourceChannel: 'message-tool', agentMuxNote: 'Original producer context',
  status: 'deferred', awaitingExplicitSend: true, error: 'Original whole refusal',
  errorCode: 'AGENT_PROMPT_INPUT_UNCONFIRMED', logId: 'original-log', enqueuedAt: 42 })
const queue = () => useAppStore.getState().agentSteerQueues[sid] ?? []
let dispose: (() => void) | undefined
beforeAll(async () => { dispose = await useAppStore.getState().initialize() })
afterAll(() => dispose?.())
beforeEach(() => {
  localStorage.clear()
  const session = composerSession()
  session.capabilities.promptExecution = { immediate: 'interrupt-before-input' }
  Object.assign(session, { promptInputNotApplied: { submissionId: operationId, run: session.control.run } })
  useAppStore.setState({ sessions: [session], agentSteerQueues: { [sid]: [entry(),
    { ...entry(), operationId: 'neighbor', text: 'Neighbor', promptCondition: null }] },
    agentSteerInFlight: {}, agentSteerInFlightPhase: {}, agentComposerDrafts: { [sid]: draft },
    runtimeEndpointWarnings: [], timelines: { [sid]: { agentSessionId: sid, revision: 0, items: [] } } })
  vi.spyOn(api.sessions, 'refresh').mockResolvedValue({ ...session, promptSubmissionPredecessor: operationId })
})
async function sendCard() {
  await dom.render(<AgentSessionComposer sessionId={sid} />)
  const card = document.querySelector(`.composer-pending__card[data-operation-id="${operationId}"]`)!
  const button = [...card.querySelectorAll('button')].find(item => item.getAttribute('aria-label') === '立即发送这条待发消息')!
  expect(button).toBeDefined()
  await act(async () => { button.click() })
}

it('explicit Send preserves the exact refused record and uses a fresh input identity, without sending neighbors or the editor draft', async () => {
  const original = structuredClone(queue()[0]), neighbor = structuredClone(queue()[1])
  let persistedAtInput: AgentSteerQueueEntry[] | undefined
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockImplementation(async () => {
    persistedAtInput = structuredClone(queue())
    const persisted = JSON.parse(localStorage.getItem('agentmux-workbench-v1')!).state.agentSteerQueues[sid]
    expect(persisted).toEqual(persistedAtInput)
  })
  await sendCard()
  await act(async () => { await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce()) })
  const call = submit.mock.calls[0]!
  expect(call[2]).not.toBe(operationId)
  expect(call.slice(0, 2)).toEqual([composerSession().control, body])
  expect(call[3]).toEqual({ expectedRun: condition.expectedRun, afterSubmissionId: operationId })
  expect(call[4]).toEqual({ allowUncertainTurn: true, execution: 'immediate' })
  expect(call.slice(5, 8)).toEqual([true, original!.agentMuxNote, 'message-tool'])
  expect(persistedAtInput?.map(item => item.operationId)).toEqual([operationId, call[2], 'neighbor'])
  expect(persistedAtInput?.[1]).toMatchObject({ text: body, origin: 'manual', execution: 'immediate', sourceChannel: 'message-tool' })
  expect(persistedAtInput?.[1].logId).toBeUndefined()
  expect(queue()).toEqual([{ ...original, archived: true }, neighbor])
  expect(dom.draft()).toBe(draft)
})

it.each(['different-operation', 'different-run', 'missing-condition'] as const)('keeps the original unknown request for %s instead of inventing new input', async kind => {
  const session = useAppStore.getState().sessions[0]!
  if (kind === 'different-operation') Object.assign(session, { promptInputNotApplied: { submissionId: 'someone-else', run: condition.expectedRun } })
  if (kind === 'different-run') Object.assign(session, { promptInputNotApplied: { submissionId: operationId, run: { runId: 'old-run' } } })
  if (kind === 'missing-condition') useAppStore.setState({ agentSteerQueues: { [sid]: [{ ...entry(), promptCondition: undefined }] } })
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue()
  await sendCard()
  await act(async () => { await vi.waitFor(() => {
    if (kind === 'missing-condition') expect(queue()[0]?.logId).not.toBe('original-log')
    else expect(submit).toHaveBeenCalledOnce()
  }) })
  if (kind === 'missing-condition') expect(submit).not.toHaveBeenCalled()
  else expect(submit.mock.calls[0]![2]).toBe(operationId)
  expect(dom.draft()).toBe(draft)
})

it('keeps Goal business identity and directs a new business input to its owner', async () => {
  const original = { ...entry(), goalContinuation: { goalId: 'goal-original', loopId: 'loop-original', condition } }
  useAppStore.setState({ agentSteerQueues: { [sid]: [original] } })
  const refusal = Object.assign(new Error('The whole original operation was not applied.'), { code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' })
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockRejectedValue(refusal)
  await expect(useAppStore.getState().resendRefusedAgentSteer(sid, operationId)).rejects.toThrow('Goal')
  expect(submit.mock.calls[0]![2]).toBe(operationId)
  expect(queue()).toHaveLength(1)
  expect(queue()[0]).toMatchObject({ operationId, text: body, promptCondition: condition, goalContinuation: original.goalContinuation })
  expect(queue()[0]?.archived).toBeUndefined()
  expect(dom.draft()).toBe(draft)
})

it('keeps public pending.send on the exact original identity rather than claiming an unseen new delivery', async () => {
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockRejectedValue(Object.assign(new Error('Stable whole refusal'), { code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' }))
  await expect(useAppStore.getState().executeControl({ operation: 'message.pending.send', agentSessionId: sid, pendingId: operationId } as never)).rejects.toThrow('Stable whole refusal')
  expect(submit.mock.calls[0]![2]).toBe(operationId)
  expect(queue()[0]?.archived).toBeUndefined()
  expect(queue().map(item => item.operationId)).toEqual([operationId, 'neighbor'])
})

it('keeps a failed fresh resend on its new identity while retaining every old refusal fact', async () => {
  const original = structuredClone(queue()[0])
  vi.spyOn(api.sessions, 'submitPrompt').mockRejectedValue(new Error('New attempt failed'))
  await expect(useAppStore.getState().resendRefusedAgentSteer(sid, operationId)).rejects.toThrow('New attempt failed')
  expect(queue()[0]).toEqual({ ...original, archived: true })
  expect(queue()[1]).toMatchObject({ text: body, awaitingExplicitSend: true })
  expect(queue()[1]?.operationId).not.toBe(operationId)
  expect(queue()[1]?.logId).toBeDefined()
  expect(queue()[1]?.logId).not.toBe('original-log')
  expect(dom.draft()).toBe(draft)
})

it('refuses a late second action on the archived original without changing its refusal or creating another input', async () => {
  const original = structuredClone(queue()[0])
  let resolve!: () => void
  const pending = new Promise<void>(done => { resolve = done })
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockReturnValue(pending)
  const first = useAppStore.getState().resendRefusedAgentSteer(sid, operationId)
  try {
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce())
    const newOperationId = submit.mock.calls[0]![2]
    await expect(useAppStore.getState().resendRefusedAgentSteer(sid, operationId)).rejects.toThrow('archived')
    expect(queue()[0]).toEqual({ ...original, archived: true })
    expect(queue().map(item => item.operationId)).toEqual([operationId, newOperationId, 'neighbor'])
    expect(submit).toHaveBeenCalledOnce()
  } finally { resolve(); await first }
  expect(queue()[0]).toEqual({ ...original, archived: true })
})
