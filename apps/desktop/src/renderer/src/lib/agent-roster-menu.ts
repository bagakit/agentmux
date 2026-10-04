import { Copy } from 'lucide-react'
import { formatSessionAddress } from './agent-address'

/** A semantic Agent link stays stable when its Views move or close. */
export type AgentRosterMenuAction = {
  key: 'copy-session'
  label: 'Copy Agent Link'
  icon: typeof Copy
  onSelect(): Promise<void>
}

export function agentRosterMenuActions(input: {
  sessionId: string
  writeClipboardText(text: string): Promise<void>
}): AgentRosterMenuAction[] {
  return [{
    key: 'copy-session',
    label: 'Copy Agent Link',
    icon: Copy,
    onSelect: async () => input.writeClipboardText(formatSessionAddress(input.sessionId))
  }]
}
