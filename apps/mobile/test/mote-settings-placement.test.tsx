import { act } from 'react'
import { readFile, unlink } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { parseMotePreferencesReadResult, type MoteQuickPreferencesSaveParams } from '@agentmux/core/mote-preferences'
import { createMotePreferencesPlacementFixture } from '../../../packages/core/test/helpers/mote-preferences-placement'
import { MobileMoteProfile } from '../src/navigation/MobileMoteProfile'
import { createBrowserPlatform } from '../src/platform/browser'
import { DeviceWorkfaceStore, emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { button, click, deferred, mount, mounted } from './conversation-fixture'

const closes: Array<() => Promise<unknown>> = []
beforeEach(async () => { localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => {
  for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }
  for (const close of closes.splice(0).reverse()) await close()
  document.body.replaceChildren(); vi.restoreAllMocks()
})
async function wait(check: () => void) {
  let last: unknown
  for (let attempt = 0; attempt < 500; attempt++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    try { check(); return } catch (error) { last = error }
  }
  throw last
}
async function change(element: HTMLElement, label: string, value: string) {
  const explicit = element.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`)
  const linked = [...element.querySelectorAll('label')].find(node => node.querySelector('strong')?.textContent === label)?.control
  const input = explicit ?? linked
  expect(input instanceof HTMLInputElement || input instanceof HTMLSelectElement).toBe(true)
  if (!(input instanceof HTMLInputElement || input instanceof HTMLSelectElement)) throw Error('Missing actual field: ' + label)
  if (input instanceof HTMLSelectElement && value) await wait(() => expect([...input.options].some(option => option.value === value)).toBe(true))
  await act(async () => {
    const prototype = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
async function addExecutor(element: HTMLElement, id: string) {
  await wait(() => expect(element.querySelector('[aria-label="添加 Executor"]')).not.toBeNull())
  await click(element.querySelector<HTMLButtonElement>('[aria-label="添加 Executor"]')!)
  const option = () => document.querySelector<HTMLButtonElement>('[role="option"][data-value="' + id + '"]')
  await wait(() => expect(option()).not.toBeNull())
  await click(option()!)
}
async function submit(element: HTMLElement) {
  await act(async () => { element.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
}
async function original(options: { absent?: boolean; loseReceipt?: boolean; holdReceipt?: boolean; holdDiscovery?: boolean } = {}) {
  const host = await createMotePreferencesPlacementFixture(); closes.push(host.close)
  if (options.absent) await unlink(host.motePath)
  const read = async () => {
    const input = { kind: 'quick' as const, target: host.target }
    const result = parseMotePreferencesReadResult(await host.rpc.call('space.mote.preferences.read', input), input)
    if (result.kind !== 'quick' || result.status !== 'ready' || !result.choices) throw Error('The original full Mote read is required')
    return { ...result, choices: result.choices }
  }
  const initial = await read(), receipt = deferred<unknown>(), discovery = deferred<Awaited<ReturnType<typeof host.discovery.catalog>>>(), writes: MoteQuickPreferencesSaveParams[] = []
  const originalCatalog = host.discovery.catalog
  if (options.holdDiscovery) {
    vi.spyOn(host.discovery, 'catalog').mockImplementation(() => discovery.promise)
    closes.push(async () => { discovery.resolve(await originalCatalog()) })
  }
  const rpc = vi.fn(async (method: string, input: unknown, context?: { signal?: AbortSignal }) => {
    if (method === 'space.ls') {
      // Profile metadata is a projection of the same original Host read. The
      // actual preference read/save below always crosses its public RPC socket.
      const current = await read()
      return { catalog: { motePresentation: [{ spaceId: host.target.spaceId,
        content: { ...host.target.expectedResource, zoneId: host.target.zoneId },
        quickMode: current.source?.result.status === 'deleted' ? { status: 'missing' } : { status: 'saved', defaults: current.defaults, version: current.source?.result.status === 'read' ? current.source.result.document.revision : 'unconfirmed' },
        conversation: current.defaults?.conversation ?? null }] } }
    }
    if (method === 'space.mote.preferences.save') {
      const packet = input as MoteQuickPreferencesSaveParams
      writes.push(structuredClone(packet))
      const durable = getDeviceWorkface().snapshot().record.moteQuickDrafts?.[0]
      expect(durable?.attempts.at(-1)?.input).toEqual(packet)
      expect(durable?.blockedAttemptId).toBe(packet.operationId)
      const result = await host.rpc.call('space.mote.preferences.save', packet)
      if (options.loseReceipt) throw new Error('Original Host applied the save; its response was lost')
      if (options.holdReceipt) await receipt.promise
      return result
    }
    return host.rpc.call(method as never, input as never, context)
  })
  const client = { runtimeOwnerIdentity: () => ({ runtimeId: 'original-settings-runtime', ownerInstanceId: 'original-settings-process', availability: 'connected' }),
    forwardRpc: rpc, onEvent: () => () => {} } as unknown as AgentMuxHostedClient
  const identity = { name: '原 Agent', project: '原项目', mote: { spaceId: host.target.spaceId, name: '同一 Mote', facts: {
    spaceId: host.target.spaceId, content: { ...host.target.expectedResource, zoneId: host.target.zoneId },
    quickMode: initial.source?.result.status === 'deleted' ? { status: 'missing' as const } : { status: 'saved' as const, defaults: initial.defaults!, version: initial.source!.result.status === 'read' ? initial.source!.result.document.revision : 'unconfirmed' },
    conversation: initial.defaults?.conversation ?? null } } }
  const render = () => <MobileMoteProfile identity={identity} client={client} visible copyText={createBrowserPlatform().copyText} />
  const view = await mount(render()); await click(button(view.element, '编辑快捷配置'))
  await wait(() => expect(view.element.textContent).toContain('已核对当前配置'))
  return { host, read, initial, rpc, writes, view, render, receipt, async releaseDiscovery() { discovery.resolve(await originalCatalog()) } }
}

it('actual Mobile Profile creates only original preferences for an unbound Mote with no file or display', async () => {
  const x = await original({ absent: true })
  expect(x.initial.source?.result.status).toBe('deleted'); expect(x.initial.choices.destinations).toEqual([])
  await addExecutor(x.view.element, 'next')
  await change(x.view.element, '心跳间隔（分钟）', '7'); await submit(x.view.element)
  await wait(() => expect(x.view.element.textContent).toContain('快捷配置已保存'))
  expect(x.writes).toHaveLength(1); expect(x.writes[0]).not.toHaveProperty('destination')
  const saved = await x.read()
  expect(saved.defaults).toMatchObject({ executorId: 'next', presence: { enabled: true, intervalMs: 420000 } })
  expect(saved.defaults!.conversation).toBeUndefined(); expect(x.host.transitions).toEqual([]); expect(x.host.writes).toEqual([])
  expect(x.host.inner.kernel.stop).not.toHaveBeenCalled()
  expect(x.rpc.mock.calls.filter(([method]) => ['agent.open', 'agent.resume', 'agent.stop', 'schedule.resume', 'agent.input.submit'].includes(method))).toEqual([])
})

it('actual Mobile Profile saves same-Main settings through public Host CAS without placement or changing role and paused input', async () => {
  const x = await original()
  expect(x.initial.choices.destinations).toEqual([])
  await change(x.view.element, '心跳间隔（分钟）', '47'); await submit(x.view.element)
  await wait(() => expect(x.writes).toHaveLength(1)); await wait(() => expect(x.view.element.textContent).toContain('快捷配置已保存'))
  expect(x.writes[0]).not.toHaveProperty('destination')
  const saved = await x.read()
  expect(saved.defaults!.presence?.intervalMs).toBe(2820000)
  expect(saved.defaults!.conversation).toEqual(x.host.defaults.conversation)
  expect(saved.defaults!.conversationRevision).toBe(x.host.defaults.conversationRevision)
  expect(saved.defaults!.conversationTransition).toEqual(x.host.marker)
  expect(saved.maintenance?.schedule).toEqual(x.host.paused)
  expect(await readFile(x.host.motePath, 'utf8')).toContain(x.host.notes)
  expect(x.host.transitions).toEqual([]); expect(x.host.writes).toEqual([])
})

it('saves a fallback from Mobile Profile and leaves its original Main in place even with multiple displayed Agents', async () => {
  const x = await original()
  await x.host.confirmDisplay()
  expect(x.view.element.querySelector('select[aria-label="主对话"]')).toBeNull()
  expect(x.view.element.querySelector('[aria-label="主对话展示位置"]')).toBeNull()
  await addExecutor(x.view.element, 'next')
  await submit(x.view.element)
  await wait(() => expect(x.view.element.textContent).toContain('快捷配置已保存'))
  expect(x.writes).toHaveLength(1)
  expect(x.writes[0]).not.toHaveProperty('destination')
  const saved = await x.read()
  expect(saved.defaults).toMatchObject({ executorId: x.host.defaults.executorId, fallbackExecutorIds: ['next'],
    conversation: x.host.defaults.conversation, conversationRevision: x.host.defaults.conversationRevision })
  expect(x.host.transitions).toEqual([])
  expect(x.rpc.mock.calls.filter(([method]) => method === 'agent.open')).toEqual([])
})

it('a lost original Host save response preserves its exact operation and later edits through durable reload without replay', async () => {
  const x = await original({ loseReceipt: true })
  await change(x.view.element, '心跳间隔（分钟）', '7'); await submit(x.view.element)
  await wait(() => expect(x.view.element.textContent).toContain('保存还没确认'))
  expect(x.writes).toHaveLength(1); const packet = structuredClone(x.writes[0]!)
  expect((await x.read()).defaults!.presence?.intervalMs).toBe(420000)
  await change(x.view.element, '心跳间隔（分钟）', '47')
  await wait(() => expect(getDeviceWorkface().snapshot().record.moteQuickDrafts?.[0]?.values.presence?.intervalMs).toBe(2820000))
  const reloaded = new DeviceWorkfaceStore(() => localStorage).snapshot().record.moteQuickDrafts![0]!
  expect(reloaded.attempts[0]!.input).toEqual(packet); expect(reloaded.attempts[0]!.phase).toBe('unknown')
  expect(reloaded.blockedAttemptId).toBe(packet.operationId)
  await x.view.render(null); await x.view.render(x.render()); await click(button(x.view.element, '编辑快捷配置'))
  await wait(() => expect(x.view.element.querySelector<HTMLInputElement>('input[name="heartbeatMinutes"]')?.value).toBe('47'))
  await submit(x.view.element)
  expect(x.writes).toHaveLength(1)
  expect(getDeviceWorkface().snapshot().record.moteQuickDrafts![0]!.attempts[0]!.input).toEqual(packet)
  expect(x.host.transitions).toEqual([]); expect(x.host.writes).toEqual([])
})

it('a late original save acknowledgement cannot replace a later Mobile preference edit', async () => {
  const x = await original({ holdReceipt: true })
  await change(x.view.element, '心跳间隔（分钟）', '7'); await submit(x.view.element)
  await wait(() => expect(x.writes).toHaveLength(1))
  await change(x.view.element, '心跳间隔（分钟）', '47')
  await wait(() => expect(getDeviceWorkface().snapshot().record.moteQuickDrafts?.[0]?.values.presence?.intervalMs).toBe(2820000))
  x.receipt.resolve(null)
  await wait(() => expect(x.view.element.textContent).toContain('快捷配置已保存'))
  expect(x.view.element.querySelector<HTMLInputElement>('input[name="heartbeatMinutes"]')!.value).toBe('47')
  const saved = getDeviceWorkface().snapshot().record.moteQuickDrafts![0]!
  expect(saved.values.presence?.intervalMs).toBe(2820000); expect(saved.attempts[0]!.input.values.presence?.intervalMs).toBe(420000)
  expect(saved.attempts[0]!.phase).toBe('saved'); expect((await x.read()).defaults!.presence?.intervalMs).toBe(420000)
  expect(x.writes).toHaveLength(1); expect(x.host.transitions).toEqual([]); expect(x.host.writes).toEqual([])
})

it('fresh original file settings remain editable and saveable while display discovery is unresolved', async () => {
  const x = await original({ holdDiscovery: true })
  expect(x.view.element.querySelector<HTMLInputElement>('input[name="heartbeatMinutes"]')!.value).toBe('30')
  expect(x.rpc.mock.calls.some(([method, input]) => method === 'space.mote.preferences.read' && (input as { includeChoices?: boolean }).includeChoices === false)).toBe(true)
  await change(x.view.element, '心跳间隔（分钟）', '47'); await submit(x.view.element)
  await wait(() => expect(x.view.element.textContent).toContain('快捷配置已保存'))
  expect(x.writes).toHaveLength(1); expect(x.writes[0]).not.toHaveProperty('destination')
  const facts = await x.host.rpc.call('space.mote.preferences.read', { kind: 'quick', target: x.host.target, includeChoices: false })
  expect(facts.kind).toBe('quick')
  if (facts.kind !== 'quick') throw Error('Original Quick source required')
  expect(facts.defaults!.presence?.intervalMs).toBe(2820000)
  expect(facts.defaults!.conversation).toEqual(x.host.defaults.conversation)
  expect(facts.maintenance?.schedule).toEqual(x.host.paused)
  await x.releaseDiscovery()
})

it('late original candidate discovery adds choices without replacing the later preference draft or its baseline', async () => {
  const x = await original({ holdDiscovery: true })
  await change(x.view.element, '心跳间隔（分钟）', '47')
  await wait(() => expect(getDeviceWorkface().snapshot().record.moteQuickDrafts?.[0]?.values.presence?.intervalMs).toBe(2820000))
  const before = structuredClone(getDeviceWorkface().snapshot().record.moteQuickDrafts![0]!)
  await x.releaseDiscovery()
  await wait(() => expect(x.view.element.textContent).not.toContain('正在读取其余候选'))
  expect(x.view.element.querySelector<HTMLInputElement>('input[name="heartbeatMinutes"]')!.value).toBe('47')
  expect(getDeviceWorkface().snapshot().record.moteQuickDrafts![0]!.baseline).toEqual(before.baseline)
  expect(getDeviceWorkface().snapshot().record.moteQuickDrafts![0]!.values).toEqual(before.values)
  expect(x.writes).toEqual([])
})

it('closing the settings reader aborts its original discovery and keeps the unsubmitted device draft', async () => {
  const x = await original({ holdDiscovery: true })
  await change(x.view.element, '心跳间隔（分钟）', '47')
  await wait(() => expect(getDeviceWorkface().snapshot().record.moteQuickDrafts?.[0]?.values.presence?.intervalMs).toBe(2820000))
  const calls = x.rpc.mock.calls.filter(([method, input, context]) => method === 'space.mote.preferences.read' && (input as { includeChoices?: unknown }).includeChoices === 'locations' && context?.signal)
  expect(calls).toHaveLength(1)
  const signal = calls[0]![2]!.signal!, before = structuredClone(getDeviceWorkface().snapshot().record.moteQuickDrafts![0]!)
  expect(signal.aborted).toBe(false)
  await x.view.render(null)
  expect(signal.aborted).toBe(true)
  await x.releaseDiscovery()
  expect(getDeviceWorkface().snapshot().record.moteQuickDrafts![0]).toEqual(before)
  expect(x.writes).toEqual([])
})
