// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ConnectionRecord } from '@agentmux/core/connections'
import { moteBotUi } from './fixtures/mote-bot-ui'
import { moteConnectionOwner } from './fixtures/mote-connection-owner'
import { createClientUiRoot } from './helpers/client-ui-render'
import { MoteConnectionPanel } from '../src/renderer/src/components/MoteConnectionIdentity'
import { useMoteBotSetup } from '../src/renderer/src/lib/use-mote-bot-setup'
import { api } from '../src/renderer/src/lib/api'
import { retainMoteConnectionSaveIntent, useAppStore } from '../src/renderer/src/store'
import { moteConnectionBaseline } from '@agentmux/core/mote-preferences'

const cleanup: Array<() => void | Promise<unknown>> = [], facts: unknown[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); if (process.env.IDENTITY_HOSTING_FACTS) await writeFile(process.env.IDENTITY_HOSTING_FACTS, JSON.stringify({ scope: 'Original mounted Mote panel/hook, AppStore, trusted IPC and two public Core/SQLite/File owners. Hosting selection and native I/O controlled; not default deployment or live transfer.', facts }, null, 2) + '\n') })
async function fixture() {
  const f = await moteBotUi({ generic: true }); cleanup.push(f.close)
  const root = await mkdtemp(join(tmpdir(), 'amx-identity-owner-')), other = await moteConnectionOwner(root, { generic: true })
  cleanup.push(async () => { await other.close(); await rm(root, { recursive: true, force: true }) })
  const otherTarget = { hostId: 'other-host', runtimeId: 'other-runtime' }, calls: Array<{ method: string; target: typeof otherTarget; input: any }> = []
  let current = f.hostingTarget
  vi.spyOn(f.runtime, 'connectionHostingTarget').mockImplementation(async () => structuredClone(current))
  vi.spyOn(f.runtime, 'callConnectionHost').mockImplementation(async (target, method, input) => {
    calls.push({ method, target: structuredClone(target), input: structuredClone(input) })
    const client = JSON.stringify(target) === JSON.stringify(f.hostingTarget) ? f.client : JSON.stringify(target) === JSON.stringify(otherTarget) ? other.client : null
    if (!client) throw Error('Original controlled hosting owner unavailable')
    return await client.call(method, input)
  })
  const connection = { connectionId: 'same-bot-reference', adapterId: 'signed-profile', application: { domain: 'signed.example', appId: 'same-app' }, label: 'Original host bot', credentialRef: 'controlled-credential-ref', enabled: true }
  const saved = await f.client.call('connection.configure', { operationId: 'same-configure-operation', expectedRevision: null, connection })
  await other.client.call('connection.configure', { operationId: 'same-configure-operation', expectedRevision: null, connection: { ...connection, label: 'Other host sentinel' } })
  return { ...f, other, otherTarget, calls, record: saved.connection, switchOwner() { current = otherTarget } }
}
async function mount(f: Awaited<ReturnType<typeof fixture>>) {
  const node = document.createElement('div'); document.body.append(node)
  let view = createClientUiRoot(node), active = true
  const read = vi.fn(), managed = vi.fn()
  const render = async (hostingTarget = f.hostingTarget) => { await act(async () => view.render(<MoteConnectionPanel target={f.target()} hostingTarget={hostingTarget} topicId={f.motes[0]!.id} moteName="Original Mote" onRead={read} onManageConnection={managed} />)) }
  const unmount = async () => { if (active) { active = false; await act(async () => view.unmount()) } }
  cleanup.push(async () => { await unmount(); node.remove() })
  await render()
  return { node, read, managed, render, async remount() { await unmount(); await useAppStore.persist.rehydrate(); view = createClientUiRoot(node); active = true; await render() } }
}
async function wait(check: () => void) { await vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 7000 }) }
async function choose(f: Awaited<ReturnType<typeof fixture>>) {
  await wait(() => expect(document.querySelector('[aria-label="Mote chat bot"]')).not.toBeNull())
  await f.click('Choose a saved bot'); await f.click('Mote chat bot')
  const option = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(node => node.textContent?.includes('Original host bot'))
  expect(option).toBeDefined(); await act(async () => option!.click())
}

it('the actual Mote preference panel retains its read owner through a lost File ACK, remount and current-owner change', async () => {
  const f = await fixture(), view = await mount(f)
  await wait(() => expect(view.read).toHaveBeenCalled())
  expect(view.read.mock.calls.at(-1)![0].hostingTarget).toEqual(f.hostingTarget)
  await choose(f); f.switchOwner()
  const save = f.saves.getMockImplementation()!
  f.saves.mockImplementation(async (input, target) => { await save(input, target); throw Error('Controlled lost original preference ACK') })
  await f.click('Use this bot'); await wait(() => expect(view.node.textContent).toContain('save result is unconfirmed'))
  const intent = Object.values(useAppStore.getState().moteConnectionSaveIntents)[0]!
  facts.push({ case: 'original-preference-save-route', intent, routes: f.calls.filter(call => call.method === 'space.mote.preferences.save') })
  expect(intent.hostingTarget).toEqual(f.hostingTarget)
  expect((await f.preferences.read({ kind: 'connection', target: f.target() })).values?.connection?.connectionId).toBe(f.record.config.connectionId)
  expect((await f.other.preferences.read({ kind: 'connection', target: f.other.target() })).values?.connection).toBeNull()
  await view.remount(); await wait(() => expect(view.node.textContent).toContain('previous save is still unconfirmed'))
  await f.click('Check current choice')
  expect(useAppStore.getState().moteConnectionSaveIntents[intent.input.operationId]).toEqual(intent)
  expect(f.calls.filter(call => call.method === 'space.mote.preferences.save')).toHaveLength(1)
  expect(f.calls.filter(call => call.method === 'space.mote.preferences.read').every(call => JSON.stringify(call.target) === JSON.stringify(f.hostingTarget))).toBe(true)
  await f.click('Manage bot application'); expect(view.managed).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ label: 'Original host bot' }) }), f.hostingTarget)
  facts.push({ case: 'lost-ACK-original-file-owner', operationId: intent.input.operationId, originalSaved: true, otherUnchanged: true, originalRequestRetained: true })
})

it('a new profile sync uses the owner that supplied the exact connection revision even after the default hosting target changes', async () => {
  const f = await fixture(); f.switchOwner()
  let hook!: ReturnType<typeof useMoteBotSetup>
  const node = document.createElement('div'); document.body.append(node); const root = createClientUiRoot(node)
  cleanup.push(async () => { await act(async () => root.unmount()); node.remove() })
  function Probe() { hook = useMoteBotSetup(f.target(), f.motes[0]!.id, f.hostingTarget); return null }
  await act(async () => root.render(<Probe />)); await wait(() => expect(hook.profile).not.toBeNull())
  await act(async () => hook.sync(f.record, false))
  const calls = f.calls.filter(call => call.method === 'space.mote.connection.sync')
  facts.push({ case: 'original-profile-sync-route', calls, issue: hook.issue })
  expect(calls).toHaveLength(1); expect(calls[0]!.target).toEqual(f.hostingTarget)
  const operationId = calls[0]!.input.operationId
  expect((await f.client.call('space.mote.connection.inspect', { operationId })).operation).toMatchObject({ action: 'sync', snapshot: { name: 'Saved public name' } })
  expect((await f.other.client.call('space.mote.connection.inspect', { operationId })).operation).toBeNull()
  expect(calls[0]!.input.connection).toEqual({ connectionId: f.record.config.connectionId, application: f.record.config.application })
})

it('old ownerless preference intents stay intact and cannot be relabelled while an independent current choice remains available', async () => {
  const f = await fixture(), input = { kind: 'connection' as const, target: f.target() }, saved = await f.preferences.read(input)
  const intent = { input: { ...input, operationId: 'old-original-preference', baseline: moteConnectionBaseline(saved)!, values: { connection: null } }, phase: 'may-have-dispatched' as const }
  await retainMoteConnectionSaveIntent(intent); await useAppStore.persist.rehydrate()
  await expect(retainMoteConnectionSaveIntent({ ...intent, hostingTarget: f.otherTarget })).rejects.toThrow('cannot be replaced')
  expect(useAppStore.getState().moteConnectionSaveIntents[intent.input.operationId]).toEqual(intent)
  const view = await mount(f); await choose(f)
  expect(view.node.textContent).toContain('Original bot hosting owner unconfirmed')
  expect(f.calls.filter(call => call.input.operationId === intent.input.operationId)).toEqual([])
  await f.click('Use this bot')
  await wait(() => expect(f.calls.filter(call => call.method === 'space.mote.preferences.save')).toHaveLength(1))
  const actual = f.calls.find(call => call.method === 'space.mote.preferences.save')!
  expect(actual.input.operationId).not.toBe(intent.input.operationId); expect(actual.target).toEqual(f.hostingTarget)
  expect(useAppStore.getState().moteConnectionSaveIntents[intent.input.operationId]).toEqual(intent)
  facts.push({ case: 'ownerless-preference-retained', originalOperationId: intent.input.operationId, independentOperationId: actual.input.operationId, originalIO: 0 })
})

it('a late preference snapshot cannot cross an explicit hosting change for the same original Mote resource', async () => {
  const f = await fixture(), call = f.connectionCalls.getMockImplementation()!
  let release!: () => void, waiting = false
  const held = new Promise<void>(resolve => { release = resolve })
  f.connectionCalls.mockImplementation(async (method, input, target) => {
    const value = await call(method, input, target)
    if (method === 'connection.ls' && JSON.stringify(target) === JSON.stringify(f.hostingTarget)) { waiting = true; await held }
    return value
  })
  const view = await mount(f)
  await wait(() => expect(waiting).toBe(true)); await view.render(f.otherTarget)
  await act(async () => release())
  await wait(() => expect(view.read.mock.calls.length).toBeGreaterThan(0))
  facts.push({ case: 'late-original-preference', readings: view.read.mock.calls.map(([value]) => ({ hostingTarget: value.hostingTarget, saved: value.saved.status })), routes: f.calls.filter(call => call.method === 'space.mote.preferences.read') })
  expect(view.read.mock.calls.every(([value]) => JSON.stringify(value.hostingTarget) === JSON.stringify(f.otherTarget))).toBe(true)
  expect(view.node.textContent).not.toContain('Original host bot')
  expect(f.calls.filter(call => call.method === 'space.mote.preferences.save' || call.method === 'space.mote.connection.sync')).toEqual([])
})
