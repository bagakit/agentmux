export const DESKTOP_ACTION_ATTRIBUTE = 'data-agentmux-action'
export const DESKTOP_SESSION_ATTRIBUTE = 'data-agentmux-session-id'

export const DESKTOP_ACTIONS = {
  claimReusableTerminal: 'claim-reusable-terminal',
  openBrowser: 'open-browser',
  createNote: 'create-note'
} as const

export function desktopActionSelector(action: keyof typeof DESKTOP_ACTIONS): string {
  return `[${DESKTOP_ACTION_ATTRIBUTE}="${DESKTOP_ACTIONS[action]}"]`
}
