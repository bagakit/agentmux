import type { AgentMuxControlSettingEntry } from '@agentmux/core'

/** Settings whose existing durable owner performs the read and write instead of ConfigOwner. */
export type OwnedSetting = {
  key: string
  unavailableCode: string
  inspect(): Promise<AgentMuxControlSettingEntry>
  apply(value: string, requestId: string): Promise<AgentMuxControlSettingEntry>
}
