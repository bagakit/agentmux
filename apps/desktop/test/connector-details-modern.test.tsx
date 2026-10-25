// @vitest-environment happy-dom
import { act } from 'react'
import { appendFile } from 'node:fs/promises'
import { beforeEach, expect, it, vi } from 'vitest'
vi.mock('react-resizable-panels', async () => { const { createRequire } = await import('node:module'); return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js') })
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div>Controlled terminal rendering</div> }))
vi.mock('electron', () => ({ app: {}, nativeImage: {} }))
import { connectorJourneyFixture } from './fixtures/connector-journey'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { copyConnectorIdentity } from './helpers/connector-identity-copy'

let lose = false
beforeEach(() => { lose = false })
const f = connectorJourneyFixture({ publication: true, platform: async request => {
  if (request.url?.endsWith('/messages')) {
    if (lose) throw Error('Controlled lost original platform acknowledgement')
    return { code: 0, data: { message_id: 'om_original_dialog', chat_id: 'oc_original_dialog', msg_type: 'interactive' } }
  }
  if (request.url?.endsWith('/members')) return { code: 0, data: { items: [{ member_id_type: 'open_id', member_id: 'ou_ada', name: 'Ada · Research and Engineering Collaboration' }], has_more: false } }
  if (request.url?.includes('/contact/v3/users/ou_saved')) return { code: 0, data: { user: { open_id: 'ou_saved', name: 'Saved participant outside this member page', avatar: { avatar_240: 'https://cdn.example/saved-participant.png' } } } }
  return { code: 0, data: { name: 'Original collaboration group', chat_status: 'normal', chat_mode: 'group' } }
} })
const wait = (check: () => void) => vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 8000 })
const dialog = () => document.querySelector<HTMLElement>('.agent-connector-dialog')!
const traffic = () => dialog().querySelector<HTMLElement>('.connector-traffic-summary')!
const writes = () => f.calls.filter(call => /configure|\.bind$|\.relink$|\.pause$|\.grant$|\.create$|\.retry$/.test(call.method)).length
async function bind() {
  const result = await f.forward('connection.bind', { ...f.original.input, operationId: 'dialog-bind', bindingId: 'original-dialog', connectionId: f.config.connectionId, expectedConnectionRevision: 1, externalConversationId: 'oc_original_dialog' }, f.hostingTarget)
  expect(result.state).toBe('applied')
  return (result as Extract<typeof result, { state: 'applied' }>).binding
}
async function section(name: string) { await act(async () => dialog().querySelector<HTMLButtonElement>(`[role="tab"][aria-controls$="-${name}-panel"]`)!.click()) }
async function open() { await f.mount(); await f.journey('details'); await wait(() => expect(traffic()).not.toBeNull()) }
const nativeRow = (id: string, type: 'user' | 'assistant') => JSON.stringify({ sessionId: 'original-native', uuid: id, type, message: { role: type, content: [{ type: 'text', text: 'Original private source ' + id }] } }) + '\n'

it('opens View group details at the group overview from the actual channel menu and keeps keyboard sections and return focus', async () => {
  const binding = await bind(), actor = { application: binding.application, idType: 'open_id', userId: 'ou_ada' }
  await f.forward('connection.grant', { operationId: 'header-member', bindingId: binding.bindingId, expectedBindingRevision: binding.revision,
    grantId: 'header-member', expectedRevision: null, actor, capabilities: ['input'], state: 'active' }, f.hostingTarget)
  await f.mount()
  const trigger = () => document.querySelector<HTMLButtonElement>('[data-channel-entry="feishu"]')!
  await wait(() => expect(trigger()).not.toBeNull())
  await act(async () => { trigger().focus(); trigger().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
  let entry: HTMLElement | undefined
  await wait(() => { entry = [...document.querySelectorAll<HTMLElement>('.connector-header-menu [role="menuitem"]')].find(node => node.textContent?.trim() === 'View group details'); expect(entry).toBeDefined() })
  const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView')
  await act(async () => entry!.click())
  await wait(() => expect(dialog()?.querySelector('.connector-group-details')).not.toBeNull())
  expect(dialog().querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Overview')
  expect(scroll.mock.instances.some(node => (node as unknown as HTMLElement).dataset.connectionSection === 'activity')).toBe(false)
  await wait(() => expect(dialog().querySelector('.connector-group-details__identity')?.textContent).toContain('Original collaboration group'))
  const overview = dialog().querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')!
  await act(async () => { overview.focus(); overview.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })) })
  expect(document.activeElement?.textContent).toBe('Member access')
  expect(dialog().querySelector<HTMLElement>('[data-connection-panel="overview"]')!.hidden).toBe(true)
  expect(dialog().querySelector<HTMLElement>('[data-connection-panel="members"]')!.hidden).toBe(false)
  const before = writes()
  await section('joining')
  const joining = dialog().querySelector<HTMLElement>('[data-connection-panel="joining"]')!
  expect(joining.hidden).toBe(false)
  expect(joining.textContent).toContain('Joining and permission to use this Agent are separate.')
  expect(joining.textContent).toContain('Create join link')
  await section('sharing')
  expect(dialog().querySelector<HTMLElement>('[data-connection-panel="sharing"]')!.hidden).toBe(false)
  expect(dialog().querySelector<HTMLElement>('[aria-label="Group input scope"]')?.dataset.value).toBe(binding.scope.input)
  expect(writes()).toBe(before)
  await f.button('Close')
  await wait(() => expect(document.activeElement).toBe(trigger()))
  expect(writes()).toBe(before)
}, 30_000)

it('observes the exact visible group after later delivery while retaining original records and releases hidden observation', async () => {
  const binding = await bind()
  await open()
  await wait(() => expect(traffic().textContent).toContain('connection notice'))
  await act(async () => dialog().querySelector<HTMLDetailsElement>('.connector-delivery-details__originals')!.querySelector('summary')!.click())
  const originalText = dialog().querySelector('[data-receipt-section="receipts"]')!.textContent
  await appendFile(f.original.transcript, nativeRow('later-visible-answer', 'assistant'))
  await wait(() => expect(traffic().textContent).toContain('1 conversation update delivered'))
  expect(dialog().querySelector('[data-receipt-section="receipts"]')!.textContent).toBe(originalText)
  const originalCalls = () => f.calls.filter(call => call.method === 'connection.diagnose' && (call.input as { bindingId?: string }).bindingId === binding.bindingId)
  expect(originalCalls().every(call => (call.input as { bindingRevision: number }).bindingRevision === binding.revision)).toBe(true)
  await section('members')
  const sectionReads = originalCalls().length
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 5200)) })
  expect(originalCalls()).toHaveLength(sectionReads)
  await section('overview')
  await wait(() => expect(originalCalls().length).toBeGreaterThan(sectionReads))
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  const hiddenReads = originalCalls().length
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 5200)) })
  expect(originalCalls()).toHaveLength(hiddenReads)
  visibility.mockReturnValue('visible')
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  await wait(() => expect(originalCalls().length).toBeGreaterThan(hiddenReads))
  await f.button('Close')
  await act(async () => {})
  const closedReads = originalCalls().length
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 5200)) })
  expect(originalCalls()).toHaveLength(closedReads)
}, 30_000)

it('routes off-state recovery to the exact original service and bot without enabling either scope', async () => {
  const binding = await bind(), forward = f.forward
  vi.mocked(api.connections.call).mockImplementation(async (method, input, owner) => {
    const result = await forward(method, input, owner)
    if (method === 'connection.diagnose') {
      const report = structuredClone(result) as import('@agentmux/core/connections').ConnectionDiagnosis
      report.service.value = { enabled: false, revision: 1 }
      const group = report.groups.value!.items[0]!
      group.adapterService.value = { adapterId: f.config.adapterId, enabled: false, revision: 1 }
      if (group.connection.value) group.connection.value.enabled = false
      return report as typeof result
    }
    return result
  })
  const before = writes()
  await open()
  await wait(() => expect(traffic().textContent).toContain('Automatic sync is off'))
  await f.button('Review automatic sync')
  expect(document.activeElement).toBe(dialog().querySelector('[data-connection-section="sync"]'))
  expect(dialog().querySelector<HTMLDetailsElement>('.connector-delivery-details__originals')!.open).toBe(true)
  expect(writes()).toBe(before)
  await f.button('Open channel settings')
  expect(f.settings).toHaveBeenCalledWith(expect.objectContaining({ hostingTarget: f.hostingTarget, hostId: binding.executionHostId, agentSessionId: binding.agentSessionId, connection: expect.objectContaining({ connectionId: binding.connectionId, application: binding.application }) }))
  expect(writes()).toBe(before)
}, 30_000)

it('shows the original cached profile for an authorized person outside the current member page without changing its grant', async () => {
  vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  const binding = await bind(), actor = { application: binding.application, idType: 'open_id', userId: 'ou_saved' }
  const grant = await f.forward('connection.grant', { operationId: 'saved-member-access', bindingId: binding.bindingId,
    expectedBindingRevision: binding.revision, grantId: 'saved-member-access', expectedRevision: null,
    actor, capabilities: ['input', 'answer'], state: 'active' }, f.hostingTarget)
  expect(grant.state).toBe('applied')
  await f.forward('connection.metadata.refresh', { connectionId: f.config.connectionId, expectedConnectionRevision: 1,
    subject: { kind: 'actor', actor } }, f.hostingTarget)
  const before = writes()
  const forward = f.forward
  vi.mocked(api.connections.call).mockImplementation(async (method, input, owner) => {
    const result = await forward(method, input, owner)
    if (method === 'connection.metadata.get') {
      const reading = result as import('@agentmux/core/connections').ChannelMetadataResult
      return { ...reading, entry: { ...reading.entry, observation: { ...reading.entry.observation, freshness: 'stale' } } } as typeof result
    }
    return result
  })
  await open()
  await section('members')
  const row = () => [...dialog().querySelectorAll<HTMLElement>('[data-member-row]')].find(node => node.dataset.memberRow === JSON.stringify(['open_id', 'ou_saved']))!
  await wait(() => expect(row()?.querySelector('img')?.getAttribute('src')).toBe('https://cdn.example/saved-participant.png'))
  expect(row().textContent).toContain('Profile update unconfirmed')
  await copyConnectorIdentity(row(), 'Copy person name', 'Saved participant outside this member page')
  expect(row().querySelector('[data-member-editor]')).toBeNull()
  await copyConnectorIdentity(row(), 'Copy open_id', 'ou_saved')
  await act(async () => row().querySelector<HTMLButtonElement>('[data-member-edit]')!.click())
  expect(row().textContent).toContain('Not in the current member page')
  await copyConnectorIdentity(row(), 'Copy open_id', 'ou_saved')
  const choices = () => [...row().querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].map(input => input.checked)
  expect(choices()).toEqual([true, true, false])
  await act(async () => row().querySelector('img')!.dispatchEvent(new Event('error')))
  expect(row().querySelector('img')).toBeNull()
  expect(row().textContent).toContain('Saved participant outside this member page')
  expect(choices()).toEqual([true, true, false])
  expect(writes()).toBe(before)
  const retained = await f.forward('connection.binding.inspect', { operationId: 'saved-member-access' }, f.hostingTarget)
  expect(retained.operation).toEqual(grant)
  expect(retained.grants).toHaveLength(1)
  expect(retained.grants[0]).toMatchObject({ actor, capabilities: ['input', 'answer'], state: 'active' })
}, 30_000)

it('shows source failure together with content gaps and original platform receipts through the real Host, RPC and dialog without writes', async () => {
  const binding = await bind(), publication = f.services.publication!
  const speech = () => publication.store.list(binding).filter(row => row.reference.source.kind !== 'binding-operation')
  const publicationFacts = () => JSON.stringify({ observation: publication.observation(binding.bindingId, binding.revision),
    states: speech().map(row => ({ state: row.state, source: row.reference.source.kind })),
    nativeEndpoints: f.platformCalls.map(call => ({ method: call.method, url: call.url })) })
  await appendFile(f.original.transcript, nativeRow('first-answer', 'assistant'))
  await wait(() => expect(speech().some(row => row.state === 'confirmed'), publicationFacts()).toBe(true))
  lose = true
  await appendFile(f.original.transcript, nativeRow('old-unknown-answer', 'assistant'))
  await wait(() => expect(speech().some(row => row.state === 'unknown'), publicationFacts()).toBe(true))
  await appendFile(f.original.transcript, nativeRow('unqualified-user', 'user'))
  await wait(() => expect(publication.observation(binding.bindingId, binding.revision).reason).toBe('content-unconfirmed'))
  // Only native source availability is controlled. Existing store coverage/effects and safe Core RPC are real.
  const read = publication.list.bind(publication)
  vi.spyOn(publication, 'list').mockImplementation(async input => ({ ...await read(input), sourceObservation: { state: 'unavailable', reason: 'source-gap', code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED', codeRecorded: true, checkpointKey: 'a'.repeat(64) } }))
  const before = writes()
  await open()
  await wait(() => expect(traffic().textContent).toContain('Source reading unconfirmed'))
  expect(traffic().querySelector('[data-direction="outgoing"]')?.getAttribute('data-tone')).toBe('warning')
  expect(traffic().querySelector('[data-problem-kind="content-gap"]')?.textContent).toContain('Some conversation content is not shared yet')
  expect(traffic().textContent).toContain('1 conversation update delivered')
  expect(traffic().textContent).toContain('1 delivery result not confirmed')
  await f.button('View source details')
  expect(document.activeElement).toBe(dialog().querySelector('[data-receipt-section="content"]'))
  expect(document.activeElement?.textContent).toContain('AGENT_SESSION_HISTORY_SOURCE_CHANGED')
  await f.button('View delivery details')
  expect(document.activeElement).toBe(dialog().querySelector('[data-receipt-section="receipts"]'))
  expect(document.activeElement?.textContent).toContain('Platform receipt: unknown')
  expect(writes()).toBe(before)
  const original = f.calls.filter(call => call.method === 'connection.diagnose').at(-1)!
  expect(original.input).toMatchObject({ bindingId: binding.bindingId, bindingRevision: binding.revision, agentSessionId: binding.agentSessionId })
  expect(dialog().textContent).not.toContain('Original private source')
  expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe('Keep the original draft 中')
}, 30_000)

it('starts with compact saved member rows, preserves a dirty editor across disclosures and reopen, and retains facts after a failed check', async () => {
  vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await bind(); const before = writes(); await open()
  await wait(() => expect(dialog().querySelector('[data-member-row]')).not.toBeNull())
  const panel = () => dialog().querySelector<HTMLElement>('[data-connection-panel="members"]')!
  await section(panel().hidden ? 'members' : 'overview')
  const row = () => dialog().querySelector<HTMLElement>('[data-member-row]')!
  expect(row().textContent).toContain('No Agent access')
  expect(row().querySelector('[data-member-editor]')).toBeNull()
  expect(panel().querySelectorAll('h3')).toHaveLength(0)
  await copyConnectorIdentity(row(), 'Copy person name', 'Ada · Research and Engineering Collaboration')
  const group = dialog().querySelector<HTMLElement>('[data-entity-kind="group"]')!
  expect(group).not.toBeNull()
  await copyConnectorIdentity(group, 'Copy group name', 'Original collaboration group')
  expect(row().textContent).toContain('No Agent access')
  expect(writes()).toBe(before)
  await act(async () => { const button = row().querySelector<HTMLButtonElement>('[data-member-edit]')!; button.focus(); button.click() })
  expect(row().querySelector('[data-member-edit]')?.getAttribute('aria-expanded')).toBe('true')
  expect(row().querySelector('[data-member-editor]')).not.toBeNull()
  await copyConnectorIdentity(row(), 'Copy open_id', 'ou_ada')
  const source = row().querySelector('select')!
  await act(async () => { source.value = 'room'; source.dispatchEvent(new Event('change', { bubbles: true })) })
  const checkbox = [...row().querySelectorAll<HTMLLabelElement>('label')].find(node => node.textContent === 'Send requests')!.querySelector('input')!
  await act(async () => checkbox.click())
  expect(row().textContent).toContain('Unsaved changes')
  expect(row().querySelector('.connector-member-row__saved')?.textContent).toContain('No Agent access')
  await wait(() => {
    const saved = JSON.parse(localStorage.getItem('agentmux-workbench-v1')!).state.connectorRoomDrafts
    expect(Object.values(saved).some((entry: any) => Object.values(entry.memberDrafts ?? {}).some((draft: any) => draft.actor.userId === 'ou_ada' && draft.capabilities.includes('input')))).toBe(true)
  })
  await section(panel().hidden ? 'members' : 'overview')
  await f.button('Close'); await f.dom.render(null); await useAppStore.persist.rehydrate(); await open()
  await wait(() => expect(row().querySelector('[data-member-editor]')).not.toBeNull())
  expect(row().textContent).toContain('Unsaved changes')
  expect(row().querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true)
  const earlierOutgoing = traffic().querySelector('[data-direction="outgoing"] strong')!.textContent
  expect(traffic().querySelector('[data-direction="incoming"] strong')!.textContent).toBe('Agent inputs could not be checked')
  const forward = f.forward
  vi.mocked(api.connections.call).mockImplementation((method, input, owner) => method === 'connection.diagnose' ? Promise.reject(Error('Controlled failed original check')) : forward(method, input, owner))
  await f.button('Check group activity')
  await wait(() => expect(traffic().querySelector('[data-direction="outgoing"] strong')?.textContent).toBe('Recent sends could not be checked'))
  expect(traffic().querySelector('[data-direction="incoming"] strong')?.textContent).toBe('Agent inputs could not be checked')
  expect(traffic().querySelector('[data-direction="outgoing"]')?.getAttribute('data-tone')).toBe('warning')
  expect(traffic().querySelector('[data-direction="incoming"]')?.getAttribute('data-tone')).toBe('warning')
  expect(traffic().textContent).toContain(`Earlier check: ${earlierOutgoing}`)
  expect(traffic().querySelector('[data-direction="incoming"]')?.textContent).not.toContain('Earlier check:')
  expect(row().querySelector('[data-member-save]')).not.toBeNull()
  expect(writes()).toBe(before)
  expect(dialog().querySelectorAll('[data-connection-panel="sharing"] h3')).toHaveLength(0)
  expect(dialog().querySelectorAll('[data-connection-panel="joining"] h3')).toHaveLength(0)
}, 30_000)
