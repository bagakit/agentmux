import type { AgentMuxBrowserMode } from '@agentmux/core'
import type { ThemeBootstrap } from './theme-bootstrap.js'

export const BROWSER_POPUP_CHANNELS = {
  inspect: 'browser-popup:inspect',
  command: 'browser-popup:command',
  changed: 'browser-popup:changed',
  focusAddress: 'browser-popup:focus-address'
} as const

export interface BrowserPopupSnapshot {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
  error: string | null
  warning: string | null
  mode: AgentMuxBrowserMode
  theme: ThemeBootstrap | null
  appLinkPrompt: { id: string; url: string; scheme: string } | null
}

/** The trusted chrome selects an action, never a different native page. */
export type BrowserPopupCommand =
  | { kind: 'navigate'; address: string }
  | { kind: 'back' | 'forward' | 'reload' | 'stop' }
  | { kind: 'chrome-height'; height: number }
  | { kind: 'answer-app-link'; promptId: string; allow: boolean; remember: boolean }

export interface BrowserPopupAPI {
  inspect(): Promise<BrowserPopupSnapshot>
  command(command: BrowserPopupCommand): Promise<BrowserPopupSnapshot>
  onChanged(listener: (snapshot: BrowserPopupSnapshot) => void): () => void
  onFocusAddress(listener: () => void): () => void
}
