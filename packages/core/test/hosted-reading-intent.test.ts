import { fixturePath as upstreamFixturePath } from './helpers/fixture-values.js'
import { describe, expect, it, vi } from 'vitest'
import { AgentMuxError } from '../src/errors.js'
import { connectHostedAgentMux as SourceConnectHosted } from '../src/hosted-client.js'
import { encodeHostedValue, decodeHostedValue, hostedTransfer } from '../src/hosted-value.js'
import type { AgentMuxHostedBootstrap, AgentMuxHostedInvocation, AgentMuxHostedRpcPort } from '../src/hosted-client-contract.js'
import type { AgentMuxClientEvent, AgentMuxRunAttachment } from '../src/types.js'
const connectHostedAgentMux: typeof SourceConnectHosted = process.env.AGENTMUX_TEST_CLIENT_ENTRY
  ? (await import(/* @vite-ignore */ process.env.AGENTMUX_TEST_CLIENT_ENTRY)).connectHostedAgentMux : SourceConnectHosted


function attachment(runId: string): AgentMuxRunAttachment {
  return { run: { nativeService: null, runId, kind: 'terminal', providerId: null, executorId: null, agentSessionId: null,
    workspacePath: upstreamFixturePath("private-workspace"), pid: 421, state: 'running', cols: 80, rows: 24, observedAt: 1,
    latestOutputBytes: 4, acceptedInputBytes: 0 }, replay: [], gap: null, terminal: { type: 'not-requested' }, resizeRevision: 0 }
}
function fixture() {
  const identity: AgentMuxHostedBootstrap['identity'] = { instanceId: 'original-daemon', ownership: 'owned', hostId: 'local',
    buildIdentity: 'private-fixture', protocolVersion: 1, processId: 123 }
  const initial: AgentMuxHostedBootstrap = { identity, owner: { runtimeId: 'original-runtime', ownerInstanceId: 'original-owner', protocolVersion: 1, processId: 123, availability: 'connected', ctxmux: identity },
    storePath: upstreamFixturePath("private-store/sessions.json"), hostProcessId: 123, catalog: [], sessions: [], messageQueuePath: upstreamFixturePath("private-store/messages.ndjson") }
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
  return { port, calls, behavior, subscriptions,
    disconnect: () => { for (const subscription of subscriptions) subscription.closeTransport();
      [...subscriptions].reverse().find(value => value.method === 'runtime.events')!.handlers.onEnd?.(new AgentMuxError('Private Host observation interrupted.', 'CONTROL_UNAVAILABLE')) } }
}

describe('Hosted desired reading intent', () => {
  it('retains a failed remote release as unknown while reconnect only restores the other desired Run', async () => {
    const f = fixture(), client = await connectHostedAgentMux({ rpc: f.port })
    const events: AgentMuxClientEvent[] = []
    client.onEvent(event => events.push(event))
    await client.attachTerminal('closed-run', 0, 'raw')
    await client.attachTerminal('retained-run', 2, 'terminal')
    f.behavior.release = async () => { throw new AgentMuxError('The original release receipt is unavailable.', 'CONTROL_UNAVAILABLE') }
    await expect(client.releaseRunAttachment({ runId: 'closed-run' })).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
    f.disconnect(); await client.connect()
    expect(f.calls).toEqual([
      { method: 'runtimeProjection', args: [] },
      { method: 'attachTerminal', args: ['closed-run', 0, 'raw'] },
      { method: 'attachTerminal', args: ['retained-run', 2, 'terminal'] },
      { method: 'releaseRunAttachment', args: [{ runId: 'closed-run' }] },
      { method: 'runtimeProjection', args: [] },
      { method: 'refreshRunAttachment', args: [{ runId: 'retained-run' }, 4, 'terminal'] }
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
    f.disconnect()
    const reconnect = client.connect()
    await vi.waitFor(() => expect(f.behavior.refresh).toHaveBeenCalledTimes(1))
    const release = client.releaseRunAttachment({ runId: 'closed-run' })
    finish(attachment('closed-run'))
    await reconnect; await release
    expect(events.filter(event => event.type === 'terminal-snapshot')).toEqual([])
    expect(f.calls).toEqual([
      { method: 'runtimeProjection', args: [] },
      { method: 'attachTerminal', args: ['closed-run', 0, 'terminal'] },
      { method: 'runtimeProjection', args: [] },
      { method: 'refreshRunAttachment', args: [{ runId: 'closed-run' }, 4, 'terminal'] },
      { method: 'releaseRunAttachment', args: [{ runId: 'closed-run' }] }
    ])
    f.disconnect(); await client.connect()
    expect(f.behavior.refresh).toHaveBeenCalledTimes(1)
    expect(f.calls.at(-1)).toEqual({ method: 'runtimeProjection', args: [] })
    await client.dispose()
  })
})
