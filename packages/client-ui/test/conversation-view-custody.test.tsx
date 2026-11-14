// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { nativeHistoryFixture, jsonl } from '../../core/test/fixtures/native-history-session.js'
import { isolateCoreFixtureEnvironment } from '../../../apps/desktop/test/helpers/isolate-core-environment.js'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform.js'
import { ConversationView } from '../src/components/ConversationView.js'
import { useConversationView } from '../src/lib/use-conversation-view.js'

const cleanups: Array<() => unknown | Promise<unknown>> = []
const platform: ClientUiPlatform = { copyText: async () => true, overlayContainer: () => document.body,
  bindComposerFocus: () => () => {}, renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
async function until(condition: () => boolean) {
  for (let i = 0; i < 400 && !condition(); i++) await act(async () => { await new Promise(done => setTimeout(done, 5)) })
  expect(condition()).toBe(true)
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const directory = await mkdtemp('/tmp/amx-view-custody-')
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  isolateCoreFixtureEnvironment(directory)
})
afterEach(async () => {
  getSelection()?.removeAllRanges()
  const errors: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) try { await cleanup() } catch (error) { errors.push(error) }
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs()
  if (errors.length) throw new AggregateError(errors, 'Owned conversation custody fixture cleanup failed')
})
async function fixture(count = 4) {
  const f = await nativeHistoryFixture('claude', jsonl(Array.from({ length: count }, (_, i) => ({ type: 'assistant',
    uuid: 'original-' + i, sessionId: 'native-main', message: { role: 'assistant', content: 'Original readable body ' + i + '.' } }))))
  cleanups.push(f.close)
  cleanups.push(async () => { expect(await readFile(f.path)).toEqual(f.before.native); expect(f.controls.flatMap(control => control.mock.calls)).toEqual([]) })
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
  let disposed = false, view!: ReturnType<typeof useConversationView>, hold = false
  const released: string[] = [], release = f.client.releaseConversationView.bind(f.client)
  vi.spyOn(f.client, 'releaseConversationView').mockImplementation(async input => {
    const result = await release(input); released.push(result.viewId); return result
  })
  function Consumer({ active }: { active: boolean }) {
    view = useConversationView(f.client, { hostId: 'local', agentSessionId: f.session.agentSessionId }, active,
      { beforeCommit: () => !hold })
    const reading = view.reading
    return <ClientUiProvider platform={platform}>{reading ? <ConversationView sessionId={f.session.agentSessionId} executionHostId="local"
      page={reading.historyPage} timeline={reading.timeline} records={reading.records} originalRecords={reading.originalRecords} coverage={reading.timeline.coverage} /> : null}</ClientUiProvider>
  }
  const render = (active = true) => act(async () => root.render(<Consumer active={active} />))
  const dispose = async () => { if (!disposed) { disposed = true; await act(async () => root.unmount()); host.remove() } }
  cleanups.push(dispose)
  const ref = { hostId: 'local', agentSessionId: f.session.agentSessionId }
  const replay = (snapshot: NonNullable<typeof view.snapshot>) => f.client.readAgentConversation({ ...ref, view: snapshot.window.view!, processDetails: snapshot.processDetails })
  return { ...f, host, ref, render, dispose, released, replay, view: () => view, hold: (value: boolean) => { hold = value } }
}

it('releases replaced accepted windows even when their exact observers never bound', async () => {
  const f = await fixture(), observe = f.client.observeConversation.bind(f.client)
  vi.spyOn(f.client, 'observeConversation').mockImplementation(async (input, listener, options) => {
    if (input.view) throw Object.assign(new Error('Controlled original view observer unavailable.'), { code: 'CONTROL_UNAVAILABLE' })
    return observe(input, listener, options)
  })
  await f.render(); await until(() => Boolean(f.view().snapshot && f.view().observationError && !f.view().loading))
  const first = f.view().snapshot!, body = f.host.querySelector('.log-turn__body')
  await act(async () => { await f.view().refresh() })
  const second = f.view().snapshot!
  expect(second.window.id).not.toBe(first.window.id)
  expect(f.host.querySelector('.log-turn__body')).toBe(body)
  await f.dispose(); await until(() => f.released.includes(first.window.id) && f.released.includes(second.window.id))
  await expect(f.replay(first)).rejects.toMatchObject({ code: 'AGENT_CONVERSATION_VIEW_EXPIRED' })
  await expect(f.replay(second)).rejects.toMatchObject({ code: 'AGENT_CONVERSATION_VIEW_EXPIRED' })
})

it('pins the displayed window and Range while a replacement is held, then parks only the admitted window', async () => {
  const f = await fixture(); await f.render(); await until(() => Boolean(f.view().snapshot && !f.view().loading && !f.view().inspect().dirty))
  const first = f.view().snapshot!, body = f.host.querySelector('.log-turn__body')!, text = body.querySelector('p')!.firstChild!
  const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 8); getSelection()!.addRange(range)
  f.hold(true); await act(async () => { await f.view().refresh() })
  expect(f.view().held).toBe(true); expect(f.host.querySelector('.log-turn__body')).toBe(body)
  expect(getSelection()!.toString()).toBe('Original')
  expect((await f.replay(first)).window.id).toBe(first.window.id)
  const held = f.view().inspect().pending!; expect(held.window.id).not.toBe(first.window.id)
  f.hold(false); await act(async () => f.view().acceptHeld())
  await until(() => f.released.includes(first.window.id))
  expect(f.view().snapshot!.window.id).toBe(held.window.id)
  await f.render(false); expect((await f.replay(held)).window.id).toBe(held.window.id)
  expect(getSelection()!.toString()).toBe('Original')
  await f.render(); await until(() => !f.view().loading)
  expect(f.view().snapshot!.window.id).toBe(held.window.id)
  await f.dispose(); await until(() => f.released.includes(held.window.id))
})

it('cancels a held exact-record candidate without releasing its original rollback window', async () => {
  const f = await fixture(); await f.render(); await until(() => Boolean(f.view().snapshot && !f.view().loading && !f.view().inspect().dirty))
  const first = f.view().snapshot!, body = f.host.querySelector('.log-turn__body'), controller = new AbortController()
  const target = first.units[0]!.records[0]!.reference!
  f.hold(true); await act(async () => { await f.view().selectRecord(target, { signal: controller.signal }) })
  expect(f.view().held).toBe(true)
  const candidate = f.view().inspect().pending!
  expect((await f.replay(first)).window.id).toBe(first.window.id)
  await act(async () => controller.abort(new Error('The original location intent was cancelled.')))
  await until(() => !f.view().held && f.released.includes(candidate.window.id))
  expect(f.view().snapshot!.window.id).toBe(first.window.id); expect(f.host.querySelector('.log-turn__body')).toBe(body)
  expect((await f.replay(first)).window.id).toBe(first.window.id)
  await expect(f.replay(candidate)).rejects.toMatchObject({ code: 'AGENT_CONVERSATION_VIEW_EXPIRED' })
})

it.each(['complete', 'partial'] as const)('releases a late %s candidate after a newer original window owns presentation', async representation => {
  const f = await fixture(), original = f.client.readAgentConversation.bind(f.client), waiting = gate()
  let armed = false, entered = false, candidate: Awaited<ReturnType<typeof original>> | undefined
  vi.spyOn(f.client, 'readAgentConversation').mockImplementation(async (input, options) => {
    if (armed && !input.cursor) {
      armed = false
      candidate = await original({ ...input, ...(representation === 'partial' ? { limit: 1 } : {}) }, options)
      entered = true; await waiting.promise
      return candidate
    }
    return original(input, options)
  })
  try {
    await f.render(); await until(() => Boolean(f.view().snapshot && !f.view().loading && !f.view().inspect().dirty))
    if (representation === 'partial') await f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.session.agentSessionId,
      item: { id: 'captured-extra', agentSessionId: f.session.agentSessionId, kind: 'assistant_message', source: 'native-hook',
        status: 'complete', title: 'Original captured reply', content: 'Original captured extra body.', createdAt: 1, updatedAt: 1 } })
    armed = true
    let abandoned!: Promise<void>
    await act(async () => { abandoned = f.view().refresh(); await Promise.resolve() })
    await until(() => entered)
    expect(candidate!.window.complete).toBe(representation === 'complete')
    await act(async () => { await f.view().refresh() })
    const accepted = f.view().snapshot!, body = f.host.querySelector('.log-turn__body')
    expect(accepted.window.id).not.toBe(candidate!.window.id)
    waiting.release(); await act(async () => { await abandoned })
    await until(() => f.released.includes(candidate!.window.id))
    expect(f.view().snapshot).toBe(accepted); expect(f.host.querySelector('.log-turn__body')).toBe(body)
    await expect(f.client.readAgentConversation({ ...f.ref, view: candidate!.window.replay, processDetails: 'deferred' })).rejects.toMatchObject({ code: 'AGENT_CONVERSATION_VIEW_EXPIRED' })
  } finally { waiting.release() }
})
