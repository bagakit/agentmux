import type { JSONRPCRequest } from 'json-rpc-2.0'
import { setTimeout as delay } from 'node:timers/promises'
import { AgentMuxError } from './errors.js'
import { observeRead } from './observation-read.js'
import type { AgentMuxRpcRemoteEndpoint, AgentMuxTailcatTarget } from './public-rpc.js'
import { AGENTMUX_RPC_SSH_TRANSPORT_BUDGET_MS, AgentMuxRpcStdioProcessTransport } from './rpc-ssh-transport.js'
import type { RemoteTransportObservation } from './remote-transport-observation.js'

export function agentMuxRpcTailcatArguments(target: AgentMuxTailcatTarget): string[] {
  if (typeof target.address !== 'string' || !/^tc[A-Za-z0-9_-]+$/u.test(target.address) ||
      typeof target.keyFile !== 'string' || !target.keyFile || target.keyFile === 'new' ||
      !(target.keyFile.startsWith('/') || /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(target.keyFile)) || /[\0\r\n]/u.test(target.keyFile)) {
    throw new AgentMuxError('Tailcat requires a tc address and a saved client key name or absolute path.', 'INVALID_CONTROL_REQUEST')
  }
  return ['--key', target.keyFile, target.address]
}

/** Select one established stdio channel before admitting any business input.
 * A failure after admission ends its original readers. It never selects a second
 * route for those requests, even when their outcomes are unknown.
 */
export class AgentMuxRpcRemoteTransport {
  private readonly channels = new Set<AgentMuxRpcStdioProcessTransport>()
  private readonly selection: Promise<AgentMuxRpcStdioProcessTransport>
  private readonly activeRuntimes = new Map<string, number>()
  private healthObserver: AbortController | undefined
  private openPeer?: () => AgentMuxRpcStdioProcessTransport
  private selected?: AgentMuxRpcStdioProcessTransport
  private closed = false
  private observation: Omit<RemoteTransportObservation, 'observedAt'> = {
    state: 'connecting', transport: null, fallback: false, establishedAt: null
  }
  constructor(endpoint: AgentMuxRpcRemoteEndpoint, sshArgs: string[] | undefined, private readonly onClose: () => void) {
    const channel = (command: 'ssh' | 'tailcat', args: string[], socketPath?: string) => {
      this.openPeer = () => new AgentMuxRpcStdioProcessTransport(command, args, () => {}, socketPath)
      const value = new AgentMuxRpcStdioProcessTransport(command, args, () => {
        this.channels.delete(value)
        if (this.selected === value) {
          this.healthObserver?.abort()
          this.observation.state = 'disconnected'; this.onClose()
        }
      }, socketPath)
      this.channels.add(value)
      return value
    }
    this.selection = (async () => {
      let chosen: AgentMuxRpcStdioProcessTransport
      let transport: 'ssh' | 'tailcat' = endpoint.transport, fallback = false
      if (endpoint.transport === 'tailcat') chosen = channel('tailcat', agentMuxRpcTailcatArguments(endpoint))
      else {
        chosen = channel('ssh', sshArgs!, endpoint.socketPath)
        try { await chosen.establish() }
        catch (error) {
          if (this.closed || !endpoint.tailcat || !(error instanceof AgentMuxError) ||
              !['CONTROL_UNAVAILABLE', 'CONTROL_CONNECTION_FAILED', 'CONTROL_TIMEOUT'].includes(error.code)) throw error
          chosen.dispose()
          chosen = channel('tailcat', agentMuxRpcTailcatArguments(endpoint.tailcat))
          transport = 'tailcat'; fallback = true
        }
      }
      await chosen.establish()
      if (this.closed) throw new AgentMuxError('RPC connection was disposed before dispatch.', 'CONTROL_CANCELLED')
      if (!this.channels.has(chosen)) throw new AgentMuxError('The remote channel closed during establishment. Its owner and Runs were retained.', 'CONTROL_UNAVAILABLE')
      this.selected = chosen
      this.observation = { state: 'connected', transport, fallback, establishedAt: Date.now() }
      return chosen
    })()
    void this.selection.catch(() => { this.observation.state = 'disconnected'; this.onClose() })
  }
  private async observeHealth(channel: AgentMuxRpcStdioProcessTransport, signal: AbortSignal): Promise<void> {
    const budget = AGENTMUX_RPC_SSH_TRANSPORT_BUDGET_MS
    const probeSignal = () => AbortSignal.any([signal, AbortSignal.timeout(budget)])
    while (!signal.aborted) {
      const revision = channel.inboundRevision
      await delay(budget, undefined, { signal, ref: false })
      if (revision !== channel.inboundRevision || this.activeRuntimes.size !== 1) continue
      const runtimeId = this.activeRuntimes.keys().next().value!
      await channel.confirmsRuntime(runtimeId, probeSignal())
      if (signal.aborted || revision !== channel.inboundRevision) continue
      const peer = this.openPeer!()
      try {
        if (await peer.confirmsRuntime(runtimeId, probeSignal()) &&
            !signal.aborted && revision === channel.inboundRevision &&
            this.activeRuntimes.size === 1 && this.activeRuntimes.has(runtimeId)) {
          channel.fail(new AgentMuxError('The original RPC carrier stopped responding while the same Runtime remained reachable. Reconnect its original reader.', 'CONTROL_CONNECTION_FAILED'))
        }
      } finally { peer.dispose() }
    }
  }
  private watchRuntime(channel: AgentMuxRpcStdioProcessTransport, runtimeId?: string): () => void {
    if (runtimeId === undefined) return () => {}
    this.activeRuntimes.set(runtimeId, (this.activeRuntimes.get(runtimeId) ?? 0) + 1)
    if (!this.healthObserver) {
      const controller = new AbortController()
      this.healthObserver = controller
      void this.observeHealth(channel, controller.signal).catch(() => {}).finally(() => {
        if (this.healthObserver === controller) this.healthObserver = undefined
      })
    }
    let watching = true
    return () => {
      if (!watching) return
      watching = false
      const remaining = (this.activeRuntimes.get(runtimeId) ?? 1) - 1
      if (remaining > 0) this.activeRuntimes.set(runtimeId, remaining)
      else this.activeRuntimes.delete(runtimeId)
      if (!this.activeRuntimes.size) {
        this.healthObserver?.abort()
        this.healthObserver = undefined
      }
    }
  }
  /** Read only local carrier facts; never establish a channel or send a request. */
  remoteTransportObservation(): RemoteTransportObservation { return { ...this.observation, observedAt: Date.now() } }
  async open(request: JSONRPCRequest, receive: (frame: unknown) => void, end: (error?: Error) => void,
    signal: AbortSignal, dispatch: () => void, options: { cancelOpening?: boolean; runtimeId?: string } = {}): Promise<{ dispose(): Promise<void> }> {
    let channel: AgentMuxRpcStdioProcessTransport
    try { channel = await observeRead(this.selection, signal) }
    catch (error) {
      // Only establishment probes have been written. This original business
      // operation is certainly unwritten; no automatic retry is performed here.
      if (error instanceof AgentMuxError) throw new AgentMuxError(error.message, error.code, error.detail,
        { disposition: 'not_applied', confirmedInputBytes: null }, error.logId)
      throw error
    }
    const unwatch = this.watchRuntime(channel, options.runtimeId)
    try {
      const reader = await channel.open(request, receive, error => { unwatch(); end(error) }, signal, dispatch, options)
      return { dispose: async () => { unwatch(); await reader.dispose() } }
    } catch (error) { unwatch(); throw error }
  }
  dispose(): void {
    if (this.closed) return
    this.closed = true
    this.healthObserver?.abort()
    this.observation.state = 'disconnected'
    for (const channel of this.channels) channel.dispose()
    this.channels.clear()
  }
}
