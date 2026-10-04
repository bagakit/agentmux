import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { agentMuxRpcSshArguments } from './public-rpc-client.js'
import { AgentMuxError } from './errors.js'
import type { RemoteCoreUpgradeHost } from './remote-core-upgrade.js'

export type RemoteCoreMaintenanceMethod = 'runtime.owner.identity' | 'runtime.bootstrap' | 'runtime.owner.shutdown' | 'system.endpoint' | 'agent.inspect'
/** Maintenance discovery has its own finite protocol. It never admits an old
 * endpoint DTO into the normal client, nor delegates Agent input or Run lifecycle. */
export async function callRemoteCoreMaintenance(host: RemoteCoreUpgradeHost, method: RemoteCoreMaintenanceMethod,
  params: Record<string, unknown>): Promise<unknown> {
  if (host.kind !== 'ssh' || !host.remoteCommand || !host.remoteSocketPath) throw new AgentMuxError('An explicit SSH command and socket are required.', 'CORE_UPGRADE_UNAVAILABLE')
  const args = agentMuxRpcSshArguments({ transport: 'ssh', host: host.hostname, ...(host.user ? { user: host.user } : {}),
    ...(host.port ? { port: host.port } : {}), ...(host.identityFile ? { identityFile: host.identityFile } : {}),
    command: host.remoteCommand, socketPath: host.remoteSocketPath })
  return await new Promise((resolve, reject) => {
    const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const id = randomUUID(); let pending = ''; let settled = false
    const complete = (error?: Error, result?: unknown): void => {
      if (settled) return; settled = true; clearTimeout(timer)
      child.stdin.destroy(); child.kill('SIGTERM') // Own reader, never remote owner or Run.
      error ? reject(error) : resolve(result)
    }
    const timer = setTimeout(() => complete(new AgentMuxError('The maintenance response is unknown. Inspect the original operation before retrying.', 'CORE_UPGRADE_RESPONSE_UNKNOWN')), 20_000)
    child.stdout.setEncoding('utf8'); child.stderr.resume()
    child.stdin.on('error', () => complete(new AgentMuxError('The maintenance request pipe closed before confirmation. Inspect the original operation.', 'CORE_UPGRADE_RESPONSE_UNKNOWN')))
    child.stdout.on('error', () => complete(new AgentMuxError('The maintenance observation pipe failed. Inspect the original operation.', 'CORE_UPGRADE_RESPONSE_UNKNOWN')))
    child.stdout.on('data', (part: string) => {
      pending += part
      if (Buffer.byteLength(pending) > 8 * 1024 * 1024) return complete(new AgentMuxError('The maintenance observation exceeds its budget.', 'CORE_UPGRADE_UNAVAILABLE'))
      const end = pending.indexOf('\n'); if (end < 0) return
      try {
        const frame = JSON.parse(pending.slice(0, end)) as { jsonrpc?: unknown; id?: unknown; result?: unknown; error?: { message?: string; data?: { code?: string } } }
        if (frame.jsonrpc !== '2.0' || frame.id !== id || Object.hasOwn(frame, 'result') === Object.hasOwn(frame, 'error')) {
          return complete(new AgentMuxError('The maintenance response does not belong to this request.', 'CONTROL_PROTOCOL_ERROR'))
        }
        if (frame.error) complete(new AgentMuxError(frame.error.message ?? 'Remote maintenance request failed.', frame.error.data?.code ?? 'CORE_UPGRADE_UNAVAILABLE'))
        else complete(undefined, frame.result)
      } catch (error) { complete(error instanceof Error ? error : new Error(String(error))) }
    })
    child.on('error', error => complete(error))
    child.on('exit', () => complete(new AgentMuxError('The maintenance reader ended without a response. Inspect the original operation.', 'CORE_UPGRADE_RESPONSE_UNKNOWN')))
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}
