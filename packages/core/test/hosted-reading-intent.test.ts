import { fixturePath } from './helpers/fixture-values.js'
import { describe, expect, it, vi } from 'vitest'
import { pathToFileURL } from 'node:url'
import { AgentMuxError as SourceError } from '../src/errors.js'
import { connectHostedAgentMux as SourceConnectHosted } from '../src/hosted-client.js'
import { encodeHostedValue, decodeHostedValue, hostedTransfer } from '../src/hosted-value.js'
import type { AgentMuxHostedBootstrap, AgentMuxHostedInvocation, AgentMuxHostedRpcPort } from '../src/hosted-client-contract.js'
import type { AgentMuxClientEvent, AgentMuxRunAttachment } from '../src/types.js'
const connectHostedAgentMux: typeof SourceConnectHosted = process.env.AGENTMUX_TEST_CLIENT_ENTRY
  ? (await import(/* @vite-ignore */ process.env.AGENTMUX_TEST_CLIENT_ENTRY)).connectHostedAgentMux : SourceConnectHosted
const AgentMuxError: typeof SourceError = process.env.AGENTMUX_TEST_CLIENT_ENTRY
  ? (await import(/* @vite-ignore */ new URL('./errors.js', pathToFileURL(process.env.AGENTMUX_TEST_CLIENT_ENTRY)).href)).AgentMuxError : SourceError


function attachment(runId: string): AgentMuxRunAttachment {
  return { run: { nativeService: null, runId, kind: 'terminal', providerId: null, executorId: null, agentSessionId: null,
    workspacePath: fixturePath("private-workspace"), pid: 421, state: 'running', cols: 80, rows: 24, observedAt: 1,
    latestOutputBytes: 4, acceptedInputBytes: 0 }, replay: [], gap: null, terminal: { type: 'not-requested' }, resizeRevision: 0 }
}
function fixture() {
  const identity: AgentMuxHostedBootstrap['identity'] = { instanceId: 'original-daemon', ownership: 'owned', hostId: 'local',
    buildIdentity: 'private-fixture', protocolVersion: 1, processId: 123 }
  const initial: AgentMuxHostedBootstrap = { identity, owner: { runtimeId: 'original-runtime', ownerInstanceId: 'original-owner', protocolVersion: 1, processId: 123, availability: 'connected', ctxmux: identity },
    storePath: fixturePath("private-store/sessions.json"), hostProcessId: 123, catalog: [], sessions: [], messageQueuePath: fixturePath("private-store/messages.ndjson") }
  const subscriptions: Array<{ method: string; handlers: Parameters<AgentMuxHostedRpcPort['subscribe']>[2]; closeTransport(): void }> = []
  const calls: AgentMuxHostedInvocation[] = []
  const behavior: {
    release?: () => Promise<void>
    refresh?: (invocation: Extract<AgentMuxHostedInvocation, { method: 'refreshRunAttachment' }>) => Promise<AgentMuxRunAttachment>
  } = {}
  // Only the public port collaborator is controlled. The actual Hosted SDK owns all
  // reconnect and desired-reading behavior; no Run or Core is started by this fixture.
  const port = {
    call: async (method: string, params: unknown) => {
      if (method === 'runtime.owner.identity') return { owner: initial.owner }
      if (method === 'runtime.bootstrap') return initial
      if (method === 'runtime.release-consumer') return { released: true }
      if (method !== 'runtime.invoke') throw new Error(`Unexpected fixture port method: ${method}`)
      const invocation = decodeHostedValue(JSON.parse(JSON.stringify((params as { invocation: unknown }).invocation))) as AgentMuxHostedInvocation
      calls.push(invocation)
      let value: unknown
      if (invocation.method === 'runtimeProjection') value = { hostId: 'local', subjects: [] }
      else if (invocation.method === 'attachTerminal') value = attachment(invocation.args[0])
      else if (invocation.method === 'refreshRunAttachment') value = await behavior.refresh?.(invocation) ?? attachment(invocation.args[0].runId)
      else if (invocation.method === 'releaseRunAttachment') await behavior.release?.()
      else throw new Error(`Unexpected business method: ${invocation.method}`)
      return { value: encodeHostedValue(value) }
    },
    subscribe: async (method: string, params: unknown, handlers: Parameters<AgentMuxHostedRpcPort['subscribe']>[2]) => {
      let closed = false
      const transferId = crypto.randomUUID()
      const data = params as { target?: { runId: string }; afterByte?: number; view?: 'raw' | 'terminal'; refresh?: boolean }
      let value: unknown = initial
      if (method === 'runtime.attachment-watch') {
        const runId = data.target!.runId
        if (data.refresh) {
          const invocation: Extract<AgentMuxHostedInvocation, { method: 'refreshRunAttachment' }> = { method: 'refreshRunAttachment', args: [{ runId }, data.afterByte!, data.view!] }
          calls.push(invocation)
          value = await behavior.refresh?.(invocation) ?? attachment(runId)
        } else {
          calls.push({ method: 'attachTerminal', args: [runId, data.afterByte!, data.view!] })
          value = attachment(runId)
        }
      } else if (method !== 'runtime.events') throw new Error(`Unexpected actual Hosted subscription: ${method}`)
      subscriptions.push({ method, handlers, closeTransport: () => { closed = true } })
      handlers.onInitial({ owner: initial.owner, transferId })
      for (const chunk of hostedTransfer({ kind: 'initial', value }, transferId)) handlers.onEvent({ type: 'snapshot', data: chunk })
      return { dispose: async () => {
        if (closed) return
        closed = true
        if (method === 'runtime.attachment-watch') {
          calls.push({ method: 'releaseRunAttachment', args: [{ runId: data.target!.runId }] })
          await behavior.release?.()
        }
      } }
    }
  } as AgentMuxHostedRpcPort
  return { port, calls, behavior, subscriptions, initial,
    disconnect: (readersFirst = false) => { for (const subscription of subscriptions) subscription.closeTransport();
      if (readersFirst) for (const subscription of subscriptions.filter(value => value.method === 'runtime.attachment-watch')) subscription.handlers.onEnd?.();
      [...subscriptions].reverse().find(value => value.method === 'runtime.events')!.handlers.onEnd?.(new AgentMuxError('Private Host observation interrupted.', 'CONTROL_UNAVAILABLE')) } }
}

describe('Hosted desired reading intent', () => {
  it('settles the exact reader notice after owner restart even when its reader closes before the endpoint observation', async () => {
    const f = fixture(), client = await connectHostedAgentMux({ rpc: f.port })
    const events: AgentMuxClientEvent[] = []
    client.onEvent(event => events.push(event))
    const original = await client.attachTerminal('retained-run', 2, 'terminal')
    expect(original.run).toMatchObject({ runId: 'retained-run', pid: 421, state: 'running' })
    f.disconnect(true)
    expect(events.filter(event => event.type === 'attachment-state')).toEqual([
      expect.objectContaining({ state: 'unavailable', run: { runId: 'retained-run' }, afterByte: 4,
        diagnostic: expect.objectContaining({ code: 'RUNTIME_ATTACHMENT_UNAVAILABLE' }) })
    ])
    expect(events.filter(event => event.type === 'connection-state').map(event => event.state)).toEqual(['lost'])
    // Replace only the semantic owner process; the durable Runtime and original Run remain.
    f.initial.owner.ownerInstanceId = 'restarted-owner'; f.initial.owner.processId = 456
    await client.connect()
    const restored = events.filter(event => event.type === 'attachment-state')
    expect(restored).toEqual([
      expect.objectContaining({ state: 'unavailable', run: { runId: 'retained-run' } }),
      expect.objectContaining({ state: 'restored', run: { runId: 'retained-run' }, afterByte: 4 })
    ])
    expect(events.filter(event => event.type === 'agent-error'), 'reader workflow cannot leave a generic Agent error').toEqual([])
    expect(events.filter(event => event.type === 'terminal-snapshot')).toEqual([
      { type: 'terminal-snapshot', ...attachment('retained-run'), afterByte: 4 }
    ])
    expect(events.filter(event => event.type === 'connection-state').map(event => event.state)).toEqual(['lost', 'restored'])
    expect(client.runtimeOwnerIdentity()).toMatchObject({ runtimeId: 'original-runtime', ownerInstanceId: 'restarted-owner', availability: 'connected' })
    expect(f.calls).toEqual([
      { method: 'runtimeProjection', args: [] }, { method: 'attachTerminal', args: ['retained-run', 2, 'terminal'] },
      { method: 'refreshRunAttachment', args: [{ runId: 'retained-run' }, 4, 'terminal'] }, { method: 'runtimeProjection', args: [] }
    ])
    await client.dispose()
  })

  it('keeps a protocol failure scoped and visible until that Run attachment succeeds, independently of endpoint recovery', async () => {
    const f = fixture(), client = await connectHostedAgentMux({ rpc: f.port })
    const events: AgentMuxClientEvent[] = []
    client.onEvent(event => events.push(event))
    await client.attachTerminal('failed-run', 0, 'terminal')
    await client.attachTerminal('healthy-run', 0, 'terminal')
    const reader = f.subscriptions.find(value => value.method === 'runtime.attachment-watch')!
    // Original typed bytes carry a real cursor discontinuity on this one reader.
    const invalid: AgentMuxClientEvent = { type: 'terminal-output', run: { runId: 'failed-run' }, data: 'x', dataBytes: Uint8Array.of(120),
      evidence: { source: 'terminal-output', observedAt: 2, run: { runId: 'failed-run' }, outputByteRange: { startByte: 5, endByte: 6 } } }
    for (const data of hostedTransfer({ kind: 'event', event: invalid }, 'invalid-cursor')) reader.handlers.onEvent({ type: 'snapshot', data })
    expect(events.filter(event => event.type === 'attachment-state')).toEqual([
      expect.objectContaining({ state: 'unavailable', run: { runId: 'failed-run' }, afterByte: 4,
        diagnostic: expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR', message: expect.stringContaining('unreported byte Gap') }) })
    ])
    expect(events.filter(event => event.type === 'connection-state')).toEqual([])
    expect(client.runtimeOwnerIdentity()?.availability).toBe('connected')
    await vi.waitFor(() => expect(events.filter(event => event.type === 'attachment-state').map(event => event.state)).toEqual(['unavailable', 'restored']))
    // A second failure exhausts only this reader's one automatic reread, leaving its notice.
    const current = f.subscriptions.filter(value => value.method === 'runtime.attachment-watch').at(-1)!
    for (const data of hostedTransfer({ kind: 'event', event: invalid }, 'invalid-again')) current.handlers.onEvent({ type: 'snapshot', data })
    f.behavior.refresh = async invocation => {
      if (invocation.args[0].runId === 'failed-run') throw new AgentMuxError('Original reader transfer is still invalid.', 'CONTROL_PROTOCOL_ERROR')
      return attachment(invocation.args[0].runId)
    }
    f.disconnect(); await client.connect()
    expect(events.filter(event => event.type === 'connection-state').map(event => event.state)).toEqual(['lost', 'restored'])
    expect(events.filter(event => event.type === 'attachment-state' && event.run.runId === 'failed-run').at(-1),
      'endpoint restoration cannot settle an unconfirmed Run reader').toMatchObject({ state: 'unavailable', diagnostic: { code: 'CONTROL_PROTOCOL_ERROR' } })
    expect(events.filter(event => event.type === 'attachment-state' && event.run.runId === 'healthy-run')).toEqual([])
    delete f.behavior.refresh
    await client.refreshRunAttachment({ runId: 'failed-run' }, 4, 'terminal', 'confirmed-reader-refresh-before-late-failure')
    const liveBeforeRelease = f.subscriptions.filter(value => value.method === 'runtime.attachment-watch').at(-1)!
    for (const data of hostedTransfer({ kind: 'event', event: invalid }, 'invalid-before-predecessor-release')) liveBeforeRelease.handlers.onEvent({ type: 'snapshot', data })
    // The new lease can fail after its valid initial cut, while the previous
    // reader's release is still pending. Its initial data cannot clear this failure.
    let releasePrevious!: () => void, holdOnce = true
    f.behavior.release = async () => {
      if (!holdOnce) return
      holdOnce = false
      await new Promise<void>(resolve => { releasePrevious = resolve })
    }
    const interruptedRefresh = client.refreshRunAttachment({ runId: 'failed-run' }, 4, 'terminal', 'late-failed-observation-refresh')
    void interruptedRefresh.catch(() => {})
    await vi.waitFor(() => expect(releasePrevious).toBeTypeOf('function'))
    const pendingReader = f.subscriptions.filter(value => value.method === 'runtime.attachment-watch').at(-1)!
    for (const data of hostedTransfer({ kind: 'event', event: invalid }, 'invalid-during-predecessor-release')) pendingReader.handlers.onEvent({ type: 'snapshot', data })
    releasePrevious()
    const interrupted = await interruptedRefresh.then(value => ({ value }), error => ({ error }))
    expect(interrupted, 'a failed new lease cannot return a successful observation receipt').toMatchObject({ error: { code: 'CONTROL_PROTOCOL_ERROR' } })
    expect(events.filter(event => event.type === 'attachment-state' && event.run.runId === 'failed-run').at(-1)).toMatchObject({ state: 'unavailable', diagnostic: { code: 'CONTROL_PROTOCOL_ERROR' } })
    delete f.behavior.release
    await client.refreshRunAttachment({ runId: 'failed-run' }, 4, 'terminal', 'explicit-observation-refresh')
    expect(events.filter(event => event.type === 'attachment-state' && event.run.runId === 'failed-run').at(-1)).toMatchObject({ state: 'restored', afterByte: 4 })
    expect(events.filter(event => event.type === 'agent-error')).toEqual([])
    expect(f.calls.filter(call => !['runtimeProjection', 'attachTerminal', 'refreshRunAttachment', 'releaseRunAttachment'].includes(call.method))).toEqual([])
    await client.dispose()
  })

  it('retains a failed remote release as unknown while reconnect only restores the other desired Run', async () => {
    const f = fixture(), client = await connectHostedAgentMux({ rpc: f.port })
    const events: AgentMuxClientEvent[] = []
    client.onEvent(event => events.push(event))
    await client.attachTerminal('closed-run', 0, 'raw')
    await client.attachTerminal('retained-run', 2, 'terminal')
    f.behavior.release = async () => { throw new AgentMuxError('The original release receipt is unavailable.', 'CONTROL_UNAVAILABLE') }
    await expect(client.releaseRunAttachment({ runId: 'closed-run' })).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
    f.disconnect(true); await client.connect()
    expect(f.calls).toEqual([
      { method: 'runtimeProjection', args: [] },
      { method: 'attachTerminal', args: ['closed-run', 0, 'raw'] },
      { method: 'attachTerminal', args: ['retained-run', 2, 'terminal'] },
      { method: 'releaseRunAttachment', args: [{ runId: 'closed-run' }] },
      { method: 'refreshRunAttachment', args: [{ runId: 'retained-run' }, 4, 'terminal'] },
      { method: 'runtimeProjection', args: [] }
    ])
    expect(events.filter(event => event.type === 'terminal-snapshot')).toEqual([
      { type: 'terminal-snapshot', ...attachment('retained-run'), afterByte: 4 }
    ])
    await client.dispose()
  })

  it('does not publish a late refresh response after release withdrew that exact desired reading during reconnect', async () => {
    const f = fixture(), client = await connectHostedAgentMux({ rpc: f.port })
    const events: AgentMuxClientEvent[] = []
    client.onEvent(event => events.push(event))
    await client.attachTerminal('closed-run', 0, 'terminal')
    let finish!: (value: AgentMuxRunAttachment) => void
    f.behavior.refresh = vi.fn(async () => await new Promise<AgentMuxRunAttachment>(resolve => { finish = resolve }))
    f.disconnect(true)
    const reconnect = client.connect()
    await vi.waitFor(() => expect(f.behavior.refresh).toHaveBeenCalledTimes(1))
    const release = client.releaseRunAttachment({ runId: 'closed-run' })
    finish(attachment('closed-run'))
    await reconnect; await release
    expect(events.filter(event => event.type === 'terminal-snapshot')).toEqual([])
    expect(f.calls).toEqual([
      { method: 'runtimeProjection', args: [] },
      { method: 'attachTerminal', args: ['closed-run', 0, 'terminal'] },
      { method: 'refreshRunAttachment', args: [{ runId: 'closed-run' }, 4, 'terminal'] },
      { method: 'runtimeProjection', args: [] },
      { method: 'releaseRunAttachment', args: [{ runId: 'closed-run' }] }
    ])
    f.disconnect(); await client.connect()
    expect(f.behavior.refresh).toHaveBeenCalledTimes(1)
    expect(f.calls.at(-1)).toEqual({ method: 'runtimeProjection', args: [] })
    await client.dispose()
  })
})
