// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { nativeHistoryFixture, jsonl } from '../../core/test/fixtures/native-history-session.js'
import { isolateCoreFixtureEnvironment } from '../../../apps/desktop/test/helpers/isolate-core-environment.js'
import { useSessionConversationWindow } from '../../../apps/desktop/src/renderer/src/lib/session-conversation-window'
import { useSessionUserMessages } from '../../../apps/desktop/src/renderer/src/lib/session-user-messages'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform.js'
import { ConversationView } from '../src/components/ConversationView.js'
import { useConversationView } from '../src/lib/use-conversation-view.js'
import { describeConversationWindow } from '../src/lib/conversation-records.js'

// The host route is explicitly supplied below. This default route must never be used.
vi.mock('../../../apps/desktop/src/renderer/src/lib/api', () => ({ api: { conversation: {} } }))
vi.mock('../../../apps/desktop/src/renderer/src/lib/reading-diagnostic-publication', () => ({ publishReadingDiagnostic: () => {} }))
const cleanups: Array<() => unknown | Promise<unknown>> = []
const factsPath = process.env.AGENTMUX_BACKFILL_FACTS
const platform: ClientUiPlatform = { copyText: async () => true, overlayContainer: () => document.body,
  bindComposerFocus: () => () => {}, renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
async function until(condition: () => boolean, message = 'The owned reader must reach the requested state') {
  for (let i = 0; i < 500 && !condition(); i++) await act(async () => { await new Promise(done => setTimeout(done, 5)) })
  expect(condition(), message).toBe(true)
}
async function note(value: unknown) {
  if (factsPath) await appendFile(factsPath, JSON.stringify(value) + '\n')
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const directory = await mkdtemp('/tmp/amx-backfill-')
  await note({ kind: 'environment-created', path: directory })
  cleanups.push(async () => { await rm(directory, { recursive: true, force: true }); await note({ kind: 'environment-removed', path: directory }) })
  isolateCoreFixtureEnvironment(directory)
})
afterEach(async () => {
  getSelection()?.removeAllRanges()
  const errors: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) try { await cleanup() } catch (error) { errors.push(error) }
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs()
  if (errors.length) throw new AggregateError(errors, 'Owned backfill fixture cleanup failed')
})

async function fixture(mode: 'coverage' | 'inputs' | 'shared' = 'shared') {
  const f = await nativeHistoryFixture('claude', jsonl(Array.from({ length: 105 }, (_, i) => ({ type: i === 0 ? 'user' : 'assistant',
    uuid: 'original-' + i, sessionId: 'native-main', timestamp: new Date(1_700_000_000_000 + i).toISOString(),
    message: { role: i === 0 ? 'user' : 'assistant', content: 'Original readable body ' + i + '.' } }))))
  await note({ kind: 'fixture-created', path: f.root })
  cleanups.push(async () => { await f.close(); await note({ kind: 'fixture-removed', path: f.root }) })
  cleanups.push(async () => { expect(await readFile(f.path)).toEqual(f.before.native); expect(f.controls.flatMap(control => control.mock.calls)).toEqual([]) })
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
  const ref = { hostId: 'local', agentSessionId: f.session.agentSessionId }
  const port = f.client as unknown as NonNullable<NonNullable<Parameters<typeof useSessionConversationWindow>[0]>['port']>
  let raw!: ReturnType<typeof useConversationView>, snapshot: typeof raw.snapshot = null, loading = false, hold = false
  function present(reading: ReturnType<typeof useSessionConversationWindow>['projection']) {
    return <ClientUiProvider platform={platform}>{reading ? <ConversationView sessionId={ref.agentSessionId} executionHostId="local"
      page={reading.historyPage} timeline={reading.timeline} records={reading.records} originalRecords={reading.originalRecords} coverage={reading.timeline.coverage} /> : null}</ClientUiProvider>
  }
  function Shared() {
    raw = useConversationView(f.client, ref, true, { beforeCommit: () => !hold })
    snapshot = raw.snapshot; loading = raw.loading
    return present(raw.reading ? describeConversationWindow(raw.reading) : null)
  }
  function Coverage() {
    const current = useSessionConversationWindow({ port, reference: ref, identity: 'actual-coverage', enabled: true }, () => true)
    snapshot = current.snapshot; loading = current.loading
    return present(current.projection)
  }
  function Inputs() {
    const current = useSessionUserMessages({ ...ref, run: f.session.run }, { enabled: true, initialInputs: 1,
      reading: { reference: ref, port: port!, identity: 'actual-input-seek' } })
    raw = current.conversation; snapshot = raw.snapshot; loading = raw.loading
    return present(raw.reading ? describeConversationWindow(raw.reading) : null)
  }
  cleanups.push(async () => { await act(async () => root.unmount()); host.remove() })
  const publish = async () => {
    const item = { id: 'captured-live', agentSessionId: ref.agentSessionId, kind: 'assistant_message' as const,
      source: 'native-hook' as const, status: 'complete' as const, title: 'Original captured reply',
      content: 'Live reply arrived during the older read.', createdAt: 1_700_000_001_000, updatedAt: 1_700_000_001_000 }
    const commit = await f.store.applyTimelineMutation({ type: 'append', agentSessionId: ref.agentSessionId, item })
    Reflect.get(f.client, 'publisher').publishTimeline(commit, { source: 'user', observedAt: item.createdAt, run: f.session.run }, f.session.hostId)
    return item.content
  }
  return { ...f, ref, host, publish, snapshot: () => snapshot, loading: () => loading, raw: () => raw,
    hold: (value: boolean) => { hold = value }, render: () => act(async () => root.render(mode === 'coverage' ? <Coverage /> : mode === 'inputs' ? <Inputs /> : <Shared />)) }
}

it.each([['coverage', 'before-source'], ['inputs', 'after-Core-commit']] as const)(
  '%s automatic backfill yields before its %s gate returns, through the original Core source', async (mode, stage) => {
    const f = await fixture(mode), waiting = gate(), read = f.client.readAgentConversation.bind(f.client)
    let entered = false, gateReleased = false, originalWindow: string | undefined, completedRevision: number | undefined
    const reopens: Array<unknown> = []
    vi.spyOn(f.client, 'readAgentConversation').mockImplementation(async (input, options) => {
      expect(input).not.toHaveProperty('background')
      if (input.nativeSource) reopens.push(input.nativeSource)
      if (input.cursor && !entered) {
        if (stage === 'before-source') { entered = true; await waiting.promise; return read(input, options) }
        const page = await read(input, options)
        if (page.window.complete) { originalWindow = page.window.id; completedRevision = page.window.revision; entered = true; await waiting.promise }
        return page
      }
      return read(input, options)
    })
    try {
      await f.render(); await until(() => entered)
      const before = f.snapshot()!
      if (stage === 'after-Core-commit') {
        expect(originalWindow).toBe(before.window.id)
        expect(completedRevision!).toBeGreaterThan(before.window.revision)
      }
      const body = await f.publish()
      await until(() => f.host.textContent!.includes(body), 'Live reply must be visible before the controlled older gate is released')
      expect(gateReleased).toBe(false)
      expect(reopens.length).toBeGreaterThan(0)
      expect(reopens.every(source => JSON.stringify(source) === JSON.stringify({ providerId: 'claude', nativeSessionId: 'native-main' }))).toBe(true)
      const accepted = f.snapshot()!
      expect(accepted.sourceHostId).toBe(before.sourceHostId); expect(accepted.scope).toEqual(before.scope)
      expect(accepted.window.id).not.toBe(before.window.id)
      gateReleased = true; waiting.release()
      await until(() => !f.loading())
      expect(f.host.textContent).toContain(body)
      await note({ kind: 'automatic-yield', mode, stage, originalView: before.window.id, originalRevision: before.window.revision,
        completedRevision, newView: accepted.window.id, source: accepted.scope, replyVisibleBeforeGateRelease: true,
        reopens, controls: [] })
    } finally { gateReleased = true; waiting.release() }
  })

it('keeps an explicit Earlier intent even with preserveCurrent, instead of treating it as automatic', async () => {
  const f = await fixture(), waiting = gate(), read = f.client.readAgentConversation.bind(f.client)
  let entered = false
  const reopens: unknown[] = []
  vi.spyOn(f.client, 'readAgentConversation').mockImplementation(async (input, options) => {
    if (input.nativeSource) reopens.push(input.nativeSource)
    if (input.cursor && !entered) { entered = true; await waiting.promise }
    return read(input, options)
  })
  try {
    await f.render(); await until(() => Boolean(f.snapshot() && !f.loading() && !f.raw().inspect().dirty))
    const before = f.snapshot()!
    let older!: Promise<unknown>
    await act(async () => { older = f.raw().earlier(100, { preserveCurrent: true }); await Promise.resolve() })
    await until(() => entered)
    const body = await f.publish(); await until(() => Boolean(f.raw().inspect().dirty))
    expect(reopens).toEqual([]); expect(f.snapshot()).toBe(before); expect(f.host.textContent).not.toContain(body)
    waiting.release(); await act(async () => { await older })
    await until(() => f.host.textContent!.includes(body))
    expect(f.snapshot()!.window.id).toBe(before.window.id)
    expect(f.snapshot()!.units.some(unit => unit.records.some(record => record.original.item.id === 'original-0'))).toBe(true)
  } finally { waiting.release() }
})

it('keeps a held replacement and its selected original body while automatic work is pending', async () => {
  const f = await fixture(), waiting = gate(), read = f.client.readAgentConversation.bind(f.client)
  let armed = false, entered = false
  const reopens: unknown[] = []
  vi.spyOn(f.client, 'readAgentConversation').mockImplementation(async (input, options) => {
    if (input.nativeSource) reopens.push(input.nativeSource)
    if (armed && input.cursor && !entered) { entered = true; await waiting.promise }
    return read(input, options)
  })
  try {
    await f.render(); await until(() => Boolean(f.snapshot() && !f.loading() && !f.raw().inspect().dirty))
    const displayed = f.snapshot()!, bodyNode = f.host.querySelector('.log-turn__body')!, text = bodyNode.querySelector('p')!.firstChild!
    const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 8); getSelection()!.addRange(range)
    f.hold(true); await act(async () => { await f.raw().refresh() }); expect(f.raw().held).toBe(true)
    armed = true
    let older!: Promise<unknown>
    await act(async () => { older = f.raw().earlier(100, { preserveCurrent: true, background: true }); await Promise.resolve() })
    await until(() => entered)
    const body = await f.publish(); await until(() => Boolean(f.raw().inspect().dirty))
    expect(reopens).toEqual([]); expect(f.snapshot()).toBe(displayed)
    expect(f.host.querySelector('.log-turn__body')).toBe(bodyNode); expect(getSelection()!.toString()).toBe('Original')
    waiting.release(); await act(async () => { await older })
    expect(f.raw().held).toBe(true); expect(f.host.textContent).not.toContain(body)
    f.hold(false); await act(async () => f.raw().acceptHeld())
    await until(() => f.host.textContent!.includes(body))
    expect(getSelection()!.toString()).toBe('Original')
  } finally { waiting.release() }
})

it('does not replace an exact original anchor with a live source update', async () => {
  const f = await fixture(), waiting = gate(), read = f.client.readAgentConversation.bind(f.client)
  let entered = false
  const reopens: unknown[] = []
  vi.spyOn(f.client, 'readAgentConversation').mockImplementation(async (input, options) => {
    if (input.nativeSource) reopens.push(input.nativeSource)
    if (input.anchor && !entered) { entered = true; await waiting.promise }
    return read(input, options)
  })
  try {
    await f.render(); await until(() => Boolean(f.snapshot() && !f.loading() && !f.raw().inspect().dirty))
    const before = f.snapshot()!, record = before.units[0]!.records[0]!
    let exact!: Promise<void>
    await act(async () => { exact = f.raw().reveal({ record: record.reference!, revision: record.revision, frontier: before.window.checkpoint }); await Promise.resolve() })
    await until(() => entered)
    const body = await f.publish(); await until(() => Boolean(f.raw().inspect().dirty))
    expect(reopens).toEqual([]); expect(f.snapshot()).toBe(before)
    waiting.release(); await act(async () => { await exact })
    expect(f.snapshot()!.window.anchor?.record).toEqual(record.reference)
    expect(f.raw().historical).toBe(true); expect(f.host.textContent).not.toContain(body)
  } finally { waiting.release() }
})
