// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('react-resizable-panels', async () => { const { createRequire } = await import('node:module'); return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js') })
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div>Controlled terminal rendering</div> }))
vi.mock('../src/renderer/src/lib/reading-diagnostic-publication', () => ({ publishReadingDiagnostic: vi.fn() }))
import { connectorJourneyFixture } from './fixtures/connector-journey'

const f = connectorJourneyFixture({ platform: async request => {
  if (request.url?.endsWith('/chats') && request.method?.toUpperCase() === 'POST') return { code: 0, data: { chat_id: 'oc_original_group' } }
  if (request.url?.endsWith('/members')) return { code: 0, data: { items: [], has_more: false } }
  if (request.url?.endsWith('/chats')) return { code: 0, data: { items: [{ chat_id: 'oc_another_group', name: 'Another group' }], has_more: false } }
  return { code: 0, data: { name: 'Original dedicated group', chat_status: 'normal', chat_mode: 'group' } }
} })
const progress = () => document.querySelector('[aria-label="Group connection progress"]')!
const currentStep = () => progress().querySelector('[aria-current="step"]')?.textContent ?? ''
async function ready(text: string) { await vi.waitFor(async () => { await act(async () => {}); expect(document.querySelector('[role="dialog"]')?.textContent).toContain(text) }, { timeout: 6000 }) }
async function confirmSharing() {
  await act(async () => [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(node => node.closest('label')?.textContent?.startsWith('Share new'))!.click())
}

it('continues the original created group through the unified entry and keeps member access distinct from sharing', async () => {
  await f.mount(); await f.journey('create')
  await f.fill('Group name', 'Original dedicated group')
  await f.button('Create group'); await ready('Group created')
  expect(currentStep()).toContain('Sharing')
  const creation = f.calls.find(call => call.method === 'connection.room.create')!
  expect(creation).toBeDefined()
  await f.button('Close'); await f.journey('existing')
  await ready('Original dedicated group')
  expect(currentStep()).toContain('Sharing')
  expect(document.querySelector('button[aria-pressed][aria-label="New group"]')).toBeNull()
  expect(f.calls.filter(call => call.method === 'connection.room.create')).toEqual([creation])
  await confirmSharing(); await f.button('Connect group'); await ready('Group saved')
  await ready('Choose who can use this Agent')
  expect(currentStep()).toContain('Member access')
  expect(progress().querySelectorAll('[data-complete="true"]')).toHaveLength(2)
  const access = [...document.querySelectorAll('details')].find(node => node.querySelector('summary')?.textContent === 'Manage member access')!
  expect(access.open).toBe(true)
  const saved = (await f.forward('connection.binding.ls', { agentSessionId: f.session.id })).bindings
  expect(saved).toHaveLength(1)
  expect(saved[0]).toMatchObject({ externalConversationId: 'oc_original_group', agentSessionId: f.session.id })
  expect(f.calls.filter(call => call.method === 'connection.grant')).toHaveLength(0)
  await f.fill('Member access ID type', 'open_id'); await f.fill('Member access ID', 'selected_member')
  await act(async () => [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(node => node.closest('label')?.textContent === 'Send requests')!.click())
  await f.button('Approve this member'); await ready('1 member approved')
  expect(progress().querySelectorAll('[data-complete="true"]')).toHaveLength(3)
  expect(currentStep()).toBe('')
  const change = [...document.querySelectorAll('summary')].find(node => node.textContent === 'Change connected group')!
  await act(async () => change.click())
  expect(document.querySelector('[aria-label="Existing group"]')).not.toBeNull()
  expect(progress().querySelectorAll('[data-complete="true"]')).toHaveLength(1)
  expect(progress().textContent).toContain('Review after sharing')
  expect(f.calls.filter(call => call.method === 'connection.room.create')).toEqual([creation])
  expect(f.calls.filter(call => call.method === 'connection.bind')).toHaveLength(1)
  expect(f.calls.filter(call => call.method === 'connection.binding.relink')).toHaveLength(0)
}, 30_000)
