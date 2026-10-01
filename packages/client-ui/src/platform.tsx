import { createContext, useContext, type ReactNode } from 'react'
import type { AgentProviderId } from '@agentmux/core'
import type { ConversationSenderDetails, ConversationSpeaker } from './lib/conversation-speaker.js'

export type ClientUiIconName = 'neutral' | 'working' | 'failed'

/** Client-owned IO and presentation. Nothing here discovers a Runtime or retains its facts. */
export type ClientUiPlatform = {
  /** A failed copy must call reportError and return false; success alone returns true. */
  copyText(text: string, reportError: (error: unknown) => void): Promise<boolean>
  overlayContainer(): HTMLElement | Element | DocumentFragment
  /** Register this editor with the host's focus policy; unregister when disabled or unmounted. */
  bindComposerFocus(element: HTMLElement, focus: () => boolean): () => void
  renderMessageAvatar(input: {
    speaker: ConversationSpeaker
    name: string
    providerId?: AgentProviderId | undefined
    project?: ConversationSenderDetails['project'] | undefined
  }): ReactNode
  renderProjectIcon(project: NonNullable<ConversationSenderDetails['project']>): ReactNode
  renderProjectLabel(project: NonNullable<ConversationSenderDetails['project']>): ReactNode
  renderIcon(name: ClientUiIconName, size: number): ReactNode
}

const PlatformContext = createContext<ClientUiPlatform | null>(null)

/** Each application supplies one explicit adapter; there is no Desktop or browser IO default. */
export function ClientUiProvider({ platform, children }: { platform: ClientUiPlatform; children: ReactNode }) {
  return <PlatformContext.Provider value={platform}>{children}</PlatformContext.Provider>
}

export function useClientUiPlatform(): ClientUiPlatform {
  const platform = useContext(PlatformContext)
  if (!platform) throw new Error('ClientUiProvider requires an explicit client platform adapter')
  return platform
}
