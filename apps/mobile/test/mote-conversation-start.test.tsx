// @vitest-environment happy-dom
import './device-locks'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MobileApp } from '../src/MobileApp'
import { createBrowserPlatform } from '../src/platform/browser'
import { DeviceWorkfaceStore, emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { button, click, fixture, mount, mounted, paste, editor, deferred } from './conversation-fixture'
import { mobileMoteStartDraftKey } from '../src/conversation/mote-composer'
import { MobileMoteMainActions } from '../src/navigation/MobileMoteMainActions'
import type { MobileAgentCreateIntent } from '../src/recovery/agent-create-intents'
import { createMoteConversationStartFixture } from '../../host/test/helpers/mote-conversation-start-fixture'
import { moteQuickBaseline } from '@agentmux/core/mote-preferences'
import { agentPromptSubmissionOutcome } from '@agentmux/core/mote-dialogue'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openPrimary } from './mobile-root-navigation'

const closing: Array<() => Promise<unknown>> = []
beforeEach(async () => { localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => {
  for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }
  for (const close of closing.splice(0).reverse()) await close()
  document.body.replaceChildren(); vi.restoreAllMocks()
})
async function wait(check: () => void) { await vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 15000, interval: 20 }) }
// The Core fixture deliberately clears AgentMux runtime env before opening its private owner.
const retentionEvidenceDirectory = process.env.AGENTMUX_MOTE_RETENTION_EVIDENCE
function retentionEvidence(surface: 'welcome' | 'profile', result: unknown, body: string | null) {
  if (retentionEvidenceDirectory) writeFileSync(join(retentionEvidenceDirectory, surface + '-fixture.json'), JSON.stringify({ surface, result, body }, null, 2))
}
async function actual(providerId: 'claude' = 'claude', earlyInputReceipt = false) {
  const host = await createMoteConversationStartFixture(providerId ? { providerId } : undefined); closing.push(host.close)
  const f = fixture(), owner = getDeviceWorkface(), content = { ...host.target.expectedResource, zoneId: host.target.zoneId }
  const identity = { name: 'Original Mote', project: 'Original', mote: { spaceId: host.target.spaceId, name: 'Original Mote', contentReference: content } }
  await owner.confirmHost({ origin: location.origin, hostId: 'local' })
  await owner.updatePresentation({ selectedSessionId: null, hostUrl: '', panel: 'conversation' }, { primary: 'mote', showSession: true, showGoalWork: false,
    recentMoteSpaceId: host.target.spaceId, identity, profile: null, moteView: { spaceId: host.target.spaceId, section: 'discussion', detail: false, directAgent: false } })
  f.client.runtimeOwnerIdentity = () => ({ runtimeId: 'actual-start-runtime', ownerInstanceId: 'actual-start-process', availability: 'connected' }) as ReturnType<AgentMuxHostedClient['runtimeOwnerIdentity']>
  let lost = false, unknownNative = false, dueBarrier: ReturnType<typeof deferred<void>> | null = null, barrier: ReturnType<typeof deferred<void>> | null = null
  const observations: Array<{ method: string; result: any }> = []
  const rpc = vi.fn(async (method: any, input: any) => {
    if (method === 'space.mote.dialogue.setup.advance' && unknownNative) { unknownNative = false; host.h.inner.kernel.input.mockImplementationOnce(async () => { throw Error('Original native input ACK is unknown') }) }
    const result: any = method === 'space.mote.dialogue.setup.advance' && !earlyInputReceipt
      ? await host.setup(input.creation.operationId) : await host.rpc.call(method, input)
    observations.push({ method, result })
    if (method === 'space.mote.dialogue.input.submit' && result.disposition === 'rollover-required' && dueBarrier) await dueBarrier.promise
    if (method === 'space.mote.dialogue.setup.advance') {
      if (result.reference) f.sessions.set(result.reference.sessionId, (await host.h.client.readAgentSession(result.reference.sessionId))!)
      if (barrier) await barrier.promise
      if (lost) throw Error('Original setup receipt lost after the actual owner applied it')
    }
    return result
  })
  const changes = vi.fn(host.h.client.readConversationChanges.bind(host.h.client))
  f.client.readAgentConversation = host.h.client.readAgentConversation.bind(host.h.client)
  f.client.readConversationChanges = changes
  f.client.observeConversation = host.h.client.observeConversation.bind(host.h.client)
  f.client.releaseConversationView = host.h.client.releaseConversationView.bind(host.h.client)
  f.client.forwardRpc = rpc as AgentMuxHostedClient['forwardRpc']
  const unlisten = host.h.client.onEvent(event => f.emit(event)); closing.push(async () => unlisten())
  const render = () => <MobileApp client={f.client} connection={{ state: 'connected', message: 'Original host' }} platform={createBrowserPlatform()} restoreWorkface />
  const view = await mount(render())
  await wait(() => expect(view.element.querySelector('.mobile-mote-composer [contenteditable="true"]')).toBeTruthy())
  const scene = () => view.element.querySelector<HTMLElement>('.mobile-conversation-panel')!
  const key = mobileMoteStartDraftKey(f.client, host.target)
  return { host, f, owner, rpc, observations, view, render, scene, key, changes, holdDue() { dueBarrier = deferred<void>(); return dueBarrier }, unknownNative() { unknownNative = true }, lose() { lost = true }, hold() { barrier = deferred<void>(); return barrier } }
}

async function openNewRound(f: Awaited<ReturnType<typeof actual>>) {
  await wait(() => expect(f.view.element.querySelector('[data-mote-discussion]')).toBeTruthy())
  await wait(() => expect(f.view.element.querySelector('button[aria-label="当前对话操作"]')).toBeTruthy())
  await click(button(f.view.element, '当前对话操作'))
  await wait(() => expect(document.body.querySelector('button[aria-label="新一轮"]')).toBeTruthy())
  await click(button(document.body, '新一轮'))
}

it('actual Mobile App welcome is editable before any Main exists and one send reaches original Device intent/public Core/File setup', async () => {
  const f = await actual()
  expect(f.rpc.mock.calls.filter(([method]) => method === 'agent.open')).toHaveLength(0)
  await paste(f.scene(), 'First exact Query')
  await wait(() => expect(new Map(f.owner.snapshot().record.conversation.drafts).get(f.key), JSON.stringify({ expected: f.key, actual: f.owner.snapshot().record.conversation })).toBe('First exact Query'))
  expect(f.key).not.toBe(JSON.stringify(['draft', null])); expect((f.scene()?.textContent ?? '')).not.toMatch(/麦克风|语音|录音/)
  await wait(() => expect(button(f.scene(), 'Send').disabled).toBe(false))
  await click(button(f.scene(), 'Send'))
  // The sent message is shown at once where the conversation shows it, in place of the greeting.
  await wait(() => expect(f.scene()?.querySelector('.mote-start__pending .mote-first-message')?.textContent).toContain('First exact Query'))
  expect(f.scene()?.querySelector('.mote-start__invitation')).toBeNull()
  await wait(() => expect(f.rpc.mock.calls.filter(([method]) => method === 'agent.open')).toHaveLength(1))
  await wait(() => expect(f.owner.snapshot().record.selectedSessionId, JSON.stringify({ body: f.scene().textContent,
    conversation: f.owner.snapshot().record.conversation, setup: f.observations.filter(item => item.method.includes('setup')).map(item => item.result),
    calls: f.rpc.mock.calls.map(([method]) => method) })).not.toBeNull())
  const packet = f.rpc.mock.calls.find(([method]) => method === 'agent.open')![1]
  expect(packet.moteMain.deferredInput.prompt).toBe('First exact Query'); expect(packet.content).not.toHaveProperty('prompt')
  expect(f.owner.snapshot().record.agentCreates?.find(value => value.input.operationId === packet.operationId)?.input).toEqual(packet)
  expect(new Map(f.owner.snapshot().record.conversation.drafts).get(f.key)).toBe('')
  const setup = await f.host.setup(packet.operationId, false)
  expect(setup.binding).toBe('confirmed'); expect(setup.deferredInput?.record).toBeTruthy()
  expect(f.rpc.mock.calls.filter(([method]) => method === 'agent.open')).toHaveLength(1)
})

it.each([false, true])('actual Mobile original early input receipt waits for native acceptance without replay and preserves later draft=%s', async laterDraft => {
  const f = await actual('claude', true), gate = deferred<void>(), originalWrite = f.host.h.inner.kernel.input.getMockImplementation()!
  closing.push(async () => gate.resolve())
  let nativeWaiting = false
  f.host.h.inner.kernel.input.mockImplementationOnce(async (...args: any[]) => {
    nativeWaiting = true; await gate.promise; return originalWrite(...args as Parameters<typeof originalWrite>)
  })
  const originalEditor = editor(f.scene()), query = 'Original early receipt Query'
  await paste(f.scene(), query); await wait(() => expect(button(f.scene(), 'Send').disabled).toBe(false)); await click(button(f.scene(), 'Send'))
  await wait(() => expect(nativeWaiting).toBe(true))
  await wait(() => expect(f.observations.some(item => item.method === 'space.mote.dialogue.setup.advance')).toBe(true))
  await wait(() => expect(f.observations.some(item => item.method === 'space.mote.dialogue.setup.inspect' &&
    item.result.deferredInput?.input?.status === 'waiting')).toBe(true))
  await wait(() => expect(f.observations.filter(item => item.method === 'space.mote.dialogue.setup.inspect')).toHaveLength(
    f.rpc.mock.calls.filter(([method]) => method === 'space.mote.dialogue.setup.inspect').length))
  expect(f.owner.snapshot().record.selectedSessionId).toBeNull()
  expect(f.scene().querySelector('.mote-first-message')?.getAttribute('data-stage')).not.toBe('delivered')
  if (laterDraft) await paste(f.scene(), 'Later C stays in this same Mote')
  await act(async () => gate.resolve())
  await wait(() => expect(f.observations.some(item => item.method === 'space.mote.dialogue.setup.inspect' &&
    ['admitted', 'terminal-confirmed'].includes(agentPromptSubmissionOutcome(item.result.deferredInput?.record ?? null)))).toBe(true))
  if (laterDraft) {
    await wait(() => expect(f.scene().textContent).toContain('首条消息已送达'))
    expect(new Map(f.owner.snapshot().record.conversation.drafts).get(f.key)).toBe('Later C stays in this same Mote')
  } else await wait(() => expect(f.owner.snapshot().record.selectedSessionId).not.toBeNull())
  expect(editor(f.scene())).toBe(originalEditor)
  expect(f.rpc.mock.calls.filter(([method]) => method === 'agent.open')).toHaveLength(1)
  expect(f.rpc.mock.calls.filter(([method]) => method === 'space.mote.dialogue.setup.advance')).toHaveLength(1)
  expect(f.host.h.inner.kernel.input.mock.calls.filter((call: any[]) => String(call[1]?.data).includes(query))).toHaveLength(1)
})

it('a delayed original A receipt cannot clear later B or steal the later Mobile selection', async () => {
  const f = await actual(), hold = f.hold()
  await paste(f.scene(), 'Original A Query'); await wait(() => expect(button(f.scene(), 'Send').disabled).toBe(false))
  await click(button(f.scene(), 'Send')); await wait(() => expect(f.rpc.mock.calls.filter(([method]) => method === 'agent.open')).toHaveLength(1))
  await act(async () => { editor(f.scene()).replaceChildren(document.createElement('p')); editor(f.scene()).dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' })) })
  await paste(f.scene(), 'Later B Query')
  await wait(() => expect(new Map(f.owner.snapshot().record.conversation.drafts).get(f.key)).toBe('Later B Query'))
  await act(async () => hold.resolve())
  await wait(() => expect((f.scene()?.textContent ?? '')).toContain('首条消息已送达'))
  expect(new Map(f.owner.snapshot().record.conversation.drafts).get(f.key)).toBe('Later B Query')
  expect(f.owner.snapshot().record.selectedSessionId).toBeNull()
  expect(f.rpc.mock.calls.filter(([method]) => method === 'agent.open')).toHaveLength(1)
})

it('the actual welcome keeps delivered A and its independent setup issue visible beside later draft B', async () => {
  const f = await actual(), hold = f.hold()
  const retention = vi.spyOn(f.host.spatial, 'recordMoteMainBindingResult').mockRejectedValue(Error('Original metadata disk unavailable'))
  await paste(f.scene(), 'Original A Query'); await wait(() => expect(button(f.scene(), 'Send').disabled).toBe(false)); await click(button(f.scene(), 'Send'))
  await wait(() => expect(f.rpc.mock.calls.some(([method]) => method === 'space.mote.dialogue.setup.advance')).toBe(true))
  await wait(() => expect(f.host.h.inner.kernel.input).toHaveBeenCalled())
  await act(async () => { editor(f.scene()).replaceChildren(document.createElement('p')); editor(f.scene()).dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' })) })
  await paste(f.scene(), 'Later B Query')
  await act(async () => hold.resolve())
  const index = f.rpc.mock.calls.findIndex(([method]) => method === 'space.mote.dialogue.setup.advance')
  const result = await f.rpc.mock.results[index]!.value
  expect(result.binding).toBe('confirmed'); expect(result.issue).toContain('retention is unconfirmed')
  expect(['admitted', 'terminal-confirmed']).toContain(agentPromptSubmissionOutcome(result.deferredInput?.record ?? null))
  await wait(() => expect(f.rpc.mock.calls.some(([method]) => method === 'space.mote.dialogue.setup.inspect')).toBe(true))
  const observed = await f.rpc.mock.results[f.rpc.mock.calls.findIndex(([method]) => method === 'space.mote.dialogue.setup.inspect')]!.value
  await act(async () => {})
  expect(observed.binding).toBe('confirmed'); expect(observed.issue).toBeTruthy()
  await wait(() => { expect(f.scene().textContent).toContain('首条消息已送达。'); expect(f.scene().textContent).toContain(observed.issue) })
  expect(f.owner.snapshot().record.selectedSessionId).toBeNull()
  expect(new Map(f.owner.snapshot().record.conversation.drafts).get(f.key)).toBe('Later B Query')
  expect(editor(f.scene()).getAttribute('contenteditable')).toBe('true')
  retentionEvidence('welcome', observed, f.scene().textContent)
  await click(f.scene().querySelector('.mobile-mote-start-details > summary')!)
  const inputs = f.host.h.inner.kernel.input.mock.calls.length
  await wait(() => expect(button(f.scene(), '核对这次开始').disabled).toBe(false)); await click(button(f.scene(), '核对这次开始'))
  await wait(() => expect(f.rpc.mock.calls.filter(([method]) => method === 'space.mote.dialogue.setup.inspect').length).toBeGreaterThan(1))
  await wait(() => expect(button(f.scene(), '核对这次开始').disabled).toBe(false))
  expect(f.rpc.mock.calls.filter(([method]) => method === 'space.mote.dialogue.setup.inspect').at(-1)![1]).toEqual({ target: f.host.target, creation: { hostId: 'local', operationId: result.operationId } })
  await wait(() => expect(f.scene().textContent).toContain(observed.issue))
  retention.mockRestore()
  await wait(() => expect(button(f.scene(), '继续这次开始').disabled).toBe(false)); await click(button(f.scene(), '继续这次开始'))
  await wait(() => expect(f.scene().textContent).not.toContain(observed.issue))
  expect(f.rpc.mock.calls.filter(([method]) => method === 'space.mote.dialogue.setup.advance').at(-1)![1]).toEqual({ target: f.host.target, creation: { hostId: 'local', operationId: result.operationId } })
  expect(f.rpc.mock.calls.filter(([method]) => method === 'agent.open')).toHaveLength(1)
  expect(f.host.h.inner.kernel.input).toHaveBeenCalledTimes(inputs)
  expect(new Map(f.owner.snapshot().record.conversation.drafts).get(f.key)).toBe('Later B Query')
  expect(f.owner.snapshot().record.selectedSessionId).toBeNull()
})

it('the actual Profile parent retains confirmed Main and its independent setup issue on the original request', async () => {
  const f = await actual()
  const retention = vi.spyOn(f.host.spatial, 'recordMoteMainBindingResult').mockRejectedValue(Error('Original Profile metadata disk unavailable'))
  await click(f.view.element.querySelector<HTMLButtonElement>('.mobile-session-identity.mobile-mote-heading')!)
  const profile = () => document.body.querySelector<HTMLElement>('.mobile-mote-profile')!
  await wait(() => expect(profile()?.querySelector('.mobile-mote-setup')).toBeTruthy())
  await wait(() => expect(button(profile(), '开始对话').disabled).toBe(false)); await click(button(profile(), '开始对话'))
  await wait(() => expect(f.rpc.mock.calls.some(([method]) => method === 'space.mote.dialogue.setup.advance')).toBe(true))
  const index = f.rpc.mock.calls.findIndex(([method]) => method === 'space.mote.dialogue.setup.advance')
  const result = await f.rpc.mock.results[index]!.value
  expect(result.binding).toBe('confirmed'); expect(result.issue).toContain('retention is unconfirmed')
  expect(result.record.moteMain.deferredInput).toBeUndefined()
  await wait(() => expect(f.rpc.mock.calls.some(([method]) => method === 'space.mote.dialogue.setup.inspect')).toBe(true))
  const observed = await f.rpc.mock.results[f.rpc.mock.calls.findIndex(([method]) => method === 'space.mote.dialogue.setup.inspect')]!.value
  await act(async () => {})
  expect(observed.binding).toBe('confirmed'); expect(observed.issue).toBeTruthy()
  await wait(() => { expect(profile().textContent).toContain('Main 已绑定，可回到主对话。'); expect(profile().textContent).toContain(observed.issue) })
  expect(button(profile(), '打开主对话').disabled).toBe(false)
  retentionEvidence('profile', observed, profile().textContent)
  await click([...profile().querySelectorAll('summary')].find(node => node.textContent === '本次设置请求')!)
  expect(profile().textContent).toContain(result.operationId)
  const inputs = f.host.h.inner.kernel.input.mock.calls.length
  await wait(() => expect(button(profile(), '核对主 Agent 创建').disabled).toBe(false)); await click(button(profile(), '核对主 Agent 创建'))
  await wait(() => expect(f.rpc.mock.calls.filter(([method]) => method === 'space.mote.dialogue.setup.inspect').length).toBeGreaterThan(1))
  await wait(() => expect(button(profile(), '核对主 Agent 创建').disabled).toBe(false))
  expect(f.rpc.mock.calls.filter(([method]) => method === 'space.mote.dialogue.setup.inspect').at(-1)![1]).toEqual({ target: f.host.target, creation: { hostId: 'local', operationId: result.operationId } })
  await wait(() => expect(profile().textContent).toContain(observed.issue))
  retention.mockRestore()
  await wait(() => expect(button(profile(), '继续设置主 Agent').disabled).toBe(false)); await click(button(profile(), '继续设置主 Agent'))
  await wait(() => expect(profile().textContent).not.toContain(observed.issue))
  expect(f.rpc.mock.calls.filter(([method]) => method === 'space.mote.dialogue.setup.advance').at(-1)![1]).toEqual({ target: f.host.target, creation: { hostId: 'local', operationId: result.operationId } })
  expect(f.rpc.mock.calls.filter(([method]) => method === 'agent.open')).toHaveLength(1)
  expect(f.host.h.inner.kernel.input).toHaveBeenCalledTimes(inputs)
})

it('unknown setup outcome remounts through Core readonly inspection without creating or replaying a Query', async () => {
  const f = await actual(); f.unknownNative(); f.lose()
  await paste(f.scene(), 'Keep unknown Query'); await wait(() => expect(button(f.scene(), 'Send').disabled).toBe(false)); await click(button(f.scene(), 'Send'))
  await wait(() => expect((f.scene()?.textContent ?? '')).toContain('Original setup receipt lost'))
  const opens = f.rpc.mock.calls.filter(([method]) => method === 'agent.open').length
  await f.view.render(null); await f.view.render(f.render())
  await wait(() => expect(f.view.element.querySelector('.mobile-mote-composer [contenteditable="true"]')).toBeTruthy())
  await wait(() => expect(f.rpc.mock.calls.some(([method]) => method === 'space.mote.dialogue.setup.inspect')).toBe(true))
  expect(f.rpc.mock.calls.filter(([method]) => method === 'agent.open')).toHaveLength(opens)
  expect(f.owner.snapshot().record.agentCreates?.some(item => item.input.moteMain?.deferredInput?.prompt === 'Keep unknown Query')).toBe(true)
  expect(new Map(f.owner.snapshot().record.conversation.drafts).get(f.key)).toBe('')
})

it('first Mobile input retains original A before waiting for Core and readonly inspection stays available beside durable later draft B', async () => {
  const f = await actual(), query = 'Original A before Core observation', later = 'Later B remains editable'
  const barrier = deferred<void>(); closing.push(async () => barrier.resolve())
  const rpc = f.rpc.getMockImplementation()!; let held = false, armed = false
  f.rpc.mockImplementation(async (method, input) => {
    if (method === 'space.state' && armed && !held) {
      held = true; await barrier.promise
    }
    return rpc(method, input)
  })
  await paste(f.scene(), query); await wait(() => expect(button(f.scene(), 'Send').disabled).toBe(false)); armed = true; await click(button(f.scene(), 'Send'))
  await wait(() => { expect(held).toBe(true); expect(new Map(f.owner.snapshot().record.conversation.drafts).get(f.key)).toBe('') })
  const original = f.owner.snapshot().record.agentCreates!.find(item => item.input.moteMain?.deferredInput?.prompt === query)!
  expect(f.scene().textContent?.split(query).length).toBe(2)
  expect(f.rpc.mock.calls.filter(([method]) => method === 'agent.open')).toHaveLength(0)
  await paste(f.scene(), later)
  await wait(() => expect(new Map(f.owner.snapshot().record.conversation.drafts).get(f.key)).toBe(later))
  expect(button(f.scene(), '核对').disabled).toBe(false); await click(button(f.scene(), '核对'))
  await wait(() => expect(f.scene().querySelector('.mote-first-message')?.getAttribute('data-stage')).toBe('unconfirmed'))
  expect(f.rpc.mock.calls.filter(([method]) => method === 'space.mote.dialogue.setup.inspect').at(-1)![1]).toEqual({ target: f.host.target, creation: { hostId: 'local', operationId: original.input.operationId } })
  const cold = new DeviceWorkfaceStore(() => localStorage).snapshot().record
  expect(cold.agentCreates?.find(item => item.input.operationId === original.input.operationId)?.input).toEqual(original.input)
  expect(new Map(cold.conversation.drafts).get(f.key)).toBe(later)
  await f.view.render(null); await f.view.render(f.render())
  await wait(() => expect(f.scene()?.textContent).toContain(query))
  expect(new Map(f.owner.snapshot().record.conversation.drafts).get(f.key)).toBe(later)
  expect(f.rpc.mock.calls.filter(([method]) => method === 'agent.open')).toHaveLength(0)
  await act(async () => barrier.resolve())
  await wait(() => expect(f.rpc.mock.calls.filter(([method]) => method === 'agent.open')).toHaveLength(1))
  await wait(() => expect(JSON.stringify(f.host.h.inner.kernel.input.mock.calls)).toContain(query))
  expect(new Map(f.owner.snapshot().record.conversation.drafts).get(f.key)).toBe(later)
  expect(f.owner.snapshot().record.selectedSessionId).toBeNull()
})

it('first Mobile input is shown once with no dispatch if its original Device intent cannot be saved', async () => {
  const f = await actual(), query = 'A stays in the draft when intent custody fails'
  await paste(f.scene(), query); await wait(() => expect(button(f.scene(), 'Send').disabled).toBe(false))
  vi.spyOn(f.owner, 'retainAgentCreate').mockRejectedValue(Error('Original Device intent disk unavailable'))
  await click(button(f.scene(), 'Send'))
  await wait(() => expect(f.scene().textContent).toContain('Original Device intent disk unavailable'))
  expect(new Map(f.owner.snapshot().record.conversation.drafts).get(f.key)).toBe(query)
  expect(f.scene().textContent?.split(query).length).toBe(2)
  expect(f.scene().querySelector('.mote-first-message .log-turn')).toBeNull()
  expect(f.rpc.mock.calls.filter(([method]) => method === 'agent.open')).toHaveLength(0)
})

it('first Mobile input custody confirmation keeps later B typed while that confirmation waits', async () => {
  const f = await actual(), query = 'A before the durable Device confirmation', later = 'B written while the confirmation waits'
  const barrier = deferred<void>(); closing.push(async () => barrier.resolve())
  const retain = f.owner.retainAgentCreate.bind(f.owner)
  vi.spyOn(f.owner, 'retainAgentCreate').mockImplementation(async (intent, recordId) => {
    await retain(intent, recordId)
    if (intent.input.moteMain?.deferredInput?.prompt === query && intent.phase === 'sending') await barrier.promise
  })
  await paste(f.scene(), query); await wait(() => expect(button(f.scene(), 'Send').disabled).toBe(false)); await click(button(f.scene(), 'Send'))
  await wait(() => expect(f.owner.snapshot().record.agentCreates?.some(item => item.input.moteMain?.deferredInput?.prompt === query)).toBe(true))
  expect(f.scene().textContent?.split(query).length).toBe(2)
  await act(async () => { editor(f.scene()).replaceChildren(document.createTextNode(later)); editor(f.scene()).dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' })) })
  await wait(() => expect(new Map(f.owner.snapshot().record.conversation.drafts).get(f.key)).toBe(later))
  await act(async () => barrier.resolve())
  await wait(() => expect(JSON.stringify(f.host.h.inner.kernel.input.mock.calls)).toContain(query))
  expect(new Map(f.owner.snapshot().record.conversation.drafts).get(f.key)).toBe(later)
  expect(f.owner.snapshot().record.selectedSessionId).toBeNull()
  expect(f.rpc.mock.calls.filter(([method]) => method === 'agent.open')).toHaveLength(1)
})

it.each(['cold-read', 'advance'] as const)('conflicting Device first input stays pending after %s and 32 later original creations are archived', async action => {
  const f = await actual(), operationId = 'mobile_conflicting_creation', other = 'Original Core first question A'
  const prompt = action === 'cold-read' ? 'Device B question still needs custody' : other
  await f.view.render(null)
  await f.host.start(operationId, other)
  const setup = await f.host.setup(operationId)
  expect(setup.creation).toBe('confirmed'); expect(setup.binding).toBe('confirmed')
  const canonical = setup.record!, opened = vi.fn()
  const intent: MobileAgentCreateIntent = { runtimeId: 'actual-start-runtime', deviceHostId: 'local', phase: 'unknown',
    input: { operationId, content: { kind: 'new-agent', executorId: canonical.executorId },
      destination: { spaceId: f.host.target.spaceId, zoneId: f.host.target.zoneId, newTab: true }, focus: false,
      moteMain: { ...canonical.moteMain!, deferredInput: { operationId: action === 'cold-read' ? canonical.moteMain!.deferredInput!.operationId : 'device_b_first_question', prompt } } } }
  await f.owner.retainAgentCreate(intent, f.owner.recordIdentity())
  const view = await mount(<MobileMoteMainActions client={f.f.client} target={f.host.target} visible onConfigure={() => {}} onBound={() => {}} onOpenMain={opened} />)
  await wait(() => expect(view.element.textContent).toContain('Main 已绑定'))
  if (action === 'advance') {
    const count = f.rpc.mock.calls.filter(([method]) => method === 'space.mote.dialogue.setup.advance').length
    await click(button(view.element, '继续设置主 Agent'))
    await wait(() => expect(f.rpc.mock.calls.filter(([method]) => method === 'space.mote.dialogue.setup.advance')).toHaveLength(count + 1))
    await wait(() => expect(button(view.element, '继续设置主 Agent').disabled).toBe(false))
  }
  expect(view.element.textContent).toContain(prompt)
  await click(button(view.element, '打开主对话')); expect(opened).toHaveBeenCalledOnce()
  expect(JSON.stringify(f.host.h.inner.kernel.input.mock.calls)).toContain(other)
  expect(canonical.moteMain!.deferredInput).not.toEqual(intent.input.moteMain!.deferredInput)
  if (action === 'advance') {
    const input = await f.host.rpc.call('space.mote.dialogue.input.inspect', { target: f.host.target, operationId: intent.input.moteMain!.deferredInput!.operationId })
    expect(input.route).toBeNull()
  } else expect(JSON.stringify(f.host.h.inner.kernel.input.mock.calls)).not.toContain(prompt)
  const firstSession = await f.host.h.client.readAgentSession(setup.reference!.sessionId)
  // Exercise the real Host/Core creator and Device pruning owner for the later
  // archived entries. They have no Mote first question and never change Main.
  for (let index = 0; index < 32; index++) {
    const input: MobileAgentCreateIntent['input'] = { operationId: 'later_original_' + action + '_' + index,
      content: { kind: 'new-agent', executorId: canonical.executorId },
      destination: { spaceId: f.host.target.spaceId, zoneId: f.host.target.zoneId, newTab: true }, focus: false }
    const result = await f.host.rpc.call('agent.open', input)
    expect(result.agent?.agentSessionId).toBeTruthy()
    await f.owner.retainAgentCreate({ runtimeId: intent.runtimeId, deviceHostId: intent.deviceHostId, input, phase: 'confirmed', agentSessionId: result.agent!.agentSessionId }, f.owner.recordIdentity())
  }
  const cold = new DeviceWorkfaceStore(() => localStorage).snapshot().record
  const retained = cold.agentCreates?.find(item => item.input.operationId === operationId)
  expect(retained?.phase).toBe('unknown'); expect(retained?.input).toEqual(intent.input)
  expect(cold.agentCreates!.filter(item => item.phase === 'confirmed').length).toBe(32)
  expect((await f.host.main.readCurrentMoteMain(f.host.target)).current).toEqual(setup.reference)
  expect((await f.host.h.client.readAgentSession(setup.reference!.sessionId))?.run).toEqual(firstSession!.run)
  expect(f.host.h.started).toHaveLength(33)
}, 60_000)

it('a Device Main creation without a first query still archives from its original confirmed Core creation', async () => {
  const f = await actual(), operationId = 'mobile_creation_without_first_query'
  await f.view.render(null); await f.host.start(operationId)
  const setup = await f.host.setup(operationId), canonical = setup.record!
  const input: MobileAgentCreateIntent['input'] = { operationId, content: { kind: 'new-agent', executorId: canonical.executorId },
    destination: { spaceId: f.host.target.spaceId, zoneId: f.host.target.zoneId, newTab: true }, focus: false, moteMain: canonical.moteMain! }
  await f.owner.retainAgentCreate({ runtimeId: 'actual-start-runtime', deviceHostId: 'local', input, phase: 'unknown' }, f.owner.recordIdentity())
  const view = await mount(<MobileMoteMainActions client={f.f.client} target={f.host.target} visible onConfigure={() => {}} onBound={() => {}} />)
  await wait(() => expect(view.element.textContent).toContain('Main 已绑定'))
  expect(f.owner.snapshot().record.agentCreates?.find(item => item.input.operationId === operationId)?.phase).toBe('confirmed')
  expect((await f.host.setup(operationId, false)).creation).toBe('confirmed')
})

it('retained Device first questions do not block an independent Core executor-change Query or become its confirmed intents', async () => {
  const f = await actual('claude'); await f.view.render(null)
  const kept: MobileAgentCreateIntent[] = []
  let current!: Awaited<ReturnType<typeof f.host.setup>>
  for (let index = 0; index < 2; index++) {
    const operationId = 'other_device_original_' + index
    await f.host.start(operationId, 'Other Device Core first question ' + index, index > 0)
    current = await f.host.setup(operationId)
    expect(current.creation).toBe('confirmed'); expect(current.binding).toBe('confirmed')
    f.f.sessions.set(current.reference!.sessionId, (await f.host.h.client.readAgentSession(current.reference!.sessionId))!)
    kept.push({ runtimeId: 'actual-start-runtime', deviceHostId: 'local', phase: 'unknown', input: { operationId,
      content: { kind: 'new-agent', executorId: current.record!.executorId }, destination: { spaceId: f.host.target.spaceId, zoneId: f.host.target.zoneId, newTab: true }, focus: false,
      moteMain: { ...current.record!.moteMain!, deferredInput: { operationId: 'retained_device_question_' + index, prompt: 'Keep this original Device question ' + index } } } })
  }
  for (const intent of kept) await f.owner.retainAgentCreate(intent, f.owner.recordIdentity())
  await f.owner.updateNavigation({ selectedSessionId: current.reference!.sessionId, hostUrl: '', panel: 'conversation' })
  await f.view.render(f.render())
  const old = current.reference!.sessionId, before = (await f.host.h.client.readAgentSession(old))!, route = await f.host.rpc.call('space.mote.dialogue.input.inspect', { target: f.host.target, operationId: current.record!.moteMain!.deferredInput!.operationId })
  const slot = () => f.view.element.querySelector<HTMLElement>('.mobile-conversation-panel')!
  await wait(() => expect(slot()?.querySelector('[contenteditable=true]')).toBeTruthy())
  const { readFile, writeFile } = await import('node:fs/promises')
  const path = join(f.host.h.root, 'configuration.json'), config = JSON.parse(await readFile(path, 'utf8'))
  config.executors.second = { ...config.executors.saved, label: 'Second executor while old question is retained' }
  await writeFile(path, JSON.stringify(config))
  const baseline = moteQuickBaseline(await f.host.quick.read({ kind: 'quick', target: f.host.target }))!
  const saved = await f.host.rpc.call('space.mote.preferences.save', { kind: 'quick', target: f.host.target, operationId: 'change_executor_with_retained_question', baseline,
    values: { ...baseline.defaults, executorId: 'second', conversationRollover: { kind: 'keep-current' } },
    destination: { kind: 'occurrence', displayWorkspaceId: current.reference!.displayWorkspaceId, groupId: current.reference!.groupId, tabId: current.reference!.tabId, regionId: current.reference!.regionId } })
  expect(saved.status).toBe('saved'); expect(f.host.h.started).toHaveLength(2)
  await paste(slot(), 'Independent new Question C'); await click(button(slot(), 'Send'))
  await wait(() => expect(f.rpc.mock.calls.filter(([method]) => method === 'agent.open')).toHaveLength(1))
  await wait(() => expect(f.owner.snapshot().record.selectedSessionId).not.toBe(old))
  const next = f.owner.snapshot().record.selectedSessionId!
  expect((await f.host.h.client.readAgentSession(next))?.executorId).toBe('second')
  for (const intent of kept) {
    const retained = f.owner.snapshot().record.agentCreates!.find(item => item.input.operationId === intent.input.operationId)
    expect(retained?.phase).toBe('unknown'); expect(retained?.input).toEqual(intent.input)
  }
  expect((await f.host.h.client.readAgentSession(old))?.run).toEqual(before.run)
  expect((await f.host.rpc.call('space.mote.dialogue.input.inspect', { target: f.host.target, operationId: current.record!.moteMain!.deferredInput!.operationId })).route?.key).toEqual(route.route?.key)
  expect(f.host.h.started).toHaveLength(3); expect(f.host.h.inner.kernel.stop).not.toHaveBeenCalled()
}, 60_000)

it('a genuinely unconfirmed original Core creation still prevents a second Mobile creation on the same role', async () => {
  const f = await actual(); await f.view.render(null)
  const barrier = deferred<void>(), entered = deferred<void>(), start = f.host.h.inner.kernel.start.getMockImplementation()!
  closing.push(async () => barrier.resolve())
  f.host.h.inner.kernel.start.mockImplementationOnce(async (...args: unknown[]) => { entered.resolve(); await barrier.promise; return start(...args) })
  const creating = f.host.start('original_core_creation_still_unconfirmed', 'Original frozen first Question')
  await entered.promise
  const observed = await f.host.setup('original_core_creation_still_unconfirmed', false)
  expect(observed.creation).toBe('unconfirmed')
  await f.view.render(f.render())
  await wait(() => expect([...f.scene().querySelectorAll('code')].some(node => node.textContent === 'original_core_creation_still_unconfirmed')).toBe(true))
  await paste(f.scene(), 'A later question is only a draft')
  expect(button(f.scene(), 'Send').disabled).toBe(true)
  const requests = f.rpc.mock.calls.filter(([method]) => method === 'agent.open').length
  await click(button(f.scene(), 'Send'))
  await f.view.render(null); await f.view.render(f.render())
  await wait(() => expect([...f.scene().querySelectorAll('code')].some(node => node.textContent === 'original_core_creation_still_unconfirmed')).toBe(true))
  expect(f.rpc.mock.calls.filter(([method]) => method === 'agent.open')).toHaveLength(requests)
  expect(f.host.h.inner.kernel.start).toHaveBeenCalledOnce()
  expect(new Map(f.owner.snapshot().record.conversation.drafts).get(f.key)).toBe('A later question is only a draft')
  await act(async () => barrier.resolve()); await creating
})

it('a live unknown Core creation invalidates the old ready read before a later B can leave its Composer', async () => {
  const f = await actual(), barrier = deferred<void>(), entered = deferred<void>()
  closing.push(async () => barrier.resolve())
  const start = f.host.h.inner.kernel.start.getMockImplementation()!, rpc = f.rpc.getMockImplementation()!
  f.host.h.inner.kernel.start.mockImplementationOnce(async (...args: unknown[]) => { entered.resolve(); await barrier.promise; return start(...args) })
  let creating: Promise<unknown> | undefined
  f.rpc.mockImplementation(async (method, input) => {
    if (method === 'agent.open' && !creating) {
      creating = rpc(method, input); void creating.catch(() => {})
      await entered.promise
      throw Error('Original creation reply unavailable while the original Core start is pending')
    }
    return rpc(method, input)
  })
  await paste(f.scene(), 'Original first question A'); await wait(() => expect(button(f.scene(), 'Send').disabled).toBe(false)); await click(button(f.scene(), 'Send'))
  await wait(() => expect(f.rpc.mock.calls.filter(([method]) => method === 'agent.open')).toHaveLength(1))
  const input = f.rpc.mock.calls.find(([method]) => method === 'agent.open')![1]
  await entered.promise
  const index = f.rpc.mock.calls.findIndex(([method]) => method === 'agent.open')
  await expect(f.rpc.mock.results[index]!.value).rejects.toThrow('Original creation reply unavailable')
  await wait(() => expect(f.scene().querySelector('.mote-first-message')?.getAttribute('data-stage')).toBe('unconfirmed'))
  await wait(() => expect([...f.scene().querySelectorAll('code')].some(node => node.textContent === input.operationId)).toBe(true))
  const observed = await f.host.setup(input.operationId, false)
  expect(observed.creation).toBe('unconfirmed')
  await paste(f.scene(), 'Later independent draft B')
  await wait(() => expect(new Map(f.owner.snapshot().record.conversation.drafts).get(f.key)).toBe('Later independent draft B'))
  expect(button(f.scene(), 'Send').disabled).toBe(true)
  await click(button(f.scene(), 'Send'))
  expect(f.rpc.mock.calls.filter(([method]) => method === 'agent.open')).toHaveLength(1)
  expect(f.owner.snapshot().record.agentCreates).toHaveLength(1)
  expect(f.owner.snapshot().record.agentCreates![0]!.input).toEqual(input)
  expect(f.host.h.inner.kernel.start).toHaveBeenCalledOnce()
  await act(async () => barrier.resolve()); await creating
  expect(new Map(f.owner.snapshot().record.conversation.drafts).get(f.key)).toBe('Later independent draft B')
})


it('an explicit Mobile new round hands over before its first Query and keeps the exact original historical period and its truthful source range', async () => {
  const f = await actual()
  await paste(f.scene(), 'First period Query'); await wait(() => expect(button(f.scene(), 'Send').disabled).toBe(false)); await click(button(f.scene(), 'Send'))
  await wait(() => expect(f.owner.snapshot().record.selectedSessionId).not.toBeNull())
  const firstSession = f.owner.snapshot().record.selectedSessionId!
  await openNewRound(f)
  await wait(() => expect(f.scene().querySelector<HTMLElement>('.mote-start')?.dataset.mode).toBe('new'))
  expect(f.view.element.querySelector('.mobile-session-tool-slot')?.hasAttribute('hidden')).toBe(true)
  expect(f.view.element.querySelector('.mobile-conversation-slot')?.hasAttribute('hidden')).toBe(true)
  const before = f.rpc.mock.calls.filter(([method]) => method === 'agent.open').length
  expect(before).toBe(1)
  await paste(f.scene(), 'Second period Query'); await wait(() => expect(button(f.scene(), 'Send').disabled).toBe(false)); await click(button(f.scene(), 'Send'))
  await wait(() => expect(f.owner.snapshot().record.selectedSessionId).not.toBe(firstSession))
  const packet = f.rpc.mock.calls.filter(([method]) => method === 'agent.open')[1]![1]
  expect(packet.moteMain.handover).toBe(true); expect(packet.moteMain.deferredInput.prompt).toBe('Second period Query')
  const setup = await f.host.setup(packet.operationId, false)
  expect(setup.handoverInput?.record).toBeTruthy(); expect(setup.deferredInput?.record).toBeTruthy()
  expect(await f.host.h.client.readAgentSession(firstSession)).toBeTruthy()
  const secondSession = f.owner.snapshot().record.selectedSessionId!
  await openNewRound(f)
  await wait(() => expect(f.scene().querySelector('[data-mote-period]')).toBeTruthy())
  const page = await f.host.rpc.call('space.mote.dialogue.read', { target: f.host.target })
  const live = page.links.find(link => link.kind === 'main' && link.reference.sessionId === secondSession)!
  if (live.kind !== 'main') throw Error('Current Main source required')
  const liveId = live.period?.id ?? JSON.stringify(['legacy-main', live.roleRevision, live.operationId])
  const liveRow = [...f.scene().querySelectorAll<HTMLElement>('[data-mote-period]')].find(row => row.dataset.motePeriod === liveId)!
  expect(liveRow.textContent).toContain('当前对话'); expect(liveRow.textContent).not.toContain('结束未记录')
  await click(liveRow.querySelector('button')!)
  await wait(() => expect(f.view.element.querySelector('[aria-label="主对话历史"]')).toBeNull())
  await wait(() => expect(f.owner.snapshot().record.selectedSessionId).toBe(secondSession))
  await openNewRound(f)
  await wait(() => expect(f.scene().querySelector('[data-mote-period]')).toBeTruthy())
  const source = (await f.host.rpc.call('space.mote.dialogue.read', { target: f.host.target })).links.find(link => link.kind === 'main' && link.reference.sessionId === firstSession)!
  expect(source.kind).toBe('main'); if (source.kind !== 'main') throw Error('Original historical Main source required')
  const periodId = source.period?.id ?? JSON.stringify(['legacy-main', source.roleRevision, source.operationId])
  const row = [...f.scene().querySelectorAll<HTMLElement>('[data-mote-period]')].find(row => row.dataset.motePeriod === periodId)?.querySelector('button')
  expect(row).toBeTruthy(); await click(row!)
  await wait(() => expect(f.view.element.querySelector('[aria-label="主对话历史"] .mote-conversation__earlier')).toBeTruthy())
  if (source.period?.range.kind === 'bounded' && source.period.range.through) {
    await wait(() => expect(f.changes).toHaveBeenCalled())
    expect(f.changes.mock.calls.at(-1)![0]).toMatchObject({ hostId: source.reference.hostId, agentSessionId: firstSession, checkpoint: source.period.range.after, through: source.period.range.through })
  } else {
    expect(f.changes).not.toHaveBeenCalled()
    expect(button(f.view.element.querySelector<HTMLElement>('[aria-label="主对话历史"]')!, '打开原 Agent 对话')).toBeTruthy()
    expect(f.view.element.textContent).toContain(source.period?.range.kind === 'unconfirmed' ? source.period.range.issue : '这段历史没有完整的消息边界记录')
  }
  expect(f.rpc.mock.calls.filter(([method]) => method === 'agent.open')).toHaveLength(2)
})

it('another client binding and confirming A never clears this Mobile Mote draft B', async () => {
  const f = await actual()
  await paste(f.scene(), 'This device B Query')
  await wait(() => expect(new Map(f.owner.snapshot().record.conversation.drafts).get(f.key)).toBe('This device B Query'))
  await f.host.start('other_client_A', 'Different client A Query'); await f.host.setup('other_client_A')
  await click(f.scene().querySelector('summary')!); await click(button(f.scene(), '重新核对'))
  await wait(() => expect(button(f.scene(), '打开主对话')).toBeTruthy())
  expect(new Map(f.owner.snapshot().record.conversation.drafts).get(f.key)).toBe('This device B Query')
  expect(f.owner.snapshot().record.selectedSessionId).toBeNull()
  expect(f.rpc.mock.calls.filter(([method]) => method === 'agent.open')).toHaveLength(0)
})


it('an unconfirmed Mote directory read keeps the already selected healthy Main reader and its draft', async () => {
  const f = await actual()
  await paste(f.scene(), 'Enter original healthy Main'); await wait(() => expect(button(f.scene(), 'Send').disabled).toBe(false)); await click(button(f.scene(), 'Send'))
  await wait(() => expect(f.owner.snapshot().record.selectedSessionId).not.toBeNull())
  const original = f.owner.snapshot().record.selectedSessionId
  await openPrimary(f.view.element, 'Mote')
  await wait(() => expect(f.view.element.textContent).toContain('主对话配置还没确认'))
  expect(f.owner.snapshot().record.selectedSessionId).toBe(original)
  expect(f.view.element.querySelector('.mote-start')).toBeNull()
  expect(f.view.element.querySelector('.mobile-conversation-slot:not([hidden])')).toBeTruthy()
  const notice = f.view.element.querySelector<HTMLDetailsElement>('.mobile-mote-source-status')!
  expect(notice).toBeTruthy(); expect(notice.open).toBe(false)
  const summary = notice.querySelector('summary')!
  expect(summary.getAttribute('aria-label')).toMatch(/^主对话信息待核对 · \d+ 项$/)
  expect(summary.querySelector('.mobile-mote-source-status__dot')).not.toBeNull()
  expect(notice.querySelector('dl')?.textContent).toContain('主对话配置还没确认')
  expect(f.view.element.querySelector('.mobile-mote-main-handoff')).toBeNull()
  expect(f.view.element.querySelector('.mote-conversation__issue')).toBeNull()
  const advances = f.rpc.mock.calls.filter(([method]) => method === 'space.mote.dialogue.setup.advance').length
  const reads = f.rpc.mock.calls.filter(([method]) => method === 'space.ls').length
  const inputs = f.host.h.inner.kernel.input.mock.calls.length
  await click(notice.querySelector('summary')!); await click(button(notice, '重新核对'))
  await wait(() => expect(f.rpc.mock.calls.filter(([method]) => method === 'space.ls').length).toBeGreaterThan(reads))
  expect(f.owner.snapshot().record.selectedSessionId).toBe(original)
  expect(notice.textContent).toContain('主对话配置还没确认')
  expect(f.rpc.mock.calls.filter(([method]) => method === 'space.mote.dialogue.setup.advance')).toHaveLength(advances)
  expect(f.host.h.inner.kernel.input).toHaveBeenCalledTimes(inputs)
  expect(f.rpc.mock.calls.filter(([method]) => method === 'agent.open')).toHaveLength(1)
})


it('a confirmed Main binding without canonical first-Query delivery keeps the exact original Device intent and input operation', async () => {
  const f = await actual(); f.unknownNative()
  await paste(f.scene(), 'Keep this exact unknown first Query'); await wait(() => expect(button(f.scene(), 'Send').disabled).toBe(false)); await click(button(f.scene(), 'Send'))
  await wait(() => expect(f.rpc.mock.calls.some(([method]) => method === 'space.mote.dialogue.setup.advance')).toBe(true))
  const operation = f.rpc.mock.calls.find(([method]) => method === 'agent.open')![1]
  await wait(() => expect((f.scene()?.textContent ?? '')).toContain('这次开始还在核对'))
  const observed = await f.host.setup(operation.operationId, false)
  expect(observed.binding).toBe('confirmed')
  expect(['admitted', 'terminal-confirmed']).not.toContain(agentPromptSubmissionOutcome(observed.deferredInput?.record ?? null))
  expect(f.owner.snapshot().record.agentCreates?.find(item => item.input.operationId === operation.operationId)?.input.moteMain?.deferredInput).toEqual(operation.moteMain.deferredInput)
  expect(new Map(f.owner.snapshot().record.conversation.drafts).get(f.key)).toBe('')
  expect(f.owner.snapshot().record.selectedSessionId).toBeNull()
  const count = f.host.h.inner.kernel.input.mock.calls.length, advances = f.rpc.mock.calls.filter(([method]) => method === 'space.mote.dialogue.setup.advance').length
  await f.view.render(null); await f.view.render(f.render())
  await wait(() => expect(f.view.element.querySelector('.mote-start')).toBeTruthy())
  await wait(() => expect(f.rpc.mock.calls.some(([method]) => method === 'space.mote.dialogue.setup.inspect')).toBe(true))
  expect(f.host.h.inner.kernel.input).toHaveBeenCalledTimes(count)
  expect(f.rpc.mock.calls.filter(([method]) => method === 'space.mote.dialogue.setup.advance')).toHaveLength(advances)
  expect(f.rpc.mock.calls.filter(([method]) => method === 'agent.open')).toHaveLength(1)
})


it('Device Mote drafts stay separate for exact Mote/Zone identities even when the other source is unconfirmed', async () => {
  const f = await actual(); await paste(f.scene(), 'Original exact Mote A draft')
  await wait(() => expect(new Map(f.owner.snapshot().record.conversation.drafts).get(f.key)).toBe('Original exact Mote A draft'))
  await f.view.render(null)
  const target = { ...f.host.target, spaceId: 'unconfirmed-other-mote', zoneId: 'unconfirmed-other-zone' }
  const identity = { name: 'Other Mote', project: 'Other', mote: { spaceId: target.spaceId, name: 'Other Mote', contentReference: { ...target.expectedResource, zoneId: target.zoneId } } }
  await f.owner.updatePresentation({ selectedSessionId: null, hostUrl: '', panel: 'conversation' }, { primary: 'mote', showSession: true, showGoalWork: false,
    identity, profile: null, recentMoteSpaceId: target.spaceId, moteView: { spaceId: target.spaceId, section: 'discussion', detail: false, directAgent: false } })
  await f.view.render(f.render()); await wait(() => expect(f.view.element.querySelector('.mobile-mote-composer [contenteditable="true"]')).toBeTruthy())
  expect(editor(f.scene()).textContent).toBe('')
  await paste(f.scene(), 'Unconfirmed exact Mote B draft')
  const otherKey = mobileMoteStartDraftKey(f.f.client, target)
  expect(otherKey).not.toBe(f.key); expect(otherKey.length).toBeLessThanOrEqual(256)
  await wait(() => expect(new Map(f.owner.snapshot().record.conversation.drafts).get(otherKey)).toBe('Unconfirmed exact Mote B draft'))
  expect(new Map(f.owner.snapshot().record.conversation.drafts).get(f.key)).toBe('Original exact Mote A draft')
  expect(f.rpc.mock.calls.filter(([method]) => method === 'agent.open')).toHaveLength(0)
})

it('actual A to B to the same A Session keeps three separate period rows after an explicit original refresh', async () => {
  const f = await actual()
  await paste(f.scene(), 'First A period Query'); await wait(() => expect(button(f.scene(), 'Send').disabled).toBe(false)); await click(button(f.scene(), 'Send'))
  await wait(() => expect(f.owner.snapshot().record.selectedSessionId).not.toBeNull())
  const a = (await f.host.main.readCurrentMoteMain(f.host.target)).current!
  await openNewRound(f)
  await paste(f.scene(), 'Second B period Query'); await wait(() => expect(button(f.scene(), 'Send').disabled).toBe(false)); await click(button(f.scene(), 'Send'))
  await wait(() => expect(f.owner.snapshot().record.selectedSessionId).not.toBe(a.sessionId))
  const read = await f.host.rpc.call('space.mote.preferences.read', { kind: 'quick', target: f.host.target }), baseline = moteQuickBaseline(read)!
  const saved = await f.host.rpc.call('space.mote.preferences.save', { kind: 'quick', target: f.host.target, baseline, operationId: 'explicit_return_to_A',
    values: { ...baseline.defaults, conversation: a }, destination: { kind: 'occurrence', displayWorkspaceId: a.displayWorkspaceId, groupId: a.groupId, tabId: a.tabId, regionId: a.regionId } })
  expect(saved.status).toBe('saved')
  await openNewRound(f); await click(f.scene().querySelector('summary')!); await click(button(f.scene(), '重新核对'))
  const page = await f.host.rpc.call('space.mote.dialogue.read', { target: f.host.target }), periods = page.links.flatMap(source => source.kind === 'main' && source.period ? [source.period] : [])
  expect(new Set(periods.map(period => period.id)).size).toBe(3)
  await wait(() => expect(f.scene().querySelectorAll('.mote-start-history [data-mote-period]')).toHaveLength(3))
  expect(new Set([...f.scene().querySelectorAll<HTMLElement>('.mote-start-history [data-mote-period]')].map(row => row.dataset.motePeriod)).size).toBe(3)
  expect(f.rpc.mock.calls.filter(([method]) => method === 'agent.open')).toHaveLength(2)
})


it.each(['idle', 'executor-change'] as const)('actual Mobile new Query follows the Core %s due decision, hands over once and archives only its exact old intent', async policy => {
  const f = await actual('claude')
  await paste(f.scene(), 'Qualify original human Query'); await wait(() => expect(button(f.scene(), 'Send').disabled).toBe(false)); await click(button(f.scene(), 'Send'))
  await wait(() => expect(f.owner.snapshot().record.selectedSessionId).not.toBeNull())
  const old = f.owner.snapshot().record.selectedSessionId!, slot = () => f.view.element.querySelector<HTMLElement>('.mobile-conversation-panel')!
  const setupIndex = f.rpc.mock.calls.findIndex(([method]) => method === 'space.mote.dialogue.setup.advance')
  expect(setupIndex).toBeGreaterThanOrEqual(0)
  const setup = await f.rpc.mock.results[setupIndex]!.value
  expect(setup.reference.sessionId).toBe(old)
  expect(['admitted', 'terminal-confirmed']).toContain(agentPromptSubmissionOutcome(setup.deferredInput?.record ?? null))
  const originalSession = (await f.host.h.client.readAgentSession(old))!, oldKey = JSON.stringify(['draft', old])
  const oldDraft = new Map(f.owner.snapshot().record.conversation.drafts).get(oldKey)
  if (policy === 'idle') {
    await f.host.qualifyMainIdle(1)
    const inspection = await f.host.rpc.call('agent.input.inspect', { key: setup.deferredInput!.route!.key, activity: true })
    expect(inspection.record?.semanticIdle?.promptSubmissionId).toBe(setup.deferredInput!.route!.operationId)
    expect(inspection.activity?.state, JSON.stringify(inspection)).toBe('idle')
  } else {
    const { readFile, writeFile } = await import('node:fs/promises')
    const path = join(f.host.h.root, 'configuration.json'), config = JSON.parse(await readFile(path, 'utf8'))
    config.executors.second = { ...config.executors.saved, label: 'Second same-Provider Executor', env: { EXECUTOR_CHANGE: 'mobile-original-config' } }
    await writeFile(path, JSON.stringify(config))
    const baseline = moteQuickBaseline(await f.host.quick.read({ kind: 'quick', target: f.host.target }))!, ref = setup.reference
    const inputs = f.host.h.inner.kernel.input.mock.calls.length
    const saved = await f.host.rpc.call('space.mote.preferences.save', { kind: 'quick', target: f.host.target, operationId: 'mobile-choose-second', baseline,
      values: { ...baseline.defaults, executorId: 'second', conversationRollover: { kind: 'keep-current' } },
      destination: { kind: 'occurrence', displayWorkspaceId: ref.displayWorkspaceId, groupId: ref.groupId, tabId: ref.tabId, regionId: ref.regionId } })
    expect(saved.status, saved.message ?? '').toBe('saved')
    expect(f.host.h.started).toHaveLength(1); expect(f.host.h.inner.kernel.input).toHaveBeenCalledTimes(inputs)
    expect((await f.host.main.readCurrentMoteMain(f.host.target)).current).toEqual(ref)
    expect(new Map(f.owner.snapshot().record.conversation.drafts).get(oldKey)).toBe(oldDraft)
  }
  await paste(slot(), 'Exact next human Query through rollover'); await click(button(slot(), 'Send'))
  await wait(() => expect(f.rpc.mock.calls.filter(([method]) => method === 'agent.open')).toHaveLength(2))
  await wait(() => expect(f.owner.snapshot().record.selectedSessionId).not.toBe(old))
  const query = f.rpc.mock.calls.find(([method]) => method === 'space.mote.dialogue.input.submit')![1]
  const start = f.rpc.mock.calls.filter(([method]) => method === 'agent.open')[1]![1]
  expect(start.operationId).toBe(start.moteMain.rollover.creationOperationId)
  expect(start.moteMain.rollover.queryOperationId).toBe(query.input.operationId)
  expect(start.moteMain.deferredInput).toEqual({ operationId: query.input.operationId, prompt: 'Exact next human Query through rollover' })
  expect(start.moteMain.handover).toBe(true)
  expect(start.moteMain.rollover.policy).toMatchObject(policy === 'executor-change'
    ? { kind: 'executor-change', previousExecutorId: 'saved', executorId: 'second' } : { kind: 'idle' })
  const next = (await f.host.h.client.readAgentSession(f.owner.snapshot().record.selectedSessionId!))!
  expect(next.executorId).toBe(policy === 'executor-change' ? 'second' : 'saved')
  if (policy === 'executor-change') expect(f.host.h.started[1].env).toMatchObject({ EXECUTOR_CHANGE: 'mobile-original-config' })
  expect((await f.host.h.client.readAgentSession(old))?.run).toEqual(originalSession.run)
  expect((await f.host.rpc.call('space.mote.dialogue.input.inspect', { target: f.host.target, operationId: setup.deferredInput!.route!.operationId })).route).toEqual(setup.deferredInput!.route)
  expect((await f.host.spatial.read())!.graph.resources['tab:old-tab']).toEqual({ draft: 'original draft' })
  const record = f.owner.snapshot().record.conversation, retained = JSON.stringify(['retained-prompt', old, query.input.operationId])
  expect(new Map(record.attempts).has(oldKey)).toBe(false)
  expect(new Map(record.attempts).get(retained)).toMatchObject({ operationId: query.input.operationId, phase: 'confirmed', moteMain: { reference: { sessionId: old } } })
  expect(new Map(record.drafts).get(oldKey)).toBe(oldDraft)
  expect(new Map(record.drafts).get(f.key)).toBe('')
  expect(f.host.h.started).toHaveLength(2)
  expect(f.host.h.inner.kernel.stop).not.toHaveBeenCalled()
})

it('a Core due response arriving after later B editing leaves the healthy original reader and B in place', async () => {
  const f = await actual('claude')
  await paste(f.scene(), 'Original idle proof Query'); await wait(() => expect(button(f.scene(), 'Send').disabled).toBe(false)); await click(button(f.scene(), 'Send'))
  await wait(() => expect(f.owner.snapshot().record.selectedSessionId).not.toBeNull())
  const old = f.owner.snapshot().record.selectedSessionId!, slot = () => f.view.element.querySelector<HTMLElement>('.mobile-conversation-panel')!
  const oldSessionDraft = new Map(f.owner.snapshot().record.conversation.drafts).get(JSON.stringify(['draft', old]))
  const setupIndex = f.rpc.mock.calls.findIndex(([method]) => method === 'space.mote.dialogue.setup.advance')
  expect(setupIndex).toBeGreaterThanOrEqual(0)
  const setup = await f.rpc.mock.results[setupIndex]!.value
  expect(setup.reference.sessionId).toBe(old)
  expect(['admitted', 'terminal-confirmed']).toContain(agentPromptSubmissionOutcome(setup.deferredInput?.record ?? null))
  await f.host.qualifyMainIdle(1)
  const inspection = await f.host.rpc.call('agent.input.inspect', { key: setup.deferredInput!.route!.key, activity: true })
  expect(inspection.record?.semanticIdle?.promptSubmissionId).toBe(setup.deferredInput!.route!.operationId)
  expect(inspection.activity?.state, JSON.stringify(inspection)).toBe('idle'); const hold = f.holdDue()
  await paste(slot(), 'Original A Query'); await click(button(slot(), 'Send'))
  await wait(() => expect(f.rpc.mock.calls.some(([method]) => method === 'space.mote.dialogue.input.submit')).toBe(true))
  await act(async () => { editor(slot()).replaceChildren(document.createElement('p')); editor(slot()).dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' })) })
  await paste(slot(), 'Later B Query remains here')
  await act(async () => hold.resolve())
  await wait(() => expect(slot().textContent).toContain('设置要求开始新一轮'))
  expect(f.owner.snapshot().record.selectedSessionId).toBe(old)
  expect(f.view.element.querySelector('.mote-start')).toBeNull()
  expect(new Map(f.owner.snapshot().record.conversation.drafts).get(f.key)).toBe('Later B Query remains here')
  expect(new Map(f.owner.snapshot().record.conversation.drafts).get(JSON.stringify(['draft', old]))).toBe(oldSessionDraft)
  expect(f.rpc.mock.calls.filter(([method]) => method === 'agent.open')).toHaveLength(1)
})
