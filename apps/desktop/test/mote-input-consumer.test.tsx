import { sendConversationQuestionReply } from '../src/renderer/src/lib/conversation-question'
import { AgentInteractionCard } from '@agentmux/client-ui/components/AgentInteractionCard'
// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createMoteApp, moteClick, moteType, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { neighborAgent, neighborTab, ordinaryAgent, ordinaryTab } from './fixtures/mote-workface'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { requestPmoTeamsTopicFloatingOpen } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { moteInputSource } from '../src/renderer/src/lib/mote-input-source'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { promptCarrierWaiting } from './helpers/prompt-carrier-receipt'
import { MoteInputReceipt } from '../src/renderer/src/components/MoteInputReceipt'

const send = useAppStore.getState().send, enqueue = useAppStore.getState().enqueueAgentSteer, initialize = useAppStore.getState().initialize
let app: MoteAppFixture
const origin = { workspaceId: SCRATCH_WORKSPACE_ID, tabGroupId: 'mote-group', tabId: neighborTab.id, regionId: neighborTab.layout.activeRegionId }
beforeEach(() => { app = createMoteApp(); useAppStore.setState({ send, enqueueAgentSteer: enqueue }) })
afterEach(async () => { await app.dispose() })

it('the real member Composer freezes its exact source in the original Store input and public submission', async () => {
  vi.spyOn(api.continuousProgress, 'pauseForInput').mockResolvedValue(undefined)
  vi.spyOn(api.sessions, 'inspectInput').mockResolvedValue(null)
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockImplementation(async (control, _body, id) => ({
    ...promptCarrierWaiting(control.agentSessionId, control.run.runId, id), moteObservationId: 'original-member-observation'
  }))
  const expected = moteInputSource(neighborAgent.id, origin)
  expect(expected).toMatchObject({ tabId: neighborTab.id, regionId: neighborTab.layout.activeRegionId })
  await app.mount()
  await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTabId: neighborTab.id, reference: { displayWorkspaceId: SCRATCH_WORKSPACE_ID, groupId: 'mote-group', tabId: neighborTab.id, regionId: neighborTab.layout.activeRegionId } }))
  await settleMoteApp()
  const input = app.panel().querySelector<HTMLElement>('[aria-label="Message Agent"]')!
  expect(input).not.toBeNull(); await moteType(input, 'Change the threshold to 12, preserve the earlier scope')
  const button = [...app.panel().querySelectorAll<HTMLButtonElement>('button')].find(button => button.getAttribute('aria-label') === 'Send' || button.getAttribute('title') === 'Send')
  expect(button).toBeDefined(); await moteClick(button!)
  await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
  expect(submit.mock.calls[0]![4]).toMatchObject({ moteSource: expected })
  expect(submit.mock.calls[0]![6]).toContain('amux mote --skill')
  expect(submit.mock.calls[0]![1]).toBe('Change the threshold to 12, preserve the earlier scope')
  const saved = useAppStore.persist.getOptions().partialize!(useAppStore.getState()).agentSteerQueues![neighborAgent.id]![0]!
  expect(saved.moteSource).toEqual(expected)
  expect(saved.inputReceipt?.moteObservationId).toBe('original-member-observation')
  expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})

it('a copied Session in an unrelated workface does not borrow Mote membership from a global selection', () => {
  expect(moteInputSource(ordinaryAgent.id, { ...origin, tabId: ordinaryTab.id, regionId: ordinaryTab.layout.activeRegionId })).toBeUndefined()
  expect(moteInputSource(neighborAgent.id, { ...origin, regionId: 'another-region' })).toBeUndefined()
  expect(moteInputSource(neighborAgent.id, undefined)).toBeUndefined()
})

it('an original observation is read only on demand, and an unavailable read never sends input', async () => {
  const inspect = vi.spyOn(api.sessions, 'inspectMoteInput').mockRejectedValue(new Error('Original observation unavailable'))
  const reference = { hostId: 'original-remote-host', agentSessionId: neighborAgent.id }
  await app.mount(<MoteInputReceipt reference={reference} observationId="original-observation" />)
  expect(inspect).not.toHaveBeenCalled()
  const details = app.container.querySelector<HTMLDetailsElement>('.mote-input-receipt')!
  await act(async () => { details.open = true })
  await vi.waitFor(() => expect(inspect).toHaveBeenCalledTimes(1))
  expect(inspect).toHaveBeenCalledWith(reference, 'original-observation')
  expect(details.textContent).toContain('could not be confirmed')
  expect(useAppStore.getState().agentSteerQueues).toEqual({})
  await moteClick(details.querySelector('button')!)
  expect(inspect).toHaveBeenCalledTimes(2)
})

it('reusing an original queued operation preserves its source and discovery note, while a changed source cannot retarget it', () => {
  vi.spyOn(api.continuousProgress, 'pauseForInput').mockResolvedValue(undefined)
  const source = moteInputSource(neighborAgent.id, origin)!, reject = vi.fn()
  expect(enqueue(neighborAgent.id, 'Original revision', reject, 'original-operation', 'manual', 'Existing note', { moteSource: source })).toBe(true)
  expect(enqueue(neighborAgent.id, 'Original revision', reject, 'original-operation', 'manual', 'Existing note', { moteSource: source })).toBe(true)
  const original = useAppStore.getState().agentSteerQueues[neighborAgent.id]![0]!
  expect(original.agentMuxNote).toContain('Existing note')
  expect(original.agentMuxNote?.match(/amux mote --skill/g)).toHaveLength(1)
  expect(enqueue(neighborAgent.id, 'Original revision', reject, 'original-operation', 'manual', 'Existing note', { moteSource: { ...source, regionId: 'different-original-region' } })).toBe(false)
  expect(useAppStore.getState().agentSteerQueues[neighborAgent.id]).toEqual([original])
  expect(reject).toHaveBeenCalledTimes(1)
})

it('a typed permission retry keeps the source captured with its original operation', async () => {
  let source = moteInputSource(neighborAgent.id, origin)!
  const getSource = vi.fn(() => source), respond = vi.fn().mockRejectedValueOnce(new Error('Original reply is unconfirmed')).mockResolvedValue(undefined)
  await app.mount(<AgentInteractionCard request={{ kind: 'permission', id: 'permission-1', agentSessionId: neighborAgent.id,
    title: 'Original permission', options: [{ id: 'allow', label: 'Allow once', kind: 'allow-once' }],
    evidence: { source: 'native-hook', observedAt: 1, run: neighborAgent.control.run, hookReceiptId: 'permission-1' } }}
    getMoteSource={getSource} onRespond={respond} />)
  const allow = () => [...app.container.querySelectorAll<HTMLButtonElement>('.agent-interaction button')].find(button => button.textContent?.includes('Allow once'))!
  await moteClick(allow()); expect(respond).toHaveBeenCalledTimes(1)
  const original = respond.mock.calls[0]![1]
  expect(original.moteSource).toEqual(source)
  source = { ...source, regionId: 'moved-after-original-submit' }
  await moteClick(allow()); expect(respond).toHaveBeenCalledTimes(2)
  expect(respond.mock.calls[1]![1]).toEqual(original)
  expect(getSource).toHaveBeenCalledTimes(1)
})

it('an uncertain native question retry preserves the original answer, source and operation', async () => {
  const dispose = await initialize()
  try {
    const source = moteInputSource(neighborAgent.id, origin) ?? { spaceId: 'original-mote', zoneId: 'original-zone', tabId: neighborTab.id, regionId: neighborTab.layout.activeRegionId }
    const native = { providerId: neighborAgent.providerId, nativeSessionId: 'original-native-member' }
    useAppStore.setState({ sessions: [{ ...neighborAgent, nativeHandle: { kind: 'provider', providerId: native.providerId, sessionId: native.nativeSessionId } }], questionReplies: {}, questionReplyDrafts: {} })
    const reply = vi.spyOn(api.sessions, 'replyQuestion').mockRejectedValueOnce(new Error('Reply ACK unknown')).mockImplementation(async (_control, original) => ({
      agentSessionId: neighborAgent.id, source: original.source, recordId: original.recordId, questionIds: original.answers.map(answer => answer.questionId), operationId: original.operationId, outcome: 'submitted'
    }))
    const input = { source: native, turnId: 'original-turn', recordId: 'original-question-record', answers: [{ questionId: 'question-1', answer: 'Use threshold 12' }] }
    await expect(sendConversationQuestionReply(neighborAgent.control, input, source)).rejects.toThrow('Reply ACK unknown')
    expect(reply).toHaveBeenCalledTimes(1)
    const original = reply.mock.calls[0]![1]
    expect(original.moteSource).toEqual(source)
    await sendConversationQuestionReply(neighborAgent.control, { ...input, answers: [{ questionId: 'question-1', answer: 'Later edit must not replace an unknown send' }] }, { ...source, regionId: 'different-region' })
    expect(reply).toHaveBeenCalledTimes(2)
    expect(reply.mock.calls[1]![1]).toEqual(original)
  } finally { dispose?.() }
})
