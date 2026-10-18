import { fixtureEpoch as _followupFixtureEpoch } from "../../../test/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { useConversationView } from '@agentmux/client-ui/use-conversation-view'
import { ConversationView } from '@agentmux/client-ui/components/ConversationView'
import { conversationPagePortFixture } from './helpers/conversation-page-port-fixture'
import { createClientUiRoot } from './helpers/client-ui-render'
import { AgentMuxError } from '../../../packages/core/src/errors'
import { api } from '../src/renderer/src/lib/api'
import type { AgentSessionHistoryPage, AgentTimelineSnapshot } from '@agentmux/core'
const closes: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  window.getSelection()?.removeAllRanges()
  const failures: unknown[] = []
  for (const close of closes.splice(0).reverse()) { try { await close() } catch (error) { failures.push(error) } }
  vi.restoreAllMocks(); vi.unstubAllGlobals()
  if (failures.length) throw new AggregateError(failures, 'Private reading transaction cleanup failed')
})
const reference = { hostId: 'local', agentSessionId: 'original-reading-transaction' }, source = { providerId: 'claude', nativeSessionId: 'original-native' }
const page = (body: string): AgentSessionHistoryPage => ({ agentSessionId: reference.agentSessionId, source, nextCursor: null,
  items: [{ id: 'same-original', kind: 'assistant-message', contentParts: [{ kind: 'text', text: body }] }] })
const pause = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
const wait = (assertion: () => void) => vi.waitFor(async () => { await pause(); assertion() }, { timeout: 7000, interval: 20 })
async function fixture() {
  let body = 'Original selected body', hold = false
  const f = await conversationPagePortFixture(reference, source, async () => page(body)); closes.push(f.close)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div'); document.body.append(host); const root = createClientUiRoot(host)
  closes.push(async () => { await act(async () => root.unmount()); host.remove() })
  let view!: ReturnType<typeof useConversationView>
  const admissions: Array<{ operation: string; anchor: unknown }> = []
  function Consumer({ active = true }: { active?: boolean }) {
    view = useConversationView(api.conversation, reference, active, { beforeCommit(snapshot, operation) { admissions.push({ operation, anchor: snapshot.window.anchor }); return !hold } })
    const reading = view.reading
    return reading ? <ConversationView sessionId={reference.agentSessionId} executionHostId="local" active page={reading.historyPage} timeline={reading.timeline} records={reading.records} originalRecords={reading.originalRecords} coverage={reading.timeline.coverage} /> : null
  }
  const render = (active = true) => act(async () => root.render(<Consumer active={active} />))
  await render(); await wait(() => { expect(host.textContent).toContain(body); expect(view.loading).toBe(false); expect(view.inspect().dirty).toBe(false) })
  return { f, host, admissions, render, view: () => view, hold: (value: boolean) => { hold = value }, body: (value: string) => { body = value } }
}
function anchorOf(view: ReturnType<typeof useConversationView>) {
  const record = view.snapshot!.units.flatMap(unit => unit.records)[0]!
  return { record: record.reference!, revision: record.revision, frontier: view.snapshot!.window.checkpoint }
}
it('a held original-anchor frame keeps displayed history and coverage together until admission with its original operation', async () => {
  const x = await fixture(), accepted = x.view().snapshot!, anchor = anchorOf(x.view())
  x.hold(true)
  await act(async () => { await x.view().reveal(anchor) })
  expect(x.view().held).toBe(true); expect(x.view().snapshot).toBe(accepted)
  expect(x.view().historical, 'Pending navigation cannot publish historical metadata ahead of its displayed body').toBe(false)
  expect(x.view().inspect().pending!.window.anchor).toEqual(anchor)
  x.hold(false)
  await act(async () => x.view().acceptHeld())
  expect(x.admissions.at(-1)!.operation, 'Held admission must replay original anchor intent').toBe('latest')
  expect(x.view().snapshot!.window.anchor).toEqual(anchor); expect(x.view().historical).toBe(true); expect(x.view().held).toBe(false)
  expect(x.f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})
it('parking and resuming a held frame preserve its original admission intent and displayed metadata', async () => {
  const x = await fixture(), accepted = x.view().snapshot!, anchor = anchorOf(x.view())
  x.hold(true); await act(async () => { await x.view().reveal(anchor) })
  await x.render(false); await x.render(true)
  await wait(() => expect(x.view().loading).toBe(false))
  expect(x.admissions.at(-1)!.operation, 'Resume of the same held view must preserve original anchor admission').toBe('latest')
  expect(x.view().snapshot).toBe(accepted); expect(x.view().historical).toBe(false)
  x.hold(false); await act(async () => x.view().acceptHeld())
  expect(x.admissions.at(-1)!.operation).toBe('latest'); expect(x.view().snapshot!.window.anchor).toEqual(anchor); expect(x.view().historical).toBe(true)
})
it('the shared real Core consumer retains a selected same-ID native body version until its Range is cleared', async () => {
  const x = await fixture(), node = x.host.querySelector('.log-turn__body p')!.firstChild!, selection = window.getSelection()!, range = document.createRange()
  range.selectNodeContents(node); selection.removeAllRanges(); selection.addRange(range)
  const old = selection.toString()
  x.body('Changed version of the same original')
  await act(async () => { await x.view().refresh() })
  expect(x.host.textContent, 'A same-ID selected version is part of placement protection').toContain('Original selected body')
  expect(x.host.textContent).not.toContain('Changed version of the same original'); expect(node.isConnected).toBe(true); expect(selection.toString()).toBe(old)
  await act(async () => { selection.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')) })
  await wait(() => expect(x.host.textContent).toContain('Changed version of the same original'))
})

it('a held source failure remains an operation service error while displayed coverage stays with its accepted body', async () => {
  const x = await fixture(), accepted = x.view().snapshot!
  x.hold(true)
  vi.mocked(x.f.client.readSessionHistoryChanges).mockRejectedValueOnce(new AgentMuxError('Exact native read temporarily unavailable.', 'AGENT_SESSION_HISTORY_UNAVAILABLE'))
  await act(async () => { await x.view().changes() })
  expect(x.view().held).toBe(true); expect(x.view().snapshot).toBe(accepted)
  expect(x.view().snapshot!.coverage).toEqual(accepted.coverage)
  expect(x.view().error, 'An accurately failed current read needs a service action even while its frame is held').toBeTruthy()
  expect(x.view().error!.message).toContain('Exact native read temporarily unavailable')
  expect(x.view().observationError).toBeNull(); expect(x.host.textContent).toContain('Original selected body')
  x.hold(false); await act(async () => x.view().acceptHeld())
  expect(x.view().snapshot!.coverage.find(source => source.source.kind === 'native')!.current).toBe('unavailable')
  expect(x.view().error).toBeTruthy()
})
