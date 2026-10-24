import { ClientUiProvider, type ClientUiPlatform, type ConversationSenderDetails } from '@agentmux/client-ui'
import { lazy, Suspense, useMemo, type ReactNode } from 'react'
import { copyTextToClipboard } from '../lib/clipboard-copy'
import { useWorkbenchDocument } from '../lib/workbench-document'
import { desktopElementVisible } from '../lib/desktop-presentation'
import { useAppStore, compareAndSwapCapsuleQuestionEditor, flushCapsuleQuestionEditors } from '../store'
import { CapsuleQuestionEditorsContext, type CapsuleQuestionEditorPort } from '../lib/capsule-question-editors'
import { usePathDisplay } from '../hooks/usePathDisplay'
import { ConversationMessageAvatar } from './ConversationMessageAvatar'
import { ProjectIcon } from './ProjectIcon'
import { SemanticIcon } from './semantic-icons'
import { resolveOverlayContainer } from './WindowOverlayHost'
import { InlineObjectLink } from './InlineObjectLink'
import { openDesktopNoteLink } from '../lib/note-file-link'
import { NoteImageResource } from './NoteImageResource'
import { BrowserSelectionImage } from './BrowserSelectionImage'
import { ConversationCapsule } from './ConversationCapsule'
import { api } from '../lib/api'

const DiagramFilePreview = lazy(() => import('./file-preview/DiagramFilePreview').then(module => ({ default: module.DiagramFilePreview })))
const DotFilePreview = lazy(() => import('./file-preview/DotFilePreview').then(module => ({ default: module.DotFilePreview })))
const DrawioFilePreview = lazy(() => import('./file-preview/DrawioFilePreview').then(module => ({ default: module.DrawioFilePreview })))

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
    observer = new (target.ownerDocument.defaultView?.MutationObserver ?? MutationObserver)(attempt)
    observer.observe(target.ownerDocument.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['inert'] })
  }
  const unsubscribe = useAppStore.subscribe((state, previous) => {
    if (state.regionCaretFocus !== previous.regionCaretFocus) update()
  })
  update()
  return () => { unsubscribe(); stopObserving() }
}

function SenderProject({ project }: { project: NonNullable<ConversationSenderDetails['project']> }) {
  const displayPath = usePathDisplay()
  const workspaces = useAppStore(state => state.config?.workspaces)
  const hostId = workspaces?.find(workspace => workspace.id === project.workspaceId)?.hostId
  return <small title={displayPath(project.path, hostId)}>{project.name}{project.branch ? ` · ${project.branch}` : ''}</small>
}

const capsuleQuestionEditors: CapsuleQuestionEditorPort = {
  get: key => useAppStore.getState().capsuleQuestionEditors[key],
  compareAndSwap: compareAndSwapCapsuleQuestionEditor,
  subscribe: changed => useAppStore.subscribe((state, previous) => {
    if (state.capsuleQuestionEditors !== previous.capsuleQuestionEditors) changed()
  }),
  flush: flushCapsuleQuestionEditors
}

const desktopPlatform: ClientUiPlatform = {
  copyText: copyTextToClipboard,
  overlayContainer: resolveOverlayContainer,
  bindComposerFocus: bindDesktopComposerFocus,
  renderMessageAvatar: input => <ConversationMessageAvatar {...input} />,
  renderProjectIcon: project => <ProjectIcon workspaceId={project.workspaceId} name={project.name} />,
  renderProjectLabel: project => <SenderProject project={project} />,
  renderIcon: (name, size) => <SemanticIcon name={`status.${name}`} size={size} />,
  readA2AMessage: async (reference, messageId, notificationId) => {
    const result = await api.sessions.readMessage(reference, messageId, notificationId)
    if (result.hostId !== reference.hostId) throw new Error('The original message Host could not be confirmed. The reference is retained.')
    return result.message
  },
  renderObjectLink: reference => <InlineObjectLink {...reference} />,
  renderCapsuleEmbed: input => <ConversationCapsule key={input.uri} {...input} />,
  openNoteLink: openDesktopNoteLink,
  renderNoteImage: input => <NoteImageResource {...input} />,
  renderBrowserSelectionImage: input => <BrowserSelectionImage {...input} />,
  renderMarkdownDiagram: ({ code, language, visible }) => <Suspense fallback={<span role="status">Preparing diagram…</span>}>
    {language === 'dot' || language === 'gv' ? <DotFilePreview content={code} visible={visible} />
      : language === 'drawio' ? <DrawioFilePreview content={code} visible={visible} />
      : <DiagramFilePreview kind={language} content={code} visible={visible} />}
  </Suspense>
}

/** Electron IO, the Desktop identity surface and its workface focus policy stay in this client. */
export function DesktopClientUiProvider({ children, document: presentationDocument }: { children: ReactNode; document?: Document }) {
  const contextDocument = useWorkbenchDocument()
  const ownerDocument = presentationDocument ?? contextDocument
  const platform = useMemo<ClientUiPlatform>(() => ({ ...desktopPlatform, ownerDocument,
    overlayContainer: () => resolveOverlayContainer(undefined, ownerDocument)
  }), [ownerDocument])
  return <CapsuleQuestionEditorsContext.Provider value={capsuleQuestionEditors}><ClientUiProvider platform={platform}>{children}</ClientUiProvider></CapsuleQuestionEditorsContext.Provider>
}
