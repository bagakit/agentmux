// @vitest-environment happy-dom
import { act } from 'react'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { moteBotUi } from './fixtures/mote-bot-ui'
import { confirmAndCreateMote } from './fixtures/mote-connection-owner'
import { initialBotPublication } from '../src/renderer/src/lib/bot-creation-preset'
import { setBotTaskSelection } from '../src/renderer/src/store'
import { enrollmentInitialWeb } from '../../../packages/connectors/test/fixtures/connection-enrollment-initial'
import iconUrl from '../resources/icon-512.png'

let f: Awaited<ReturnType<typeof moteBotUi>> | undefined
let web: ReturnType<typeof enrollmentInitialWeb>
afterEach(async () => { await f?.close(); f = undefined })
const progress = () => document.querySelector('[data-initial-setup-stage]')
const guide = () => document.querySelector('[data-bot-setup-guide]')!
const refresh = () => [...document.querySelectorAll<HTMLButtonElement>('.mote-bot-actions button')].find(b => b.textContent?.trim() === 'Check saved progress')!
const effects = () => ({ http: web.requests.length, parent: f!.parentCalls.mock.calls.filter(([m]) => m.endsWith('.create') || m.endsWith('.sync') || m.endsWith('.advance')).length, child: f!.connectionCalls.mock.calls.filter(([m]) => m.endsWith('.begin') || m.endsWith('.advance')).length })
async function settleReads() {
  await act(async () => { await Promise.all(f!.parentCalls.mock.results.filter(r => r.type === 'return').map(r => r.value)); await Promise.all(f!.connectionCalls.mock.results.filter(r => r.type === 'return').map(r => r.value)) })
}
async function click(selector: string) {
  let button!: HTMLButtonElement
  await vi.waitFor(() => { button = document.querySelector(selector)!; expect(button, selector + "\n" + document.body.textContent).not.toBeNull(); expect(button.disabled).toBe(false) }, { timeout: 6000 })
  await settleReads()
  await act(async () => document.querySelector<HTMLButtonElement>(selector)!.click()); await f!.settle()
}
async function create(options: Parameters<typeof enrollmentInitialWeb>[0] = {}, loseFileAck = false, throughCreationUi = false) {
  f = await moteBotUi({ loseFileAck })
  web = enrollmentInitialWeb({ name: 'Saved public name', description: 'Saved public summary.', ...(options.versionStatus === undefined ? {} : { versionStatus: options.versionStatus }), ...(options.unknownEffect === undefined ? {} : { unknownEffect: options.unknownEffect }) })
  const image = await readFile(resolve('apps/desktop/resources/icon-512.png'))
  vi.stubGlobal('fetch', vi.fn(async (input, init) => String(input) === iconUrl ? new Response(new Uint8Array(image)) : web.fetch(input, init)))
  const route = { section: 'lark' as const, moteLarkOrigin: { target: f.target(), topicId: f.motes[0]!.id, moteName: f.scopes[0]!.topic.title } }
  let operationId: string
  if (throughCreationUi) {
    await f.renderSettings(route)
    await f.click('Create a bot for this Mote')
    await click('[data-mote-enrollment-action="confirm-account"]')
    await click('[data-mote-enrollment-action="create"]')
    operationId = (f.parentCalls.mock.calls.find(([m]) => m === 'space.mote.connection.create')![1] as { operationId: string }).operationId
  } else {
    const input = { ...await f.input(crypto.randomUUID()), initialPublication: initialBotPublication }
    operationId = input.operationId
    await f.client.call('space.mote.connection.create', input)
    await confirmAndCreateMote(f, operationId)
    setBotTaskSelection({ kind: 'mote', target: f.target() }, operationId)
    await f.renderSettings(route)
  }
  await vi.waitFor(() => expect(progress()?.getAttribute('data-state')).toBe(options.unknownEffect ? 'attention' : options.versionStatus === 1 || options.versionStatus === 5 ? 'approval-required' : 'complete'), { timeout: 6000 })
  await vi.waitFor(() => expect(refresh()).toBeDefined())
  const input = { operationId }
  let parent = (await f.client.call('space.mote.connection.inspect', { operationId: input.operationId })).operation!
  await vi.waitFor(async () => { parent = (await f!.client.call('space.mote.connection.inspect', { operationId: input.operationId })).operation!; expect(parent.defaultLink.state).toBe(loseFileAck ? 'unknown' : 'saved') })
  await settleReads(); await f.settle()
  return parent
}

it('shows actual approved creation as complete and keeps optional refresh busy through both original local reads', async () => {
  const parent = await create({}, false, true)
  expect(parent.enrollment?.initialSetup?.progress?.state).toBe('complete')
  expect(guide().querySelector('[aria-current]')).toBeNull()
  expect(guide().querySelectorAll('[data-state="recorded"]')).toHaveLength(4)
  expect(guide().textContent).toContain('Bot setup complete')
  expect(progress()?.textContent).toContain('The original version is approved.')
  expect(document.body.textContent).toContain('Message delivery')
  const button = refresh(), before = effects()
  expect(button.classList.contains('small-button')).toBe(true)
  expect(button.classList.contains('primary-button')).toBe(false)
  let releaseParent!: () => void, releaseChild!: () => void, enteredParent!: () => void, enteredChild!: () => void
  const parentHeld = new Promise<void>(r => { releaseParent = r }), childHeld = new Promise<void>(r => { releaseChild = r })
  const parentEntered = new Promise<void>(r => { enteredParent = r }), childEntered = new Promise<void>(r => { enteredChild = r })
  const parentCall = f!.parentCalls.getMockImplementation()!, childCall = f!.connectionCalls.getMockImplementation()!
  f!.parentCalls.mockImplementation(async (method, input) => { if (method === 'space.mote.connection.inspect') { enteredParent(); await parentHeld }; return parentCall(method, input) })
  f!.connectionCalls.mockImplementation(async (method, input) => { if (method === 'connection.enrollment.inspect' && !('requestTrace' in input)) { enteredChild(); await childHeld }; return childCall(method, input) })
  try {
    await act(async () => button.click()); await parentEntered
    expect(button.textContent?.trim()).toBe('Check saved progress')
    expect(button.getAttribute('aria-busy')).toBe('true')
    expect(button.querySelector('[data-semantic-icon="status.loading"]')).not.toBeNull()
    await act(async () => { releaseParent(); await childEntered })
    expect(button.getAttribute('aria-busy')).toBe('true')
    expect(guide().querySelector('[aria-current]')).toBeNull()
  } finally { await act(async () => { releaseParent(); releaseChild() }) }
  await vi.waitFor(() => expect(document.body.textContent).toContain('Saved progress checked.'))
  await vi.waitFor(() => expect(button.getAttribute('aria-busy')).toBe('false'))
  expect(button.textContent?.trim()).toBe('Check saved progress')
  expect(effects()).toEqual(before)
}, 30_000)

it.each([
  { name: 'reviewing version', versionStatus: 1, loseFileAck: false },
  { name: 'awaiting release', versionStatus: 5, loseFileAck: false },
  { name: 'unknown configuration write', unknownEffect: '/event/switch/', loseFileAck: false },
  { name: 'unconfirmed local association', versionStatus: 2, loseFileAck: true }
])('keeps $name separate from full creation completion', async options => {
  const parent = await create(options, options.loseFileAck)
  expect(guide().querySelector('[aria-current]')?.getAttribute('data-step')).toBe('4')
  expect(guide().textContent).not.toContain('Bot setup complete')
  if (options.loseFileAck) expect(parent.defaultLink.state).toBe('unknown')
  else expect(parent.enrollment?.initialSetup?.progress?.state).not.toBe('complete')
}, 30_000)

it.each(['matching', 'parent-summary-missing', 'foreign', 'foreign-setup'] as const)('uses only the %s newer child observation beside a retained parent snapshot', async source => {
  const parent = await create({ versionStatus: 1 })
  const childId = parent.enrollmentOperationId!, view = await f!.client.call('connection.enrollment.inspect', { operationId: childId })
  const parentCall = f!.parentCalls.getMockImplementation()!
  f!.parentCalls.mockImplementation(async (method, input) => method === 'space.mote.connection.inspect' ? { operation: source === 'parent-summary-missing' ? { ...parent, enrollment: null } : parent } : parentCall(method, input))
  const transport = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    const response = await transport(input, init)
    if (!String(input).includes('/app_version/detail/')) return response
    const value = await response.json(); value.data.versionStatus = 2
    return Response.json(value)
  }))
  const action = view.actions.find(a => a.kind === 'continue-setup')!
  expect(action).toBeDefined()
  const fresh = await f!.client.call('connection.enrollment.advance', { operationId: childId, ownRevision: action.ownRevision, decision: { actionId: action.actionId, kind: action.kind } })
  expect(fresh.operation!.initialSetup!.progress!.state).toBe('complete')
  expect(fresh.operation!.revision).toBeGreaterThanOrEqual(parent.enrollment!.revision)
  const childCall = f!.connectionCalls.getMockImplementation()!
  // The real public fresh DTO is the source. Only its identity is conflicted for the negative reply boundary.
  f!.connectionCalls.mockImplementation(async (method, input) => method === 'connection.enrollment.inspect' && !('requestTrace' in input)
    ? source === 'foreign' ? { ...fresh, operation: { ...fresh.operation!, operationId: 'foreign-original-child' } } : source === 'foreign-setup' ? { ...fresh, operation: { ...fresh.operation!, initialSetup: { ...fresh.operation!.initialSetup!, operationId: 'foreign-initial-setup' } } } : fresh
    : childCall(method, input))
  const before = effects()
  await act(async () => refresh().click())
  await vi.waitFor(() => expect(document.body.textContent).toContain('Saved progress checked.'))
  if (source === 'matching' || source === 'parent-summary-missing') { expect(guide().querySelector('[aria-current]')).toBeNull(); expect(guide().textContent).toContain('Bot setup complete') }
  else { expect(guide().querySelector('[aria-current]')?.getAttribute('data-step')).toBe('4'); expect(guide().textContent).not.toContain('Bot setup complete') }
  expect(effects()).toEqual(before)
}, 30_000)
