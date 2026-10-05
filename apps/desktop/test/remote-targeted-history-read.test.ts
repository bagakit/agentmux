import { fixtureIso as _hygiene_fixtureIso, fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxMemoryAgentSessionStore } from '../../../packages/core/src/agent-session-store.js'
import { nativeHistoryFixture, jsonl } from '../../../packages/core/test/fixtures/native-history-session.js'
import { RuntimeController } from '../src/main/runtime-controller.js'
import type { DesktopRuntimeClient } from '../src/main/desktop-host.js'
import type { AppConfig } from '../src/shared/contracts.js'
vi.mock('electron', () => ({ app: {}, nativeImage: {} }))
const closes: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0K8AAAAASUVORK5CYII='
async function fixture(unrelated = 0) {
  const f = await nativeHistoryFixture('claude', jsonl([{ uuid: 'original-record', type: 'user', sessionId: 'native-main',
    timestamp: _hygiene_fixtureIso(24537600000, "second"), message: { role: 'user', content: [
      { type: 'text', text: 'Original task' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.split(',')[1] } }
    ] } }]))
  closes.push(f.close)
  for (let n = 0; n < unrelated; n++) for (const kind of ['active', 'retired', 'reopen'] as const) {
    const id = `${kind}-${n}`, session = { ...f.session, agentSessionId: id, run: { runId: `run-${id}` }, hookBindingId: `binding-${id}`,
      nativeHandle: { ...f.session.nativeHandle!, sessionId: `native-${id}` } }
    await f.store.compareAndSwap(null, session)
    if (kind !== 'active') {
      const stop = { kind: 'stop' as const, reservationId: `stop-${id}`, ownerId: 'test-owner', ownerPid: process.pid,
        agentSessionId: id, expectedRun: session.run, operationId: `stop-${id}`, expiresAt: Date.now() + 60_000,
        stopOperation: { daemonInstance: 'test-native', operationKey: `stop-${id}`, runId: session.run.runId } }
      await f.store.reserveLifecycle(stop); await f.store.commitLifecycle(stop, null)
      if (kind === 'reopen') {
        const expectedRetirement = (await f.store.loadRetiredAgentSessions()).find(item => item.agentSessionId === id)!
        await f.store.reserveLifecycle({ kind: 'reopen', reservationId: `reopen-${id}`, ownerId: 'test-owner', ownerPid: process.pid,
          agentSessionId: id, expectedRetirement, operationId: `reopen-${id}`, expiresAt: Date.now() + 60_000 })
      }
    }
  }
  const host = { id: 'remote', kind: 'ssh' as const, label: 'Remote', hostname: 'target.invalid' }
  const main = new RuntimeController(new AgentMuxMemoryAgentSessionStore(), async () => { throw new Error('No substitute connection') })
  main.commit({ hosts: [{ id: host.id, config: host, client: f.client as unknown as DesktopRuntimeClient, executionHost: { kind: 'ssh', dispose: async () => {} } as never }],
    removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  closes.push(() => main.dispose())
  const config = { hosts: [host], executors: { claude: { label: 'Local template', providerId: 'claude', command: _hygiene_fixturePath("local/claude"),
    args: ['local-only'], env: { LOCAL_SECRET: 'never-forward' }, injectAgentMuxGuide: false } } } as unknown as AppConfig
  const control = { hostId: host.id, agentSessionId: f.session.agentSessionId }
  const resource = { source: { providerId: 'claude', nativeSessionId: 'native-main' }, recordId: 'original-record', partIndex: 1, expectedReference: image }
  const exact = vi.spyOn(f.store, 'readHistorySource')
  const catalogue = vi.spyOn(f.client, 'sessionHistorySources').mockRejectedValue(new Error('Unrelated directory unavailable'))
  const scans = [vi.spyOn(f.store, 'loadMetadata'), vi.spyOn(f.store, 'loadRetiredAgentSessions'), vi.spyOn(f.store, 'loadReopenCorrelations')]
  for (const scan of scans) scan.mockRejectedValue(new Error('Unrelated directory unavailable'))
  const connect = vi.spyOn(f.client, 'connect').mockRejectedValue(new Error('History must not connect Runtime'))
  return { ...f, main, host, config, control, resource, exact, catalogue, scans, connect }
}
it('Main reads only the requested remote SID with 1/16 unrelated active/retired/reopen records per kind at the same read cost', async () => {
  const counts: number[] = []
  for (const size of [1, 16]) {
    const f = await fixture(size)
    expect((await f.main.sessionTimeline(f.control)).agentSessionId).toBe(f.control.agentSessionId)
    const page = await f.main.sessionHistoryPage(f.control, { limit: 3 }, f.config)
    expect(page.items.map(item => item.id)).toEqual(['original-record'])
    const result = await f.main.sessionHistoryResource(f.control, f.resource, f.config)
    expect(result).toMatchObject({ agentSessionId: f.control.agentSessionId, recordId: 'original-record', reference: image, result: { status: 'unavailable', code: 'AGENT_SESSION_HISTORY_RECORD_UNSUPPORTED' } })
    const watch = await f.main.observeSessionHistory(f.control, () => {}, f.config, new AbortController().signal)
    expect(watch.source.nativeSessionId).toBe('native-main'); watch.dispose()
    counts.push(f.exact.mock.calls.length)
    expect(f.exact).toHaveBeenCalled()
    expect(new Set(f.exact.mock.calls.map(([id]) => id))).toEqual(new Set([f.control.agentSessionId]))
    expect(f.catalogue).not.toHaveBeenCalled(); for (const scan of f.scans) expect(scan).not.toHaveBeenCalled()
    expect(f.connect).not.toHaveBeenCalled(); for (const control of f.controls) expect(control).not.toHaveBeenCalled()
  }
  expect(counts[1]).toBe(counts[0])
})
it('lets the original Core reject an unknown SID without scanning or contacting another owner', async () => {
  const f = await fixture(), control = { ...f.control, agentSessionId: 'unknown' }
  const calls = [() => f.main.sessionTimeline(control), () => f.main.sessionHistoryPage(control, {}, f.config),
    () => f.main.sessionHistoryResource(control, f.resource, f.config),
    () => f.main.observeSessionHistory(control, () => {}, f.config, new AbortController().signal)]
  for (const call of calls) await expect(call()).rejects.toMatchObject({ code: 'UNKNOWN_AGENT_SESSION' })
  expect(f.catalogue).not.toHaveBeenCalled(); expect(f.exact.mock.calls.map(([id]) => id)).toEqual(['unknown', 'unknown', 'unknown', 'unknown'])
})
it.each(['timeline', 'page', 'resource'] as const)('rejects %s results after the captured Host changes during the actual Core read', async kind => {
  const f = await fixture()
  const replace = () => f.main.commit({ hosts: [{ id: f.host.id, config: { ...f.host, hostname: 'replacement.invalid' },
    client: { onEvent: () => () => {}, dispose: async () => {} } as never, executionHost: { kind: 'ssh', dispose: async () => {} } as never }],
    removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  if (kind === 'timeline') {
    const read = f.client.sessionTimeline.bind(f.client)
    vi.spyOn(f.client, 'sessionTimeline').mockImplementationOnce(async id => { const result = await read(id); replace(); return result })
    await expect(f.main.sessionTimeline(f.control)).rejects.toThrow('host configuration changed')
  } else if (kind === 'page') {
    const read = f.client.sessionHistoryPage.bind(f.client)
    vi.spyOn(f.client, 'sessionHistoryPage').mockImplementationOnce(async (id, input) => { const result = await read(id, input); replace(); return result })
    await expect(f.main.sessionHistoryPage(f.control, {}, f.config)).rejects.toThrow('host configuration changed')
  } else {
    const read = f.client.sessionHistoryResource.bind(f.client)
    vi.spyOn(f.client, 'sessionHistoryResource').mockImplementationOnce(async (id, input) => { const result = await read(id, input); replace(); return result })
    await expect(f.main.sessionHistoryResource(f.control, f.resource, f.config)).rejects.toThrow('host configuration changed')
  }
})
it('disposes a late actual Core observation when its caller cancels while acquisition finishes', async () => {
  const f = await fixture(), abort = new AbortController(), read = f.client.observeSessionHistory.bind(f.client)
  const disposed = vi.fn()
  vi.spyOn(f.client, 'observeSessionHistory').mockImplementationOnce(async (...args) => {
    const handle = await read(...args), dispose = handle.dispose.bind(handle)
    handle.dispose = () => { disposed(); dispose() }
    abort.abort(new Error('Original observer cancelled'))
    return handle
  })
  await expect(f.main.observeSessionHistory(f.control, () => {}, f.config, abort.signal)).rejects.toThrow('Original observer cancelled')
  expect(disposed).toHaveBeenCalledOnce()
})

it.each(['timeline', 'page'] as const)('rejects another Session in a %s response without changing the original Host', async kind => {
  const f = await fixture()
  if (kind === 'timeline') {
    const read = f.client.sessionTimeline.bind(f.client)
    vi.spyOn(f.client, 'sessionTimeline').mockImplementationOnce(async id => ({ ...await read(id), agentSessionId: 'foreign' }))
    await expect(f.main.sessionTimeline(f.control)).rejects.toThrow('another Session')
  } else {
    const read = f.client.sessionHistoryPage.bind(f.client)
    vi.spyOn(f.client, 'sessionHistoryPage').mockImplementationOnce(async (id, input) => ({ ...await read(id, input), agentSessionId: 'foreign' }))
    await expect(f.main.sessionHistoryPage(f.control, {}, f.config)).rejects.toThrow('another Session')
  }
})
