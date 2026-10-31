import type { JSONRPCRequest } from 'json-rpc-2.0'
import { AgentMuxError } from './errors.js'
import { observeRead } from './observation-read.js'
import type { AgentMuxRpcRemoteEndpoint, AgentMuxTailcatTarget } from './public-rpc.js'
import { AgentMuxRpcStdioProcessTransport } from './rpc-ssh-transport.js'

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
  private selected?: AgentMuxRpcStdioProcessTransport
  private closed = false
  constructor(endpoint: AgentMuxRpcRemoteEndpoint, sshArgs: string[] | undefined, private readonly onClose: () => void) {
    const channel = (command: 'ssh' | 'tailcat', args: string[], socketPath?: string) => {
      const value = new AgentMuxRpcStdioProcessTransport(command, args, () => {
        this.channels.delete(value)
        if (this.selected === value) this.onClose()
      }, socketPath)
      this.channels.add(value)
      return value
    }
    this.selection = (async () => {
      let chosen: AgentMuxRpcStdioProcessTransport
      if (endpoint.transport === 'tailcat') chosen = channel('tailcat', agentMuxRpcTailcatArguments(endpoint))
      else {
        chosen = channel('ssh', sshArgs!, endpoint.socketPath)
        try { await chosen.establish() }
        catch (error) {
          if (this.closed || !endpoint.tailcat || !(error instanceof AgentMuxError) ||
              !['CONTROL_UNAVAILABLE', 'CONTROL_CONNECTION_FAILED', 'CONTROL_TIMEOUT'].includes(error.code)) throw error
          chosen.dispose()
          chosen = channel('tailcat', agentMuxRpcTailcatArguments(endpoint.tailcat))
        }
      }
      await chosen.establish()
      if (this.closed) throw new AgentMuxError('RPC connection was disposed before dispatch.', 'CONTROL_CANCELLED')
      if (!this.channels.has(chosen)) throw new AgentMuxError('The remote channel closed during establishment. Its owner and Runs were retained.', 'CONTROL_UNAVAILABLE')
      this.selected = chosen
      return chosen
    })()
    void this.selection.catch(() => { this.onClose() })
  }
  async open(request: JSONRPCRequest, receive: (frame: unknown) => void, end: (error?: Error) => void,
    signal: AbortSignal, dispatch: () => void): Promise<{ dispose(): Promise<void> }> {
    let channel: AgentMuxRpcStdioProcessTransport
    try { channel = await observeRead(this.selection, signal) }
    catch (error) {
      // Only establishment probes have been written. This original business
      // operation is certainly unwritten; no automatic retry is performed here.
      if (error instanceof AgentMuxError) throw new AgentMuxError(error.message, error.code, error.detail,
        { disposition: 'not_applied', confirmedInputBytes: null }, error.logId)
      throw error
    }
    return await channel.open(request, receive, end, signal, dispatch)
  }
  dispose(): void {
    if (this.closed) return
    this.closed = true
    for (const channel of this.channels) channel.dispose()
    this.channels.clear()
  }
}
