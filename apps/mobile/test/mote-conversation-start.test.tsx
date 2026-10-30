// @vitest-environment happy-dom
import './device-locks'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MobileApp } from '../src/MobileApp'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { button, click, fixture, mount, mounted, paste, editor, deferred } from './conversation-fixture'
import { mobileMoteStartDraftKey } from '../src/navigation/MobileMoteConversationStart'
import { createMoteConversationStartFixture } from '../../host/test/helpers/mote-conversation-start-fixture'
import { moteQuickBaseline } from '@agentmux/core/mote-preferences'
import { agentPromptSubmissionOutcome } from '@agentmux/core/mote-dialogue'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'

const closing: Array<() => Promise<unknown>> = []
beforeEach(async () => { localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => {
  for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }
  for (const close of closing.splice(0).reverse()) await close()
  document.body.replaceChildren(); vi.restoreAllMocks()
})
async function wait(check: () => void) { await vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 15000, interval: 20 }) }
async function actual(providerId?: 'claude') {
  const host = await createMoteConversationStartFixture(providerId ? { providerId } : undefined); closing.push(host.close)
  const f = fixture(), owner = getDeviceWorkface(), content = { ...host.target.expectedResource, zoneId: host.target.zoneId }
  const identity = { name: 'Original Mote', project: 'Original', mote: { spaceId: host.target.spaceId, name: 'Original Mote', contentReference: content } }
  await owner.confirmHost({ origin: location.origin, hostId: 'local' })
  await owner.updatePresentation({ selectedSessionId: null, hostUrl: '', panel: 'conversation' }, { primary: 'mote', showSession: true, showGoalWork: false,
    recentMoteSpaceId: host.target.spaceId, identity, profile: null, moteView: { spaceId: host.target.spaceId, section: 'discussion', detail: false, directAgent: false } })
  f.client.runtimeOwnerIdentity = () => ({ runtimeId: 'actual-start-runtime', ownerInstanceId: 'actual-start-process', availability: 'connected' }) as ReturnType<AgentMuxHostedClient['runtimeOwnerIdentity']>
  let lost = false, unknownNative = false, dueBarrier: ReturnType<typeof deferred<void>> | null = null, barrier: ReturnType<typeof deferred<void>> | null = null
  const rpc = vi.fn(async (method: any, input: any) => {
    if (method === 'space.mote.dialogue.setup.advance' && unknownNative) { unknownNative = false; host.h.inner.kernel.input.mockImplementationOnce(async () => { throw Error('Original native input ACK is unknown') }) }
    const result: any = await host.rpc.call(method, input)
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
  const render = () => <MobileApp client={f.client} connection={{ state: 'connected', message: 'Original host' }} platform={createBrowserPlatform()} restoreWorkface />
  const view = await mount(render())
  await wait(() => expect(view.element.querySelector('.mote-start [contenteditable="true"]')).toBeTruthy())
  const scene = () => view.element.querySelector<HTMLElement>('.mote-start')!
  const key = mobileMoteStartDraftKey(f.client, host.target)
  return { host, f, owner, rpc, view, render, scene, key, changes, holdDue() { dueBarrier = deferred<void>(); return dueBarrier }, unknownNative() { unknownNative = true }, lose() { lost = true }, hold() { barrier = deferred<void>(); return barrier } }
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
  await wait(() => expect(f.rpc.mock.calls.filter(([method]) => method === 'agent.open')).toHaveLength(1))
  await wait(() => expect(f.owner.snapshot().record.selectedSessionId).not.toBeNull())
  const packet = f.rpc.mock.calls.find(([method]) => method === 'agent.open')![1]
  expect(packet.moteMain.deferredInput.prompt).toBe('First exact Query'); expect(packet.content).not.toHaveProperty('prompt')
  expect(f.owner.snapshot().record.agentCreates?.find(value => value.input.operationId === packet.operationId)?.input).toEqual(packet)
  expect(new Map(f.owner.snapshot().record.conversation.drafts).get(f.key)).toBe('')
  const setup = await f.host.setup(packet.operationId, false)
  expect(setup.binding).toBe('confirmed'); expect(setup.deferredInput?.record).toBeTruthy()
  expect(f.rpc.mock.calls.filter(([method]) => method === 'agent.open')).toHaveLength(1)
})

it('a delayed original A receipt cannot clear later B or steal the later Mobile selection', async () => {
  const f = await actual(), hold = f.hold()
  await paste(f.scene(), 'Original A Query'); await wait(() => expect(button(f.scene(), 'Send').disabled).toBe(false))
  await click(button(f.scene(), 'Send')); await wait(() => expect(f.rpc.mock.calls.filter(([method]) => method === 'agent.open')).toHaveLength(1))
  await act(async () => { editor(f.scene()).replaceChildren(document.createElement('p')); editor(f.scene()).dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' })) })
  await paste(f.scene(), 'Later B Query')
  await wait(() => expect(new Map(f.owner.snapshot().record.conversation.drafts).get(f.key)).toBe('Later B Query'))
  await act(async () => hold.resolve())
  await wait(() => expect((f.scene()?.textContent ?? '')).toContain('原首条消息已确认投递'))
  expect(new Map(f.owner.snapshot().record.conversation.drafts).get(f.key)).toBe('Later B Query')
  expect(f.owner.snapshot().record.selectedSessionId).toBeNull()
  expect(f.rpc.mock.calls.filter(([method]) => method === 'agent.open')).toHaveLength(1)
})

it('unknown setup outcome remounts through Core readonly inspection without creating or replaying a Query', async () => {
  const f = await actual(); f.lose()
  await paste(f.scene(), 'Keep unknown Query'); await wait(() => expect(button(f.scene(), 'Send').disabled).toBe(false)); await click(button(f.scene(), 'Send'))
  await wait(() => expect((f.scene()?.textContent ?? '')).toContain('Original setup receipt lost'))
  const opens = f.rpc.mock.calls.filter(([method]) => method === 'agent.open').length
  await f.view.render(null); await f.view.render(f.render())
  await wait(() => expect(f.view.element.querySelector('.mote-start [contenteditable="true"]')).toBeTruthy())
  await wait(() => expect(f.rpc.mock.calls.some(([method]) => method === 'space.mote.dialogue.setup.inspect')).toBe(true))
  expect(f.rpc.mock.calls.filter(([method]) => method === 'agent.open')).toHaveLength(opens)
  expect(new Map(f.owner.snapshot().record.conversation.drafts).get(f.key)).toBe('Keep unknown Query')
})


it('an explicit Mobile new round hands over before its first Query and keeps the exact original historical period and its truthful source range', async () => {
  const f = await actual()
  await paste(f.scene(), 'First period Query'); await wait(() => expect(button(f.scene(), 'Send').disabled).toBe(false)); await click(button(f.scene(), 'Send'))
  await wait(() => expect(f.owner.snapshot().record.selectedSessionId).not.toBeNull())
  const firstSession = f.owner.snapshot().record.selectedSessionId!
  await openNewRound(f)
  await wait(() => expect(f.scene().dataset.mode).toBe('new'))
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
  await openNewRound(f)
  await wait(() => expect(f.scene().querySelector('[data-mote-period]')).toBeTruthy())
  const source = (await f.host.rpc.call('space.mote.dialogue.read', { target: f.host.target })).links.find(link => link.kind === 'main' && link.reference.sessionId === firstSession)!
  expect(source.kind).toBe('main'); if (source.kind !== 'main') throw Error('Original historical Main source required')
  const periodId = source.period?.id ?? JSON.stringify(['legacy-main', source.roleRevision, source.operationId])
  const row = [...f.scene().querySelectorAll<HTMLElement>('[data-mote-period]')].find(row => row.dataset.motePeriod === periodId)?.querySelector('button')
  expect(row).toBeTruthy(); await click(row!)
  await wait(() => expect(f.view.element.querySelector('[aria-label="原主对话历史"] .mote-conversation__earlier')).toBeTruthy())
  if (source.period?.range.kind === 'bounded' && source.period.range.through) {
    await wait(() => expect(f.changes).toHaveBeenCalled())
    expect(f.changes.mock.calls.at(-1)![0]).toMatchObject({ hostId: source.reference.hostId, agentSessionId: firstSession, checkpoint: source.period.range.after, through: source.period.range.through })
  } else {
    expect(f.changes).not.toHaveBeenCalled()
    expect(button(f.view.element.querySelector<HTMLElement>('[aria-label="原主对话历史"]')!, '打开原 Agent 对话')).toBeTruthy()
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
  await click(button(f.view.element.querySelector<HTMLElement>('.mobile-navigation')!, 'Mote'))
  await wait(() => expect(f.view.element.textContent).toContain('原主对话配置尚未确认'))
  expect(f.owner.snapshot().record.selectedSessionId).toBe(original)
  expect(f.view.element.querySelector('.mote-start')).toBeNull()
  expect(f.view.element.querySelector('.mobile-conversation-slot:not([hidden])')).toBeTruthy()
  const notice = f.view.element.querySelector<HTMLDetailsElement>('.mobile-mote-source-status')!
  expect(notice).toBeTruthy(); expect(notice.open).toBe(false)
  expect(notice.querySelector('summary')?.textContent).toBe('主对话信息待核对')
  expect(notice.querySelector('dl')?.textContent).toContain('原主对话配置尚未确认')
  expect(f.view.element.querySelector('.mobile-mote-main-handoff')).toBeNull()
  expect(f.view.element.querySelector('.mote-conversation__issue')).toBeNull()
  const advances = f.rpc.mock.calls.filter(([method]) => method === 'space.mote.dialogue.setup.advance').length
  const reads = f.rpc.mock.calls.filter(([method]) => method === 'space.ls').length
  const inputs = f.host.h.inner.kernel.input.mock.calls.length
  await click(notice.querySelector('summary')!); await click(button(notice, '重新核对主对话信息'))
  await wait(() => expect(f.rpc.mock.calls.filter(([method]) => method === 'space.ls').length).toBeGreaterThan(reads))
  expect(f.owner.snapshot().record.selectedSessionId).toBe(original)
  expect(notice.textContent).toContain('原主对话配置尚未确认')
  expect(f.rpc.mock.calls.filter(([method]) => method === 'space.mote.dialogue.setup.advance')).toHaveLength(advances)
  expect(f.host.h.inner.kernel.input).toHaveBeenCalledTimes(inputs)
  expect(f.rpc.mock.calls.filter(([method]) => method === 'agent.open')).toHaveLength(1)
})


it('a confirmed Main binding without canonical first-Query delivery keeps the exact Mote draft and input operation', async () => {
  const f = await actual(); f.unknownNative()
  await paste(f.scene(), 'Keep this exact unknown first Query'); await wait(() => expect(button(f.scene(), 'Send').disabled).toBe(false)); await click(button(f.scene(), 'Send'))
  await wait(() => expect(f.rpc.mock.calls.some(([method]) => method === 'space.mote.dialogue.setup.advance')).toBe(true))
  const operation = f.rpc.mock.calls.find(([method]) => method === 'agent.open')![1]
  await wait(() => expect((f.scene()?.textContent ?? '')).toContain('原开始意图已保留'))
  const observed = await f.host.setup(operation.operationId, false)
  expect(observed.binding).toBe('confirmed')
  expect(['admitted', 'terminal-confirmed']).not.toContain(agentPromptSubmissionOutcome(observed.deferredInput?.record ?? null))
  expect(new Map(f.owner.snapshot().record.conversation.drafts).get(f.key)).toBe('Keep this exact unknown first Query')
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
  await f.view.render(f.render()); await wait(() => expect(f.view.element.querySelector('.mote-start [contenteditable="true"]')).toBeTruthy())
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


it('actual Mobile new Query follows the Core native-idle due decision, hands over once and archives only its exact old intent', async () => {
  const f = await actual('claude')
  await paste(f.scene(), 'Qualify original human Query'); await wait(() => expect(button(f.scene(), 'Send').disabled).toBe(false)); await click(button(f.scene(), 'Send'))
  await wait(() => expect(f.owner.snapshot().record.selectedSessionId).not.toBeNull())
  const old = f.owner.snapshot().record.selectedSessionId!, slot = () => f.view.element.querySelector<HTMLElement>('.mobile-conversation-slot:not([hidden])')!
  await f.host.qualifyMainIdle(1)
  await paste(slot(), 'Exact next human Query through rollover'); await click(button(slot(), 'Send'))
  await wait(() => expect(f.rpc.mock.calls.filter(([method]) => method === 'agent.open')).toHaveLength(2))
  await wait(() => expect(f.owner.snapshot().record.selectedSessionId).not.toBe(old))
  const query = f.rpc.mock.calls.find(([method]) => method === 'space.mote.dialogue.input.submit')![1]
  const start = f.rpc.mock.calls.filter(([method]) => method === 'agent.open')[1]![1]
  expect(start.operationId).toBe(start.moteMain.rollover.creationOperationId)
  expect(start.moteMain.rollover.queryOperationId).toBe(query.input.operationId)
  expect(start.moteMain.deferredInput).toEqual({ operationId: query.input.operationId, prompt: 'Exact next human Query through rollover' })
  expect(start.moteMain.handover).toBe(true)
  const record = f.owner.snapshot().record.conversation, oldKey = JSON.stringify(['draft', old]), retained = JSON.stringify(['retained-prompt', old, query.input.operationId])
  expect(new Map(record.attempts).has(oldKey)).toBe(false)
  expect(new Map(record.attempts).get(retained)).toMatchObject({ operationId: query.input.operationId, phase: 'confirmed', moteMain: { reference: { sessionId: old } } })
  expect(new Map(record.drafts).get(oldKey)).toBe('')
  expect(f.host.h.started).toHaveLength(2)
  expect(f.host.h.inner.kernel.stop).not.toHaveBeenCalled()
})

it('a Core due response arriving after later B editing leaves the healthy original reader and B in place', async () => {
  const f = await actual('claude')
  await paste(f.scene(), 'Original idle proof Query'); await wait(() => expect(button(f.scene(), 'Send').disabled).toBe(false)); await click(button(f.scene(), 'Send'))
  await wait(() => expect(f.owner.snapshot().record.selectedSessionId).not.toBeNull())
  const old = f.owner.snapshot().record.selectedSessionId!, slot = () => f.view.element.querySelector<HTMLElement>('.mobile-conversation-slot:not([hidden])')!
  await f.host.qualifyMainIdle(1); const hold = f.holdDue()
  await paste(slot(), 'Original A Query'); await click(button(slot(), 'Send'))
  await wait(() => expect(f.rpc.mock.calls.some(([method]) => method === 'space.mote.dialogue.input.submit')).toBe(true))
  await act(async () => { editor(slot()).replaceChildren(document.createElement('p')); editor(slot()).dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' })) })
  await paste(slot(), 'Later B Query remains here')
  await act(async () => hold.resolve())
  await wait(() => expect(slot().textContent).toContain('原策略已要求新一轮'))
  expect(f.owner.snapshot().record.selectedSessionId).toBe(old)
  expect(f.view.element.querySelector('.mote-start')).toBeNull()
  expect(new Map(f.owner.snapshot().record.conversation.drafts).get(JSON.stringify(['draft', old]))).toBe('Later B Query remains here')
  expect(f.rpc.mock.calls.filter(([method]) => method === 'agent.open')).toHaveLength(1)
})
