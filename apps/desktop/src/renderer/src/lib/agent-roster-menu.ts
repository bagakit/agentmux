import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { formatSessionAddress } from './agent-address'

const ThemeActionCopyIcon = semanticIconComponent('action.copy')


/** A semantic Agent link stays stable when its Views move or close. */
export type AgentRosterMenuAction = {
  key: 'copy-session'
  label: 'Copy Agent Link'
  icon: typeof ThemeActionCopyIcon
  onSelect(): Promise<void>
}

export function agentRosterMenuActions(input: {
  sessionId: string
  writeClipboardText(text: string): Promise<void>
}): AgentRosterMenuAction[] {
  return [{
    key: 'copy-session',
    label: 'Copy Agent Link',
    icon: ThemeActionCopyIcon,
    onSelect: async () => input.writeClipboardText(formatSessionAddress(input.sessionId))
  }]
}
