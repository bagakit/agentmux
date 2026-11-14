// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { nativeHistoryFixture, jsonl } from '../../core/test/fixtures/native-history-session.js'
import { isolateCoreFixtureEnvironment } from '../../../apps/desktop/test/helpers/isolate-core-environment.js'
import { AgentMuxError } from '../../core/src/errors.js'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform.js'
import { ConversationView } from '../src/components/ConversationView.js'
import { useConversationView } from '../src/lib/use-conversation-view.js'

const cleanups: Array<() => unknown | Promise<unknown>> = []
const platform: ClientUiPlatform = { copyText: async () => true, overlayContainer: () => document.body,
  bindComposerFocus: () => () => {}, renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const directory = await mkdtemp('/tmp/amx-first-')
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  isolateCoreFixtureEnvironment(directory)
})
afterEach(async () => {
  getSelection()?.removeAllRanges()
  const failures: unknown[] = []
  try { for (const cleanup of cleanups.splice(0).reverse()) { try { await cleanup() } catch (error) { failures.push(error) } } }
  finally { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs() }
  if (failures.length) throw new AggregateError(failures, 'First-frame private fixture cleanup failed')
})
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
async function until(condition: () => boolean) {
  for (let i = 0; i < 200 && !condition(); i++) await act(async () => { await new Promise(done => setTimeout(done, 5)) })
  expect(condition()).toBe(true)
}
async function fixture() {
  const f = await nativeHistoryFixture('claude', jsonl([{ type: 'assistant', uuid: 'first-original', sessionId: 'native-main',
    message: { role: 'assistant', content: 'Original first accepted body.' } }]))
  cleanups.push(f.close)
  cleanups.push(async () => {
    expect(await readFile(f.path)).toEqual(f.before.native)
    expect(await f.store.readMetadata(f.session.agentSessionId)).toMatchObject({ agentSessionId: f.session.agentSessionId, run: f.session.run, nativeHandle: f.session.nativeHandle })
    expect(f.controls.flatMap(control => control.mock.calls)).toEqual([])
  })
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
  cleanups.push(async () => { await act(async () => root.unmount()); host.remove() })
  let view!: ReturnType<typeof useConversationView>
  const admissions: string[] = []
  function Consumer() {
    view = useConversationView(f.client, { hostId: 'local', agentSessionId: f.session.agentSessionId }, true,
      { beforeCommit: (_snapshot, operation) => { admissions.push(operation); return true } })
    const reading = view.reading
    return <ClientUiProvider platform={platform}>{reading ? <ConversationView sessionId={f.session.agentSessionId} executionHostId="local"
      page={reading.historyPage} timeline={reading.timeline} records={reading.records} originalRecords={reading.originalRecords} coverage={reading.timeline.coverage} /> : null}</ClientUiProvider>
  }
  return { ...f, host, view: () => view, admissions, render: () => act(async () => root.render(<Consumer />)) }
}

it('publishes its first accepted latest body while the exact original view observer is still pending', async () => {
  const f = await fixture(), opening = gate(), observe = f.client.observeConversation.bind(f.client)
  let entered = false, completed = false
  vi.spyOn(f.client, 'observeConversation').mockImplementation(async (input, callback, options) => {
    if (input.view) { entered = true; await opening.promise }
    const handle = await observe(input, callback, options)
    if (input.view) completed = true
    return handle
  })
  try {
    await f.render(); await until(() => entered)
    await until(() => f.host.textContent!.includes('Original first accepted body.'))
    expect(completed, 'First original body must not depend on its pending exact observer').toBe(false)
    expect(f.admissions).toContain('latest'); expect(f.view().snapshot?.units.length).toBeGreaterThan(0)
    const body = f.host.querySelector('.log-turn__body')
    opening.release(); await until(() => !f.view().loading && f.view().inspect().watch.bound)
    expect(completed).toBe(true); expect(f.host.querySelector('.log-turn__body')).toBe(body)
  } finally { opening.release() }
})

it('keeps the accepted original body and observation error after observer rejection, then recovers the same view', async () => {
  const f = await fixture(), recovery = gate(), observe = f.client.observeConversation.bind(f.client)
  let openings = 0
  vi.spyOn(f.client, 'observeConversation').mockImplementation(async (input, callback, options) => {
    if (input.view && ++openings === 1) throw new AgentMuxError('Controlled exact view observer unavailable.', 'AGENT_SESSION_HISTORY_OBSERVATION_UNAVAILABLE')
    if (input.view) await recovery.promise
    return observe(input, callback, options)
  })
  try {
    await f.render(); await until(() => Boolean(f.view().observationError))
    expect(f.view().observationError?.message).toContain('Controlled exact view observer unavailable.')
    expect(f.host.textContent).toContain('Original first accepted body.')
    const id = f.view().snapshot!.window.id, body = f.host.querySelector('.log-turn__body')
    await until(() => openings >= 2)
    expect(f.view().snapshot!.window.id).toBe(id); expect(f.host.querySelector('.log-turn__body')).toBe(body)
    expect(f.view().observationError).not.toBeNull()
    recovery.release(); await until(() => !f.view().loading && !f.view().observationError && f.view().inspect().watch.bound)
    expect(f.view().snapshot!.window.id).toBe(id); expect(f.host.querySelector('.log-turn__body')).toBe(body)
  } finally { recovery.release() }
})
