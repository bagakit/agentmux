import type { Socket } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { observeSpace, readSpaceSnapshot } from '../src/space-authority-stream.js'
import { AgentMuxError } from '../src/errors.js'
import type { AgentMuxRpcService } from '../src/public-rpc-service.js'
import type { SpaceSnapshot } from '../src/space-authority.js'
import { createSpaceSessionsFixture } from './helpers/space-session-fixture.js'

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  for (const release of cleanup.splice(0).reverse()) await release()
  vi.restoreAllMocks()
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}

it.each(['cancelled', 'admission-changed', 'admission-changed-release-failed'] as const)(
  '%s member startup preserves its peer on the original shared Unix socket', async scenario => {
    const f = await createSpaceSessionsFixture(cleanup)
    const session = await f.b.put('original-startup-member')
    const admission = await f.admit('local', f.b.owner.runtimeId, session.agentSessionId, 'original-startup-admission')
    const effects = (['createAgent', 'resumeAgent', 'restartAgent', 'stopAgent', 'submitAgentPrompt', 'writeAgent'] as const)
      .map(method => vi.spyOn(f.b.core, method))
    const peerFailures: Error[] = [], changes: SpaceSnapshot[] = []
    const peer = await observeSpace(f.b.rpc, { reference: f.reference }, {
      onChange: snapshot => { changes.push(snapshot) }, onError: error => { peerFailures.push(error) }
    })
    cleanup.push(() => peer.dispose())
    const server = f.b.server as unknown as { service: AgentMuxRpcService; sockets: Set<Socket> }
    expect(server.sockets.size).toBe(1)
    const socket = [...server.sockets][0]!
    const serviceSubscribe = server.service.subscribe.bind(server.service)
    const gate = deferred(), entered = deferred(), settled = deferred(), disposed = deferred()
    if (scenario === 'admission-changed-release-failed') {
      const hostedSubscribe = f.b.hosted.subscribe.bind(f.b.hosted)
      vi.spyOn(f.b.hosted, 'subscribe').mockImplementation(async (...args) => {
        const reader = await hostedSubscribe(...args)
        if (args[0] !== 'runtime.events') return reader
        return { ...reader, dispose: async () => {
          await reader.dispose()
          throw new AgentMuxError('The original reader release acknowledgement is unavailable.', 'CONTROL_UNAVAILABLE')
        } }
      })
    }
    // Only scheduling is controlled. Core/member validation, returned start,
    // subscription cancellation, framing and the physical writer stay real.
    vi.spyOn(server.service, 'subscribe').mockImplementation(async (...args) => {
      const sub = await serviceSubscribe(...args)
      if (args[0] !== 'space.member.watch') return sub
      return { ...sub,
        start: async () => {
          entered.resolve()
          await gate.promise
          try { await sub.start?.() } finally { settled.resolve() }
        },
        dispose: async () => { await sub.dispose(); disposed.resolve() }
      }
    })
    cleanup.push(() => gate.resolve())
    const memberErrors: Array<{ code: string; message: string }> = []
    const member = await f.b.rpc.subscribe('space.member.watch', {
      target: { reference: f.reference, regionId: admission.address.regionId, runtimeId: f.b.owner.runtimeId,
        agentSessionId: session.agentSessionId, expectedRun: session.run,
        expectedAdmission: { kind: 'creation', operationId: admission.requestId } },
      call: { method: 'runtime.events', params: { consumerId: 'original-startup-reader',
        fence: { runtimeId: f.b.owner.runtimeId, ownerInstanceId: f.b.owner.ownerInstanceId },
        sessions: 'full', agentSessionIds: [session.agentSessionId] } }
    }, { onInitial() {}, onEvent: event => { if (event.type === 'error') memberErrors.push(event.error) } })
    cleanup.push(() => member.dispose())
    await entered.promise // The real public opening ACK preceded this start gate.
    if (scenario === 'cancelled') {
      await member.dispose()
      await disposed.promise // Client-local release alone is not the server's receipt.
    } else {
      const snapshot = await readSpaceSnapshot(f.b.rpc, f.reference)
      await f.b.rpc.call('space.apply', { reference: f.reference, expectedRevision: snapshot.revision,
        changes: { remove: { tabs: [admission.address.tabId], regions: [admission.address.regionId] } } })
    }
    gate.resolve()
    await settled.promise
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(socket.destroyed, 'One original reader startup cannot close its healthy peer transport').toBe(false)
    expect(peerFailures, 'The already-live original Space reader must remain subscribed').toEqual([])
    if (scenario !== 'cancelled') {
      await vi.waitFor(() => expect(memberErrors.some(error => error.code === 'SPACE_MEMBER_ADMISSION_UNCONFIRMED')).toBe(true))
    }
    if (scenario === 'admission-changed-release-failed') {
      await vi.waitFor(() => expect(memberErrors.some(error => error.code === 'SPACE_MEMBER_ADMISSION_UNCONFIRMED' &&
        error.message.includes('Reader release could not be confirmed (CONTROL_UNAVAILABLE)') &&
        error.message.includes('The original reader release acknowledgement is unavailable.'))).toBe(true))
    }
    const snapshot = await readSpaceSnapshot(f.b.rpc, f.reference)
    const branch = 'peer-after-' + scenario
    await f.b.rpc.call('space.apply', { reference: f.reference, expectedRevision: snapshot.revision,
      changes: { zones: [{ ...snapshot.scope.zones[0]!, branch }] } })
    await vi.waitFor(() => expect(changes.some(value => value.scope.zones.some(zone => zone.branch === branch))).toBe(true))
    expect(peerFailures).toEqual([])
    expect([...server.sockets], 'A new connection cannot substitute for surviving the original channel').toEqual([socket])
    expect((await f.b.core.readAgentSession(session.agentSessionId))!.run).toEqual(session.run)
    for (const effect of effects) expect(effect).not.toHaveBeenCalled()
  }, 15000
)
