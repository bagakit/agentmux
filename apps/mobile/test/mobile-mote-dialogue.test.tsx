import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import { parseMoteDialogueResult, type MoteDialoguePage } from '@agentmux/core/mote-dialogue'
import { MOTE_INPUT_GUIDANCE } from '@agentmux/core/mote-input-source'
import { MobileApp } from '../src/MobileApp'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { acceptedPrompt, button, click, deferred, editor, fixture, mount, mounted, paste, plainEnter } from './conversation-fixture'
import { fixturePath } from '../../../test/fixture-values.mjs'

const sid = 'session-original', worker = 'other', hostId = 'host-original', spaceId = 'mote-original'
const workspacePath = fixturePath('mote-dialogue'), zoneId = 'zone-original'
const resource = { hostId, workspaceId: 'workspace-original', workspacePath }, target = { spaceId, zoneId, expectedResource: resource }
const place = (regionId: string) => ({ spaceId, zoneId, workspaceId: resource.workspaceId, displayWorkspaceId: 'display-original', groupId: 'group-original', tabId: 'tab-original', regionId })
const main = { hostId, sessionId: sid, displayWorkspaceId: 'display-original', groupId: 'group-original', tabId: 'tab-original', regionId: 'main-region' }
const content = { ...resource, zoneId }, file = { ...resource, zoneId, zonePath: workspacePath, path: 'MOTE.md' }
const identity = { hostId, moteId: spaceId }
const work = { sequence: 2, identity, operationId: 'original-link-operation', associatedAt: 2, kind: 'work' as const, eventId: 'original-work-event', mainRoleRevision: 'original-role',
  main: { hostId, agentSessionId: sid }, origin: { hostId, messageId: 'original-work-message', threadId: 'original-thread', senderSessionId: sid, recipientSessionId: worker, createdAt: 2 } }
function dialogue(): MoteDialoguePage { return { main: { target, identity, status: 'ready', resource: file, documentRevision: 'original-file-revision', roleRevision: 'original-role', current: main, issue: null },
  links: [work], incarnation: 'original-journal', throughSequence: 2, next: null, coverage: 'linked-sources-only', sourceStatus: 'read', sourceIssue: null } }
function catalog(): AgentMuxSpaceCatalog {
  return { spaces: [{ spaceId, kind: 'mote', name: '持续产品搭档', hostId, directoryPath: workspacePath, projectId: null }], zones: [], bindings: [{ spaceId, zoneId }],
    tabs: [{ tabId: main.tabId, zoneId, workspaceId: resource.workspaceId, name: '原工作', regionIds: ['main-region', 'worker-region'] }],
    regions: [{ tabId: main.tabId, regionId: 'main-region', kind: 'agent', agentSessionId: sid, execution: { hostId, cwd: workspacePath } },
      { tabId: main.tabId, regionId: 'worker-region', kind: 'agent', agentSessionId: worker, execution: { hostId, cwd: workspacePath } }], locations: [place('main-region'), place('worker-region')],
    motePresentation: [{ spaceId, content, quickMode: { status: 'saved', version: 'original-file-revision', defaults: { conversation: main, conversationRevision: 'original-role' } }, conversation: main }],
    agentPresentation: [sid, worker].map(agentSessionId => ({ agentSessionId, name: agentSessionId === sid ? '当前承接者' : '资料研究员', project: '持续产品搭档', detail: '', group: 'working', state: 'working', providerId: 'codex', stateMark: 'working', stateLabel: '正在执行', recap: null })) }
}
const dispatch = { hostId, dispatch: { sourceMessageId: work.origin.messageId, ownerAgentSessionId: sid, workerAgentSessionId: worker, threadId: work.origin.threadId, openedAt: 2, originAwaits: true, events: [] },
  source: { envelope: { messageId: work.origin.messageId, threadId: work.origin.threadId, senderSessionId: sid, recipientSessionId: worker, body: '核对原资料并给出带来源的结论', createdAt: 2 } },
  replies: [worker, 'unconfirmed-original-sender'].map((senderSessionId, index) => ({ envelope: { messageId: 'original-report-' + index, threadId: work.origin.threadId, senderSessionId, recipientSessionId: sid, body: '原回复正文 ' + index, createdAt: 3 + index } })), identityDiagnostics: [] }
beforeEach(async () => {
  localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface())
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 320, 44))
  vi.stubGlobal('IntersectionObserver', class {
    constructor(readonly callback: IntersectionObserverCallback) {}
    observe(target: Element) { this.callback([{ target, isIntersecting: true, intersectionRatio: 1 } as IntersectionObserverEntry], this as unknown as IntersectionObserver) }
    unobserve() {}; disconnect() {}; takeRecords() { return [] }
  })
})
afterEach(async () => {
  for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
async function wait(check: () => void) { await vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 10000 }) }
async function original() {
  const f = fixture(), owner = getDeviceWorkface(), facts = catalog()
  await owner.updatePresentation({ selectedSessionId: sid, hostUrl: '', panel: 'conversation' }, { primary: 'mote', showSession: true, showGoalWork: false,
    identity: { name: '当前承接者', project: '持续产品搭档', context: place('main-region'), mote: { spaceId, name: '持续产品搭档', contentReference: content } }, profile: null })
  let page = dialogue(), workResult = structuredClone(dispatch), readFailure = false
  let inputMode: 'confirmed' | 'lost' | 'partial' | 'refused' | 'pending' = 'confirmed'
  const inputs = new Map<string, any>()
  const rpc = vi.fn(async (method: string, input: any) => {
    if (method === 'space.ls' || method === 'space.inspect') return { catalog: facts }
    if (method === 'space.mote.dialogue.read') { if (readFailure) throw Error('原主对话读取失败，旧来源保留'); return structuredClone(page) }
    if (method === 'message.dispatch.read') return structuredClone(workResult)
    if (method === 'space.mote.dialogue.input.inspect') return structuredClone(inputs.get(input.operationId) ?? { route: null, record: null, input: null })
    if (method === 'space.mote.dialogue.input.submit') {
      const packet = input.input, original = getDeviceWorkface().snapshot().record.conversation.attempts.find(([, value]) => value.operationId === packet.operationId)?.[1]
      if (!original?.moteMain || original.moteMain.expectedRoleRevision !== input.expectedRoleRevision || original.phase !== 'sending') throw Error('Logical main role must be durable before intake')
      if (inputMode === 'refused') throw Object.assign(new Error('The original main role changed; no input was accepted'), { code: 'MOTE_MAIN_INPUT_CHANGED' })
      const key = { kind: 'prompt', agentSessionId: packet.agentSessionId, expectedRun: packet.expectedRun, submissionId: packet.operationId }
      let receipt = packet.admissionIntent ? await acceptedPrompt({ ...packet, authorHuman: true }) : null
      let record: any = receipt?.admission ?? { agentSessionId: packet.agentSessionId, run: packet.expectedRun, admission: {
        submissionId: packet.operationId, operationId: packet.operationId, transport: 'pty', startByte: 0, endByte: new TextEncoder().encode(packet.prompt + '\r').length, acknowledged: true,
        intent: { run: packet.expectedRun, ownerInstanceId: 'controlled-original-owner', prompt: packet.prompt, execution: packet.execution,
          ...(Object.hasOwn(packet, 'afterSubmissionId') ? { afterSubmissionId: packet.afterSubmissionId } : {}), plan: { kind: 'single-phase', data: packet.prompt + '\r' },
          agentMuxNote: MOTE_INPUT_GUIDANCE, message: { userContent: packet.prompt, authorHuman: true, systemContext: MOTE_INPUT_GUIDANCE } } } }
      if (inputMode === 'partial' && !packet.admissionIntent) {
        const length = new TextEncoder().encode(packet.prompt).length, payloadId = packet.operationId + '-payload'
        record.admission.operationId = payloadId
        record.admission.intent.plan = { kind: 'render-then-submit', payload: packet.prompt, renderedText: packet.prompt, submit: '\r' }
        record.terminalPromptSubmission = { run: packet.expectedRun, submissionId: packet.operationId, promptDigest: 'controlled-original-digest', outputCursorBytes: 0,
          payload: { operationId: payloadId, inputByteRange: { startByte: 0, endByte: length }, acknowledged: true },
          submit: { operationId: packet.operationId + '-submit', inputByteRange: { startByte: length, endByte: length + 1 }, acknowledged: false } }
      }
      if (inputMode === 'pending') { record = null; receipt = null }
      const result = { route: { identity, operationId: packet.operationId, roleRevision: input.expectedRoleRevision, reference: structuredClone(page.main.current!),
        key, runtimeId: 'original-runtime', intentDigest: 'a'.repeat(64), admittedAt: 2 }, record, input: receipt ?? null }
      // Controlled replies satisfy the real wire parser before exercising outcomes.
      parseMoteDialogueResult('space.mote.dialogue.input.submit', result, input)
      inputs.set(packet.operationId, result)
      if (inputMode === 'lost') throw Error('Original main intake reply unavailable')
      return structuredClone(result)
    }
    if (method === 'agent.inspect') return { session: f.client.agentSession(input.agentSessionId), displayName: { override: null, availability: 'observed' } }
    return { agents: [], workspaces: [], projects: [], executors: [], unavailable: [], goals: [], topics: [], categories: [] }
  })
  f.client.forwardRpc = rpc
  const platform = createBrowserPlatform(), render = (client = f.client) => <MobileApp client={client} connection={{ state: 'connected', message: 'Original connected Host' }} platform={platform} />
  const view = await mount(render())
  await wait(() => expect(view.element.querySelector('[data-mote-dialogue]')).not.toBeNull())
  return { ...f, rpc, owner, view, render, facts, setPage(value: MoteDialoguePage) { page = value }, mainInput(mode: typeof inputMode) { inputMode = mode }, failDialogueRead() { readFailure = true }, wrongWorkHost() { workResult = { ...workResult, hostId: 'foreign-host' } } }
}

it('actual Mobile App reads one logical dialogue and the same work event in chat and history without sending, preserving drafts through original member and main navigation', async () => {
  const f = await original()
  await wait(() => expect(f.view.element.textContent).toContain('核对原资料并给出带来源的结论'))
  expect(f.rpc).toHaveBeenCalledWith('space.mote.dialogue.read', { target, limit: 50 })
  expect(f.rpc).toHaveBeenCalledWith('message.dispatch.read', { hostId, sourceMessageId: work.origin.messageId })
  await paste(f.view.element, '主对话原稿，不因查看工作而发送')
  const originalEditor = editor(f.view.element)
  const chatEvent = f.view.element.querySelector('.mote-conversation__messages [data-mote-work-event]')!
  expect(chatEvent.getAttribute('data-mote-work-event')).toBe(work.eventId)
  await click(button(f.view.element, '事件历史 · 1'))
  expect(f.view.element.querySelector('.mote-conversation__history [data-mote-work-event]')!.getAttribute('data-mote-work-event')).toBe(work.eventId)
  expect(editor(f.view.element)).toBe(originalEditor)
  await click(f.view.element.querySelector('.mote-conversation__history .mote-work-event__summary')!)
  await wait(() => expect(f.view.element.querySelector('.mote-conversation__history .mote-work-event__reply small')?.textContent).toContain('资料研究员'))
  expect([...f.view.element.querySelectorAll('.mote-conversation__history .mote-work-event__reply small')].at(-1)?.textContent).toContain('unconfirmed-original-sender')
  await click(button(f.view.element.querySelector<HTMLElement>('.mote-conversation__history')!, '继续原工作'))
  await wait(() => expect(f.owner.snapshot().record.selectedSessionId).toBe(worker))
  await paste(f.view.element, '成员原稿')
  await click(button(f.view.element, '回到 持续产品搭档'))
  await wait(() => expect(f.owner.snapshot().record.selectedSessionId).toBe(sid))
  expect(editor(f.view.element).textContent).toBe('主对话原稿，不因查看工作而发送')
  expect(f.submit).not.toHaveBeenCalled(); expect(f.respond).not.toHaveBeenCalled()
})

it('rejects a wrong Host work reading while keeping the source event and healthy original composer', async () => {
  const f = await original(); f.wrongWorkHost()
  await click(button(f.view.element, '事件历史 · 1')); await click(f.view.element.querySelector('.mote-conversation__history .mote-work-event__summary')!)
  await wait(() => expect(f.view.element.textContent).toContain('另一执行端的记录'))
  expect(f.view.element.querySelector('[data-mote-work-event]')?.getAttribute('data-mote-work-event')).toBe(work.eventId)
  await paste(f.view.element, '原健康输入仍保留')
  expect(button(f.view.element, 'Send').disabled).toBe(false)
  expect(f.owner.snapshot().record.selectedSessionId).toBe(sid)
  expect(f.submit).not.toHaveBeenCalled()
})

it('keeps original linked events when discovery becomes unconfirmed and does not convert turn reports into task acceptance', async () => {
  const f = await original(); await wait(() => expect(f.view.element.textContent).toContain('核对原资料并给出带来源的结论'))
  f.setPage({ ...dialogue(), links: [], sourceStatus: 'unconfirmed', sourceIssue: '原关联读取暂不可用' })
  await click(button(f.view.element.querySelector<HTMLElement>('.mote-conversation__navigation')!, '刷新'))
  await wait(() => expect(f.view.element.textContent).toContain('原关联读取暂不可用'))
  expect(f.view.element.querySelector('[data-mote-work-event]')?.getAttribute('data-mote-work-event')).toBe(work.eventId)
  expect(f.view.element.textContent).not.toContain('任务已验收')
  expect(f.submit).not.toHaveBeenCalled()
})

it('does not attach the newly selected connection to a retained older page or borrow its Mote target', async () => {
  const f = await original(), second = fixture(), reading = deferred<any>()
  second.client.readAgentConversation = vi.fn().mockReturnValue(reading.promise)
  const rpc = vi.fn(async (method: string) => method === 'space.ls' ? { catalog: catalog() } : method === 'space.mote.dialogue.read' ? dialogue() : { agents: [], unavailable: [], goals: [] })
  second.client.forwardRpc = rpc
  const oldReads = f.rpc.mock.calls.filter(([method]) => method === 'space.mote.dialogue.read').length
  await f.view.render(f.render(second.client))
  await act(async () => {})
  expect(rpc.mock.calls.filter(([method]) => method === 'space.mote.dialogue.read').length).toBeGreaterThan(0)
  expect(rpc.mock.calls.filter(([method]) => method === 'message.dispatch.read')).toHaveLength(0)
  expect(f.rpc.mock.calls.filter(([method]) => method === 'space.mote.dialogue.read')).toHaveLength(oldReads)
  expect(f.view.element.querySelector('[data-mote-dialogue]')).toBeNull()
  expect(editor(f.view.element)).not.toBeNull()
  expect(f.submit).not.toHaveBeenCalled(); expect(second.submit).not.toHaveBeenCalled()
})

it('returns to the original dialogue reader main after a role change instead of a stale team main', async () => {
  const f = await original(), replacement = { ...main, sessionId: 'peer', tabId: 'replacement-tab', regionId: 'replacement-region' }
  f.setPage({ ...dialogue(), main: { ...dialogue().main, roleRevision: 'replacement-role', current: replacement } })
  await click(button(f.view.element.querySelector<HTMLElement>('.mote-conversation__navigation')!, '刷新'))
  await wait(() => expect(f.view.element.textContent).toContain('回到 持续产品搭档'))
  expect(f.view.element.querySelector('.mobile-mote-recipient small')?.textContent).toBe('成员')
  await click(button(f.view.element, '回到 持续产品搭档'))
  await wait(() => expect(f.owner.snapshot().record.selectedSessionId).toBe('peer'))
  expect(f.view.element.querySelector('.mobile-mote-recipient small')?.textContent).toBe('主 Agent')
  expect(f.submit).not.toHaveBeenCalled()
})

it('keeps an unconfirmed main as an original reference without presenting a current main badge or disabling healthy input', async () => {
  const f = await original()
  f.setPage({ ...dialogue(), main: { ...dialogue().main, status: 'unconfirmed', issue: '原主角色暂不可核对' } })
  await click(button(f.view.element.querySelector<HTMLElement>('.mote-conversation__navigation')!, '刷新'))
  await wait(() => expect(f.view.element.querySelector('.mobile-mote-recipient small')?.textContent).toBe('主角色待核对'))
  await click(button(f.view.element, '查看本 Mote 团队'))
  const panel = document.querySelector<HTMLElement>('[aria-label="本 Mote 团队"]')!
  expect([...panel.querySelectorAll('.mobile-mote-role')].filter(node => node.textContent === '主 Agent')).toHaveLength(0)
  expect(button(panel, '打开上次主对话')).toBeDefined()
  await click(button(document.body, '关闭面板'))
  await paste(f.view.element, '未知角色不拿走原输入')
  expect(button(f.view.element, 'Send').disabled).toBe(false)
  f.setPage({ ...dialogue(), sourceStatus: 'unconfirmed', sourceIssue: '工作关联尚未读全' })
  await click(button(f.view.element.querySelector<HTMLElement>('.mote-conversation__navigation')!, '刷新'))
  await wait(() => expect(f.view.element.querySelector('.mobile-mote-recipient small')?.textContent).toBe('主 Agent'))
  f.failDialogueRead()
  await click(button(f.view.element.querySelector<HTMLElement>('.mote-conversation__navigation')!, '刷新'))
  await wait(() => expect(f.view.element.querySelector('.mobile-mote-recipient small')?.textContent).toBe('主角色待核对'))
  expect(button(f.view.element, '主对话 · 待核对')).toBeDefined()
  expect(editor(f.view.element).textContent).toBe('未知角色不拿走原输入')
  expect(button(f.view.element, 'Send').disabled).toBe(false)
  expect(f.submit).not.toHaveBeenCalled()
})

it('sends actual main Composer input only through the role qualified public port after freezing its original source', async () => {
  const f = await original(); await paste(f.view.element, '持续主对话的原输入'); await click(button(f.view.element, 'Send'))
  await wait(() => expect(f.owner.snapshot().record.conversation.attempts[0]?.[1].phase).toBe('confirmed'))
  await wait(() => expect(f.rpc.mock.calls.filter(([method]) => method === 'space.mote.dialogue.input.submit')).toHaveLength(1))
  const packet = f.rpc.mock.calls.find(([method]) => method === 'space.mote.dialogue.input.submit')![1]
  expect(packet).toMatchObject({ target, expectedRoleRevision: 'original-role', input: { prompt: '持续主对话的原输入', admissionIntent: { kind: 'manual-actor' }, moteGuidance: true } })
  expect(packet.input).not.toHaveProperty('agentMuxNote'); expect(packet.input).not.toHaveProperty('authorHuman')
  expect(f.owner.snapshot().record.conversation.attempts[0]![1]).toMatchObject({ moteMain: { target, expectedRoleRevision: 'original-role', reference: main } })
  expect(f.submit).not.toHaveBeenCalled()
})

it('inspects an original unknown main operation after A to B without resubmitting through either main or generic intake', async () => {
  const f = await original(); f.mainInput('lost'); await paste(f.view.element, '未知原主输入 A'); await click(button(f.view.element, 'Send'))
  await wait(() => expect(f.owner.snapshot().record.conversation.attempts[0]?.[1].phase).toBe('unknown'))
  const originalPacket = structuredClone(f.rpc.mock.calls.find(([method]) => method === 'space.mote.dialogue.input.submit')![1])
  f.setPage({ ...dialogue(), main: { ...dialogue().main, roleRevision: 'role-B', current: { ...main, sessionId: worker, regionId: 'worker-region' } } })
  await click(button(f.view.element.querySelector<HTMLElement>('.mote-conversation__navigation')!, '刷新'))
  await wait(() => expect(f.view.element.querySelector('.mobile-mote-recipient small')?.textContent).toBe('成员'))
  await click(button(f.view.element.querySelector<HTMLElement>('.mobile-send-status')!, '核对原主对话输入'))
  await wait(() => expect(f.owner.snapshot().record.conversation.attempts[0]?.[1].phase).toBe('confirmed'))
  expect(f.rpc.mock.calls.filter(([method]) => method === 'space.mote.dialogue.input.submit')).toHaveLength(1)
  expect(f.rpc).toHaveBeenCalledWith('space.mote.dialogue.input.inspect', { target, operationId: originalPacket.input.operationId })
  expect(f.owner.snapshot().record.conversation.attempts[0]![1].moteMain?.expectedRoleRevision).toBe('original-role')
  expect(f.submit).not.toHaveBeenCalled()
})

it('keeps ordinary Enter exact conditions and confirms only a complete original Core record', async () => {
  const f = await original(); await paste(f.view.element, '按原轮次条件继续'); await plainEnter(f.view.element)
  await wait(() => expect(f.owner.snapshot().record.conversation.attempts[0]?.[1].phase).toBe('confirmed'))
  const packet = f.rpc.mock.calls.find(([method]) => method === 'space.mote.dialogue.input.submit')![1].input
  expect(packet).toMatchObject({ execution: 'default', expectedRun: { runId: 'run-original' }, afterSubmissionId: null })
  expect(packet).not.toHaveProperty('admissionIntent'); expect(f.submit).not.toHaveBeenCalled()
})

it('does not confirm a main exact input from payload only and reads its same operation on retry', async () => {
  const f = await original(); f.mainInput('partial'); await paste(f.view.element, '仅原payload尚未提交'); await plainEnter(f.view.element)
  await wait(() => expect(f.owner.snapshot().record.conversation.attempts[0]?.[1].phase).toBe('unknown'))
  const packet = f.rpc.mock.calls.find(([method]) => method === 'space.mote.dialogue.input.submit')![1].input
  await click(button(f.view.element, '核对原主对话输入'))
  await wait(() => expect(f.rpc).toHaveBeenCalledWith('space.mote.dialogue.input.inspect', { target, operationId: packet.operationId }))
  expect(f.owner.snapshot().record.conversation.attempts[0]![1].phase).toBe('unknown')
  expect(editor(f.view.element).textContent).toBe('仅原payload尚未提交')
  expect(f.rpc.mock.calls.filter(([method]) => method === 'space.mote.dialogue.input.submit')).toHaveLength(1)
  expect(f.submit).not.toHaveBeenCalled()
})

it('does not fall back to generic input when the Host refuses the frozen main role', async () => {
  const f = await original(); f.mainInput('refused'); await paste(f.view.element, '主角色拒绝也保留正文'); await click(button(f.view.element, 'Send'))
  await wait(() => expect(f.owner.snapshot().record.conversation.attempts[0]?.[1].phase).toBe('unknown'))
  expect(editor(f.view.element).textContent).toBe('主角色拒绝也保留正文')
  expect(f.owner.snapshot().record.selectedSessionId).toBe(sid)
  expect(f.submit).not.toHaveBeenCalled()
})

it('keeps explicit member navigation generic even if that exact member later becomes the main', async () => {
  const f = await original(); await click(button(f.view.element, '查看本 Mote 团队'))
  await click(button(document.querySelector<HTMLElement>('[aria-label="本 Mote 团队"]')!, '打开原成员 · 资料研究员'))
  f.setPage({ ...dialogue(), main: { ...dialogue().main, roleRevision: 'role-worker', current: { ...main, sessionId: worker, regionId: 'worker-region' } } })
  await click(button(f.view.element.querySelector<HTMLElement>('.mote-conversation__navigation')!, '刷新'))
  await wait(() => expect(f.view.element.querySelector('.mobile-mote-recipient small')?.textContent).toBe('主 Agent'))
  await paste(f.view.element, '明确给原成员的输入'); await click(button(f.view.element, 'Send'))
  await wait(() => expect(f.submit).toHaveBeenCalledOnce())
  expect(f.submit.mock.calls[0]![0].agentSessionId).toBe(worker)
  expect(f.rpc.mock.calls.filter(([method]) => method === 'space.mote.dialogue.input.submit')).toHaveLength(0)
})

it('keeps healthy current Agent input generic when no main role has been established', async () => {
  const f = await original(); f.setPage({ ...dialogue(), main: { ...dialogue().main, status: 'unconfirmed', current: null, roleRevision: null, issue: '原主角色未确认' } })
  await click(button(f.view.element.querySelector<HTMLElement>('.mote-conversation__navigation')!, '刷新'))
  await wait(() => expect(f.view.element.querySelector('.mobile-mote-recipient small')?.textContent).toBe('主角色待核对'))
  await paste(f.view.element, '给原Agent的新输入'); await click(button(f.view.element, 'Send'))
  await wait(() => expect(f.submit).toHaveBeenCalledOnce())
  expect(f.submit.mock.calls[0]![0].agentSessionId).toBe(sid)
  expect(f.rpc.mock.calls.filter(([method]) => method === 'space.mote.dialogue.input.submit')).toHaveLength(0)
})

it('refuses a known wrong Host for the observed main without falling back to the same bare SID', async () => {
  const f = await original()
  const originalSession = f.sessions.get(sid)!
  f.emit({ type: 'agent-session', session: { ...originalSession, hostId: 'foreign-host' } })
  await paste(f.view.element, '准确主目标不符保留正文'); await click(button(f.view.element, 'Send'))
  await wait(() => expect(f.owner.snapshot().record.conversation.attempts[0]?.[1].phase).toBe('rejected'))
  expect(editor(f.view.element).textContent).toBe('准确主目标不符保留正文')
  expect(f.submit).not.toHaveBeenCalled()
  expect(f.rpc.mock.calls.filter(([method]) => method === 'space.mote.dialogue.input.submit')).toHaveLength(0)
})

it('retains a pending main intake across cold remount and only inspects its original role and operation after replacement', async () => {
  const f = await original(); f.mainInput('pending'); await paste(f.view.element, '主输入尚无Core回执'); await click(button(f.view.element, 'Send'))
  await wait(() => expect(f.owner.snapshot().record.conversation.attempts[0]?.[1].phase).toBe('unknown'))
  const packet = structuredClone(f.owner.snapshot().record.conversation.attempts[0]![1])
  f.setPage({ ...dialogue(), main: { ...dialogue().main, roleRevision: 'role-B', current: { ...main, sessionId: worker, regionId: 'worker-region' } } })
  await f.view.render(null); await f.view.render(f.render())
  await wait(() => expect(f.view.element.querySelector('.mobile-mote-recipient small')?.textContent).toBe('成员'))
  await click(button(f.view.element.querySelector<HTMLElement>('.mobile-send-status')!, '核对原主对话输入'))
  await wait(() => expect(f.rpc.mock.calls.filter(([method]) => method === 'space.mote.dialogue.input.inspect').length).toBeGreaterThan(0))
  expect(f.rpc.mock.calls.filter(([method]) => method === 'space.mote.dialogue.input.submit')).toHaveLength(1)
  const retained = f.owner.snapshot().record.conversation.attempts[0]![1]
  expect(retained.moteMain).toEqual(packet.moteMain); expect(retained.operationId).toBe(packet.operationId)
  expect(retained.phase).toBe('unknown'); expect(retained).not.toHaveProperty('agentMuxNote')
  expect(editor(f.view.element).textContent).toBe('主输入尚无Core回执')
  expect(f.submit).not.toHaveBeenCalled()
})

it('shows the same static Mote identity for exact previous and current main sources after A to B without rewriting original source IDs', async () => {
  const f = await original(), prior = { sequence: 1, kind: 'main' as const, identity, operationId: 'original-main-link', associatedAt: 1,
    roleRevision: 'original-role', reference: main, range: 'whole-session' as const, file: { resource: file, revision: 'original-file-revision' } }
  f.setPage({ ...dialogue(), links: [work, prior], main: { ...dialogue().main, roleRevision: 'role-B', current: { ...main, sessionId: worker, regionId: 'worker-region' } } })
  await click(button(f.view.element.querySelector<HTMLElement>('.mote-conversation__navigation')!, '刷新'))
  await wait(() => expect(f.view.element.textContent).toContain('回到 持续产品搭档'))
  await click(button(f.view.element, '回到 持续产品搭档'))
  await wait(() => expect(f.view.element.querySelector('[data-mote-earlier-source] [data-mote-speaker]')).not.toBeNull())
  const previous = f.view.element.querySelector('[data-mote-earlier-source]')!
  expect(JSON.parse(previous.getAttribute('data-mote-earlier-source')!)).toEqual({ hostId, agentSessionId: sid })
  expect(previous.querySelector('[data-mote-speaker]')?.getAttribute('data-mote-speaker')).toBe(spaceId)
  expect(previous.textContent).toContain('阅读范围与来源'); expect(previous.textContent).not.toContain('Current reading window')
  await wait(() => expect([...f.view.element.querySelectorAll('[data-mote-speaker]')].some(node => !node.closest('[data-mote-earlier-source]') && node.getAttribute('data-mote-speaker') === spaceId)).toBe(true))
  expect(f.owner.snapshot().record.selectedSessionId).toBe(worker)
  expect(f.submit).not.toHaveBeenCalled()
})

it('keeps work reply names scoped to the original Host and message when an event spans repeated message IDs', async () => {
  const keyIssues = vi.spyOn(console, 'error')
  const f = await original(), foreign = { ...work, sequence: 3, operationId: 'foreign-original-link', main: { hostId: 'foreign-host', agentSessionId: sid }, origin: { ...work.origin, hostId: 'foreign-host' } }
  f.client.forwardRpc = (async (method: string, input: any, ...rest: any[]) => method === 'message.dispatch.read' && input.hostId === 'foreign-host'
    ? structuredClone({ ...dispatch, hostId: 'foreign-host' }) : (f.rpc as any)(method, input, ...rest)) as typeof f.client.forwardRpc
  f.setPage({ ...dialogue(), throughSequence: 3, links: [foreign, work] })
  await click(button(f.view.element.querySelector<HTMLElement>('.mote-conversation__navigation')!, '刷新'))
  await click(button(f.view.element, '事件历史 · 1'))
  await click(f.view.element.querySelector('.mote-conversation__history .mote-work-event__summary')!)
  await wait(() => expect(f.view.element.querySelectorAll('.mote-conversation__history .mote-work-event__reply small')).toHaveLength(4))
  const headers = [...f.view.element.querySelectorAll('.mote-conversation__history .mote-work-event__reply small')].map(node => node.textContent)
  expect(headers[0]).toContain('资料研究员')
  expect(headers[2]).toContain(worker); expect(headers[2]).not.toContain('资料研究员')
  expect(keyIssues.mock.calls.filter(args => args.some(value => typeof value === 'string' && value.includes('Encountered two children with the same key')))).toHaveLength(0)
  expect(f.owner.snapshot().record.selectedSessionId).toBe(sid); expect(f.submit).not.toHaveBeenCalled()
})
