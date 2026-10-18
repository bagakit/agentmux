// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryDescriptor } from '@agentmux/core'
import type { RuntimeEvent } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { useFocusHistorySources, type FocusHistoryCatalogue } from '../src/renderer/src/lib/focus-history-sources'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { agentCreationFixture } from './helpers/agent-creation-fixture'

const dom = composerDOM()
let catalogue: FocusHistoryCatalogue, listeners: Set<(event: RuntimeEvent) => void>, visible: DocumentVisibilityState
const source = (hostId = 'local', agentSessionId = 'same-session', state: AgentSessionHistoryDescriptor['state'] = 'active'): AgentSessionHistoryDescriptor => ({ hostId, agentSessionId, state })
const active = (hostId = 'local', id = 'same-session'): RuntimeEvent => ({ type: 'core', hostId,
  event: { type: 'agent-session', session: { ...agentCreationFixture(composerSession(id)), hostId } } })
const removed = (hostId = 'local', id = 'same-session'): RuntimeEvent => ({ type: 'core', hostId,
  event: { type: 'run-removed', agentSessionId: id, run: { runId: 'original-run' }, evidence: { source: 'run-process', observedAt: 1 } } })
function Catalogue({ enabled = true }: { enabled?: boolean }) {
  catalogue = useFocusHistorySources(enabled)
  return <output>{catalogue.error ?? catalogue.sources.map(item => item.hostId + ':' + item.agentSessionId + ':' + item.state).join(',')}</output>
}
async function emit(...events: RuntimeEvent[]) {
  await act(async () => { for (const event of events) for (const listener of [...listeners]) listener(event) })
}
function deferred() {
  let resolve!: (sources: AgentSessionHistoryDescriptor[]) => void
  const promise = new Promise<AgentSessionHistoryDescriptor[]>(done => { resolve = done })
  return { promise, resolve }
}
beforeEach(() => {
  visible = 'visible'; listeners = new Set()
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visible)
  vi.spyOn(api.sessions, 'onEvent').mockImplementation(listener => { listeners.add(listener); return () => { listeners.delete(listener) } })
})

it('invalidates new exact Host identities and reopened sources without rescanning ordinary Session ticks', async () => {
  const original = [source(), source('local', 'closed', 'retired')]
  const read = vi.spyOn(api.sessions, 'historySources').mockResolvedValue({ sources: original, warnings: [] })
  await dom.render(<Catalogue />)
  await emit(...Array.from({ length: 100 }, () => active()))
  expect(read).toHaveBeenCalledTimes(1)
  await emit(active('other-host'))
  expect(read).toHaveBeenCalledTimes(2)
  await emit(...Array.from({ length: 100 }, () => active('other-host')))
  expect(read).toHaveBeenCalledTimes(2)
  await emit(active('local', 'closed'))
  expect(read).toHaveBeenCalledTimes(3)
  await emit(...Array.from({ length: 100 }, () => active('local', 'closed')))
  expect(read).toHaveBeenCalledTimes(3)
  expect(catalogue.sources).toBe(original)
})

it('drains a lifecycle invalidation received during the original catalogue read without overlapping reads', async () => {
  const first = deferred(), second = deferred(), original = [source()], retired = [source('local', 'same-session', 'retired')]
  const read = vi.spyOn(api.sessions, 'historySources').mockReturnValueOnce(first.promise.then(sources => ({ sources, warnings: [] }))).mockReturnValueOnce(second.promise.then(sources => ({ sources, warnings: [] })))
  await dom.render(<Catalogue />); expect(read).toHaveBeenCalledTimes(1)
  await emit(removed()); expect(read).toHaveBeenCalledTimes(1)
  await act(async () => first.resolve(original))
  expect(read).toHaveBeenCalledTimes(2); expect(catalogue.loading).toBe(true)
  await act(async () => second.resolve(retired))
  expect(catalogue.sources).toBe(retired); expect(catalogue.available).toBe(true)
  expect(read).toHaveBeenCalledTimes(2)
})

it('preserves a newer reopen invalidation through an older in-flight catalogue and subsequent ordinary ticks', async () => {
  const pending = deferred(), reopened = [source()]
  const read = vi.spyOn(api.sessions, 'historySources').mockReturnValueOnce(pending.promise.then(sources => ({ sources, warnings: [] }))).mockResolvedValueOnce({ sources: reopened, warnings: [] })
  await dom.render(<Catalogue />)
  await emit(removed(), active())
  expect(read).toHaveBeenCalledTimes(1)
  await act(async () => pending.resolve([source('local', 'same-session', 'retired')]))
  expect(read).toHaveBeenCalledTimes(2); expect(catalogue.sources).toBe(reopened)
  await emit(...Array.from({ length: 100 }, () => active()))
  expect(read).toHaveBeenCalledTimes(2); expect(catalogue.available).toBe(true)
})

it('coalesces hidden lifecycle changes and fences a hidden late catalogue before resuming its original owner', async () => {
  const original = [source()], late = deferred(), retired = [source('local', 'same-session', 'retired')]
  const read = vi.spyOn(api.sessions, 'historySources').mockResolvedValueOnce({ sources: original, warnings: [] }).mockReturnValueOnce(late.promise.then(sources => ({ sources, warnings: [] }))).mockResolvedValueOnce({ sources: retired, warnings: [] })
  await dom.render(<Catalogue />)
  await emit(removed()); expect(read).toHaveBeenCalledTimes(2)
  await act(async () => { visible = 'hidden'; document.dispatchEvent(new Event('visibilitychange')) })
  await emit(removed(), active('other-host'), removed('other-host'))
  await act(async () => late.resolve([]))
  expect(catalogue.sources).toBe(original); expect(read).toHaveBeenCalledTimes(2)
  await act(async () => { visible = 'visible'; document.dispatchEvent(new Event('visibilitychange')) })
  expect(read).toHaveBeenCalledTimes(3); expect(catalogue.sources).toBe(retired)
})

it('retains the original catalogue and explicit retry after a lifecycle read fails', async () => {
  const original = [source()], retired = [source('local', 'same-session', 'retired')]
  const read = vi.spyOn(api.sessions, 'historySources').mockResolvedValueOnce({ sources: original, warnings: [] })
    .mockRejectedValueOnce(Error('Original lifecycle source unavailable')).mockResolvedValueOnce({ sources: retired, warnings: [] })
  await dom.render(<Catalogue />); await emit(removed())
  expect(catalogue.sources).toBe(original); expect(catalogue.error).toContain('Original lifecycle source unavailable')
  expect(catalogue.available).toBe(false); expect(read).toHaveBeenCalledTimes(2)
  await act(async () => catalogue.refresh())
  expect(catalogue.sources).toBe(retired); expect(catalogue.error).toBeNull(); expect(read).toHaveBeenCalledTimes(3)
})

it('tracks lifecycle invalidation while disabled and ignores removal without an exact Session identity', async () => {
  const original = [source()], retired = [source('local', 'same-session', 'retired')]
  const read = vi.spyOn(api.sessions, 'historySources').mockResolvedValueOnce({ sources: original, warnings: [] }).mockResolvedValueOnce({ sources: retired, warnings: [] })
  await dom.render(<Catalogue />)
  const event = removed(); if (event.type !== 'core' || event.event.type !== 'run-removed') throw Error('Exact fixture required')
  delete event.event.agentSessionId
  await emit(event); expect(read).toHaveBeenCalledTimes(1)
  await dom.render(<Catalogue enabled={false} />); await emit(removed(), removed())
  expect(read).toHaveBeenCalledTimes(1); expect(catalogue.sources).toBe(original)
  await dom.render(<Catalogue />)
  expect(read).toHaveBeenCalledTimes(2); expect(catalogue.sources).toBe(retired)
})
