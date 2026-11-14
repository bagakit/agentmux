import { AgentMuxError } from '@agentmux/core'
import { readOriginalMoteConfiguration } from './mote-resources.js'
import { parseHostConfigurations } from './host-configuration.js'

/** The original Host's configured topology, without creating a connection,
 * qualifying an executor, or borrowing another client's configuration writer. */
export async function readHostSettingsHosts(configurationPath: string | undefined) {
  if (!configurationPath) throw new AgentMuxError('The original Host configuration source is unavailable. Saved Spaces and healthy Agents are retained.', 'CONTROL_UNAVAILABLE')
  const raw = await readOriginalMoteConfiguration(configurationPath)
  const parsed = parseHostConfigurations(raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>).hosts : undefined)
  if (!parsed.success) throw new AgentMuxError('The original Hosts configuration is unreadable. Restore that source; existing Spaces, Sessions and input are retained.', 'CONTROL_UNAVAILABLE')
  return parsed.data
}
