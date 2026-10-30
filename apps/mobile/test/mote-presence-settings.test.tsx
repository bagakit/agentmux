import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { effectiveMoteQuickSave, type MotePresenceReading, type MoteQuickDefaults, type MoteQuickPreferencesSaveParams } from '@agentmux/core/mote-preferences'
import { MobileMoteProfile } from '../src/navigation/MobileMoteProfile'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { button, click, deferred, fixture, mount, mounted } from './conversation-fixture'
import { fixtureEpoch, fixturePath } from '../../../test/fixture-values.mjs'

beforeEach(async () => { localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => {
  for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }
  document.body.replaceChildren(); vi.restoreAllMocks()
})
async function wait(check: () => void) { await vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 10000 }) }
async function minutes(element: HTMLElement, text: string) {
  const input = element.querySelector<HTMLInputElement>('[aria-label="心跳间隔（分钟）"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
async function submit(element: HTMLElement) { await act(async () => element.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))) }
function original(defaults: MoteQuickDefaults = {}) {
  const f = fixture(), workspacePath = fixturePath('mote-presence-settings'), hostId = 'host-original'
  const resource = { hostId, workspaceId: 'workspace-original', workspacePath }
  const target = { spaceId: 'mote-original', zoneId: 'zone-original', expectedResource: resource }
  const document = { path: 'MOTE.md', content: '# original user note\nDo not rewrite this body.', revision: 'sha256:' + 'a'.repeat(64) }
  const fileResource = { ...resource, zoneId: target.zoneId, zonePath: workspacePath, path: 'MOTE.md' }
  const main = { hostId, sessionId: 'session-original', displayWorkspaceId: 'display-original', groupId: 'group-original', tabId: 'tab-original', regionId: 'region-original' }
  const savedDefaults = { ...defaults, conversation: main }
  let maintenance: MotePresenceReading = { status: 'paused', issue: null, schedule: { loopId: 'original-schedule', hostId, agentSessionId: main.sessionId,
    providerId: 'codex', workspacePath, everyMs: 1800000, intervalMs: 1000, prompt: 'Original frozen internal heartbeat', nextCheckAt: fixtureEpoch(2), status: 'paused',
    revision: 7, creationOperationId: 'original-arrangement-create', futureIntentId: 'original-future-intent' } }
  let pendingSave: ReturnType<typeof deferred<any>> | undefined
  let loseResumeReceipt = false
  const source = { resource: fileResource, result: { status: 'read' as const, document } }
  const fact = { spaceId: target.spaceId, content: { ...resource, zoneId: target.zoneId }, quickMode: { status: 'saved' as const, defaults: savedDefaults, version: 'original-version' }, conversation: main }
  const reads = () => ({ kind: 'quick', target, status: 'ready', source, defaults: savedDefaults, choices: { executors: [], conversations: [{ reference: main, label: '原主对话' }],
    destinations: [{ reference: { kind: 'occurrence', displayWorkspaceId: main.displayWorkspaceId, groupId: main.groupId, tabId: main.tabId, regionId: main.regionId }, label: '原位置' }] }, main: false, issue: null, maintenance })
  f.client.runtimeOwnerIdentity = () => ({ runtimeId: 'original-settings-runtime', ownerInstanceId: 'original-settings-process', availability: 'connected' }) as ReturnType<AgentMuxHostedClient['runtimeOwnerIdentity']>
  const rpc = vi.fn(async (method: string, input: any, _context?: unknown, _fence?: unknown) => {
    if (method === 'space.ls') return { catalog: { motePresentation: [fact] } }
    if (method === 'space.mote.preferences.read') return structuredClone(reads())
    if (method === 'space.mote.preferences.save') {
      if (pendingSave) return pendingSave.promise
      return { kind: 'quick', target, operationId: input.operationId, status: 'saved', source: { resource: fileResource, document, defaults: effectiveMoteQuickSave(input) }, message: null }
    }
    if (method === 'schedule.resume') {
      const stored = getDeviceWorkface().snapshot().record.moteQuickDrafts?.[0]?.maintenanceAttempts?.find(value => value.input.operationId === input.operationId)
      if (!stored || stored.phase !== 'sending' || stored.input.scheduleId !== maintenance.schedule?.loopId) throw Error('Original complete intent must be durable before its actual resume')
      const schedule = { ...maintenance.schedule!, status: 'active' as const, revision: input.expectedRevision + 1,
        lastMutation: { action: 'resume' as const, operationId: input.operationId, expectedRevision: input.expectedRevision } }
      maintenance = { status: 'active', schedule, issue: null }
      if (loseResumeReceipt) throw Error('Original resume receipt lost after apply')
      return { schedule, diskDurability: 'confirmed', executionScope: 'connected-host' }
    }
    if (method === 'schedule.inspect') return { schedule: maintenance.schedule, executionScope: 'connected-host' }
    throw Error('Unexpected product operation: ' + method)
  })
  f.client.forwardRpc = rpc as AgentMuxHostedClient['forwardRpc']
  const identity = { name: '原承接 Agent', project: '原项目', mote: { spaceId: target.spaceId, name: '同一 Mote', facts: fact } }
  const render = () => <MobileMoteProfile identity={identity} client={f.client} visible copyText={createBrowserPlatform().copyText} />
  async function open() {
    const view = await mount(render()); await click(button(view.element, '编辑快捷配置'))
    await wait(() => expect(view.element.textContent).toContain('已核对当前配置'))
    return view
  }
  return { f, rpc, target, document, savedDefaults, open, render, maintenance(value: MotePresenceReading) { maintenance = value },
    holdSave() { pendingSave = deferred<any>(); return pendingSave }, loseResumeReceipt() { loseResumeReceipt = true },
    stopArrangement() { maintenance = { ...maintenance, status: 'paused', schedule: { ...maintenance.schedule!, status: 'stopped' } } } }
}

it('actual Mobile Profile settings save default30min presence through the original public CAS without resuming a paused schedule', async () => {
  const f = original(), view = await f.open(), input = view.element.querySelector<HTMLInputElement>('[aria-label="心跳间隔（分钟）"]')!
  expect(input.value).toBe('30')
  expect(view.element.querySelector<HTMLInputElement>('[aria-label="启用 Mote 自动维持"]')!.checked).toBe(true)
  expect(view.element.textContent).toContain('原心跳安排已暂停')
  await minutes(view.element, '7'); await submit(view.element)
  await wait(() => expect(view.element.textContent).toContain('原 Quick 配置已保存'))
  const saves = f.rpc.mock.calls.filter(([method]) => method === 'space.mote.preferences.save')
  expect(saves).toHaveLength(1)
  expect(saves[0]![1]).toMatchObject({ kind: 'quick', target: f.target, baseline: { document: f.document, defaults: f.savedDefaults }, values: { presence: { enabled: true, intervalMs: 420000 } } })
  expect(view.element.querySelector('[data-mote-maintenance-status]')?.textContent).toBe('原心跳安排已暂停')
  expect(f.rpc.mock.calls.every(([method]) => ['space.ls', 'space.mote.preferences.read', 'space.mote.preferences.save'].includes(method))).toBe(true)
  expect(f.f.submit).not.toHaveBeenCalled()
})

it('keeps an invalid interval visible without sending the former valid configuration or changing the frozen baseline', async () => {
  const f = original({ presence: { enabled: false, intervalMs: 900000 } }), view = await f.open()
  expect(view.element.querySelector<HTMLInputElement>('[aria-label="心跳间隔（分钟）"]')!.value).toBe('15')
  expect(view.element.querySelector<HTMLInputElement>('[aria-label="启用 Mote 自动维持"]')!.checked).toBe(false)
  await minutes(view.element, '0'); await submit(view.element)
  expect(view.element.textContent).toContain('至少 1 分钟的整数')
  expect(view.element.querySelector<HTMLInputElement>('[aria-label="心跳间隔（分钟）"]')!.value).toBe('0')
  expect(f.rpc.mock.calls.filter(([method]) => method === 'space.mote.preferences.save')).toHaveLength(0)
  await minutes(view.element, '60'); await submit(view.element)
  await wait(() => expect(f.rpc.mock.calls.filter(([method]) => method === 'space.mote.preferences.save')).toHaveLength(1))
  const input = f.rpc.mock.calls.find(([method]) => method === 'space.mote.preferences.save')![1] as MoteQuickPreferencesSaveParams
  expect(input.values.presence).toEqual({ enabled: false, intervalMs: 3600000 })
})

it('retains an unknown presence save and later interval under its original operation across remount without replay', async () => {
  const f = original(), pending = f.holdSave(), view = await f.open()
  await minutes(view.element, '7'); await submit(view.element)
  await wait(() => expect(f.rpc.mock.calls.filter(([method]) => method === 'space.mote.preferences.save')).toHaveLength(1))
  const packet = structuredClone(f.rpc.mock.calls.find(([method]) => method === 'space.mote.preferences.save')![1])
  pending.reject(new Error('Original save receipt unavailable'))
  await wait(() => expect(view.element.textContent).toContain('原保存未确认'))
  await minutes(view.element, '47')
  await wait(() => expect(getDeviceWorkface().snapshot().record.moteQuickDrafts?.[0]?.values.presence?.intervalMs).toBe(2820000))
  const originalDraft = getDeviceWorkface().snapshot().record.moteQuickDrafts![0]!
  expect(originalDraft.attempts[0]!.input).toEqual(packet)
  await view.render(null); await view.render(f.render()); await click(button(view.element, '编辑快捷配置'))
  await wait(() => expect(view.element.querySelector<HTMLInputElement>('[aria-label="心跳间隔（分钟）"]')!.value).toBe('47'))
  await submit(view.element)
  expect(f.rpc.mock.calls.filter(([method]) => method === 'space.mote.preferences.save')).toHaveLength(1)
  expect(getDeviceWorkface().snapshot().record.moteQuickDrafts![0]!.attempts[0]!.input).toEqual(packet)
})

it('presents unconfirmed actual maintenance independently from readable settings and permits an explicit original refresh', async () => {
  const f = original(); f.maintenance({ status: 'unconfirmed', schedule: null, issue: '原安排读取暂不可用；原操作保留。' })
  const view = await f.open()
  expect(view.element.textContent).toContain('实际安排尚未确认')
  expect(view.element.textContent).not.toContain('已安排自动心跳')
  const before = f.rpc.mock.calls.filter(([method]) => method === 'space.mote.preferences.read').length
  await click(button(view.element, '刷新实际安排'))
  await wait(() => expect(f.rpc.mock.calls.filter(([method]) => method === 'space.mote.preferences.read').length).toBe(before + 1))
  expect(f.f.submit).not.toHaveBeenCalled()
})

it('resumes only the explicit original paused arrangement after retaining its exact operation and current owner fence', async () => {
  const f = original(), view = await f.open()
  expect(f.rpc.mock.calls.filter(([method]) => method === 'schedule.resume')).toHaveLength(0)
  await click(button(view.element, '明确恢复原心跳安排'))
  await wait(() => expect(getDeviceWorkface().snapshot().record.moteQuickDrafts?.[0]?.maintenanceAttempts?.[0]?.phase).toBe('confirmed'))
  const call = f.rpc.mock.calls.find(([method]) => method === 'schedule.resume')!
  expect(call[1]).toEqual({ scheduleId: 'original-schedule', expectedRevision: 7, operationId: expect.any(String) })
  expect(call[3]).toEqual({ runtimeId: 'original-settings-runtime', ownerInstanceId: 'original-settings-process' })
  const intent = getDeviceWorkface().snapshot().record.moteQuickDrafts![0]!.maintenanceAttempts![0]!
  expect(intent.input).toEqual(call[1]); expect(intent.phase).toBe('confirmed')
  expect(f.rpc.mock.calls.filter(([method]) => method === 'space.mote.preferences.save')).toHaveLength(0)
  expect(f.f.submit).not.toHaveBeenCalled()
})

it('inspects an unknown original resume without replay and keeps its read observation separate from a write durability receipt', async () => {
  const f = original(); f.loseResumeReceipt(); const view = await f.open()
  await click(button(view.element, '明确恢复原心跳安排'))
  await wait(() => expect(view.element.textContent).toContain('原恢复回执未确认'))
  const packet = structuredClone(getDeviceWorkface().snapshot().record.moteQuickDrafts![0]!.maintenanceAttempts![0]!.input)
  await view.render(null); await view.render(f.render()); await click(button(view.element, '编辑快捷配置'))
  await wait(() => expect(view.element.textContent).toContain('原恢复待核对'))
  const summary = [...view.element.querySelectorAll('summary')].find(node => node.textContent?.startsWith('原心跳恢复请求'))!
  await click(summary); await click(button(view.element, '核对原恢复请求'))
  await wait(() => expect(view.element.textContent).toContain('已读到原恢复记录'))
  expect(f.rpc.mock.calls.filter(([method]) => method === 'schedule.resume')).toHaveLength(1)
  expect(f.rpc.mock.calls.find(([method]) => method === 'schedule.inspect')![1]).toEqual({ operationId: packet.operationId })
  const originalResume = getDeviceWorkface().snapshot().record.moteQuickDrafts![0]!.maintenanceAttempts![0]!
  expect(originalResume.input).toEqual(packet); expect(originalResume.phase).toBe('observed')
  expect(originalResume.result).not.toHaveProperty('diskDurability')
  expect(f.f.submit).not.toHaveBeenCalled()
})

it('presents the actual stopped arrangement before the compatibility paused status without offering resume or creating a replacement', async () => {
  const f = original(); f.stopArrangement(); const view = await f.open()
  expect(view.element.querySelector('[data-mote-maintenance-status]')?.textContent).toBe('原安排已停止')
  expect([...view.element.querySelectorAll('button')].some(node => node.textContent === '明确恢复原心跳安排')).toBe(false)
  expect(f.rpc.mock.calls.filter(([method]) => method === 'schedule.resume' || method === 'schedule.create')).toHaveLength(0)
  await minutes(view.element, '20'); await submit(view.element)
  await wait(() => expect(f.rpc.mock.calls.filter(([method]) => method === 'space.mote.preferences.save')).toHaveLength(1))
  expect(f.f.submit).not.toHaveBeenCalled()
})


it('inspects the same durable original resume across same runtime process restart without replay or rewriting its original source', async () => {
  const f = original(); f.loseResumeReceipt(); const view = await f.open()
  await click(button(view.element, '明确恢复原心跳安排'))
  await wait(() => expect(getDeviceWorkface().snapshot().record.moteQuickDrafts?.[0]?.maintenanceAttempts?.[0]?.phase).toBe('unknown'))
  const retained = structuredClone(getDeviceWorkface().snapshot().record.moteQuickDrafts![0]!.maintenanceAttempts![0]!)
  f.f.client.runtimeOwnerIdentity = () => ({ runtimeId: 'original-settings-runtime', ownerInstanceId: 'replacement-settings-process', availability: 'connected' }) as ReturnType<AgentMuxHostedClient['runtimeOwnerIdentity']>
  await view.render(null); await view.render(f.render()); await click(button(view.element, '编辑快捷配置'))
  await wait(() => expect(view.element.textContent).toContain('原恢复待核对'))
  await click([...view.element.querySelectorAll('summary')].find(node => node.textContent?.startsWith('原心跳恢复请求'))!)
  await click(button(view.element, '核对原恢复请求'))
  await wait(() => expect(view.element.textContent).toContain('已读到原恢复记录'))
  expect(f.rpc.mock.calls.filter(([method]) => method === 'schedule.resume')).toHaveLength(1)
  const inspection = f.rpc.mock.calls.find(([method]) => method === 'schedule.inspect')!
  expect(inspection[1]).toEqual({ operationId: retained.input.operationId })
  expect(inspection[3]).toEqual({ runtimeId: 'original-settings-runtime', ownerInstanceId: 'replacement-settings-process' })
  const result = getDeviceWorkface().snapshot().record.moteQuickDrafts![0]!.maintenanceAttempts![0]!
  expect(result.input).toEqual(retained.input); expect(result.ownerInstanceId).toBe(retained.ownerInstanceId); expect(result.phase).toBe('observed')
  expect(f.f.submit).not.toHaveBeenCalled()
})


it('does not send an unknown original resume to a different runtime even through the same client object', async () => {
  const f = original(); f.loseResumeReceipt(); const view = await f.open()
  await click(button(view.element, '明确恢复原心跳安排'))
  await wait(() => expect(getDeviceWorkface().snapshot().record.moteQuickDrafts?.[0]?.maintenanceAttempts?.[0]?.phase).toBe('unknown'))
  const retained = structuredClone(getDeviceWorkface().snapshot().record.moteQuickDrafts![0]!.maintenanceAttempts![0]!)
  f.f.client.runtimeOwnerIdentity = () => ({ runtimeId: 'different-settings-runtime', ownerInstanceId: 'different-settings-process', availability: 'connected' }) as ReturnType<AgentMuxHostedClient['runtimeOwnerIdentity']>
  await click([...view.element.querySelectorAll('summary')].find(node => node.textContent?.startsWith('原心跳恢复请求'))!)
  await click(button(view.element, '核对原恢复请求'))
  await wait(() => expect(view.element.textContent).toContain('原安排的连接或设备归属尚未确认'))
  expect(f.rpc.mock.calls.filter(([method]) => method === 'schedule.resume')).toHaveLength(1)
  expect(f.rpc.mock.calls.filter(([method]) => method === 'schedule.inspect')).toHaveLength(0)
  expect(getDeviceWorkface().snapshot().record.moteQuickDrafts![0]!.maintenanceAttempts![0]).toEqual(retained)
})
