// @vitest-environment happy-dom
import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RuntimeEvent } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { useSessionMessages } from '../src/renderer/src/lib/use-session-messages'
import { createClientUiRoot } from './helpers/client-ui-render'

type Reading = ReturnType<typeof useSessionMessages>
let reading: Reading, container: HTMLDivElement, root: ReturnType<typeof createClientUiRoot>
const listeners = new Set<(event: RuntimeEvent) => void>()
const item = (id: string, sequence: number) => ({ sequence, bodyPreview: 'Original ' + id, bodyBytes: 11,
  delivery: { state: 'queued' as const, at: _tailFixtureEpoch(0, 0, 1) }, envelope: { schema: 'agentmux.a2a.v1' as const, messageId: id, operationId: 'op-' + id, createdAt: _tailFixtureEpoch(0, 0, 1),
    sender: { kind: 'agent-session' as const, agentSessionId: 'sender' }, recipient: { kind: 'agent-session' as const, agentSessionId: 'reader' },
    senderSessionId: 'sender', senderRunId: 'sender-run', recipientSessionId: 'reader', recipientRunId: null,
    threadId: id, correlationId: id, replyTo: null, workspaceId: null } })
const page = (messages = [item('one', 50)], nextBeforeSequence: number | null = null, participantSessionId = 'reader') =>
  ({ hostId: 'original-host', participantSessionId, direction: 'incoming' as const, messages, nextBeforeSequence })
function Probe({ enabled = true, agentSessionId = 'reader' }: { enabled?: boolean; agentSessionId?: string }) {
  reading = useSessionMessages({ hostId: 'original-host', agentSessionId, direction: 'incoming', enabled }); return null
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); listeners.clear()
  container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
  vi.spyOn(api.sessions, 'listMessages').mockResolvedValue(page())
  vi.spyOn(api.sessions, 'onEvent').mockImplementation(listener => { listeners.add(listener); return () => { listeners.delete(listener) } })
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks() })
const render = async (props: Parameters<typeof Probe>[0] = {}) => act(async () => root.render(<Probe {...props} />))
const emit = async (event: Omit<RuntimeEvent, 'type'>) => act(async () => { for (const listener of listeners) listener({ type: 'core', ...event }) })

it('reads only while visible and only invalidates the exact Host/participant/direction', async () => {
  await render({ enabled: false }); expect(api.sessions.listMessages).not.toHaveBeenCalled(); expect(listeners.size).toBe(0)
  await render(); expect(api.sessions.listMessages).toHaveBeenCalledExactlyOnceWith({ hostId: 'original-host', agentSessionId: 'reader' }, { direction: 'incoming', limit: 25 })
  const event = { type: 'agent-message-changed' as const, sequence: 51, messageId: 'new', senderSessionId: 'sender', recipientSessionId: 'reader' }
  await emit({ hostId: 'foreign-host', event })
  await emit({ hostId: 'original-host', event: { ...event, recipientSessionId: 'other' } })
  await emit({ hostId: 'original-host', event: { ...event, senderSessionId: 'reader', recipientSessionId: 'other' } })
  expect(api.sessions.listMessages).toHaveBeenCalledTimes(1)
  vi.mocked(api.sessions.listMessages).mockResolvedValueOnce(page([item('new', 51), item('one', 50)]))
  await emit({ hostId: 'original-host', event })
  expect(reading.items.map(value => value.envelope.messageId)).toEqual(['new', 'one'])
  await render({ enabled: false }); await emit({ hostId: 'original-host', event })
  expect(api.sessions.listMessages).toHaveBeenCalledTimes(2); expect(listeners.size).toBe(0)
})

it('ignores a delayed old Session read and retains the selected current participant', async () => {
  let resolve!: (value: ReturnType<typeof page>) => void
  vi.mocked(api.sessions.listMessages).mockImplementationOnce(() => new Promise(done => { resolve = done }))
  await render()
  vi.mocked(api.sessions.listMessages).mockResolvedValueOnce(page([], null, 'new-reader'))
  await render({ agentSessionId: 'new-reader' })
  await act(async () => resolve(page()))
  expect(reading.items).toEqual([]); expect(reading.scope).toContain('new-reader')
})

it('keeps original pages and the exact failed cursor for an explicit retry', async () => {
  vi.mocked(api.sessions.listMessages).mockResolvedValueOnce(page([item('one', 50)], 50))
  await render(); vi.mocked(api.sessions.listMessages).mockRejectedValueOnce(new Error('Private later page unavailable'))
  await act(async () => reading.loadEarlier())
  expect(reading.items.map(value => value.envelope.messageId)).toEqual(['one']); expect(reading.nextCursor).toBe(50)
  expect(reading.error).toContain('later page unavailable')
  vi.mocked(api.sessions.listMessages).mockResolvedValueOnce(page([item('older', 40)], 40))
  await act(async () => reading.loadEarlier())
  expect(api.sessions.listMessages).toHaveBeenLastCalledWith({ hostId: 'original-host', agentSessionId: 'reader' }, { direction: 'incoming', beforeSequence: 50, limit: 25 })
  expect(reading.items.map(value => value.envelope.messageId)).toEqual(['one', 'older'])
})

it('retains original metadata when a returned owner or immutable MID content conflicts', async () => {
  await render(); const original = reading.items
  vi.mocked(api.sessions.listMessages).mockResolvedValueOnce({ ...page(), hostId: 'replacement-host' })
  await act(async () => reading.refresh()); expect(reading.error).toContain('identity changed'); expect(reading.items).toEqual(original)
  vi.mocked(api.sessions.listMessages).mockResolvedValueOnce(page([{ ...item('one', 50), bodyPreview: 'replacement body' }]))
  await act(async () => reading.refresh()); expect(reading.error).toContain('immutable content'); expect(reading.items).toEqual(original)
})

it('keeps observation unknown separate from a successful explicit read and never invokes input or ack', async () => {
  const submit = vi.spyOn(api.sessions, 'submitPrompt'), rejoin = vi.spyOn(api.sessions, 'rejoinInputWaiting'), input = vi.spyOn(api.sessions, 'write')
  await render()
  await emit({ hostId: 'original-host', event: { type: 'agent-message-observation', state: 'unavailable', message: 'Private watch gap' } })
  await act(async () => reading.refresh())
  expect(reading.error).toBeNull(); expect(reading.observationError).toBe('Private watch gap'); expect(reading.items).toHaveLength(1)
  await emit({ hostId: 'original-host', event: { type: 'agent-message-observation', state: 'available' } })
  expect(reading.observationError).toBeNull()
  expect(submit).not.toHaveBeenCalled(); expect(rejoin).not.toHaveBeenCalled(); expect(input).not.toHaveBeenCalled()
})


it('refreshes only the requested page budget into one contiguous latest window after a burst', async () => {
  vi.mocked(api.sessions.listMessages).mockResolvedValueOnce(page([item('original-top', 50)], 50))
  await render()
  vi.mocked(api.sessions.listMessages).mockResolvedValueOnce(page([item('original-older', 40)], null))
  await act(async () => reading.loadEarlier())
  expect(reading.items.map(value => value.sequence)).toEqual([50, 40])
  vi.mocked(api.sessions.listMessages).mockResolvedValueOnce(page([item('burst-top', 100)], 100))
    .mockResolvedValueOnce(page([item('burst-next', 90)], 90))
  await act(async () => reading.refresh())
  expect(api.sessions.listMessages).toHaveBeenLastCalledWith({ hostId: 'original-host', agentSessionId: 'reader' }, { direction: 'incoming', beforeSequence: 100, limit: 25 })
  expect(reading.items.map(value => value.sequence)).toEqual([100, 90])
  expect(reading.nextCursor).toBe(90)
  vi.mocked(api.sessions.listMessages).mockResolvedValueOnce(page([item('gap-middle', 80)], 80))
  await act(async () => reading.loadEarlier())
  expect(reading.items.map(value => value.sequence)).toEqual([100, 90, 80])
})

it('retains the complete prior window when a later page of its refresh fails', async () => {
  vi.mocked(api.sessions.listMessages).mockResolvedValueOnce(page([item('one', 50)], 50))
  await render()
  vi.mocked(api.sessions.listMessages).mockResolvedValueOnce(page([item('two', 40)], 40))
  await act(async () => reading.loadEarlier())
  const original = reading.items
  vi.mocked(api.sessions.listMessages).mockResolvedValueOnce(page([item('new', 60)], 60))
    .mockRejectedValueOnce(new Error('Private second page unavailable'))
  await act(async () => reading.refresh())
  expect(reading.items).toEqual(original); expect(reading.nextCursor).toBe(40)
  expect(reading.error).toContain('second page unavailable')
})
