// @vitest-environment happy-dom
import { act } from 'react'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
vi.mock('react-resizable-panels', async () => { const { createRequire } = await import('node:module'); return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js') })
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div>Controlled terminal rendering</div> }))
vi.mock('electron', () => ({ app: {}, nativeImage: {} }))
import { connectorJourneyFixture } from './fixtures/connector-journey'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { openConnectedGroup } from './helpers/connector-header-navigation'

const f = connectorJourneyFixture({ platform: async request => {
  if (request.url?.endsWith('/members')) return { code: 0, data: { items: [], has_more: false } }
  return { code: 0, data: { name: request.url?.includes('oc_occupied') ? 'Research discussion' : 'Engineering discussion', chat_status: 'normal', chat_mode: 'group' } }
} })
const wait = (check: () => void) => vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 8000 })
const dialog = () => document.querySelector<HTMLElement>('.agent-connector-dialog')!
const recovery = () => dialog()?.querySelector<HTMLElement>('[aria-label="Group setup status"]')
const writes = () => f.calls.filter(call => /configure|\.bind$|\.relink$|\.pause$|\.resume$|\.detach$|\.grant$|\.create$|\.retry$/.test(call.method))
const button = (label: string) => [...dialog().querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === label)
const bindingRequest = () => [...f.calls].reverse().find(call => call.method === 'connection.bind' || call.method === 'connection.binding.relink')!
async function consent() {
  await wait(() => expect(dialog().getAttribute('aria-busy')).not.toBe('true'))
  const box = dialog().querySelector<HTMLInputElement>('.agent-connector-check input')!
  expect(box).not.toBeNull(); expect(box.checked).toBe(false)
  await act(async () => box.click())
}
async function peerBinding() {
  // A second real durable Session and native transcript provide an actual Core mapping conflict.
  const stored = f.original.session, transcript = join(f.original.root, 'peer.jsonl')
  await writeFile(transcript, (await readFile(f.original.transcript, 'utf8')).split('\n').filter(Boolean).map(line => JSON.stringify({ ...JSON.parse(line), sessionId: 'peer-native' })).join('\n') + '\n')
  await f.original.store.compareAndSwap(null, { ...stored, agentSessionId: 'peer-agent', run: { runId: 'controlled-peer-run' }, nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'peer-native', transcriptPath: transcript } })
  const { regionAnchor: _anchor, ...input } = f.original.input
  const result = await f.forward('connection.bind', { ...input, operationId: 'bind-peer-occupied', bindingId: 'peer-binding', connectionId: f.config.connectionId, agentSessionId: 'peer-agent', externalConversationId: 'oc_occupied', expectedSource: { providerId: 'claude', nativeSessionId: 'peer-native' } }, f.hostingTarget)
  expect(result.state).toBe('applied')
  if (result.state !== 'applied') throw Error('Peer setup must establish the real conflicting binding')
  return result.binding
}
async function submitOccupied() {
  await f.mount(); await f.journey('existing'); await f.fill('Existing group ID', 'oc_occupied')
  await consent(); await f.button('Connect group')
  await wait(() => expect(recovery()?.dataset.state).toBe('refused'))
  await wait(() => expect(dialog().getAttribute('aria-busy')).not.toBe('true'))
  return bindingRequest()
}
async function unchangedOriginal(before: Buffer) {
  expect(await readFile(f.original.storePath)).toEqual(before)
  expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe('Keep the original draft 中')
  expect(f.original.create).not.toHaveBeenCalled(); expect(f.original.addMembers).not.toHaveBeenCalled()
}

it('Setup recovery presents a real original-owner refusal and exact conflict without claiming a pending result', async () => {
  const peer = await peerBinding(), before = await readFile(f.original.storePath)
  const request = await submitOccupied()
  expect(request.result).toMatchObject({ state: 'refused', code: 'ROOM_BINDING_MAPPING_CONFLICT' })
  expect(recovery()?.textContent).toContain('Group connection was not saved')
  await wait(() => expect(recovery()?.textContent).toContain('Another Agent'))
  expect(recovery()?.textContent).not.toContain('Connection result is not confirmed')
  expect(button('Review group selection')).toBeDefined()
  expect(button('Continue setup')).toBeUndefined()
  const observed = await f.forward('connection.binding.inspect', { operationId: (request.input as { operationId: string }).operationId }, f.hostingTarget)
  expect(observed.operation).toEqual(request.result)
  expect(observed.mappingConflict).toMatchObject({ status: 'checked', current: [{ binding: { bindingId: peer.bindingId, revision: peer.revision, externalConversationId: 'oc_occupied', agentSessionId: 'peer-agent' }, differences: expect.arrayContaining(['target']) }] })
  const count = writes().length
  await f.button('Check status')
  await wait(() => expect(dialog().getAttribute('aria-busy')).not.toBe('true'))
  expect(writes()).toHaveLength(count)
  expect((await f.forward('connection.binding.inspect', { bindingId: peer.bindingId }, f.hostingTarget)).current).toEqual(peer)
  await unchangedOriginal(before)
}, 120_000)

it('Setup recovery returns to the retained selection without a write and requires fresh confirmation for one corrected binding', async () => {
  await peerBinding(); const before = await readFile(f.original.storePath)
  const refused = await submitOccupied(), operationId = (refused.input as { operationId: string }).operationId
  const count = writes().length, reads = f.calls.length
  await f.button('Review group selection')
  await wait(() => expect(recovery()).toBeNull())
  expect(dialog().querySelector<HTMLInputElement>('[aria-label="Existing group ID"]')?.value).toBe('oc_occupied')
  expect(dialog().querySelector<HTMLInputElement>('.agent-connector-check input')?.checked).toBe(false)
  expect(button('Connect group')?.disabled).toBe(true)
  expect(writes()).toHaveLength(count)
  expect(f.calls.slice(reads).some(call => call.method === 'connection.binding.inspect' && (call.input as { operationId?: string }).operationId === operationId)).toBe(false)
  expect((await f.forward('connection.binding.inspect', { operationId }, f.hostingTarget)).operation).toEqual(refused.result)
  await f.fill('Existing group ID', 'oc_corrected')
  expect(button('Connect group')?.disabled).toBe(true)
  await consent(); await f.button('Connect group')
  await wait(() => expect(dialog().querySelector('.connector-group-details')).not.toBeNull())
  expect(writes().slice(count)).toHaveLength(1)
  const corrected = bindingRequest()
  expect(corrected.input).toMatchObject({ connectionId: f.config.connectionId, agentSessionId: 'original-agent', externalConversationId: 'oc_corrected' })
  expect((corrected.input as { operationId: string }).operationId).not.toBe(operationId)
  expect(corrected.result).toMatchObject({ state: 'applied', binding: { externalConversationId: 'oc_corrected' } })
  expect((await f.forward('connection.binding.inspect', { operationId }, f.hostingTarget)).operation).toEqual(refused.result)
  await unchangedOriginal(before)
}, 120_000)

it('Setup recovery keeps a lost binding acknowledgement unknown across remount and observes only its original request', async () => {
  let unavailable = true, acknowledgementLost = false
  vi.mocked(api.connections.call).mockImplementation(async (method, input, hosting) => {
    if (method === 'connection.binding.inspect' && 'operationId' in input && unavailable) throw Error('Controlled original observation unavailable')
    const result = await f.forward(method, input, hosting)
    if (method === 'connection.bind') { acknowledgementLost = true; throw Error('Controlled acknowledgement lost after the original owner applied') }
    return result
  })
  await f.mount(); await f.journey('existing'); await f.fill('Existing group ID', 'oc_unknown')
  await consent(); await f.button('Connect group')
  await wait(() => expect(acknowledgementLost).toBe(true))
  await wait(() => expect(recovery()?.dataset.state).toBe('unknown'))
  const request = bindingRequest(), operationId = (request.input as { operationId: string }).operationId
  expect(request.result).toMatchObject({ state: 'applied' })
  const retained = useAppStore.getState().connectorRoomIntents[operationId]!, persisted = localStorage.getItem('agentmux-workbench-v1')!
  expect(retained.phase).toBe('may-have-dispatched')
  await f.dom.render(null); useAppStore.setState({ connectorRoomIntents: {} })
  localStorage.setItem('agentmux-workbench-v1', persisted); await useAppStore.persist.rehydrate()
  await f.mount(); await wait(() => expect(document.querySelector('[data-channel-entry="feishu"]')).not.toBeNull())
  await openConnectedGroup('oc_unknown', 'original-region', 'feishu')
  await wait(() => expect(recovery()?.dataset.state).toBe('unknown'))
  expect(recovery()?.textContent).toContain('Connection result is not confirmed')
  expect(button('Review group selection')).toBeUndefined(); expect(button('Continue setup')).toBeUndefined()
  expect(writes().filter(call => call.method === 'connection.bind')).toHaveLength(1)
  const count = writes().length
  unavailable = false; await f.button('Check status')
  await wait(() => expect(dialog().querySelector('.connector-group-details')).not.toBeNull())
  expect(writes()).toHaveLength(count)
  const inspections = vi.mocked(api.connections.call).mock.calls.filter(call => call[0] === 'connection.binding.inspect' && 'operationId' in call[1])
  expect(inspections.length).toBeGreaterThan(0)
  for (const [, input, owner] of inspections) { expect(input).toEqual({ operationId }); expect(owner).toEqual(f.hostingTarget) }
  expect(useAppStore.getState().connectorRoomIntents[operationId]).toBeUndefined()
  await f.original.unchanged()
}, 120_000)

it('Setup recovery retains the saved group after a refused relink and public inspection separates immutable refusal from current conflict', async () => {
  const peer = await peerBinding(), before = await readFile(f.original.storePath)
  const saved = await f.forward('connection.bind', { ...f.original.input, operationId: 'bind-saved-original', bindingId: 'saved-original', connectionId: f.config.connectionId, externalConversationId: 'oc_saved' }, f.hostingTarget)
  expect(saved.state).toBe('applied'); if (saved.state !== 'applied') throw Error('Original binding must be confirmed')
  await f.mount(); await wait(() => expect(document.querySelector('[data-channel-entry="feishu"]')).not.toBeNull())
  await openConnectedGroup('oc_saved', 'original-region', 'feishu')
  await wait(() => expect(dialog().querySelector('.connector-group-details')).not.toBeNull())
  const change = [...dialog().querySelectorAll('details')].find(node => node.querySelector('summary')?.textContent === 'Change connected group')!
  expect(change).toBeDefined(); await act(async () => change.querySelector('summary')!.click())
  await f.fill('Existing group ID', 'oc_occupied'); await consent(); await f.button('Change group')
  await wait(() => expect(recovery()?.dataset.state).toBe('refused'))
  const request = bindingRequest(), operationId = (request.input as { operationId: string }).operationId
  expect(request.method).toBe('connection.binding.relink')
  expect((await f.forward('connection.binding.inspect', { bindingId: saved.binding.bindingId }, f.hostingTarget)).current).toEqual(saved.binding)
  const cli = process.env.CONNECTOR_SETUP_RECOVERY_CLI
  expect(cli, 'This consumer requires the candidate source CLI, not a previous dist parser').toBeTruthy()
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', cli!)
  const inspected = await f.cli(['binding', 'inspect', '--operation-id', operationId])
  expect(inspected.operation).toEqual(request.result)
  expect(inspected.mappingConflict).toMatchObject({ status: 'checked', current: [{ binding: { bindingId: peer.bindingId, agentSessionId: 'peer-agent', externalConversationId: 'oc_occupied' } }] })
  const count = writes().length
  await f.button('Review group selection')
  await wait(() => expect(recovery()).toBeNull())
  expect(dialog().querySelector<HTMLInputElement>('[aria-label="Existing group ID"]')?.value).toBe('oc_occupied')
  expect(writes()).toHaveLength(count)
  expect((await f.forward('connection.binding.inspect', { bindingId: saved.binding.bindingId }, f.hostingTarget)).current).toEqual(saved.binding)
  expect((await f.cli(['binding', 'inspect', '--operation-id', operationId])).operation).toEqual(request.result)
  await unchangedOriginal(before)
}, 120_000)
