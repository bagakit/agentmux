import { AgentMuxError } from '@agentmux/core'
import { readOriginalMoteConfiguration } from './mote-resources.js'

/** Read the original configuration for a new admission only. Existing operations retain their recovery. */
export async function assertPromotionEnabled(configurationPath: string): Promise<void> {
  let config: unknown
  try { config = await readOriginalMoteConfiguration(configurationPath) }
  catch { throw new AgentMuxError('The original Promotion settings are unreadable. Existing Agents and operations remain available.', 'PROMOTION_POLICY_UNCONFIRMED') }
  if (!config || typeof config !== 'object' || Array.isArray(config))
    throw new AgentMuxError('Promotion settings are unconfirmed. Existing Agents and promotion operations remain available.', 'PROMOTION_POLICY_UNCONFIRMED')
  const promotion = (config as { promotion?: unknown }).promotion
  if (promotion === undefined) return
  if (!promotion || typeof promotion !== 'object' || Array.isArray(promotion) || typeof (promotion as { enabled?: unknown }).enabled !== 'boolean')
    throw new AgentMuxError('The saved Promotion switch is unconfirmed. Inspect Promotion settings; original work and operations are retained.', 'PROMOTION_POLICY_UNCONFIRMED')
  // User-authored scope: refuse only a new promotion, never a healthy Agent or an existing operation.
  if (!(promotion as { enabled: boolean }).enabled)
    throw new AgentMuxError('New promotions are disabled. Enable Allow promotion in Settings → Promotion. Existing Motes and unfinished promotions remain available.', 'PROMOTION_DISABLED')
}
