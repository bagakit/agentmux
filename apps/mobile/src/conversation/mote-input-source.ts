import { parseAgentInputMoteSource, type AgentInputMoteSource } from '@agentmux/core/mote-input-source'
import type { MobileObjectIdentity } from '../navigation/MobileIdentity'

/** Original navigation reference only. The Host checks the actual Region binding and Mote. */
export function mobileMoteInputSource(identity: MobileObjectIdentity | null, recipient: string | null,
  identityRecipient: string | null): AgentInputMoteSource | undefined {
  const context = identity?.context
  if (!recipient || recipient !== identityRecipient || !identity?.mote || !context ||
      context.spaceId !== identity.mote.spaceId || !context.zoneId) return undefined
  try {
    return parseAgentInputMoteSource({ spaceId: context.spaceId, zoneId: context.zoneId,
      tabId: context.tabId, regionId: context.regionId })
  } catch { return undefined }
}
