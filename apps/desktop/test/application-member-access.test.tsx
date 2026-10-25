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
import { copyConnectorIdentity } from './helpers/connector-identity-copy'
import { channelMetadataSubjectKey, type ChannelMetadataSubject } from '@agentmux/core/connections'
import { ConnectorEntityIdentity, ConnectorIdentityField } from '../src/renderer/src/components/ConnectorEntityIdentity'
import { useConnectorEntityProfiles } from '../src/renderer/src/lib/use-connector-room-name'

const creatorId = 'ou_creator'
const f = connectorJourneyFixture({ platform: async request => {
  if (request.url?.endsWith('/bot/v3/info')) return { code: 0, bot: { open_id: 'ou_bot', app_name: 'Original bot' } }
  if (request.url?.includes('/application/v6/applications/')) return { code: 0, data: { app: { app_id: f.config.application.appId, creator_id: creatorId } } }
  if (request.url?.includes('/contact/v3/users/')) return { code: 0, data: { user: { open_id: creatorId, name: 'Ava', avatar: { avatar_240: 'https://cdn.example/ava-original.png' } } } }
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

it('loads the first visible original person through Settings and copies their identity while a failed avatar preserves the original access proposal', async () => {
  const clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  const forward = f.forward
  vi.mocked(api.connections.call).mockImplementation(async (method, input, owner) => {
    const result = await forward(method, input, owner)
    if (method === 'connection.metadata.get') {
      const reading = result as import('@agentmux/core/connections').ChannelMetadataResult
      return { ...reading, entry: { ...reading.entry, observation: { ...reading.entry.observation, freshness: 'stale' } } } as typeof result
    }
    return result
  })
  await app()
  await wait(() => expect(appRow().textContent).toContain('Profile update unconfirmed'))
  await wait(() => expect(appRow().querySelector('[data-entity-kind="person"] img')?.getAttribute('src')).toBe('https://cdn.example/ava-original.png'))
  const before = choices(appRow()).map(input => input.checked)
  await copyConnectorIdentity(appRow(), 'Copy person name', 'Ava')
  await copyConnectorIdentity(appRow(), 'Copy open_id', creatorId)
  const image = appRow().querySelector<HTMLImageElement>('[data-entity-kind="person"] img')!
  await act(async () => image.dispatchEvent(new Event('error')))
  expect(appRow().querySelector('[data-entity-kind="person"] img')).toBeNull()
  expect(appRow().querySelector('.connector-entity__name')?.textContent).toBe('Ava')
  expect(appRow().textContent).toContain(creatorId)
  expect(choices(appRow()).map(input => input.checked)).toEqual(before)
  expect(applicationWrites()).toHaveLength(0)
  expect(clipboard.mock.calls.map(call => call[0])).toEqual(['Ava', creatorId])
  facts.entityCopy = { originalName: 'Ava', originalId: creatorId, avatarFailurePreservedIdentity: true, capabilities: before, writes: applicationWrites().length }
})

it.each(['subject', 'hosting-owner'] as const)('keeps late entity profile observations inside their original %s and never adds a native lookup', async change => {
  const original: ChannelMetadataSubject = { kind: 'actor', actor: { application: f.config.application, idType: 'open_id', userId: creatorId } }
  const other: ChannelMetadataSubject = { kind: 'actor', actor: { ...original.actor, userId: 'ou_ben' } }
  await f.forward('connection.metadata.refresh', { connectionId: f.config.connectionId, expectedConnectionRevision: 1, subject: original }, f.hostingTarget)
  const nativeReads = f.platformCalls.length, localReads: unknown[] = [], released: Array<() => void> = []
  let held = false, release!: () => void, completed = 0
  const barrier = new Promise<void>(resolve => { release = resolve })
  const forward = f.forward
  vi.spyOn(api.connections, 'call').mockImplementation(async (method, input, owner) => {
    if (method === 'connection.metadata.get') localReads.push({ input, owner })
    if (owner?.hostId === 'different-profile-host') throw Error('Controlled different Host metadata unavailable')
    const result = await forward(method, input, owner)
    if (method === 'connection.metadata.get' && !held) { held = true; await barrier; completed++ }
    return result
  })
  vi.spyOn(api.connections, 'onMetadataChanged').mockImplementation((listener, observation, owner) => {
    // Delivery timing is controlled; the original metadata result still comes through Core/RPC/IPC.
    observation?.('ready')
    released.push(() => listener({ connectionId: f.config.connectionId, application: f.config.application, subject: original }))
    return () => {}
  })
  function People({ subjects, owner, active = true }: { subjects: readonly ChannelMetadataSubject[]; owner: typeof f.hostingTarget; active?: boolean }) {
    const profiles = useConnectorEntityProfiles(f.config, subjects, owner, active)
    return <>{subjects.map(subject => {
      if (subject.kind !== 'actor') throw Error('This fixture renders actual person identities')
      const key = channelMetadataSubjectKey(subject), profile = profiles.get(key)?.observation?.profile
      return <ConnectorEntityIdentity key={key} identityKey={key} kind="person" name={profile?.name} missingName="Profile not observed" avatarUrl={profile?.avatarUrl}
        secondary={<ConnectorIdentityField identityKey={key} label={subject.actor.idType} value={subject.actor.userId} />} />
    })}</>
  }
  try {
    await f.dom.render(<People subjects={[original]} owner={f.hostingTarget} />)
    await wait(() => expect(held).toBe(true))
    const subjects = change === 'subject' ? [other] : [original]
    const owner = change === 'hosting-owner' ? { ...f.hostingTarget, hostId: 'different-profile-host' } : f.hostingTarget
    await f.dom.render(<People subjects={subjects} owner={owner} />)
    await act(async () => release())
    await wait(() => expect(completed).toBe(1))
    expect(document.querySelector('.connector-entity__name')?.textContent).toBe('Profile not observed')
    expect(document.querySelector('[data-entity-kind="person"] img')).toBeNull()
    expect(document.querySelector('[data-identity-field="open_id"]')?.textContent).toContain(change === 'subject' ? 'ou_ben' : creatorId)
    expect(document.querySelector('[aria-label="Copy person name"]')).toBeNull()
    const before = localReads.length
    await f.dom.render(<People subjects={subjects} owner={owner} active={false} />)
    await act(async () => { for (const staleCallback of released) staleCallback() })
    expect(localReads).toHaveLength(before)
    expect(f.platformCalls).toHaveLength(nativeReads)
    expect(applicationWrites()).toHaveLength(0)
  } finally { release() }
})
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
