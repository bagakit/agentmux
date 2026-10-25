// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
vi.mock('react-resizable-panels', async () => { const { createRequire } = await import('node:module'); return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js') })
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div>Controlled terminal rendering</div> }))
vi.mock('electron', () => ({ app: {}, nativeImage: {} }))
import { connectorJourneyFixture } from './fixtures/connector-journey'
import type { ConnectionParamsMap } from '@agentmux/core/connections'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'

const f = connectorJourneyFixture({ platform: async request => request.url?.endsWith('/members')
  ? { code: 0, data: { items: [{ member_id_type: 'open_id', member_id: 'ou_ada', name: 'Ada' }, { member_id_type: 'open_id', member_id: 'ou_ben', name: 'Ben' }], has_more: false } }
  : { code: 0, data: { name: 'Original members group', chat_status: 'normal', chat_mode: 'group' } } })
const facts: Record<string, unknown> = {}
afterEach(async () => {
  if (process.env.MEMBER_ACCESS_FACTS) { await mkdir(dirname(process.env.MEMBER_ACCESS_FACTS), { recursive: true }); await writeFile(process.env.MEMBER_ACCESS_FACTS, JSON.stringify(facts, null, 2) + '\n') }
})
const wait = (assert: () => void) => vi.waitFor(async () => { await act(async () => {}); assert() }, { timeout: 8000 })
const row = (id: string) => [...document.querySelectorAll<HTMLElement>('[data-member-row]')].find(node => node.dataset.memberRow === JSON.stringify(['open_id', id]))!
const checkbox = (id: string, permission: 'Send requests' | 'Answer questions') => [...row(id).querySelectorAll<HTMLLabelElement>('label')].find(node => node.textContent === permission)!.querySelector<HTMLInputElement>('input')!
async function toggle(id: string, permission: 'Send requests' | 'Answer questions') {
  if (!row(id).querySelector('[data-member-editor]')) await act(async () => { const panel = row(id).closest('details')!; panel.open = true; row(id).querySelector<HTMLButtonElement>('[data-member-edit]')!.click() })
  const source = row(id).querySelector<HTMLSelectElement>('select')
  if (source && source.value !== 'room') await act(async () => { source.value = 'room'; source.dispatchEvent(new Event('change', { bubbles: true })) })
  await act(async () => checkbox(id, permission).click())
}
async function click(id: string, selector: string) { await act(async () => row(id).querySelector<HTMLButtonElement>(selector)!.click()) }
async function bind() {
  const result = await f.forward('connection.bind', { ...f.original.input, operationId: 'member-binding', bindingId: 'member-group', connectionId: f.config.connectionId, expectedConnectionRevision: 1, externalConversationId: 'oc_members' }, f.hostingTarget)
  expect(result.state).toBe('applied')
  return (result as Extract<typeof result, { state: 'applied' }>).binding
}
async function open() { await f.mount(); await f.journey('details'); await wait(() => { expect(row('ou_ada')).toBeDefined(); expect(row('ou_ben')).toBeDefined() }) }
async function ready() { await wait(() => expect(row('ou_ada').dataset.memberState).not.toBe('unconfirmed')) }
const grantCalls = () => f.calls.filter(call => call.method === 'connection.grant')

it('keeps per-member edits through another row and real unmount/restore, then saves only a changed member through public IPC and CLI', async () => {
  const binding = await bind(); await open(); await ready()
  expect(row('ou_ada').textContent).toContain('No access')
  expect(row('ou_ada').querySelector('[data-member-save]')).toBeNull()
  await toggle('ou_ada', 'Send requests'); await toggle('ou_ben', 'Answer questions')
  expect(checkbox('ou_ada', 'Send requests').checked).toBe(true)
  await wait(() => {
    const stored = JSON.parse(localStorage.getItem('agentmux-workbench-v1')!).state.connectorRoomDrafts
    const edits = Object.values(stored).flatMap((draft: any) => Object.values(draft.memberDrafts ?? {})) as Array<{ actor: { userId: string }; capabilities: string[] }>
    expect(edits.some(draft => draft.actor.userId === 'ou_ada' && draft.capabilities.includes('input'))).toBe(true)
    expect(edits.some(draft => draft.actor.userId === 'ou_ben' && draft.capabilities.includes('answer'))).toBe(true)
  })
  await f.button('Close'); await f.dom.render(null); await useAppStore.persist.rehydrate(); await open()
  expect(checkbox('ou_ada', 'Send requests').checked).toBe(true)
  expect(checkbox('ou_ben', 'Answer questions').checked).toBe(true)
  expect(grantCalls()).toHaveLength(0)
  await click('ou_ada', '[data-member-save]')
  await wait(() => expect(row('ou_ada').textContent).toContain('Saved'))
  expect(row('ou_ada').querySelector('[data-member-save]')).toBeNull()
  expect(checkbox('ou_ben', 'Answer questions').checked).toBe(true)
  expect(grantCalls()).toHaveLength(1)
  const read = await f.cli(['binding', 'inspect', '--binding', binding.bindingId])
  expect(read.grants).toMatchObject([{ actor: { idType: 'open_id', userId: 'ou_ada' }, capabilities: ['input'], revision: 1 }])
  expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe('Keep the original draft 中')
  facts.restore = { retainedTwoDrafts: true, grantCalls: 1, originalBinding: binding.bindingId, cliGrants: read.grants, unchangedSaveAvailable: false }
})

it('keeps a dirty member choice through a delayed original grant read and a later save ACK', async () => {
  const binding = await bind()
  await f.forward('connection.grant', { operationId: 'original-ada', bindingId: binding.bindingId, expectedBindingRevision: 1, grantId: 'ada-grant', expectedRevision: null,
    actor: { application: binding.application, idType: 'open_id', userId: 'ou_ada' }, capabilities: ['answer'], state: 'active' }, f.hostingTarget)
  let releaseRead!: () => void, releaseAck!: () => void, readHeld = true, ackHeld = false
  const readBarrier = new Promise<void>(resolve => { releaseRead = resolve }), ackBarrier = new Promise<void>(resolve => { releaseAck = resolve }), forward = f.forward
  vi.spyOn(api.connections, 'call').mockImplementation(async (method, input, target) => {
    const holdRead = method === 'connection.binding.inspect' && 'bindingId' in input && readHeld
    const holdAck = method === 'connection.grant' && ackHeld
    const result = await forward(method, input, target)
    if (holdRead) await readBarrier
    if (holdAck) await ackBarrier
    return result
  })
  try {
    await open(); await toggle('ou_ada', 'Send requests')
    await act(async () => { readHeld = false; releaseRead() })
    await wait(() => expect(row('ou_ada').querySelector('[data-member-review]')).not.toBeNull())
    expect(checkbox('ou_ada', 'Send requests').checked).toBe(true)
    expect(checkbox('ou_ada', 'Answer questions').checked).toBe(false)
    await click('ou_ada', '[data-member-review]')
    await wait(() => expect(row('ou_ada').querySelector('[data-member-save]')).not.toBeNull())
    ackHeld = true
    await click('ou_ada', '[data-member-save]')
    await wait(() => expect(grantCalls()).toHaveLength(2))
    await toggle('ou_ada', 'Answer questions')
    await act(async () => { ackHeld = false; releaseAck() })
    await wait(() => expect(row('ou_ada').dataset.memberState).not.toBe('pending'))
    const current = await f.services.connections.bindings!.inspect({ bindingId: binding.bindingId })
    facts.late = { currentConfirmed: current.grants[0], laterDesired: ['input', 'answer'], displayedRequests: checkbox('ou_ada', 'Send requests').checked, displayedAnswers: checkbox('ou_ada', 'Answer questions').checked, draftStatus: row('ou_ada').dataset.memberState }
    expect(checkbox('ou_ada', 'Send requests').checked, 'The earlier ACK cannot replace a later dirty choice').toBe(true)
    expect(checkbox('ou_ada', 'Answer questions').checked, 'The earlier ACK cannot discard the later Answer choice').toBe(true)
    expect(row('ou_ada').textContent).toContain('Unsaved · review current access')
    expect(row('ou_ada').dataset.memberState).toBe('dirty')
    expect(current.grants[0]?.capabilities).toEqual(['input'])
  } finally { readHeld = false; ackHeld = false; releaseRead(); releaseAck() }
})

it('keeps the original unknown request, inspects a terminal refusal and explicitly corrects it against current facts', async () => {
  const binding = await bind(); await open(); await ready()
  const forward = f.forward
  let originalOperation = '', lose = true
  vi.spyOn(api.connections, 'call').mockImplementation(async (method, input, target) => {
    if (method === 'connection.grant' && lose) {
      lose = false; originalOperation = (input as ConnectionParamsMap['connection.grant']).operationId
      await forward('connection.grant', { operationId: 'competing-original', bindingId: binding.bindingId, expectedBindingRevision: 1, grantId: 'confirmed-ada', expectedRevision: null,
        actor: { application: binding.application, idType: 'open_id', userId: 'ou_ada' }, capabilities: ['answer'], state: 'active' }, target)
      const refused = await forward(method, input as ConnectionParamsMap['connection.grant'], target)
      expect(refused).toMatchObject({ state: 'refused', code: 'ROOM_GRANT_ACTOR_CONFLICT' })
      throw Error('Controlled lost original refusal ACK')
    }
    return forward(method, input, target)
  })
  await toggle('ou_ada', 'Send requests'); await click('ou_ada', '[data-member-save]')
  await wait(() => expect(row('ou_ada').textContent).toContain('Original result unconfirmed'))
  expect([...document.querySelectorAll('[role="dialog"] button')].some(button => button.textContent === 'Continue setup')).toBe(false)
  expect(row('ou_ada').querySelector('[data-member-save]')).toBeNull()
  const original = structuredClone(useAppStore.getState().connectorRoomIntents[originalOperation])
  await f.button('Close'); await f.journey('details')
  await wait(() => expect(row('ou_ada').querySelector('[data-member-review]')).not.toBeNull())
  expect(grantCalls()).toHaveLength(2)
  expect(useAppStore.getState().connectorRoomIntents[originalOperation]).toEqual(original)
  await click('ou_ada', '[data-member-review]')
  await wait(() => expect(row('ou_ada').querySelector('[data-member-save]')).not.toBeNull())
  await click('ou_ada', '[data-member-save]')
  await wait(() => expect(row('ou_ada').textContent).toContain('Saved'))
  expect(grantCalls()).toHaveLength(3)
  const old = await f.cli(['binding', 'inspect', '--operation-id', originalOperation])
  expect(old.operation).toMatchObject({ operationId: originalOperation, state: 'refused' })
  const current = await f.services.connections.bindings!.inspect({ bindingId: binding.bindingId })
  expect(current.grants[0]).toMatchObject({ grantId: 'confirmed-ada', revision: 2, capabilities: ['input'] })
  facts.refused = { originalOperation, originalRetained: true, originalResult: old.operation, totalGrantWrites: 3, repaired: current.grants[0] }
})

it('keeps earlier draft choices visible across a binding revision and sends no invalid grant while paused', async () => {
  const binding = await bind(); await open(); await ready()
  await toggle('ou_ada', 'Send requests')
  await f.button('Pause sync')
  await wait(() => expect(document.querySelector('[data-member-earlier]')).not.toBeNull())
  expect(document.querySelector('[data-member-access]')?.textContent).toContain('Original group revision 1: Send requests')
  expect(document.querySelector('[data-member-access]')?.textContent).toContain('Resume sharing')
  expect(row('ou_ada').querySelector('[data-member-save]')).toBeNull()
  expect(grantCalls()).toHaveLength(0)
  const current = await f.services.connections.bindings!.inspect({ bindingId: binding.bindingId })
  expect(current.current).toMatchObject({ revision: 2, state: 'paused' })
  facts.paused = { originalDraftVisible: true, grants: grantCalls().length, current: current.current }
})
