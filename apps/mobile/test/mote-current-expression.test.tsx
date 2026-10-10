import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxAgentSession } from '@agentmux/core'
import { parseRpcControlResult, rpcControlResult } from '../../../packages/core/src/rpc-business-codec'
import { currentMote, moteAppearanceSource } from '../../desktop/test/fixtures/mote-current-expression'
import { MobileIdentity, type MobileObjectIdentity } from '../src/navigation/MobileIdentity'
import { fixture, mount, mounted } from './conversation-fixture'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'

vi.mock('@agentmux/client-ui/mote-face-motion', () => ({ observeMoteMotion: () => ({ dispose() {} }) }))
let mono = 100, snapshot: Awaited<ReturnType<ReturnType<typeof moteAppearanceSource>['read']>>, value: ReturnType<typeof moteAppearanceSource>, identity: MobileObjectIdentity, session: AgentMuxAgentSession
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); vi.setSystemTime(_historyFixtureEpoch(0, 2000, 0))
  mono = 100; vi.spyOn(performance, 'now').mockImplementation(() => mono)
  value = moteAppearanceSource(currentMote()); snapshot = await value.read()
  identity = { name: value.topic.title, project: 'Original project', mote: { spaceId: value.target.key, appearance: snapshot.find(item => item.spaceId === value.target.key) } }
  const source = value.state.sessions[0]!
  session = { kind: 'agent', agentSessionId: source.id, hostId: source.hostId, providerId: source.providerId, executorId: source.executorId, workspacePath: source.workspacePath, run: source.control.run, retiredRuns: [], createdAt: _historyFixtureEpoch(0, 0, 1), updatedAt: _historyFixtureEpoch(0, 0, 2) }
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{ width: 32, height: 32 }] as unknown as DOMRectList)
})
afterEach(async () => { for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }; vi.useRealTimers(); vi.restoreAllMocks() })
function carrier(appearance = snapshot) {
  const wire = JSON.parse(JSON.stringify(rpcControlResult('space.ls', { operation: 'space.ls', catalog: { ...value.catalog, appearance } })))
  return parseRpcControlResult('space.ls', wire, { target: { spaceId: value.target.key }, presentation: true })
}
function setup() {
  const f = fixture(); f.sessions.set(session.agentSessionId, session)
  const rpc = vi.fn(async () => carrier()); f.client.forwardRpc = rpc as never
  return { ...f, rpc }
}
const current = (element: HTMLElement) => element.querySelector<HTMLElement>('[data-mote-expression]')!.dataset.moteExpression
async function elapsed(ms: number) { mono += ms; await act(async () => vi.advanceTimersByTimeAsync(ms)) }
it.each([-40_000_000, 70_000_000])('the real Mobile face ignores wall-clock offset %s and expires once without more reads', async offset => {
  const f = setup(), remaining = snapshot.find(item => item.spaceId === value.target.key)!.activities![0]!.activeForMs!
  vi.setSystemTime(Date.now() + offset)
  const view = await mount(<MobileIdentity identity={identity} session={session} client={f.client} connected />)
  expect(current(view.element)).toBe('thinking')
  const face = view.element.querySelector('.mote-face')!, reads = f.rpc.mock.calls.length
  await elapsed(remaining)
  expect(current(view.element)).toBe('unknown'); expect(f.rpc).toHaveBeenCalledTimes(reads)
  expect(view.element.querySelector('.mote-face')).toBe(face)
  expect(face.getAttribute('data-mote-face-palette')).toBe(identity.mote!.appearance!.parts!.palette)
  expect(f.submit).not.toHaveBeenCalled(); expect(f.readHistory).not.toHaveBeenCalled()
})
it('cached props cannot grant work and a response beyond its whole request RTT validity never starts working', async () => {
  const f = setup(); let release!: (value: ReturnType<typeof carrier>) => void
  f.rpc.mockImplementation(() => new Promise(resolve => { release = resolve }))
  const view = await mount(<MobileIdentity identity={identity} session={session} client={f.client} connected />)
  expect(current(view.element)).toBe('unknown'); expect(view.element.querySelector('.mote-face')).not.toBeNull()
  const remaining = snapshot.find(item => item.spaceId === value.target.key)!.activities![0]!.activeForMs!
  await elapsed(remaining + 10)
  await act(async () => release(carrier()))
  expect(current(view.element)).toBe('unknown'); expect(f.rpc).toHaveBeenCalledTimes(1)
})
it('missing metadata or another Host/Run cannot reuse work; saved face and input methods stay intact', async () => {
  const f = setup()
  for (const change of [{ hostId: 'other-host' }, { activeForMs: undefined }, { runId: 'retired-run' }]) {
    const appearance = snapshot.map(item => ({ ...item, activities: item.activities?.map(activity => Object.fromEntries(Object.entries({ ...activity, ...change }).filter(([, val]) => val !== undefined)) as never) }))
    f.rpc.mockResolvedValue(carrier(appearance))
    const view = await mount(<MobileIdentity identity={identity} session={session} client={f.client} connected />)
    expect(current(view.element)).toBe('unknown'); expect(view.element.querySelector('.mote-face')).not.toBeNull()
    await act(async () => mounted.at(-1)!.root.unmount()); mounted.pop()!.element.remove()
  }
  expect(f.submit).not.toHaveBeenCalled(); expect(f.respond).not.toHaveBeenCalled()
})
it('exact read failure stops work, unrelated Session events do not read, and foreground needs an actual new request', async () => {
  const f = setup(), view = await mount(<MobileIdentity identity={identity} session={session} client={f.client} connected />)
  expect(current(view.element)).toBe('thinking')
  const reads = f.rpc.mock.calls.length
  await act(async () => { for (let revision = 0; revision < 50; revision++) f.emit({ type: 'agent-timeline', agentSessionId: 'unrelated', revision }) })
  expect(f.rpc).toHaveBeenCalledTimes(reads)
  f.rpc.mockRejectedValue(new Error('Original appearance unavailable'))
  await act(async () => f.emit({ type: 'agent-timeline', agentSessionId: session.agentSessionId, revision: 2 }))
  expect(current(view.element)).toBe('unknown'); expect(view.element.querySelector('.mote-face')).not.toBeNull()
  f.rpc.mockResolvedValue(carrier())
  let hidden = true; vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  expect(current(view.element)).toBe('unknown')
  hidden = false; await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  expect(current(view.element)).toBe('thinking'); expect(f.rpc.mock.calls.length).toBeGreaterThan(reads)
  await view.render(<MobileIdentity identity={identity} session={session} client={f.client} connected={false} />)
  expect(current(view.element)).toBe('unknown'); expect(f.submit).not.toHaveBeenCalled()
})
it('a previous Run response cannot refresh a newer Run; unmount releases the deadline and observer', async () => {
  const f = setup(); let release!: (value: ReturnType<typeof carrier>) => void
  f.rpc.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const view = await mount(<MobileIdentity identity={identity} session={session} client={f.client} connected />)
  const next = { ...session, run: { runId: 'new-original-run' } }
  const newer = snapshot.map(item => ({ ...item, activities: item.activities?.map(activity => ({ ...activity, runId: next.run.runId })) }))
  f.rpc.mockResolvedValue(carrier(newer))
  await view.render(<MobileIdentity identity={identity} session={next} client={f.client} connected />)
  expect(current(view.element)).toBe('thinking')
  await act(async () => release(carrier()))
  expect(current(view.element)).toBe('thinking')
  await act(async () => mounted.at(-1)!.root.unmount()); mounted.pop()!.element.remove()
  expect(vi.getTimerCount()).toBe(0); expect(f.unsubscribe).toHaveBeenCalled()
})
