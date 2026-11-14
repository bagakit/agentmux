import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentProviderRegistry } from '../../../packages/core/src/agent-provider'
import { createSpaceSessionsFixture } from '../../../packages/core/test/helpers/space-session-fixture'
import { createHostRouteInventoryFixture } from '../../../packages/core/test/helpers/host-route-inventory-fixture'
import { decodeHostedValue } from '../../../packages/core/src/hosted-value'
import { DEFAULT_CONFIG } from '../src/main/config-store'
import { spaceMemberTerminalSource } from '../src/renderer/src/lib/space-member-terminal'
import { spaceMountTransport } from './helpers/space-mount-fixture'
import type { SpaceMountMemberTarget } from '../src/shared/space-mount'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const effects = ['write', 'paste', 'resize'] as const
type Effect = typeof effects[number]
const nativeMethod = { write: 'writeAgent', paste: 'pasteAgent', resize: 'resizeTerminal' } as const

async function fixture() {
  const f = await createSpaceSessionsFixture(cleanup), sid = 'original-terminal-ack'
  f.d.core.providers.register(new AgentProviderRegistry().get('codex'))
  await f.b.put(sid)
  const session = await f.d.put(sid), admission = await f.admit('D-in-B', f.d.owner.runtimeId, sid, 'original-terminal-C')
  const subject = await f.d.core.runtimeSubject({ kind: 'agent-session', agentSessionId: sid })
  if (subject.kind !== 'agent') throw Error('Expected the original Agent subject')
  // Native Session resolution is a leaf; keep its original durable Core projection.
  vi.spyOn(f.d.core.metadata, 'resolveRaw').mockImplementation(async id => {
    const original = await f.d.core.readAgentSession(id)
    if (!original) throw Error('Expected the original durable Session')
    return original
  })
  const bytes = new TextEncoder().encode('Original terminal output\r\n')
  vi.spyOn(f.d.core, 'refreshRunAttachment').mockResolvedValue({ run: subject.run, gap: null, resizeRevision: 0,
    terminal: { type: 'unknown', reason: 'origin_unknown' }, replay: [{ type: 'data', runId: session.run.runId,
      startByte: 0, endByte: bytes.length, data: new TextDecoder().decode(bytes), dataBytes: bytes }] })
  vi.spyOn(f.d.core, 'releaseRunAttachment').mockResolvedValue()
  const ack = { runId: session.run.runId, appliedByteRange: { startByte: 0, endByte: 1 }, acceptedThroughByte: 1 }
  // Native observation and effects are controlled; the original public routes,
  // Main/IPC/Preload/Renderer and TerminalSessionSource remain production owners.
  const native = {
    write: vi.spyOn(f.d.core, 'writeAgent').mockResolvedValue(ack),
    paste: vi.spyOn(f.d.core, 'pasteAgent').mockResolvedValue(ack),
    resize: vi.spyOn(f.d.core, 'resizeTerminal').mockImplementation(async (_run, cols, rows) => ({ ...subject.run, cols, rows }))
  }
  const localWrite = vi.spyOn(f.b.core, 'writeAgent').mockRejectedValue(Error('Observer-local namesake must not receive input'))
  let afterReply: ((method: string) => void) | undefined
  const carrier = { forwardRpc: async (method: string, params: unknown, context?: unknown) => {
    const result = await f.b.rpc.call(method as never, params as never, context as never)
    const call = (params as { call?: { method: string; params: { invocation?: unknown } } }).call
    if (method === 'space.member.call' && call?.method === 'runtime.invoke') {
      afterReply?.((decodeHostedValue(call.params.invocation) as { method: string }).method)
    }
    return result
  }, subscribeRpc: f.b.rpc.subscribe.bind(f.b.rpc) }
  const main = spaceMountTransport(cleanup, [{ id: 'original-terminal-carrier', carrier: carrier as never }], structuredClone(DEFAULT_CONFIG))
  const target: SpaceMountMemberTarget = { hostId: 'original-terminal-carrier', target: { reference: f.reference,
    regionId: admission.address.regionId, runtimeId: f.d.owner.runtimeId, agentSessionId: sid, expectedRun: session.run,
    expectedAdmission: { kind: 'creation', operationId: admission.requestId } } }
  const surface = await main.api.member(target, () => {})
  cleanup.push(() => surface.dispose())
  const snapshot = await surface.call('read', {})
  const source = spaceMemberTerminalSource(surface, target.target, () => () => {})
  const attached = await source.sessions.attach(snapshot.control, 0)
  const invoke = (effect: Effect, signal?: AbortSignal) => signal
    ? surface.call(effect, effect === 'resize' ? { attachmentId: attached.attachmentId, cols: 101, rows: 29 }
      : effect === 'write' ? { data: 'x', source: 'user' } : { text: 'Original paste', terminalData: 'Original terminal paste' }, signal)
    : effect === 'write' ? source.sessions.write(snapshot.control, new Uint8Array([0x80]), 'terminal-protocol')
      : effect === 'paste' ? source.sessions.paste(snapshot.control, 'Original paste', 'Original terminal paste')
        : source.sessions.resize(attached.attachmentId, 101, 29)
  return { ...f, main, native, localWrite, target, surface, snapshot, source, invoke,
    afterReply(callback: typeof afterReply) { afterReply = callback },
    changeCarrier() { main.routes.set(target.hostId, { client: {} as never }) } }
}

it.each(effects)('preserves the original %s ACK when its configured carrier changes after the effect', async effect => {
  const f = await fixture()
  f.afterReply(method => { if (method === nativeMethod[effect]) f.changeCarrier() })
  await expect(f.invoke(effect)).resolves.toEqual(effect === 'resize' ? { cols: 101, rows: 29 } : undefined)
  expect(f.native[effect]).toHaveBeenCalledOnce()
  if (effect === 'write') expect(f.native.write.mock.calls[0]![0]).toMatchObject({ agentSessionId: f.target.target.agentSessionId,
    expectedRun: f.target.target.expectedRun, data: new Uint8Array([0x80]), source: 'terminal-protocol' })
  if (effect === 'paste') expect(f.native.paste.mock.calls[0]![0]).toMatchObject({ agentSessionId: f.target.target.agentSessionId,
    expectedRun: f.target.target.expectedRun, text: 'Original paste', terminalData: 'Original terminal paste' })
  if (effect === 'resize') expect(f.native.resize).toHaveBeenCalledExactlyOnceWith(f.target.target.expectedRun, 101, 29)
  expect(f.localWrite).not.toHaveBeenCalled()
})

it.each(effects)('preserves the original %s ACK when only its reply request is cancelled afterwards', async effect => {
  const f = await fixture(), request = new AbortController()
  f.afterReply(method => { if (method === nativeMethod[effect]) request.abort(Error('The reply reader closed after the ACK')) })
  await expect(f.invoke(effect, request.signal)).resolves.toEqual(effect === 'resize' ? { cols: 101, rows: 29 } : undefined)
  expect(f.native[effect]).toHaveBeenCalledOnce()
})

it.each(effects)('preserves the original %s ACK when its viewing surface closes afterwards', async effect => {
  const f = await fixture()
  f.afterReply(method => { if (method === nativeMethod[effect]) void f.surface.dispose() })
  await expect(f.invoke(effect)).resolves.toEqual(effect === 'resize' ? { cols: 101, rows: 29 } : undefined)
  expect(f.native[effect]).toHaveBeenCalledOnce()
})

it.each(effects)('rejects %s before its effect when the configured carrier already changed', async effect => {
  const f = await fixture(); f.changeCarrier()
  await expect(f.invoke(effect)).rejects.toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH' })
  expect(f.native[effect]).not.toHaveBeenCalled()
})

it.each(effects)('does not turn a genuinely lost %s response into an ACK or replay', async effect => {
  const f = await fixture()
  f.afterReply(method => { if (method === nativeMethod[effect]) throw Error('The original transport response was lost') })
  await expect(f.invoke(effect)).rejects.toThrow('The original transport response was lost')
  expect(f.native[effect]).toHaveBeenCalledOnce()
})

it('rejects another Run or Session before any original terminal input effect', async () => {
  const f = await fixture(), control = f.snapshot.control
  if (control.kind !== 'agent') throw Error('Expected original Agent control')
  await expect(f.source.sessions.write({ ...control, run: { runId: 'another-run' } }, 'wrong Run', 'user')).rejects.toThrow('another original Session or Run')
  await expect(f.source.sessions.paste({ ...control, agentSessionId: 'another-session' }, 'wrong Session', 'wrong Session')).rejects.toThrow('another original Session or Run')
  expect(f.native.write).not.toHaveBeenCalled(); expect(f.native.paste).not.toHaveBeenCalled()
})

it('rejects a changed original admission before any original terminal effect', async () => {
  const f = await fixture(), changed = { ...f.target, target: { ...f.target.target,
    expectedAdmission: { kind: 'creation' as const, operationId: 'another-C' } } }
  const surface = await mainSurface(f, changed)
  await expect(surface.call('write', { data: 'wrong admission', source: 'user' })).rejects.toMatchObject({ code: 'SPACE_MEMBER_ADMISSION_UNCONFIRMED' })
  expect(f.native.write).not.toHaveBeenCalled()
})

it('still requires the original receiver grant for a current viewer terminal write', async () => {
  const source = await createSpaceSessionsFixture(cleanup)
  source.b.owner.runtimeId = 'runtime-B'
  const h = await createHostRouteInventoryFixture(cleanup as Array<() => Promise<void>>, { spatialState: source.b.spatial,
    hostedRuntime: () => source.b.hosted, coreClients: () => [{ hostId: 'local', client: source.b.core }] })
  h.native.mockResolvedValue()
  const session = await h.original.client.readAgentSession('recipient')
  if (!session) throw Error('Expected the original recipient')
  const admission = await source.admit('collision', h.d.identity.runtimeId, session.agentSessionId, 'routed-terminal-C', h.route, h.original.root)
  const target: SpaceMountMemberTarget = { hostId: 'current-viewer-source', target: {
    reference: { ...source.reference, runtimeId: h.b.identity.runtimeId }, regionId: admission.address.regionId,
    runtimeId: h.d.identity.runtimeId, agentSessionId: session.agentSessionId, expectedRun: session.run,
    expectedAdmission: { kind: 'creation', operationId: admission.requestId } } }
  const scopes = ['runtime.owner.identity', 'runtime.invoke/writeAgent']
  await h.configure(h.b, [{ id: 'collision', route: h.route }], [h.grant('current-viewer-member', h.a.identity, h.b.identity, ['space.member.call'])])
  await h.configure(h.c, [], [h.grant('source-terminal', h.b.identity, h.d.identity, scopes)])
  await h.configure(h.d, [], [])
  const main = spaceMountTransport(cleanup, [{ id: target.hostId, carrier: { forwardRpc: h.rpc.call.bind(h.rpc), subscribeRpc: h.rpc.subscribe.bind(h.rpc) } }], structuredClone(DEFAULT_CONFIG))
  const surface = await main.api.member(target, () => {}); cleanup.push(() => surface.dispose())
  const write = vi.spyOn(h.original.client, 'writeAgent').mockResolvedValue({ runId: session.run.runId,
    appliedByteRange: { startByte: 0, endByte: 1 }, acceptedThroughByte: 1 })
  await expect(surface.call('write', { data: 'x', source: 'user' })).rejects.toMatchObject({ code: 'HOST_ROUTE_NOT_DELEGATED' })
  expect(write).not.toHaveBeenCalled()
  await h.configure(h.d, [], [h.grant('receiver-terminal', h.c.identity, h.d.identity, scopes)])
  await expect(surface.call('write', { data: 'x', source: 'user' })).resolves.toBeUndefined()
  expect(write).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ agentSessionId: session.agentSessionId, expectedRun: session.run }), expect.anything())
})

async function mainSurface(f: Awaited<ReturnType<typeof fixture>>, target: SpaceMountMemberTarget) {
  const surface = await f.main.api.member(target, () => {}); cleanup.push(() => surface.dispose()); return surface
}

it.each(['carrier', 'request'] as const)('still rejects a pure read after its %s changes', async changed => {
  const f = await fixture(), request = new AbortController()
  f.afterReply(method => { if (method === 'readAgentInputEpoch') {
    if (changed === 'carrier') f.changeCarrier(); else request.abort(Error('The pure read closed'))
  } })
  await expect(f.surface.call('inputEpoch', {}, request.signal)).rejects.toBeInstanceOf(Error)
  for (const effect of effects) expect(f.native[effect]).not.toHaveBeenCalled()
})

it('rejects an interaction inspection result after its original carrier changes', async () => {
  const f = await fixture()
  const inspect = vi.spyOn(f.d.core, 'inspectAgentInteractionOperation').mockResolvedValue(null)
  f.afterReply(method => { if (method === 'inspectAgentInteractionOperation') f.changeCarrier() })
  await expect(f.surface.call('inspectInteraction', { operationId: 'original-interaction' }))
    .rejects.toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH' })
  expect(inspect).toHaveBeenCalledExactlyOnceWith({ agentSessionId: f.target.target.agentSessionId, operationId: 'original-interaction' })
  for (const effect of effects) expect(f.native[effect]).not.toHaveBeenCalled()
})
