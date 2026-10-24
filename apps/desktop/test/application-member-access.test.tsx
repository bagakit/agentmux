// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
vi.mock('react-resizable-panels', async () => { const { createRequire } = await import('node:module'); return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js') })
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div>Controlled terminal rendering</div> }))
vi.mock('electron', () => ({ app: {}, nativeImage: {} }))
import { connectorJourneyFixture } from './fixtures/connector-journey'
import { ExternalConnectionsSettings } from '../src/renderer/src/components/settings/ExternalConnectionsSettings'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'

const creatorId = 'ou_creator'
const f = connectorJourneyFixture({ platform: async request => {
  if (request.url?.endsWith('/bot/v3/info')) return { code: 0, bot: { open_id: 'ou_bot', app_name: 'Original bot' } }
  if (request.url?.includes('/application/v6/applications/')) return { code: 0, data: { app: { app_id: f.config.application.appId, creator_id: creatorId } } }
  if (request.url?.includes('/contact/v3/users/')) return { code: 0, data: { user: { open_id: creatorId, name: 'Ava' } } }
  if (request.url?.endsWith('/members')) return { code: 0, data: { items: [{ member_id_type: 'open_id', member_id: creatorId, name: 'Ava' }, { member_id_type: 'open_id', member_id: 'ou_ben', name: 'Ben' }], has_more: false } }
  return { code: 0, data: { name: 'Original members group', chat_status: 'normal', chat_mode: 'group' } }
} })
const facts: Record<string, unknown> = {}
afterEach(async () => {
  if (process.env.APPLICATION_MEMBER_FACTS) { await mkdir(dirname(process.env.APPLICATION_MEMBER_FACTS), { recursive: true }); await writeFile(process.env.APPLICATION_MEMBER_FACTS, JSON.stringify(facts, null, 2) + '\n') }
})
const wait = (assertion: () => void) => vi.waitFor(async () => { await act(async () => {}); assertion() }, { timeout: 8000 })
const appRow = (id = creatorId) => [...document.querySelectorAll<HTMLElement>('[data-application-member-row]')].find(row => row.dataset.applicationMemberRow === JSON.stringify(['open_id', id]))!
const groupRow = (id = creatorId) => [...document.querySelectorAll<HTMLElement>('[data-member-row]')].find(row => row.dataset.memberRow === JSON.stringify(['open_id', id]))!
const choices = (row: HTMLElement) => [...row.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
async function click(node: HTMLElement) { expect(node).toBeDefined(); await act(async () => node.click()) }
async function changeSource(row: HTMLElement, source: 'application' | 'room') { const select = row.querySelector<HTMLSelectElement>('select')!; await act(async () => { select.value = source; select.dispatchEvent(new Event('change', { bubbles: true })) }) }
async function app() {
  await f.dom.render(<ExternalConnectionsSettings active hostingTarget={f.hostingTarget} />)
  await wait(() => expect(document.querySelector('[data-application-access-settings]') || document.querySelector('.connector-record__open')).not.toBeNull())
  if (!document.querySelector('[data-application-access-settings]')) await click(document.querySelector<HTMLElement>('.connector-record__open')!)
  await wait(() => expect(document.querySelector('[data-application-access-settings] > summary')).not.toBeNull())
  await click(document.querySelector<HTMLElement>('[data-application-access-settings] > summary')!)
  await wait(() => expect(appRow()).toBeDefined())
}
const actor = () => ({ application: f.config.application, idType: 'open_id', userId: creatorId })
const applicationWrites = () => f.calls.filter(call => call.method === 'connection.application.access.configure')
async function setApp(capabilities: Array<'input' | 'answer' | 'permission'>) {
  return f.forward('connection.application.access.configure', { operationId: 'original-application-rule', connectionId: f.config.connectionId, expectedConnectionRevision: 1, grantId: 'application-creator', expectedRevision: null, actor: actor(), capabilities, state: capabilities.length ? 'active' : 'revoked' }, f.hostingTarget)
}
async function bind() {
  const result = await f.forward('connection.bind', { ...f.original.input, operationId: 'application-member-binding', bindingId: 'member-group', connectionId: f.config.connectionId, expectedConnectionRevision: 1, externalConversationId: 'oc_members' }, f.hostingTarget)
  expect(result.state).toBe('applied')
  if (result.state !== 'applied') throw Error('The original binding did not apply')
  return result.binding
}
async function settingsDraft() {
  await wait(() => expect(JSON.parse(localStorage.getItem('agentmux-workbench-v1')!).state.manualConnectionIntents).toBeDefined())
}

it('preselects only a confirmed absent creator proposal, keeps all cancelled choices and Discard through reopening, then explicitly saves all groups', async () => {
  await app()
  await wait(() => expect(choices(appRow()).map(input => input.checked)).toEqual([true, true, true]))
  expect(applicationWrites()).toHaveLength(0)
  for (const input of choices(appRow())) await click(input)
  facts.creatorCancelled = { selected: choices(appRow()).map(input => input.checked), writes: applicationWrites().length }
  expect(choices(appRow()).map(input => input.checked), 'Cancelling the creator choices must not reapply the preset').toEqual([false, false, false])
  expect(appRow().querySelector('[data-application-member-save]')).not.toBeNull()
  await click([...appRow().querySelectorAll<HTMLElement>('button')].find(button => button.textContent === 'Discard changes')!)
  expect(appRow().querySelector('[data-application-member-save]')).toBeNull()
  await settingsDraft()
  await wait(() => {
    const saved = JSON.parse(localStorage.getItem('agentmux-workbench-v1')!).state.manualConnectionIntents
    expect(Object.values(saved).some((entry: any) => Object.values(entry.applicationAccess?.drafts ?? {}).some((draft: any) => draft.decision === 'absent'))).toBe(true)
  })
  await f.dom.render(null); await useAppStore.persist.rehydrate(); await app()
  expect(choices(appRow()).map(input => input.checked)).toEqual([false, false, false])
  expect(applicationWrites()).toHaveLength(0)
  for (const input of choices(appRow())) await click(input)
  expect(appRow().textContent).toContain('current and future groups')
  await click(appRow().querySelector<HTMLElement>('[data-application-member-save]')!)
  await wait(() => expect(appRow().textContent).toContain('Saved · all groups'))
  expect(applicationWrites()).toHaveLength(1)
  expect(appRow().querySelector('[data-application-member-save]')).toBeNull()
  const read = await f.forward('connection.application.access.get', { connectionId: f.config.connectionId }, f.hostingTarget)
  expect(read.grants[0]).toMatchObject({ actor: actor(), capabilities: ['input', 'answer', 'permission'], state: 'active' })
  await f.dom.render(null); await app()
  await wait(() => expect(appRow().textContent).toContain('Saved · all groups'))
  expect(appRow().querySelector('[data-application-member-save]')).toBeNull()
  facts.creatorSaved = { grant: read.grants[0], explicitWrites: applicationWrites().length, noBinding: (await f.forward('connection.binding.ls', {}, f.hostingTarget)).bindings.length }
})

it('preserves later application choices through an earlier ACK and inspects the same unknown request after remount', async () => {
  await app(); await wait(() => expect(choices(appRow()).every(input => input.checked)).toBe(true))
  const forward = f.forward
  let release!: () => void, held = true, failAccessRead = false, originalOperation = ''
  const barrier = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(api.connections, 'call').mockImplementation(async (method, input, target) => {
    const hold = method === 'connection.application.access.configure' && held
    if (method === 'connection.application.access.get' && failAccessRead) throw Error('Controlled access reading unavailable after the original receipt')
    const result = await forward(method, input, target)
    if (hold) { originalOperation = input.operationId; await barrier; throw Error('Controlled lost original application ACK') }
    return result
  })
  try {
    await click(appRow().querySelector<HTMLElement>('[data-application-member-save]')!)
    await wait(() => expect(applicationWrites()).toHaveLength(1))
    await click(choices(appRow())[2]!)
    await act(async () => { held = false; release() })
    await wait(() => expect(appRow().textContent).toContain('Original result unconfirmed'))
    expect(appRow().querySelector('[data-application-member-save]')).toBeNull()
    const original = Object.values(useAppStore.getState().manualConnectionIntents).flatMap(item => Object.values(item.applicationAccess?.requests ?? {})).find(request => request.input.operationId === originalOperation)
    expect(original?.phase).toBe('may-have-dispatched')
    failAccessRead = true
    await f.dom.render(null); await app()
    await wait(() => expect(appRow().textContent).not.toContain('Original result unconfirmed'))
    expect(choices(appRow()).map(input => input.checked)).toEqual([true, true, false])
    expect(appRow().textContent).toContain('Unsaved')
    expect(appRow().textContent).toContain('Last confirmed access: input, answer, permission')
    expect(appRow().textContent).not.toContain('Last confirmed access: No access')
    expect(applicationWrites()).toHaveLength(1)
    const actual = await forward('connection.application.access.get', { connectionId: f.config.connectionId }, f.hostingTarget)
    expect(actual.grants[0]?.capabilities).toEqual(['input', 'answer', 'permission'])
    facts.unknown = { originalOperation, originalInput: original?.input, preservedChoices: choices(appRow()).map(input => input.checked), actualGrant: actual.grants[0], lastConfirmed: appRow().textContent?.includes('Last confirmed access: input, answer, permission'), writes: applicationWrites().length }
  } finally { held = false; release() }
})

it.each([{ capabilities: [] }, { capabilities: ['input'] }] as Array<{ capabilities: Array<'input' | 'answer' | 'permission'> }>)('keeps an original revoked or limited creator rule through late profile observation and dirty edits: %j', async ({ capabilities }) => {
  await setApp(capabilities)
  const forward = f.forward
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(api.connections, 'call').mockImplementation(async (method, input, target) => {
    const result = await forward(method, input, target)
    if (method === 'connection.profile.get') await barrier
    return result
  })
  try {
    await app()
    await wait(() => expect(choices(appRow()).map(input => input.checked)).toEqual([capabilities.includes('input'), false, false]))
    await click(choices(appRow())[1]!)
    await act(async () => release())
    await wait(() => expect(appRow().textContent).toContain('Bot creator'))
    expect(choices(appRow()).map(input => input.checked)).toEqual([capabilities.includes('input'), true, false])
    expect(applicationWrites()).toHaveLength(1)
    expect(appRow().textContent).toContain('Unsaved')
    facts['existing-' + (capabilities.join('-') || 'revoked')] = { original: capabilities, dirtyAfterLateCreator: choices(appRow()).map(input => input.checked), writes: applicationWrites().length }
  } finally { release() }
})

it('uses the original effective source, saves an empty local override and explicitly inherits without touching the application rule', async () => {
  const binding = await bind(); await setApp(['input', 'answer', 'permission'])
  await f.mount(); await f.journey('details')
  await wait(() => expect(groupRow()).toBeDefined())
  await wait(() => expect(groupRow().querySelector<HTMLSelectElement>('select')?.value).toBe('application'))
  expect(choices(groupRow()).map(input => input.checked)).toEqual([true, true, true])
  expect(choices(groupRow()).every(input => input.disabled || input.closest('fieldset')?.disabled)).toBe(true)
  await changeSource(groupRow(), 'room')
  expect(choices(groupRow()).map(input => input.checked)).toEqual([true, true, true])
  for (const input of choices(groupRow())) await click(input)
  await click(groupRow().querySelector<HTMLElement>('[data-member-save]')!)
  await wait(() => expect(groupRow().textContent).toContain('No access'))
  const local = await f.forward('connection.binding.inspect', { bindingId: binding.bindingId }, f.hostingTarget)
  expect(local.access?.find(item => item.actor.userId === creatorId)?.local).toMatchObject({ kind: 'override', grant: { state: 'revoked', capabilities: [] } })
  await changeSource(groupRow(), 'application')
  expect(groupRow().textContent).toContain('Bot settings will apply after Save')
  await click(groupRow().querySelector<HTMLElement>('[data-member-save]')!)
  await wait(() => expect(groupRow().textContent).toContain('Inherited from this bot'))
  const inherited = await f.forward('connection.binding.inspect', { bindingId: binding.bindingId }, f.hostingTarget)
  expect(inherited.access?.find(item => item.actor.userId === creatorId)).toMatchObject({ local: { kind: 'none', previousDecision: true }, effective: { capabilities: ['input', 'answer', 'permission'], source: { kind: 'application' } } })
  expect(applicationWrites()).toHaveLength(1)
  expect(f.calls.filter(call => call.method === 'connection.grant')).toHaveLength(1)
  expect(f.calls.filter(call => call.method === 'connection.binding.member.inherit')).toHaveLength(1)
  facts.inheritance = { local: local.access, inherited: inherited.access, appWrites: applicationWrites().length }
})
