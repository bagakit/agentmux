// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MOTE_CHAT_DEFAULT_VALUES } from '@agentmux/core/mote-chat'
import { moteBotUi } from './fixtures/mote-bot-ui'
import { moteConnectionOwner } from './fixtures/mote-connection-owner'
import { createClientUiRoot } from './helpers/client-ui-render'
import { api } from '../src/renderer/src/lib/api'
import { MoteBotSetup } from '../src/renderer/src/components/MoteBotSetup'
import { MoteChatRequests } from '../src/renderer/src/components/MoteChatRequests'
import { submitMoteChatIntent, inspectMoteChatIntent } from '../src/renderer/src/lib/mote-chat-request'
import { useMoteBotSetup } from '../src/renderer/src/lib/use-mote-bot-setup'
import { botTaskSelectionKey, readBotTaskLocator } from '../src/renderer/src/lib/bot-task-selection'
import { retainConnectorRoomIntent, retainMoteBotRequest, retainMoteChatIntent, setBotTaskSelection, useAppStore } from '../src/renderer/src/store'
import type { MoteChatIntent } from '../src/renderer/src/lib/mote-chat-intent'

const cleanup: Array<() => void | Promise<void>> = [], facts: unknown[] = []
afterEach(async () => {
  try { for (const close of cleanup.splice(0).reverse()) await close() }
  finally { if (process.env.RENDERER_HOSTING_FACTS) await writeFile(process.env.RENDERER_HOSTING_FACTS, JSON.stringify({ scope: 'Actual Renderer/AppStore/trusted IPC/public Core/SQLite with controlled hosting selection and native SDK ports; not default RuntimeController, installed App or SSH deployment.', facts }, null, 2) + '\n') }
})
async function fixture() {
  const f = await moteBotUi({ generic: true }); cleanup.push(f.close)
  const root = await mkdtemp(join(tmpdir(), 'amx-other-mote-owner-'))
  const other = await moteConnectionOwner(root, { generic: true })
  cleanup.push(async () => { await other.close(); await rm(root, { recursive: true, force: true }) })
  const otherTarget = { hostId: 'other-host', runtimeId: 'other-runtime' }
  let current = f.hostingTarget
  vi.spyOn(f.runtime, 'connectionHostingTarget').mockImplementation(async () => structuredClone(current))
  const calls: Array<{ target: typeof current; method: string; input: any }> = []
  const routed: Array<{ target: typeof current; method: string; operationId: unknown }> = []
  facts.push({ case: 'controlled-original-routing', routed })
  vi.spyOn(f.runtime, 'callConnectionHost').mockImplementation(async (target, method, input) => {
    calls.push({ target: structuredClone(target), method, input: structuredClone(input) })
    routed.push({ target: structuredClone(target), method, operationId: input && 'operationId' in input ? input.operationId : null })
    if (JSON.stringify(target) === JSON.stringify(f.hostingTarget)) return await f.client.call(method, input)
    if (JSON.stringify(target) === JSON.stringify(otherTarget)) return await other.client.call(method, input)
    throw Error('The original controlled hosting endpoint is unavailable')
  })
  return { ...f, other, otherTarget, calls, switchOwner() { current = otherTarget } }
}
async function mountRequests(target: ReturnType<Awaited<ReturnType<typeof fixture>>['target']>) {
  const node = document.createElement('div'); document.body.append(node)
  let view = createClientUiRoot(node), active = true
  const confirmed = vi.fn()
  const render = () => view.render(<MoteChatRequests target={target} onConfirmed={confirmed} />)
  await act(async () => render())
  const unmount = async () => { if (active) { active = false; await act(async () => view.unmount()) } }
  cleanup.push(async () => { await unmount(); node.remove() })
  return { node, confirmed, unmount, async remount() { await unmount(); await useAppStore.persist.rehydrate(); view = createClientUiRoot(node); active = true; await act(async () => render()) } }
}
function chatInput(f: Awaited<ReturnType<typeof fixture>>, operationId: string, interval = 47) {
  return { operationId, target: f.target(), expectedRevision: null, expectedConnectionRevision: null, values: { ...MOTE_CHAT_DEFAULT_VALUES, conversationIdleMs: interval * 60000 } }
}

it('the actual Store preserves hosting separately from execution/resource targets and cannot relabel an original operation', async () => {
  const f = await fixture(), operationId = 'original-retained-owner'
  const request = { action: 'create' as const, input: await f.input(operationId), phase: 'may-have-dispatched' as const, hostingTarget: f.hostingTarget }
  await retainMoteBotRequest(request)
  const chat: MoteChatIntent = { method: 'space.mote.chat.configure', input: chatInput(f, 'original-chat-owner'), phase: 'not-dispatched', hostingTarget: f.hostingTarget }
  await retainMoteChatIntent(chat)
  const target = { executionHostId: 'different-execution-host', agentSessionId: 'original-session' }
  const room = { method: 'connection.room.create' as const, target, hostingTarget: f.hostingTarget, phase: 'may-have-dispatched' as const,
    input: { ...target, operationId: 'original-room-owner', connectionId: 'original-connection', expectedConnectionRevision: 1, name: 'Original group', members: [] } }
  await retainConnectorRoomIntent(room)
  setBotTaskSelection({ kind: 'mote', target: f.target() }, { operationId, hostingTarget: f.hostingTarget })
  await retainMoteBotRequest(request)
  await useAppStore.persist.rehydrate()
  expect(useAppStore.getState().moteBotRequests[operationId]).toEqual(request)
  expect(useAppStore.getState().moteChatIntents[chat.input.operationId]).toEqual(chat)
  expect(useAppStore.getState().connectorRoomIntents[room.input.operationId]).toEqual(room)
  expect(readBotTaskLocator(useAppStore.getState().botTaskSelections[botTaskSelectionKey({ kind: 'mote', target: f.target() })])).toEqual({ operationId, hostingTarget: f.hostingTarget })
  await expect(retainMoteBotRequest({ ...request, hostingTarget: f.otherTarget })).rejects.toThrow('cannot be replaced')
  await expect(retainMoteChatIntent({ ...chat, hostingTarget: f.otherTarget })).rejects.toThrow('cannot be replaced')
  await expect(retainConnectorRoomIntent({ ...room, hostingTarget: f.otherTarget })).rejects.toThrow('without replacing')
  await expect(submitMoteChatIntent({ ...chat, hostingTarget: f.otherTarget })).rejects.toThrow('cannot be replaced')
  expect(useAppStore.getState().moteChatIntents[chat.input.operationId]).toEqual(chat)
  setBotTaskSelection({ kind: 'enrollment' }, 'old-owner-unconfirmed')
  expect(() => setBotTaskSelection({ kind: 'enrollment' }, { operationId: 'old-owner-unconfirmed', hostingTarget: f.otherTarget })).toThrow('unconfirmed old owner')
  expect(f.calls).toEqual([])
})

it('a mounted original chat request survives lost ACK and remount, then inspects the same owner despite another owner having the same operation ID', async () => {
  const f = await fixture(), input = chatInput(f, 'same-chat-operation'), forward = f.chatRequests.getMockImplementation()!
  await f.other.client.call('space.mote.chat.configure', { ...input, target: f.other.target(), values: { ...input.values, conversationIdleMs: 19 * 60000 } })
  f.chatRequests.mockImplementation(async (method, params, target) => {
    const result = await forward(method, params, target)
    if (method === 'space.mote.chat.configure') throw Error('Controlled lost original admission ACK')
    return result
  })
  await expect(submitMoteChatIntent({ method: 'space.mote.chat.configure', input, phase: 'not-dispatched' })).rejects.toThrow('lost original admission')
  expect(useAppStore.getState().moteChatIntents[input.operationId]?.hostingTarget).toEqual(f.hostingTarget)
  const view = await mountRequests(f.target())
  f.switchOwner(); await view.remount()
  await act(async () => [...view.node.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Check original request')!.click())
  await vi.waitFor(() => expect(view.confirmed).toHaveBeenCalledTimes(1))
  expect(view.confirmed.mock.calls[0]![0].configuration.values.conversationIdleMs).toBe(47 * 60000)
  expect(useAppStore.getState().moteChatIntents[input.operationId]).toBeUndefined()
  expect(f.calls.filter(call => call.method === 'space.mote.chat.inspect' && call.input.operationId === input.operationId).map(call => call.target)).toEqual([f.hostingTarget])
  expect((await f.other.client.call('space.mote.chat.inspect', { operationId: input.operationId })).operation?.configuration.values.conversationIdleMs).toBe(19 * 60000)
  expect(f.calls.filter(call => call.method === 'space.mote.chat.configure')).toHaveLength(1)
  facts.push({ case: 'original-chat-owner-remount', originalTarget: f.hostingTarget, otherTarget: f.otherTarget, operationId: input.operationId, originalInterval: 47, otherInterval: 19, originalAdmitted: true })
})

it('an old ownerless original request stays retained and neither Check nor Continue queries the current owner', async () => {
  const f = await fixture(), input = chatInput(f, 'ownerless-original-chat')
  const intent: MoteChatIntent = { method: 'space.mote.chat.configure', input, phase: 'may-have-dispatched' }
  // Reopen original serialized UI state; it predates any hosting-target producer.
  useAppStore.setState({ moteChatIntents: { [input.operationId]: intent } })
  await useAppStore.persist.rehydrate(); f.switchOwner()
  const view = await mountRequests(f.target())
  expect(useAppStore.getState().moteChatIntents[input.operationId]?.input).toEqual(input)
  expect(view.node.textContent).toContain('hosting owner is unconfirmed')
  expect(view.node.querySelector('button')?.disabled).toBe(true)
  expect([...view.node.querySelectorAll('button')].some(button => button.textContent === 'Continue original request')).toBe(false)
  await expect(inspectMoteChatIntent(intent)).rejects.toThrow('hosting owner is unconfirmed')
  await expect(submitMoteChatIntent(intent)).rejects.toThrow('hosting owner is unconfirmed')
  expect(useAppStore.getState().moteChatIntents[input.operationId]).toEqual(intent)
  expect(f.calls).toEqual([])
  facts.push({ case: 'ownerless-retained', operationId: input.operationId, currentOwnerCalls: f.calls.length })
})

it('the real Mote hook keeps the parent and child owner after retiring prepared PNG and remounting under a different current owner', async () => {
  const f = await fixture()
  let hook!: ReturnType<typeof useMoteBotSetup>
  const node = document.createElement('div'); document.body.append(node)
  let view = createClientUiRoot(node), active = true
  function Probe() { hook = useMoteBotSetup(f.target(), f.motes[0]!.id); return null }
  const render = async () => { await act(async () => view.render(<Probe />)); await vi.waitFor(() => expect(hook.profile).not.toBeNull()) }
  const unmount = async () => { if (active) { active = false; await act(async () => view.unmount()) } }
  cleanup.push(async () => { await unmount(); node.remove() })
  await render()
  await vi.waitFor(() => expect(hook.capabilities.length).toBeGreaterThan(0))
  await act(async () => hook.begin(hook.capabilities[0]!, true))
  const operationId = hook.operation!.operationId, child = hook.enrollmentView!.operation!.operationId
  expect(useAppStore.getState().moteBotRequests[operationId]).toBeUndefined()
  expect(readBotTaskLocator(useAppStore.getState().botTaskSelections[botTaskSelectionKey({ kind: 'mote', target: f.target() })])).toEqual({ operationId, hostingTarget: f.hostingTarget })
  const otherInput = await f.other.input(operationId)
  await f.other.client.call('space.mote.connection.create', { ...otherInput, desired: { ...otherInput.desired, name: 'Other owner sentinel' } })
  await unmount(); f.switchOwner(); await useAppStore.persist.rehydrate(); view = createClientUiRoot(node); active = true
  await render(); await vi.waitFor(() => expect(hook.enrollmentView?.operation?.operationId).toBe(child))
  expect(hook.operation?.snapshot.name).not.toBe('Other owner sentinel')
  const reads = f.calls.filter(call => call.method === 'space.mote.connection.inspect' && call.input.operationId === operationId || call.method === 'connection.enrollment.inspect' && call.input.operationId === child)
  expect(reads.length).toBeGreaterThan(1); expect(reads.every(call => JSON.stringify(call.target) === JSON.stringify(f.hostingTarget))).toBe(true)
  expect(f.calls.filter(call => call.method === 'space.mote.connection.create')).toHaveLength(1)
  facts.push({ case: 'retired-body-original-parent-child', operationId, child, originalTarget: f.hostingTarget, originalReads: reads.length, nativeBegins: f.counts.begin, otherBegins: f.other.counts.begin })
})

it('the actual restored ownerless Mote observer settles without inspecting or advancing the original operation on the current Host', async () => {
  const f = await fixture(), input = await f.input('ownerless-original-parent')
  useAppStore.setState({ moteBotRequests: { [input.operationId]: { action: 'create', input, phase: 'may-have-dispatched' } },
    botTaskSelections: { [botTaskSelectionKey({ kind: 'mote', target: f.target() })]: input.operationId } })
  await useAppStore.persist.rehydrate(); f.switchOwner()
  let hook!: ReturnType<typeof useMoteBotSetup>
  const node = document.createElement('div'); document.body.append(node); const view = createClientUiRoot(node)
  function Probe() { hook = useMoteBotSetup(f.target(), f.motes[0]!.id); return null }
  cleanup.push(async () => { await act(async () => view.unmount()); node.remove() })
  await act(async () => view.render(<Probe />))
  await vi.waitFor(() => expect(hook.checking).toBe(false))
  await act(async () => { await hook.check(input.operationId, true); await hook.send(hook.requests[0]!) })
  expect(useAppStore.getState().moteBotRequests[input.operationId]?.input).toEqual(input)
  expect(readBotTaskLocator(useAppStore.getState().botTaskSelections[botTaskSelectionKey({ kind: 'mote', target: f.target() })])).toEqual({ operationId: input.operationId, hostingTarget: null })
  expect(f.calls.filter(call => call.input.operationId === input.operationId)).toEqual([])
  expect(f.counts.begin + f.other.counts.begin).toBe(0)
  await act(async () => view.render(<MoteBotSetup target={f.target()} topicId={f.motes[0]!.id} record={null} hasSavedBot={false} onChoose={() => {}} onCurrent={() => {}} />))
  await vi.waitFor(() => expect(node.querySelectorAll('p[role="status"]')).not.toHaveLength(0))
  expect([...node.querySelectorAll('button')].some(button => button.textContent?.trim() === 'Check original result')).toBe(false)
  expect([...node.querySelectorAll('button')].some(button => button.textContent?.trim() === 'Continue this request')).toBe(false)
  expect([...node.querySelectorAll('p')].filter(p => p.textContent?.includes('hosting owner is unconfirmed'))).toHaveLength(1)
  expect([...node.querySelectorAll('button')].some(button => button.textContent?.trim() === 'Back to bot profile')).toBe(true)
  expect(useAppStore.getState().moteBotRequests[input.operationId]?.input).toEqual(input)
  facts.push({ case: 'ownerless-original-parent-observer', operationId: input.operationId, checking: hook.checking, originalCalls: 0 })
})
