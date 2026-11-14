import * as Dialog from '@agentmux/client-ui/components/Modal'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { useRef } from 'react'
import { AgentMarkdown } from '@agentmux/client-ui/components/AgentMarkdown'
import { AGENT_EXECUTION_GUIDE } from '@agentmux/core/agent-execution-guide'
import type { DocumentationTarget } from './DocumentationNavigation'
import { DocumentOverlayPortal, markWindowOverlayDismissal } from '../WindowOverlayHost'
import { AmuxProtocolReference } from './AmuxProtocolReference'
import './documentation.css'

/** The original pane stays mounted below this read-only document. */
export function DocumentationOverlay({ opener, onClose, target = 'protocols' }: { opener: HTMLElement | null; onClose(): void; target?: DocumentationTarget }) {
  const remote = target === 'remote-execution'
  const content = useRef<HTMLDivElement>(null)
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}>
    <DocumentOverlayPortal component={Dialog.Portal}>
      <Dialog.Overlay className="dialog-scrim" />
      <Dialog.Content ref={content} className="documentation-dialog dialog-surface"
        onOpenAutoFocus={event => {
          const search = content.current?.querySelector<HTMLInputElement>('[data-documentation-search]')
          if (search) { event.preventDefault(); search.focus() }
        }}
        onCloseAutoFocus={event => {
          event.preventDefault()
          const document = opener?.ownerDocument, active = document?.activeElement
          if (opener?.isConnected && (active === document?.body || active === opener || !active?.isConnected || content.current?.contains(active))) opener.focus({ preventScroll: true })
        }}
        onEscapeKeyDown={markWindowOverlayDismissal}>
        <header className="documentation-dialog__header">
          <span className="documentation-dialog__symbol"><SemanticIcon name={remote ? 'object.document' : 'object.amux-protocols'} size={22} aria-hidden="true" /></span>
          <div><span className="documentation-dialog__eyebrow">Documentation</span><Dialog.Title>{remote ? 'Remote work guide' : 'amux Protocols'}</Dialog.Title>
            <Dialog.Description>{remote ? 'Project, Agent device and continuing original work. From this app version’s Core guide.' : 'Original text and readable cards from this app version’s protocol definitions.'}</Dialog.Description></div>
          <Dialog.Close className="icon-button" aria-label="Close documentation" title="Close documentation"><SemanticIcon name="action.close" size={16} /></Dialog.Close>
        </header>
        {remote ? <div className="documentation-guide"><AgentMarkdown content={AGENT_EXECUTION_GUIDE} documentMode readOnly visible /></div> : <AmuxProtocolReference active />}
      </Dialog.Content>
    </DocumentOverlayPortal>
  </Dialog.Root>
}
