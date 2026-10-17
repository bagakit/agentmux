// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { moteBotUi } from './fixtures/mote-bot-ui'
import { confirmAndCreateMote } from './fixtures/mote-connection-owner'
import { ConnectionRequestTrace, type ConnectionTraceSource } from '../src/renderer/src/components/settings/ConnectionRequestTrace'
import { api } from '../src/renderer/src/lib/api'

let f: Awaited<ReturnType<typeof moteBotUi>>, root: Root | null, container: HTMLDivElement
beforeEach(async () => {
  f = await moteBotUi()
  container = document.createElement('div'); document.body.append(container)
  root = createClientUiRoot(container)
})
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  container.remove(); await f.close()
})
async function originalTrace(kind: ConnectionTraceSource['kind'], polls = 30) {
  const input = await f.input('trace-parent-' + kind)
  let parent = await f.client.call('space.mote.connection.create', input)
  if (kind === 'setup') parent = await confirmAndCreateMote(f, input.operationId)
  const transport = f.registration.getMockImplementation()!
  f.registration.mockImplementation(async (url, input) => new URL(url instanceof Request ? url.url : String(url)).pathname === '/accounts/qrlogin/polling'
    ? Response.json({ code: 0, data: { next_step: 'qr_login_polling', step_info: { status: 1 } } })
    : transport(url, input))
  const source: ConnectionTraceSource = { kind, operationId: kind === 'setup' ? 'trace-export-setup' : parent.enrollmentOperationId! }
  if (kind === 'setup') {
    let view = await api.connections.call('connection.setup.begin', { operationId: source.operationId, connectionId: parent.connection!.connectionId, expectedConnectionRevision: 1, goal: { kind: 'agent-conversation', interaction: 'messages' } })
    for (let index = 0; index < polls; index++) {
      const action = view.continuation!.actions.find(action => action.kind === 'continue')!
      expect(action).toBeDefined()
      view = await api.connections.call('connection.setup.advance', { operationId: source.operationId, expectedRevision: action.expectedRevision, decision: { actionId: action.actionId, value: 'continue' } })
    }
  } else {
    let view = await api.connections.call('connection.enrollment.inspect', { operationId: source.operationId })
    for (let index = 0; index < 30; index++) {
      const action = view.actions.find(action => action.kind === 'continue-authentication')!
      expect(action).toBeDefined()
      view = await api.connections.call('connection.enrollment.advance', { operationId: source.operationId, ownRevision: action.ownRevision, decision: { actionId: action.actionId, kind: action.kind } })
    }
  }
  return source
}
async function render(source: ConnectionTraceSource) {
  await act(async () => root!.render(<ConnectionRequestTrace source={source} />))
}
async function open(source: ConnectionTraceSource, visibleEntries = 25) {
  await render(source)
  await act(async () => container.querySelector<HTMLElement>('summary')!.click())
  await vi.waitFor(() => expect(container.querySelectorAll('tbody tr')).toHaveLength(visibleEntries))
}
async function copy() {
  const button = [...container.querySelectorAll('button')].find(button => button.textContent === 'Copy diagnosis')!
  expect(button).toBeDefined()
  await act(async () => button.click())
}

it.each(['setup', 'enrollment'] as const)('copies the complete original %s trace through registered IPC without platform calls', async kind => {
  const source = await originalTrace(kind)
  const result = kind === 'setup'
    ? await api.connections.call('connection.setup.inspect', { operationId: source.operationId, requestTrace: { limit: 100 } })
    : await api.connections.call('connection.enrollment.inspect', { operationId: source.operationId, requestTrace: { limit: 100 } })
  expect(result.requestTrace!.entries.length).toBeGreaterThan(kind === 'setup' ? 25 : 0)
  expect(result.requestTrace!.next).toBeNull()
  const visibleEntries = Math.min(25, result.requestTrace!.entries.length)
  await open(source, visibleEntries)
  const nativeCalls = f.registration.mock.calls.length
  const clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await copy()
  await vi.waitFor(() => expect(clipboard).toHaveBeenCalledOnce())
  const diagnosis = JSON.parse(clipboard.mock.calls[0]![0])
  expect(diagnosis).toEqual(result.requestTrace)
  expect(diagnosis.entries.at(-1).stepId).toBe(result.requestTrace!.entries.at(-1)!.stepId)
  expect(f.registration.mock.calls).toHaveLength(nativeCalls)
  expect(container.querySelectorAll('tbody tr')).toHaveLength(visibleEntries)
  expect(container.textContent).toContain('Complete sanitized trace copied.')
  expect(clipboard.mock.calls[0]![0]).not.toMatch(/private-mote|mote-session|csrf|https?:\/\/|pngDataUrl/iu)
}, 30_000)

it('copies original steps recorded after the visible page was read', async () => {
  const source = await originalTrace('setup', 0)
  await open(source, 1)
  const view = await api.connections.call('connection.setup.inspect', { operationId: source.operationId })
  const action = view.continuation!.actions.find(action => action.kind === 'continue')!
  await api.connections.call('connection.setup.advance', { operationId: source.operationId, expectedRevision: action.expectedRevision, decision: { actionId: action.actionId, value: 'continue' } })
  const result = await api.connections.call('connection.setup.inspect', { operationId: source.operationId, requestTrace: { limit: 100 } })
  expect(result.requestTrace!.entries).toHaveLength(2)
  const clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await copy()
  await vi.waitFor(() => expect(clipboard).toHaveBeenCalledOnce())
  expect(JSON.parse(clipboard.mock.calls[0]![0])).toEqual(result.requestTrace)
  expect(container.querySelectorAll('tbody tr')).toHaveLength(1)
}, 30_000)

it.each(['unmount', 'switch', 'close', 'failure'] as const)('does not copy a held partial diagnosis after %s', async action => {
  const source = await originalTrace('setup')
  await open(source)
  const forward = f.connectionCalls.getMockImplementation()!
  let arrive!: () => void, release!: () => void, finish!: () => void
  const arrived = new Promise<void>(resolve => { arrive = resolve }), held = new Promise<void>(resolve => { release = resolve }), returned = new Promise<void>(resolve => { finish = resolve })
  f.connectionCalls.mockImplementation(async (method, input) => {
    if ('requestTrace' in input && input.requestTrace?.cursor) {
      arrive()
      try {
        await held
        if (action === 'failure') throw new Error('Fixture page unavailable')
        return await forward(method, input)
      } finally { finish() }
    }
    return forward(method, input)
  })
  const clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await copy()
  try {
    await arrived
    expect(clipboard).not.toHaveBeenCalled()
    if (action === 'unmount') { await act(async () => root!.unmount()); root = null }
    else if (action === 'switch') await render({ kind: 'setup', operationId: 'different-original-request' })
    else if (action === 'close') await act(async () => container.querySelector<HTMLElement>('summary')!.click())
  } finally {
    await act(async () => {
      release(); await returned
      await new Promise<void>(resolve => setImmediate(resolve))
    })
  }
  await vi.waitFor(() => {
    if (action === 'failure') expect(container.textContent).toContain('Could not copy the complete diagnosis')
    else expect(container.textContent).not.toContain('Copying…')
  })
  expect(clipboard).not.toHaveBeenCalled()
}, 30_000)
