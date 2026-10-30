import { MOTE_INPUT_GUIDANCE } from '@agentmux/core/mote-input-source'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentInputMoteSource } from '@agentmux/core'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { questionReplyKey } from '@agentmux/client-ui/conversation-question-reply'
import { MobileApp } from '../src/MobileApp'
import { MobileConversationSurface } from '../src/conversation/MobileConversationSurface'
import { createLocalDrafts } from '../src/conversation/local-drafts'
import { mobileMoteInputSource } from '../src/conversation/mote-input-source'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { acceptedPrompt, button, click, evidence, fixture, history, mount, mounted, paste, plainEnter, session } from './conversation-fixture'

const sid = 'session-original', connected = { state: 'connected' as const, message: 'Connected' }
const source: AgentInputMoteSource = { spaceId: 'original-mote', zoneId: 'original-zone', tabId: 'original-tab', regionId: 'original-region' }
const otherSource: AgentInputMoteSource = { spaceId: 'other-mote', zoneId: 'other-zone', tabId: 'other-tab', regionId: 'other-region' }
const identity = { name: 'Original member', project: 'Original project', mote: { spaceId: source.spaceId },
  context: { ...source, workspaceId: 'original-workspace', displayWorkspaceId: 'original-display', groupId: 'original-group' } }
const platform = createBrowserPlatform()
const record = () => getDeviceWorkface().snapshot().record.conversation
const prompt = () => record().attempts.find(([key]) => key === JSON.stringify(['draft', sid]))?.[1]
const surface = (f: ReturnType<typeof fixture>, moteSource: AgentInputMoteSource | undefined) =>
  <MobileConversationSurface client={f.client} agentSessionId={sid} moteSource={moteSource} connection={connected} platform={platform} />

beforeEach(async () => { localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => {
  for (const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() }
  document.body.replaceChildren(); vi.restoreAllMocks()
})

it('the actual App sends and durably retains the original Mote Region before its manual prompt dispatch', async () => {
  const f = fixture()
  let durableAtDispatch: unknown
  await getDeviceWorkface().updatePresentation({ selectedSessionId: sid, hostUrl: '', panel: 'conversation' },
    { primary: 'mote', showSession: true, showGoalWork: false, identity, profile: null })
  f.client.forwardRpc = vi.fn().mockImplementation(async (method: string) => method === 'space.ls' || method === 'space.inspect'
    ? { catalog: { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [], agentPresentation: [] } }
    : { agents: [], workspaces: [], projects: [], executors: [], unavailable: [], goals: [], topics: [], categories: [] })
  f.submit.mockImplementation(async input => {
    durableAtDispatch = structuredClone(prompt())
    return acceptedPrompt(input)
  })
  const view = await mount(<MobileApp client={f.client} connection={connected} platform={platform} />)
  await paste(view.element, 'Original Mote member decision')
  expect(f.submit).not.toHaveBeenCalled()
  await click(button(view.element, 'Send'))
  expect(f.submit).toHaveBeenCalledOnce()
  expect(f.submit.mock.calls[0]![0]).toMatchObject({ agentSessionId: sid, moteSource: source, admissionIntent: { kind: 'manual-actor' } })
  expect(f.submit.mock.calls[0]![0]).toMatchObject({ agentMuxNote: MOTE_INPUT_GUIDANCE })
  expect(f.submit.mock.calls[0]![0].prompt).toBe('Original Mote member decision')
  expect(durableAtDispatch).toMatchObject({ operationId: f.submit.mock.calls[0]![0].operationId, agentMuxNote: MOTE_INPUT_GUIDANCE, moteSource: source, inputRequested: true, phase: 'sending' })
  expect(createLocalDrafts().attempts.get(JSON.stringify(['draft', sid]))?.moteSource).toEqual(source)
})

it('conditioned prompt retries retain the exact original operation and source across navigation and device restoration', async () => {
  const f = fixture()
  let durableAtDispatch: unknown
  f.submit.mockImplementationOnce(async input => {
    durableAtDispatch = structuredClone(prompt())
    throw new Error('Original transport acknowledgement unavailable')
  })
  const view = await mount(surface(f, source))
  await paste(view.element, 'Original conditioned input'); await plainEnter(view.element)
  expect(f.submit).toHaveBeenCalledOnce()
  const original = structuredClone(f.submit.mock.calls[0]![0])
  expect(durableAtDispatch).toMatchObject({ operationId: original.operationId, moteSource: source, phase: 'sending' })
  expect(original.moteSource).toEqual(source)
  expect(original.agentMuxNote).toBe(MOTE_INPUT_GUIDANCE)
  expect(createLocalDrafts().attempts.get(JSON.stringify(['draft', sid]))).toMatchObject({ phase: 'unknown', moteSource: source })
  await view.render(null)
  await view.render(surface(f, otherSource))
  await click(button(view.element, '重试原请求'))
  expect(f.submit).toHaveBeenCalledTimes(2)
  expect(f.submit.mock.calls[1]![0]).toEqual(original)
})

it('a legacy unknown prompt never acquires a new navigation source when explicitly retried', async () => {
  const f = fixture(), local = createLocalDrafts()
  local.attempts.set(JSON.stringify(['draft', sid]), { operationId: 'legacy-original-operation', runId: 'run-original', draft: 'Legacy original input',
    phase: 'unknown', message: 'Unknown original receipt', inputRequested: true, originalHostId: 'host-original', originalRuntimeId: 'original-runtime',
    request: { condition: { expectedRun: { runId: 'run-original' }, afterSubmissionId: null }, execution: 'default', explicit: false, runtimeId: 'original-runtime' } })
  await local.save()
  const view = await mount(surface(f, otherSource))
  await click(button(view.element, '重试原请求'))
  expect(f.submit).toHaveBeenCalledOnce()
  expect(f.submit.mock.calls[0]![0]).toMatchObject({ operationId: 'legacy-original-operation', prompt: 'Legacy original input' })
  expect(f.submit.mock.calls[0]![0]).not.toHaveProperty('moteSource')
  expect(f.submit.mock.calls[0]![0]).not.toHaveProperty('agentMuxNote')
})

it('manual prompt retries keep their original source and operation after navigation', async () => {
  const f = fixture()
  f.submit.mockRejectedValueOnce(new Error('Original manual acknowledgement unavailable'))
  const view = await mount(surface(f, source))
  await paste(view.element, 'Original manual input'); await click(button(view.element, 'Send'))
  expect(f.submit).toHaveBeenCalledOnce()
  const original = structuredClone(f.submit.mock.calls[0]![0])
  expect(original.moteSource).toEqual(source)
  expect(original.agentMuxNote).toBe(MOTE_INPUT_GUIDANCE)
  await view.render(surface(f, otherSource))
  await click(button(view.element, '重试原请求'))
  expect(f.submit).toHaveBeenCalledTimes(2)
  expect(f.submit.mock.calls[1]![0]).toEqual(original)
})


it.each([undefined, 'Earlier frozen platform note'] as const)('a legacy original Mote source retains its frozen note=%s without adopting the upgraded guide', async savedNote => {
  const f = fixture(), local = createLocalDrafts()
  local.attempts.set(JSON.stringify(['draft', sid]), { operationId: 'legacy-mote-original-operation', runId: 'run-original', draft: 'Legacy exact human body',
    moteSource: source, ...(savedNote === undefined ? {} : { agentMuxNote: savedNote }),
    phase: 'unknown', message: 'Unknown original receipt', inputRequested: true, originalHostId: 'host-original', originalRuntimeId: 'original-runtime',
    request: { condition: { expectedRun: { runId: 'run-original' }, afterSubmissionId: null }, execution: 'default', explicit: false, runtimeId: 'original-runtime' } })
  await local.save()
  const view = await mount(surface(f, otherSource))
  expect(f.submit).not.toHaveBeenCalled()
  await click(button(view.element, '重试原请求'))
  expect(f.submit).toHaveBeenCalledOnce()
  const input = f.submit.mock.calls[0]![0]
  expect(input).toMatchObject({ operationId: 'legacy-mote-original-operation', prompt: 'Legacy exact human body', moteSource: source })
  if (savedNote === undefined) expect(input).not.toHaveProperty('agentMuxNote')
  else expect(input.agentMuxNote).toBe(savedNote)
  expect(input.prompt).not.toContain('Mote collaboration:')
})

const { mote: _mote, ...ordinaryIdentity } = identity
const { context: _context, ...unknownIdentity } = identity
it.each([
  ['non-Mote', ordinaryIdentity, sid],
  ['unknown Region', unknownIdentity, sid],
  ['different Mote', { ...identity, mote: { spaceId: 'different-space' } }, sid],
  ['background Session identity', identity, 'different-recipient']
] as const)('%s has no guessed source and keeps healthy prompt input available', async (_label, original, identityRecipient) => {
  const f = fixture(), moteSource = mobileMoteInputSource(original, sid, identityRecipient)
  expect(moteSource).toBeUndefined()
  const view = await mount(surface(f, moteSource))
  await paste(view.element, 'Healthy input without confirmed Mote source'); await click(button(view.element, 'Send'))
  expect(f.submit).toHaveBeenCalledOnce()
  expect(f.submit.mock.calls[0]![0]).not.toHaveProperty('moteSource')
  expect(f.submit.mock.calls[0]![0]).not.toHaveProperty('agentMuxNote')
})

it('native question answers persist the exact source before dispatch and retry their original frozen reply after navigation', async () => {
  const f = fixture(), target = { source: history().source, turnId: 'original-turn', recordId: 'original-question' }
  f.setPage({ ...history(), nextCursor: null, items: [{ id: target.recordId, turnId: target.turnId, kind: 'assistant-message',
    contentParts: [{ kind: 'text', text: 'Original native question' }], questionRequest: { delivery: 'async', questions: [
      { id: 'choice', prompt: 'Original decision?', options: [{ id: 'keep', label: 'Keep original' }], acceptsText: false }
    ] } }] })
  f.sessions.set(sid, { ...session(), nativeHandle: { kind: 'provider', providerId: target.source.providerId, sessionId: target.source.nativeSessionId } })
  const key = questionReplyKey(sid, target)
  const durableAtDispatch: unknown[] = []
  const reply = vi.fn<AgentMuxHostedClient['replySessionQuestion']>().mockImplementation(async input => {
    durableAtDispatch.push(structuredClone(record().questions?.find(([id]) => id === key)?.[1]))
    return { agentSessionId: sid, source: input.source, recordId: input.recordId, questionIds: input.answers.map(answer => answer.questionId),
      operationId: input.operationId, outcome: 'submitted' }
  }).mockImplementationOnce(async input => {
    durableAtDispatch.push(structuredClone(record().questions?.find(([id]) => id === key)?.[1]))
    throw new Error('Question original acknowledgement unavailable')
  })
  Object.assign(f.client, { replySessionQuestion: reply })
  const view = await mount(surface(f, source))
  await click(button(view.element, 'Keep original')); await click(button(view.element, '发送答案'))
  expect(reply).toHaveBeenCalledOnce()
  expect(durableAtDispatch[0]).toMatchObject({ phase: 'sending', input: { moteSource: source, operationId: reply.mock.calls[0]![0].operationId } })
  expect(reply.mock.calls[0]![0]).toMatchObject({ ...target, moteSource: source, agentSessionId: sid, answers: [{ questionId: 'choice', answer: 'Keep original' }] })
  expect(createLocalDrafts().questions.get(key)?.input.moteSource).toEqual(source)
  await view.render(surface(f, otherSource)); await click(button(view.element, '继续原发送'))
  expect(reply).toHaveBeenCalledTimes(2)
  expect(durableAtDispatch[1]).toMatchObject({ input: { moteSource: source, operationId: reply.mock.calls[0]![0].operationId } })
  expect(reply.mock.calls[1]![0]).toEqual(reply.mock.calls[0]![0])
  expect(f.submit).not.toHaveBeenCalled()
})

it('permission responses persist the original Card operation and source before dispatch and preserve unknown responses after navigation', async () => {
  const f = fixture(), value = session()
  let durableAtDispatch: unknown
  value.pendingInteraction = { request: { kind: 'permission', agentSessionId: sid, id: 'original-permission', title: 'Original request', evidence,
    permissionHook: { receiptId: 'original-permission' }, options: [{ id: 'exact-allow', label: 'Original option', kind: 'allow-once' }] } }
  f.sessions.set(sid, value)
  f.respond.mockImplementationOnce(async input => {
    durableAtDispatch = structuredClone(record().responses[0]?.[1])
    throw new Error('Permission original acknowledgement unavailable')
  })
  const view = await mount(surface(f, source))
  await click(button(view.element, 'Original option'))
  expect(f.respond).toHaveBeenCalledOnce()
  expect(durableAtDispatch).toMatchObject({ phase: 'sending', original: { input: { moteSource: source, operationId: f.respond.mock.calls[0]![0].operationId } } })
  expect(f.respond.mock.calls[0]![0]).toMatchObject({ agentSessionId: sid, moteSource: source, expectedRequest: value.pendingInteraction.request,
    response: { kind: 'permission', requestId: 'original-permission', decision: { outcome: 'selected', optionId: 'exact-allow' } } })
  await view.render(surface(f, otherSource))
  expect(f.respond).toHaveBeenCalledOnce()
  expect(createLocalDrafts().responses.values().next().value).toMatchObject({ phase: 'unknown', original: { input: { moteSource: source } } })
  expect(view.element.textContent).toContain('答复回执未知')
})

it.each([source, undefined])('a cold refused permission retry keeps its entire original operation and source %j', async originalSource => {
  const f = fixture(), value = session(), local = createLocalDrafts()
  const request = { kind: 'permission' as const, agentSessionId: sid, id: 'original-permission', title: 'Original request', evidence,
    permissionHook: { receiptId: 'original-permission' }, options: [{ id: 'exact-allow', label: 'Original option', kind: 'allow-once' as const }] }
  value.pendingInteraction = { request }; f.sessions.set(sid, value)
  const original = { agentSessionId: sid, expectedRun: value.run, expectedRequest: request, operationId: 'original-rejected-permission',
    response: { kind: 'permission' as const, requestId: request.id, decision: { outcome: 'selected' as const, optionId: 'exact-allow' } },
    ...(originalSource ? { moteSource: originalSource } : {}) }
  local.responses.set(JSON.stringify([sid, value.run.runId, request.id, original.operationId]), { phase: 'rejected', message: 'Original refused reply',
    original: { input: original, runtimeId: 'original-runtime', hostId: 'host-original' } })
  await local.save()
  const view = await mount(surface(f, otherSource))
  await click(button(view.element, 'Original option'))
  expect(f.respond).toHaveBeenCalledExactlyOnceWith(original)
})
