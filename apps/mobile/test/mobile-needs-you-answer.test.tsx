import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMuxAgentSession, AgentMuxInteractionOperationReceipt, AgentMuxInteractionRequest } from '@agentmux/core'
import { MobileSpatialNavigation } from '../src/navigation/MobileSpatialNavigation'
import { mobileTicketChoices } from '../src/navigation/MobileNeedsYouAnswer'
import { MobileLocalDraftsOwner, useMobileLocalDrafts, type MobileLocalDrafts } from '../src/conversation/local-drafts-owner'
import { MobileConversationSurface } from '../src/conversation/MobileConversationSurface'
import { createBrowserPlatform } from '../src/platform/browser'
import { mobileNeedsYou } from '../src/navigation/needs-you'
import type { MobileAgentPresentation } from '../src/navigation/mobile-agent-status'
import { DEVICE_WORKFACE_KEY, DeviceWorkfaceStore, emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { button, click, deferred, editor, evidence, fixture, mount, mounted, paste, session } from './conversation-fixture'

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
async function focus(request: AgentMuxInteractionRequest, mote = false) {
  const f = fixture(), open = vi.fn(), reads = vi.fn()
  f.sessions.set('waiting', waiting(request))
  const context = { spaceId: 'mote-space', zoneId: 'mote-zone', tabId: 'mote-tab', regionId: 'mote-region' }
  const catalog = { spaces: mote ? [{ spaceId: context.spaceId, kind: 'mote', name: '协调', hostId: 'host-original' }] : [],
    zones: [], tabs: [], regions: mote ? [{ kind: 'agent', tabId: context.tabId, regionId: context.regionId, agentSessionId: 'waiting' }] : [], bindings: [], locations: mote ? [context] : [], agentPresentation: [row] }
  f.client.forwardRpc = vi.fn().mockImplementation(async () => { reads(); return { catalog } })
  let local!: MobileLocalDrafts
  function LocalProbe() { local = useMobileLocalDrafts(); return null }
  const scene = (visible = true) => <MobileLocalDraftsOwner><LocalProbe />{visible && <MobileSpatialNavigation client={f.client} connected home="focus" sessions={[]} openSession={open} needsYou={mobileNeedsYou([row])} />}</MobileLocalDraftsOwner>
  const view = await mount(scene())
  const card = () => view.element.querySelector<HTMLElement>('.mobile-needs-you-card')!
  return { ...f, ...view, open, reads, context, get local() { return local }, get card() { return card() },
    show: (visible: boolean) => view.render(scene(visible)),
    choice: (label: string) => [...card().querySelectorAll<HTMLButtonElement>('.mobile-ticket-answer__choices button')].find(value => value.textContent === label)! }
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
    f.respond.mockImplementation(async input => {
      // Observe ordering at the real SDK boundary, before its receipt can trigger the final save.
      expect(getDeviceWorkface().snapshot().record.conversation.responses.map(([, value]) =>
        (value as { original?: { input: { operationId: string } } }).original?.input.operationId)).toContain(input.operationId)
      return receipt(input, 'hook-written')
    })
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
    await vi.waitFor(() => expect(f.reads.mock.calls.length).toBe(before + 1))
    // Real SDK observations return distinct objects; neither may restart the directory poll.
    const pointRead = vi.spyOn(f.client, 'agentSession').mockImplementation(id => structuredClone(f.sessions.get(id)!))
    await act(async () => f.emit({ type: 'agent-session', session: waiting(permission()) }))
    await act(async () => f.emit({ type: 'agent-session', session: { ...waiting(permission()), updatedAt: 10 } }))
    expect(f.reads.mock.calls.length).toBe(before + 1)
    pointRead.mockRestore()
    expect(f.open).not.toHaveBeenCalled()
    // Core closes the request: the directory is read again at once, not on the next periodic read.
    const confirmedReads = f.reads.mock.calls.length
    await act(async () => f.emit({ type: 'agent-session', session: session('waiting') }))
    await vi.waitFor(() => expect(f.reads.mock.calls.length).toBeGreaterThan(confirmedReads))
  })

  it('keeps response operations and directory refreshes scoped to the exact request Run', async () => {
    const f = await focus(permission())
    f.respond.mockImplementation(async input => receipt(input, 'hook-written'))
    await click(f.choice('允许本次'))
    const original = f.respond.mock.calls[0]![0]
    const nextRequest = { ...permission(), evidence: { ...evidence, run: { runId: 'run-next' } } }
    await act(async () => f.emit({ type: 'agent-session', session: { ...waiting(nextRequest), run: { runId: 'run-next' } } }))
    await click(f.choice('允许本次'))
    expect(f.respond).toHaveBeenCalledTimes(2)
    const next = f.respond.mock.calls[1]![0]
    expect(next.operationId).not.toBe(original.operationId)
    expect(next.expectedRun.runId).toBe('run-next')
    expect(next.expectedRequest.evidence?.run?.runId).toBe('run-next')
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

  it.each(['confirmed', 'unknown', 'rejected'] as const)('settles an original %s answer after its ticket unmounts', async outcome => {
    const f = await focus(permission()), pending = deferred<AgentMuxInteractionOperationReceipt>()
    f.respond.mockImplementation(() => pending.promise)
    await click(f.choice('允许本次'))
    const input = f.respond.mock.calls[0]![0], original = [...f.local.responses.values()][0]!
    expect(original.phase).toBe('sending')
    await f.show(false)
    await act(async () => {
      if (outcome === 'rejected') pending.reject(Object.assign(new Error('request closed'), { code: 'UNKNOWN_AGENT_INTERACTION' }))
      else pending.resolve(receipt(input, outcome === 'confirmed' ? 'hook-written' : 'unknown'))
    })
    await vi.waitFor(() => expect(original.phase).toBe(outcome))
    await vi.waitFor(() => expect(getDeviceWorkface().snapshot().record.conversation.responses[0]![1].phase).toBe(outcome))
    await f.show(true)
    expect(f.card.querySelector('.mobile-ticket-answer')?.getAttribute('data-phase')).toBe(outcome === 'rejected' ? 'idle' : outcome)
    expect(f.respond).toHaveBeenCalledTimes(1)
  })

  it('uses the explicitly replaced device record without remounting the page or losing its saved draft', async () => {
    const f = await focus(permission()), originalOwner = f.local
    originalOwner.drafts.set('kept-draft', '继续保留的草稿'); await originalOwner.save()
    const before = getDeviceWorkface().recordIdentity()
    await act(async () => { await getDeviceWorkface().replaceUnreadableWithCurrent() })
    expect(getDeviceWorkface().recordIdentity()).not.toBe(before)
    expect(f.local).not.toBe(originalOwner)
    expect(f.local.drafts.get('kept-draft')).toBe('继续保留的草稿')
    f.respond.mockImplementation(async input => receipt(input, 'hook-written'))
    await click(f.choice('允许本次'))
    expect(f.respond).toHaveBeenCalledTimes(1)
    expect(f.card.querySelector('.mobile-ticket-answer')?.getAttribute('data-phase')).toBe('confirmed')
    expect(JSON.parse(originalOwner.exportBackup()).workface.conversation.drafts).toContainEqual(['kept-draft', '继续保留的草稿'])
  })

  it('preserves an unstored draft alongside the imported draft through the actual editor, conflict Copy and device backup', async () => {
    const f = fixture(), copy = vi.fn().mockResolvedValue(true), owner = getDeviceWorkface()
    const view = await mount(<MobileLocalDraftsOwner><MobileConversationSurface client={f.client} agentSessionId="session-original"
      connection={{ state: 'connected', message: '已连接' }} platform={{ ...createBrowserPlatform(), copyText: copy }} /></MobileLocalDraftsOwner>)
    const originalEditor = editor(view.element), before = localStorage.getItem(DEVICE_WORKFACE_KEY)!
    const fault = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw Error('device write unavailable') })
    await paste(view.element, '仅在页面里的草稿')
    expect(originalEditor.textContent).toContain('仅在页面里的草稿')
    expect(localStorage.getItem(DEVICE_WORKFACE_KEY)).toBe(before)
    fault.mockRestore()
    const key = JSON.stringify(['draft', 'session-original'])
    const replacement = emptyDeviceWorkface(); replacement.conversation.drafts = [[key, '导入文件中的草稿']]
    await act(async () => { await owner.replaceBackup(replacement) })
    expect(editor(view.element)).toBe(originalEditor)
    expect(editor(view.element).textContent).toBe('导入文件中的草稿')
    const retained = [...view.element.querySelectorAll('details')].find(value => value.querySelector('summary')?.textContent === '保全的冲突内容')!
    expect(retained).toBeDefined()
    expect(retained.textContent).toContain('仅在页面里的草稿')
    await click(button(retained, '复制这份保全内容'))
    expect(copy).toHaveBeenLastCalledWith('仅在页面里的草稿', expect.any(Function))
    const backup = JSON.parse(owner.exportBackup()).workface
    expect(backup.conversation.drafts).toContainEqual([key, '导入文件中的草稿'])
    expect(backup.conversation.conflicts).toContainEqual({ bucket: 'drafts', key, value: '仅在页面里的草稿' })
    // Recovering the retained text uses the maintained editor; replacement never sends or replays it.
    await paste(view.element, copy.mock.calls.at(-1)![0])
    expect(editor(view.element).textContent).toContain('仅在页面里的草稿')
    expect(editor(view.element).textContent).toContain('导入文件中的草稿')
    expect(f.submit).not.toHaveBeenCalled(); expect(f.respond).not.toHaveBeenCalled()
  })

  it('keeps the original page owner and its backup after another page replaces the device record', async () => {
    const f = await focus(permission()), oldOwner = f.local
    oldOwner.drafts.set('draft-memory', '这页尚未保存的正文')
    // A separate device owner shares only the storage/lock, as another browser page does.
    const otherPage = new DeviceWorkfaceStore(() => localStorage)
    await otherPage.replaceBackup(emptyDeviceWorkface())
    const accepted = getDeviceWorkface().snapshot().record
    await f.show(true)
    expect(f.local).toBe(oldOwner)
    expect(f.local.drafts.get('draft-memory')).toBe('这页尚未保存的正文')
    expect(await oldOwner.save()).toBe(false)
    expect(oldOwner.recordChanged).toBe(true)
    expect(JSON.parse(oldOwner.exportBackup()).workface.conversation.drafts).toContainEqual(['draft-memory', '这页尚未保存的正文'])
    expect(getDeviceWorkface().snapshot().record).toEqual(accepted)
    expect(f.respond).not.toHaveBeenCalled()
  })

  it('keeps a late receipt with its old attempt and does not write it into a replacement record', async () => {
    const f = await focus(permission()), pending = deferred<AgentMuxInteractionOperationReceipt>()
    f.respond.mockImplementation(() => pending.promise)
    await click(f.choice('允许本次'))
    const input = f.respond.mock.calls[0]![0], oldOwner = f.local, original = [...oldOwner.responses.values()][0]!
    await act(async () => { await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
    const accepted = getDeviceWorkface().snapshot().record
    await act(async () => pending.resolve(receipt(input, 'hook-written')))
    expect(original.phase).toBe('confirmed')
    expect(getDeviceWorkface().snapshot().record).toEqual(accepted)
    expect(f.local.responses.size).toBe(0)
    expect(JSON.parse(oldOwner.exportBackup()).workface.conversation.responses[0][1].phase).toBe('confirmed')
    expect(f.respond).toHaveBeenCalledTimes(1)
  })

  it('uses only status events for ticket observations and never listens to terminal output', async () => {
    const f = await focus(permission())
    const onEvent = vi.spyOn(f.client, 'onEvent'), onStatus = vi.spyOn(f.client, 'onStatusEvent')
    await f.show(false); onEvent.mockClear(); onStatus.mockClear()
    await f.show(true)
    expect(onStatus).toHaveBeenCalled()
    // Directory observers use the qualified status channel too; no broad byte subscriber is needed.
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('attributes a Mote ticket answer to the same exact occurrence as opening its conversation', async () => {
    const f = await focus(permission(), true)
    f.respond.mockImplementation(async input => receipt(input, 'hook-written'))
    await click(f.card.querySelector<HTMLButtonElement>('.mobile-needs-you-ticket')!)
    expect(f.open).toHaveBeenCalledWith('waiting', expect.objectContaining({ context: f.context, mote: expect.objectContaining({ spaceId: f.context.spaceId }) }))
    await click(f.choice('允许本次'))
    expect(f.respond.mock.calls[0]![0].moteSource).toEqual(f.context)
  })

  it('keeps a larger request as a summary that opens the conversation', async () => {
    const f = await focus(question(6))
    expect(f.card.querySelector('.mobile-ticket-answer')).toBeNull()
    await click(f.card.querySelector<HTMLButtonElement>('.mobile-needs-you-ticket')!)
    expect(f.open).toHaveBeenCalledWith('waiting', expect.objectContaining({ name: '资料整理' }))
    expect(f.respond).not.toHaveBeenCalled()
  })
})
