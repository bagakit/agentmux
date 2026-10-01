import { ClientUiProvider, type ClientUiPlatform } from '@agentmux/client-ui'
import type { ReactNode } from 'react'
import { copyTextToClipboard } from '../lib/clipboard-copy'
import { desktopElementVisible } from '../lib/desktop-presentation'
import { useAppStore } from '../store'
import { ConversationMessageAvatar } from './ConversationMessageAvatar'
import { ProjectIcon } from './ProjectIcon'
import { SemanticIcon } from './semantic-icons'
import { resolveOverlayContainer } from './WindowOverlayHost'

/** Focus intents are Desktop workface facts; a shared editor only registers its own DOM target. */
export function bindDesktopComposerFocus(target: HTMLElement, focus: () => boolean): () => void {
  let observer: MutationObserver | undefined
  const stopObserving = (): void => { observer?.disconnect(); observer = undefined }
  const update = (): void => {
    stopObserving()
    const intent = useAppStore.getState().regionCaretFocus
    const region = target.closest<HTMLElement>('[data-workbench-region-id]')
    if (!intent || region?.dataset.workbenchRegionId !== intent.regionId ||
        target.closest('[data-input-surface="terminal"]')) return
    const attempt = (): void => {
      if (useAppStore.getState().regionCaretFocus?.nonce !== intent.nonce) { stopObserving(); return }
      if (desktopElementVisible(target) && focus()) useAppStore.getState().clearRegionCaretFocus(intent.nonce)
      if (useAppStore.getState().regionCaretFocus?.nonce !== intent.nonce) stopObserving()
    }
    attempt()
    if (useAppStore.getState().regionCaretFocus?.nonce !== intent.nonce) return
    observer = new MutationObserver(attempt)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['inert'] })
  }
  const unsubscribe = useAppStore.subscribe((state, previous) => {
    if (state.regionCaretFocus !== previous.regionCaretFocus) update()
  })
  update()
  return () => { unsubscribe(); stopObserving() }
}

const desktopPlatform: ClientUiPlatform = {
  copyText: copyTextToClipboard,
  overlayContainer: resolveOverlayContainer,
  bindComposerFocus: bindDesktopComposerFocus,
  renderMessageAvatar: input => <ConversationMessageAvatar {...input} />,
  renderProjectIcon: project => <ProjectIcon workspaceId={project.workspaceId} name={project.name} />,
  renderIcon: (name, size) => <SemanticIcon name={name} size={size} />
}

/** Electron IO, the Desktop identity surface and its workface focus policy stay in this client. */
export function DesktopClientUiProvider({ children }: { children: ReactNode }) {
  return <ClientUiProvider platform={desktopPlatform}>{children}</ClientUiProvider>
}
