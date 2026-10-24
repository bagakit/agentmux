import { createContext, useContext, useMemo, type ReactNode } from 'react'
import type { AgentProviderId, DurableAgentMuxMessage } from '@agentmux/core'
import type { ConversationRef } from '@agentmux/core/conversation'
import type { AmuxObjectLinkTarget } from '@agentmux/core/sharing'
import type { BrowserInputImageReference } from '@agentmux/core/browser-input-context'
import type { ConversationSenderDetails, ConversationSpeaker } from './lib/conversation-speaker.js'
import type { NoteResource } from '@agentmux/core/notebook-catalog'

export type ClientUiIconName = 'neutral' | 'working' | 'failed'
export type ObjectLinkReference = { uri: string; target: AmuxObjectLinkTarget; label?: string }
export type CapsuleEmbedInput = { uri: string; capsuleId: string; title: string; visible: boolean; presentationKey?: string | undefined }
export type MarkdownDiagramInput = { code: string; language: 'mermaid' | 'dot' | 'gv' | 'drawio' | 'plantuml'; visible: boolean }
export type BrowserSelectionImageInput = { reference: BrowserInputImageReference; visible: boolean; interactive: boolean }
export type NoteImageInput = { resource: NoteResource | null; src: string; alt: string; title?: string }

/** Client-owned IO and presentation. Nothing here discovers a Runtime or retains its facts. */
export type ClientUiPlatform = {
  /** Current presentation document; moving a retained editor does not replace its state. */
  ownerDocument?: Document

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
  /** Read one original Inbox message at its recorded Host/participant. Never sends or acknowledges input. */
  readA2AMessage?(reference: ConversationRef, messageId: string): Promise<DurableAgentMuxMessage | null>
  /** Optional inline presentation of an exact Core object URI. The host owns facts and navigation. */
  renderObjectLink?(reference: ObjectLinkReference): ReactNode
  /** Explicit block-level Capsule embedding; the host owns native document isolation and lifecycle. */
  renderCapsuleEmbed?(input: CapsuleEmbedInput): ReactNode
  /** Optional transient diagram presentation. The host owns cancelable, isolated computation. */
  renderMarkdownDiagram?(input: MarkdownDiagramInput): ReactNode
  /** Original Note resource owns relative image reads; no inferred local filesystem. */
  renderNoteImage?(input: NoteImageInput): ReactNode
  /** Resolve an authored link against its original Note resource; false keeps it visible in place. */
  openNoteLink?(resource: NoteResource | null, href: string): Promise<boolean>
  /** Exact saved selection image. The host validates Host, confined path, hash and dimensions;
   * the shared reader never falls back to path-only local or network IO. */
  renderBrowserSelectionImage?(input: BrowserSelectionImageInput): ReactNode
}

const PlatformContext = createContext<ClientUiPlatform | null>(null)

export function useA2AMessageReader(): ClientUiPlatform['readA2AMessage'] {
  return useContext(PlatformContext)?.readA2AMessage
}

/** Standalone Markdown also works without a host adapter, retaining its original text. */
export function useObjectLinkRenderer(): ClientUiPlatform['renderObjectLink'] {
  return useContext(PlatformContext)?.renderObjectLink
}

export function useMarkdownDiagramRenderer(): ClientUiPlatform['renderMarkdownDiagram'] {
  return useContext(PlatformContext)?.renderMarkdownDiagram
}
export function useCapsuleEmbedRenderer(): ClientUiPlatform['renderCapsuleEmbed'] { return useContext(PlatformContext)?.renderCapsuleEmbed }
export function useNoteLinkOpener(): ClientUiPlatform['openNoteLink'] { return useContext(PlatformContext)?.openNoteLink }
export function useNoteImageRenderer(): ClientUiPlatform['renderNoteImage'] { return useContext(PlatformContext)?.renderNoteImage }

export function useBrowserSelectionImageRenderer(): ClientUiPlatform['renderBrowserSelectionImage'] {
  return useContext(PlatformContext)?.renderBrowserSelectionImage
}

/** Standalone Markdown has no implicit clipboard IO; preserve the adapter's receiver. */
export function useMarkdownCopyText(): ClientUiPlatform['copyText'] | undefined {
  const platform = useContext(PlatformContext)
  return useMemo(() => platform?.copyText ? platform.copyText.bind(platform) : undefined, [platform, platform?.copyText])
}

/** Optional presentation scope; standalone content can still observe its own DOM document. */
export function useClientUiOwnerDocument(): Document | undefined {
  return useContext(PlatformContext)?.ownerDocument
}

/** Each application supplies one explicit adapter; there is no Desktop or browser IO default. */
export function ClientUiProvider({ platform, children }: { platform: ClientUiPlatform; children: ReactNode }) {
  return <PlatformContext.Provider value={platform}>{children}</PlatformContext.Provider>
}

export function useClientUiPlatform(): ClientUiPlatform {
  const platform = useContext(PlatformContext)
  if (!platform) throw new Error('ClientUiProvider requires an explicit client platform adapter')
  return platform
}
