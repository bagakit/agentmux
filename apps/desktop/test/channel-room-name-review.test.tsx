// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import type { ChannelMetadataChange, ChannelMetadataResult, RoomBinding } from '@agentmux/core/connections'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
import { api } from '../src/renderer/src/lib/api'
import { useConnectorRoomName } from '../src/renderer/src/lib/use-connector-room-name'

const application = { domain: 'channel.example', appId: 'original-application' }
const original = { connectionId: 'original-connection', application, externalConversationId: 'original-room' } as RoomBinding
let root: Root | undefined, container: HTMLDivElement
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; container?.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function result(name?: string, binding = original): ChannelMetadataResult {
  return { connectionId: binding.connectionId, connectionRevision: 1, application: binding.application, entry: {
    subject: { kind: 'conversation', externalConversationId: binding.externalConversationId }, cacheRevision: name ? 'original-cache-version' : null,
    observation: { application: binding.application, externalConversationId: binding.externalConversationId,
      state: name ? 'observed' : 'unknown', profile: name ? { name, observedAt: 1 } : null, checkedAt: 1, freshness: name ? 'current' : 'unknown' }
  } }
}
function Probe({ binding, refresh = 0 }: { binding: RoomBinding; refresh?: number }) {
  const read = useConnectorRoomName(binding, refresh)
  return <output data-loading={read.loading}>{read.label} | {read.issue}</output>
}
async function fixture(read: (method: string, input: unknown) => Promise<unknown>, watch = true) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const listeners = new Set<(change: ChannelMetadataChange) => void>()
  const call = vi.spyOn(api.connections, 'call').mockImplementation(read as typeof api.connections.call)
  if (watch) vi.spyOn(api.connections, 'onMetadataChanged').mockImplementation(listener => { listeners.add(listener); return () => { listeners.delete(listener) } })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  const render = async (binding = original, refresh = 0) => { await act(async () => root!.render(<Probe binding={binding} refresh={refresh} />)) }
  const changed = async (binding = original) => { await act(async () => { for (const listener of listeners) listener({ connectionId: binding.connectionId, application: binding.application, subject: { kind: 'conversation', externalConversationId: binding.externalConversationId } }) }) }
  const text = () => container.textContent
  const settled = async (expected: string) => { await vi.waitFor(async () => { await act(async () => {}); expect(text()).toBe(expected); expect(container.querySelector('output')?.dataset.loading).toBe('false') }) }
  return { call, render, changed, text, settled }
}

it('native rename changes only the exact original group; a failed read preserves its name and confirmed clear removes it', async () => {
  let entry = result('Original group'), unavailable = false
  const f = await fixture(async method => {
    expect(method).toBe('connection.metadata.get')
    if (unavailable) throw Error('Controlled local metadata observation failure')
    return entry
  })
  await f.render(); await f.settled('Original group | ')
  const before = f.call.mock.calls.length
  await f.changed({ ...original, externalConversationId: 'another-room' }); expect(f.call).toHaveBeenCalledTimes(before)
  await f.changed({ ...original, application: { ...application, appId: 'another-application' } }); expect(f.call).toHaveBeenCalledTimes(before)
  entry = result('Renamed original group'); await f.changed(); await f.settled('Renamed original group | ')
  unavailable = true; await f.changed(); await f.settled('Renamed original group | Group name unconfirmed')
  unavailable = false; entry = result(); await f.changed(); await f.settled('original-room | Group name unconfirmed')
  expect(f.call.mock.calls.every(([method]) => method === 'connection.metadata.get')).toBe(true)
})

it('a changed application cannot turn the original group cache miss into a native refresh on a different issuer', async () => {
  const f = await fixture(async () => result(undefined, { ...original, application: { ...application, appId: 'changed-application' } }))
  await f.render(); await f.settled('original-room | Group name unconfirmed')
  expect(f.call).toHaveBeenCalledExactlyOnceWith('connection.metadata.get', { connectionId: original.connectionId, subject: { kind: 'conversation', externalConversationId: original.externalConversationId } }, undefined)
})

it('a late original group read cannot replace the currently displayed group', async () => {
  let finish!: (value: ChannelMetadataResult) => void
  const pending = new Promise<ChannelMetadataResult>(resolve => { finish = resolve })
  const other = { ...original, externalConversationId: 'another-room' }
  const f = await fixture(async (_method, input) => (input as { subject: { externalConversationId: string } }).subject.externalConversationId === original.externalConversationId ? pending : result('Other group', other))
  await f.render(); await f.render(other); await f.settled('Other group | ')
  await act(async () => finish(result('Late original name')))
  await f.settled('Other group | ')
})

it('an unavailable preview subscription preserves the original card and independent snapshot reads', async () => {
  expect(() => api.connections.onMetadataChanged(() => {})).toThrow('requires the executing Desktop Host')
  let name = 'Confirmed local name'
  const f = await fixture(async method => { expect(method).toBe('connection.metadata.get'); return result(name) }, false)
  await f.render(); await f.settled('Confirmed local name | Group name updates unconfirmed')
  name = 'Another confirmed name'
  // The same card's explicit refresh still reads its snapshot; watch failure is not read failure.
  await f.render(original, 1); await f.settled('Another confirmed name | Group name updates unconfirmed')
  expect(f.call).toHaveBeenCalledTimes(2)
  expect(container.querySelector('output')).not.toBeNull()
})

it('keeps the original preview card when neither native metadata reading nor watching is available', async () => {
  const previewRead = api.connections.call
  const f = await fixture(async () => previewRead('connection.metadata.get', {
    connectionId: original.connectionId, subject: { kind: 'conversation', externalConversationId: original.externalConversationId }
  }), false)
  await f.render(); await f.settled('original-room | Group name unconfirmed · Group name updates unconfirmed')
  expect(container.querySelector('output')).not.toBeNull()
})
