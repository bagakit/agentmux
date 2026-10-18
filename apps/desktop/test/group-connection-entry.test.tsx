// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('react-resizable-panels', async () => { const { createRequire } = await import('node:module'); return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js') })
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div>Controlled terminal rendering</div> }))
import type { ConnectionMethod, ConnectionParamsMap, ConnectionResultMap } from '@agentmux/core/connections'
import { connectorJourneyFixture } from './fixtures/connector-journey'
import { openConnectionsMenu } from './helpers/connector-header-navigation'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { invalidateConnectorTarget } from '../src/renderer/src/lib/connector-room-intent'

const f = connectorJourneyFixture()
const target = { executionHostId: 'local', agentSessionId: 'original-agent' }
const region = () => document.querySelector<HTMLElement>('[data-workbench-region-id="original-region"]')!
async function ready(check: () => void) { await vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 6000 }) }
const writes = () => f.calls.filter(call => ['connection.service.configure', 'connection.configure', 'connection.room.create', 'connection.bind', 'connection.binding.relink', 'connection.grant', 'connection.room.members.add', 'connection.room.link.create', 'connection.delivery.retry'].includes(call.method))

it('keeps unbound input free of connection management while the original header opens setup without mutation or lost input', async () => {
  await f.mount()
  await ready(() => expect(region().querySelector('.agent-region-header__connector')).not.toBeNull())
  expect(region().querySelector('.conversation-sharing-notice')).toBeNull()
  expect(region().querySelector('[data-agent-composer]')?.textContent).not.toContain('Connect group')
  const editor = region().querySelector<HTMLElement>('[role="textbox"]')!
  const draft = useAppStore.getState().agentComposerDrafts['original-agent']
  await act(async () => editor.focus())
  const reads = f.calls.filter(call => call.method === 'connection.binding.ls')
  expect(reads.length).toBeGreaterThan(0)
  expect(reads.every(call => JSON.stringify(call.input) === JSON.stringify(target))).toBe(true)
  expect(document.activeElement).toBe(editor)
  expect(writes()).toHaveLength(0)
  const trigger = await openConnectionsMenu()
  const connect = [...document.querySelectorAll<HTMLElement>('.connector-header-menu [role="menuitem"]')].find(node => node.textContent === 'Connect Lark group')!
  expect(connect).toBeDefined()
  await act(async () => connect.click())
  await ready(() => expect(document.querySelector('.connector-header-menu')).toBeNull())
  await ready(() => expect(document.querySelector<HTMLElement>('[aria-label="Group application"]')?.dataset.value).toBe(f.config.connectionId))
  await ready(() => expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-busy')).toBe('false'))
  const dialog = document.querySelector('[role="dialog"]')!
  expect(dialog.textContent).toContain('Connect a group')
  expect(dialog.textContent).toContain('Original Mote Agent')
  expect(document.querySelector('button[aria-pressed="true"][aria-label="Existing group"]')).not.toBeNull()
  const pending: (() => void)[] = []
  vi.mocked(api.connections.call).mockImplementation(async <M extends ConnectionMethod>(method: M, input: ConnectionParamsMap[M]): Promise<ConnectionResultMap[M]> => {
    if (method === 'connection.binding.ls') await new Promise<void>(resolve => pending.push(resolve))
    return f.forward(method, input)
  })
  try {
    await act(async () => invalidateConnectorTarget(target))
    await ready(() => expect(pending.length).toBeGreaterThan(0))
    expect(document.querySelector('[role="dialog"]')).toBe(dialog)
  } finally {
    await act(async () => { for (const release of pending) release() })
  }
  await ready(() => expect(region().querySelector('.agent-region-header__connector')).toBe(trigger))
  expect(document.querySelector('[role="dialog"]')).toBe(dialog)
  await f.button('Cancel')
  expect(region().querySelector('[role="textbox"]')).toBe(editor)
  expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe(draft)
  expect(writes()).toHaveLength(0)
  expect(f.original.create).not.toHaveBeenCalled(); await f.original.unchanged()
}, 25_000)

it('keeps the original header and Region connection entries available while automatic sync is off and opening never enables it', async () => {
  await api.connections.call('connection.service.configure', { operationId: 'pause-automatic-group-sync', expectedRevision: 0, service: { enabled: false } })
  await f.mount()
  const before = writes().length, draft = useAppStore.getState().agentComposerDrafts['original-agent']
  for (const context of [false, true]) {
    await f.journey('existing', 'original-region', context)
    await ready(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Automatic chat sync is off'))
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Original Mote Agent')
    await f.button('Cancel')
  }
  expect(await api.connections.call('connection.service.get', {})).toEqual({ enabled: false, revision: 1 })
  expect(writes()).toHaveLength(before)
  expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe(draft)
  expect(f.original.create).not.toHaveBeenCalled(); await f.original.unchanged()
}, 25_000)
