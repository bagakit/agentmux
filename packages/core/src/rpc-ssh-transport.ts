import { mintObjectId } from './object-id.js'
import { spawn } from 'node:child_process'
import { AgentMuxError } from './errors.js'
import { parseRpcNativeResult } from './rpc-native-codec.js'
import { AgentMuxRpcStreamTransport } from './rpc-stream-transport.js'
export const AGENTMUX_RPC_SSH_TRANSPORT_BUDGET_MS = 30_000

/** Diagnose the exact superseded endpoint receipt without admitting it to the client. */
function validateEndpoint(value: unknown, socketPath?: string): void {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const result = value as Record<string, unknown>
    const endpoint = result.endpoint as Record<string, unknown> | undefined
    const shape = Object.keys(result).sort().join(',')
    if ((shape === 'endpoint,framing,protocol' ||
         shape === 'connection,endpoint,framing,protocol' && result.connection === 'responded') &&
        result.protocol === 'jsonrpc-2.0' && result.framing === 'json-lines' &&
        endpoint && typeof endpoint === 'object' && !Array.isArray(endpoint) &&
        Object.keys(endpoint).sort().join(',') === 'path,transport' && endpoint.transport === 'unix' &&
        typeof endpoint.path === 'string' && endpoint.path.startsWith('/') &&
        (socketPath === undefined || endpoint.path === socketPath)) {
      // The current validator checks every other field. This synthetic receipt is
      // diagnostic only: the original response is always refused below.
      parseRpcNativeResult('system.endpoint', { ...result, connection: 'responded', publication: null }, {})
      throw new AgentMuxError('The remote Core uses an older endpoint interface without current publication facts. Update this service in its connection settings.',
        'REMOTE_CORE_UPGRADE_REQUIRED')
    }
  }
  parseRpcNativeResult('system.endpoint', value, {})
}

/** A transport channel only. The existing JSONRPCClient/dispatcher retain RPC ownership. */
export class AgentMuxRpcSshTransport extends AgentMuxRpcStreamTransport {
  constructor(args: string[], onClose: () => void, socketPath?: string) {
    const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    super({ input: child.stdin, output: child.stdout, close: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill()
    } }, onClose, { budgetMs: AGENTMUX_RPC_SSH_TRANSPORT_BUDGET_MS,
      probe: { request: { jsonrpc: '2.0', id: mintObjectId(), method: 'system.endpoint', params: {} },
        validate: value => validateEndpoint(value, socketPath) } })
    child.stderr.resume()
    child.once('error', () => this.fail(new AgentMuxError('SSH RPC transport could not start.', 'CONTROL_UNAVAILABLE')))
    child.once('exit', () => this.fail(new AgentMuxError('SSH RPC transport exited; its owner and Runs were preserved.', 'CONTROL_UNAVAILABLE')))
  }
}
