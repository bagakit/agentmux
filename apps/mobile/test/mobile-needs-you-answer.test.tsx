import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMuxAgentSession, AgentMuxInteractionOperationReceipt, AgentMuxInteractionRequest } from '@agentmux/core'
import { MobileSpatialNavigation } from '../src/navigation/MobileSpatialNavigation'
import { mobileTicketChoices } from '../src/navigation/MobileNeedsYouAnswer'
import { MobileLocalDraftsOwner } from '../src/conversation/local-drafts-owner'
import { mobileNeedsYou } from '../src/navigation/needs-you'
import type { MobileAgentPresentation } from '../src/navigation/mobile-agent-status'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { click, deferred, evidence, fixture, mount, mounted, session } from './conversation-fixture'

const permission = (options = [{ id: 'allow', label: '允许本次', kind: 'allow-once' as const }, { id: 'deny', label: '拒绝', kind: 'reject-once' as const }]): AgentMuxInteractionRequest => ({
  kind: 'permission', id: 'request-1', agentSessionId: 'waiting', title: '读取 ~/资料 目录', options, permissionHook: { receiptId: 'hook-1' },
  evidence: { ...evidence, run: { runId: 'run-waiting' } } })
const question = (count: number, questions = 1): AgentMuxInteractionRequest => ({
  kind: 'question', id: 'question-1', agentSessionId: 'waiting', evidence: { ...evidence, run: { runId: 'run-waiting' } },
  questions: Array.from({ length: questions }, (_, q) => ({ id: `q${q}`, prompt: '用哪种方案？', options: Array.from({ length: count }, (_, i) => ({ id: `o${i}`, label: `方案 ${i + 1}` })) })) })
const row: MobileAgentPresentation = { agentSessionId: 'waiting', name: '资料整理', project: '原项目', detail: '', group: 'attention', state: 'waiting', stateMark: 'attention', providerId: 'codex', recap: null }

beforeEach(async () => { localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => {
  for (const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() }
  document.body.replaceChildren(); vi.restoreAllMocks()
})

function waiting(request: AgentMuxInteractionRequest): AgentMuxAgentSession {
  return { ...session('waiting'), pendingInteraction: { request } }
}
function receipt(input: Parameters<ReturnType<typeof fixture>['respond']>[0], delivery: AgentMuxInteractionOperationReceipt['delivery']): AgentMuxInteractionOperationReceipt {
  return { agentSessionId: input.agentSessionId, operationId: input.operationId, run: input.expectedRun, expectedRequest: input.expectedRequest,
    response: input.response, delivery, nativeAdoption: 'unknown' }
}
async function focus(request: AgentMuxInteractionRequest) {
  const f = fixture(), open = vi.fn(), reads = vi.fn()
  f.sessions.set('waiting', waiting(request))
  f.client.forwardRpc = vi.fn().mockImplementation(async () => { reads(); return { catalog: { spaces: [], zones: [], tabs: [], regions: [], locations: [], bindings: [], agentPresentation: [row] } } })
  const view = await mount(<MobileLocalDraftsOwner><MobileSpatialNavigation client={f.client} connected home="focus" sessions={[]} openSession={open} needsYou={mobileNeedsYou([row])} /></MobileLocalDraftsOwner>)
  const card = view.element.querySelector<HTMLElement>('.mobile-needs-you-card')!
  return { ...f, ...view, open, reads, card, choice: (label: string) => [...card.querySelectorAll<HTMLButtonElement>('.mobile-ticket-answer__choices button')].find(value => value.textContent === label)! }
}

describe('which requests fit one tap', () => {
  it('answers permission requests up to three options and single questions up to four, from the shared plan', () => {
    expect(mobileTicketChoices(permission())?.choices.map(value => [value.label, value.primary, value.response])).toEqual([
      ['允许本次', true, { kind: 'permission', requestId: 'request-1', decision: { outcome: 'selected', optionId: 'allow' } }],
      ['拒绝', false, { kind: 'permission', requestId: 'request-1', decision: { outcome: 'selected', optionId: 'deny' } }]])
    expect(mobileTicketChoices(question(4))?.choices.map(value => value.response)).toContainEqual(
      { kind: 'question', requestId: 'question-1', outcome: 'answered', answers: [{ questionId: 'q0', optionId: 'o3' }] })
    expect(mobileTicketChoices(question(5))).toBeNull()
    expect(mobileTicketChoices(question(2, 2))).toBeNull()
    expect(mobileTicketChoices(permission([1, 2, 3, 4].map(i => ({ id: `p${i}`, label: `选项 ${i}`, kind: 'allow-once' as const }))))).toBeNull()
    expect(mobileTicketChoices({ ...permission(), responseUnavailableReason: 'Continue in the original terminal.' })).toBeNull()
    expect(mobileTicketChoices(undefined)).toBeNull()
  })
})

describe('the one-tap answer on a needs-you ticket', () => {
  it('saves on the device, answers the exact request once through Core, then collapses and refreshes the directory', async () => {
    const f = await focus(permission())
    f.respond.mockImplementation(async input => receipt(input, 'hook-written'))
    expect(f.card.querySelector('.mobile-ticket-answer__title')?.textContent).toBe('读取 ~/资料 目录')
    const before = f.reads.mock.calls.length
    await click(f.choice('允许本次'))
    expect(f.respond).toHaveBeenCalledTimes(1)
    const input = f.respond.mock.calls[0]![0]
    expect(input).toMatchObject({ agentSessionId: 'waiting', expectedRun: { runId: 'run-waiting' }, expectedRequest: permission(),
      response: { kind: 'permission', requestId: 'request-1', decision: { outcome: 'selected', optionId: 'allow' } } })
    expect(input.operationId).toEqual(expect.any(String))
    // The device record held the original answer before Core saw it.
    expect(getDeviceWorkface().snapshot().record.conversation.responses.map(([, value]) => (value as { original?: { input: { operationId: string } } }).original?.input.operationId)).toContain(input.operationId)
    await vi.waitFor(() => expect(f.card.querySelector('.mobile-ticket-answer')?.getAttribute('data-phase')).toBe('confirmed'))
    expect(f.card.querySelector('.mobile-ticket-answer__choices')).toBeNull()
    await vi.waitFor(() => expect(f.reads.mock.calls.length).toBeGreaterThan(before))
    expect(f.open).not.toHaveBeenCalled()
    // Core closes the request: the directory is read again at once, not on the next periodic read.
    const confirmedReads = f.reads.mock.calls.length
    await act(async () => f.emit({ type: 'agent-session', session: session('waiting') }))
    await vi.waitFor(() => expect(f.reads.mock.calls.length).toBeGreaterThan(confirmedReads))
  })

  it('never answers twice: a pending or unknown answer has no tappable choices and points to the conversation', async () => {
    const f = await focus(permission()), pending = deferred<AgentMuxInteractionOperationReceipt>()
    f.respond.mockImplementation(() => pending.promise)
    await click(f.choice('拒绝'))
    expect(f.card.querySelector('.mobile-ticket-answer')?.getAttribute('data-phase')).toBe('sending')
    expect([...f.card.querySelectorAll<HTMLButtonElement>('.mobile-ticket-answer__choices button')].every(value => value.disabled)).toBe(true)
    await click(f.choice('允许本次'))
    expect(f.respond).toHaveBeenCalledTimes(1)
    const input = f.respond.mock.calls[0]![0]
    await act(async () => pending.resolve(receipt(input, 'unknown')))
    await vi.waitFor(() => expect(f.card.querySelector('.mobile-ticket-answer')?.getAttribute('data-phase')).toBe('unknown'))
    expect(f.card.querySelector('.mobile-ticket-answer__choices')).toBeNull()
    await click([...f.card.querySelectorAll('button')].find(value => value.textContent === '打开对话查看')!)
    expect(f.open).toHaveBeenCalledWith('waiting', expect.objectContaining({ name: '资料整理' }))
    expect(f.respond).toHaveBeenCalledTimes(1)
  })

  it('treats a thrown transport failure as unknown, and an explicit Core rejection as retryable', async () => {
    const lost = await focus(permission())
    lost.respond.mockRejectedValue(new Error('socket closed'))
    await click(lost.choice('允许本次'))
    await vi.waitFor(() => expect(lost.card.querySelector('.mobile-ticket-answer')?.getAttribute('data-phase')).toBe('unknown'))
    expect(lost.respond).toHaveBeenCalledTimes(1)
    for (const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() }
    localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface())
    const refused = await focus(permission())
    refused.respond.mockRejectedValueOnce(Object.assign(new Error('The exact original interaction request changed.'), { code: 'UNKNOWN_AGENT_INTERACTION' }))
    await click(refused.choice('允许本次'))
    await vi.waitFor(() => expect(refused.card.querySelector('.mobile-ticket-answer__issue')?.textContent).toBe('没能答复，可以再试一次'))
    expect(refused.choice('允许本次').disabled).toBe(false)
  })

  it('keeps a larger request as a summary that opens the conversation', async () => {
    const f = await focus(question(6))
    expect(f.card.querySelector('.mobile-ticket-answer')).toBeNull()
    await click(f.card.querySelector<HTMLButtonElement>('.mobile-needs-you-ticket')!)
    expect(f.open).toHaveBeenCalledWith('waiting', expect.objectContaining({ name: '资料整理' }))
    expect(f.respond).not.toHaveBeenCalled()
  })
})
