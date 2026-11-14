import { AgentMuxError } from './errors.js'
import { readControlJsonInput } from './cli-json-input.js'

/** Carriers only; the public owner validates the request, actor and approval. */
export async function parseSettingsHostMaintenanceCommand(args: readonly string[]): Promise<Record<string, unknown> | null> {
  const [resource, action] = args
  if (resource !== 'hosts' || !['maintenance-request', 'maintenance-inspect', 'maintenance-review'].includes(action ?? '')) return null
  if (action === 'maintenance-request' && args.length === 4 && args[2] === '--input') return await readControlJsonInput(args[3]!, 'Host maintenance') as Record<string, unknown>
  if (action === 'maintenance-inspect' && args.length === 4 && args[2] === '--operation-id' && args[3]?.length) return { operationId: args[3] }
  if (action === 'maintenance-review' && args.length === 6 && args[2] === '--operation-id' && args[3]?.length && args[4] === '--input') {
    const value = await readControlJsonInput(args[5]!, 'Host maintenance review')
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['requestDigest', 'decision'].includes(key))) throw new AgentMuxError('Review input requires only requestDigest and decision; its actor comes from the transport.', 'INVALID_CLI_ARGUMENT')
    return { ...value as Record<string, unknown>, operationId: args[3] }
  }
  throw new AgentMuxError('Use settings hosts maintenance-request --input FILE, maintenance-inspect --operation-id ID or maintenance-review --operation-id ID --input FILE.', 'INVALID_CLI_ARGUMENT')
}
