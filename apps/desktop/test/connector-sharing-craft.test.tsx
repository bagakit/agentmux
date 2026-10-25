// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
vi.mock('react-resizable-panels', async () => { const { createRequire } = await import('node:module'); return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js') })
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div>Controlled terminal rendering</div> }))
vi.mock('electron', () => ({ app: {}, nativeImage: {} }))
import { connectorJourneyFixture } from './fixtures/connector-journey'
import { api } from '../src/renderer/src/lib/api'
import { openConnectedGroup } from './helpers/connector-header-navigation'

const f = connectorJourneyFixture({ publication: true, platform: async request => {
  if (request.url?.endsWith('/messages')) return { code: 0, data: { message_id: 'om_sharing', chat_id: 'oc_sharing', msg_type: 'interactive' } }
  if (request.url?.endsWith('/members')) return { code: 0, data: { items: [], has_more: false } }
  return { code: 0, data: { name: request.url?.includes('oc_second') ? 'Engineering discussion' : 'Research discussion', chat_status: 'normal', chat_mode: 'group' } }
} })
const wait = (check: () => void) => vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 8000 })
const dialog = () => document.querySelector<HTMLElement>('.agent-connector-dialog')!
const scope = () => dialog().querySelector<HTMLElement>('[aria-label="Group input scope"]')!
const writes = () => f.calls.filter(call => /configure|\.bind$|\.relink$|\.pause$|\.resume$|\.detach$|\.grant$|\.create$|\.retry$/.test(call.method))
const button = (label: string) => [...dialog().querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === label)!
async function section(name: string) { await act(async () => dialog().querySelector<HTMLButtonElement>(`[role="tab"][aria-controls$="-${name}-panel"]`)!.click()) }
async function bind(id = 'sharing-original', group = 'oc_sharing', connectionId = f.config.connectionId) {
  const result = await f.forward('connection.bind', { ...f.original.input, operationId: 'bind-' + id, bindingId: id, connectionId, expectedConnectionRevision: 1, externalConversationId: group }, f.hostingTarget)
  expect(result.state).toBe('applied')
  if (result.state !== 'applied') throw Error('The controlled original binding must exist')
  return result.binding
}
async function open() { await f.mount(); await wait(() => expect(document.querySelector('[data-channel-entry="feishu"]')).not.toBeNull()); await openConnectedGroup('oc_sharing', 'original-region', 'feishu'); await wait(() => expect(dialog()?.querySelector('.connector-group-details')).not.toBeNull()); await section('sharing') }

it('Sharing choices retain a local draft across tabs and save the chosen scope to the original owner only after confirmation', async () => {
  const saved = await bind()
  await open()
  const before = writes().length
  const radios = [...scope().querySelectorAll<HTMLInputElement>('input[type="radio"]')]
  expect(radios.map(input => input.closest('label')?.textContent)).toEqual([expect.stringContaining('Only @mentions'), expect.stringContaining('Every message')])
  expect(scope().dataset.value).toBe(saved.scope.input)
  await act(async () => radios[1]!.click())
  expect(scope().dataset.value).toBe('all-messages')
  expect(button('Save sharing').disabled).toBe(true)
  const consent = dialog().querySelector<HTMLInputElement>('[data-connection-section="sharing"] input[type="checkbox"]')!
  expect(consent.checked).toBe(false)
  await section('members'); await section('sharing')
  expect(scope().querySelector<HTMLInputElement>('input[value="all-messages"]')?.checked).toBe(true)
  const boundaries = dialog().querySelector<HTMLElement>('[aria-label="Context and sharing boundaries"]')!
  const disclosure = boundaries.matches('details') ? boundaries as HTMLDetailsElement : boundaries.closest('details')!
  expect(disclosure.open).toBe(false)
  await act(async () => disclosure.querySelector('summary')!.click())
  expect(disclosure.open).toBe(true)
  expect(writes()).toHaveLength(before)
  await act(async () => consent.click())
  expect(button('Save sharing').disabled).toBe(false)
  await f.button('Save sharing')
  await wait(() => expect(writes().slice(before)).toHaveLength(1))
  const write = writes().at(-1)!
  expect(write.method).toBe('connection.binding.relink')
  expect(write.input).toMatchObject({ bindingId: saved.bindingId, expectedRevision: saved.revision, connectionId: saved.connectionId, expectedConnectionRevision: 1, executionHostId: saved.executionHostId, agentSessionId: saved.agentSessionId, externalConversationId: saved.externalConversationId, scope: { input: 'all-messages', publication: saved.scope.publication } })
  expect(vi.mocked(api.connections.call).mock.calls.find(call => call[0] === write.method && (call[1] as { operationId?: string }).operationId === (write.input as { operationId: string }).operationId)?.[2]).toEqual(f.hostingTarget)
  await wait(() => expect(scope().dataset.value).toBe('all-messages'))
  const observed = await f.forward('connection.binding.inspect', { bindingId: saved.bindingId }, f.hostingTarget)
  expect(observed.current?.scope.input).toBe('all-messages')
}, 120_000)

it('Sharing audiences keep all original groups visible and reading or cancelling disconnect never writes', async () => {
  const first = await bind(), configured = (await f.services.connections.list()).connections[0]!.config
  await f.forward('connection.configure', { operationId: 'configure-sharing-second', expectedRevision: null, connection: { ...configured, connectionId: 'sharing-second-bot', application: { ...configured.application, appId: 'cli_1123456789abcdef' } } }, f.hostingTarget)
  const second = await bind('sharing-second', 'oc_second', 'sharing-second-bot')
  await open()
  const before = writes().length
  const audiences = dialog().querySelector<HTMLElement>('[aria-label="Connected audiences"]')!
  expect(audiences.closest('details:not([open]),[hidden]')).toBeNull()
  expect([...audiences.querySelectorAll<HTMLElement>('[data-sharing-audience]')].map(node => node.dataset.sharingAudience).sort()).toEqual([first.bindingId, second.bindingId].sort())
  expect(audiences.textContent).toContain('AgentMux App')
  const warning = [...dialog().querySelectorAll<HTMLElement>('p')].find(node => /existing (?:private )?context/.test(node.textContent ?? '') && !node.closest('details:not([open]),[hidden]'))
  expect(warning).toBeDefined()
  await f.button('Disconnect group')
  expect(dialog().querySelector('[aria-label="Confirm group disconnection"]')).not.toBeNull()
  await f.button('Keep connected')
  for (const name of ['overview', 'joining', 'sharing']) await section(name)
  expect(writes()).toHaveLength(before)
  expect((await f.forward('connection.binding.inspect', { bindingId: first.bindingId }, f.hostingTarget)).current?.state).toBe('active')
  expect((await f.forward('connection.binding.inspect', { bindingId: second.bindingId }, f.hostingTarget)).current?.state).toBe('active')
}, 120_000)
