import * as Dialog from '@agentmux/client-ui/components/Modal'
import { useCallback, type ReactNode } from 'react'
import type { SessionHistoryReference } from '../../../shared/contracts'
import { api } from '../lib/api'
import { ActivityView } from './ActivityView'
import { DocumentOverlayPortal } from './WindowOverlayHost'

/** Explicit reading host; the original conversation reader owns its data. */
export function AgentSessionActionSurface({ title, description, returnTrigger, onClose, children, compact = false }: {
  title: string; description: string; returnTrigger?: HTMLElement | null | undefined; onClose(): void; children: ReactNode; compact?: boolean
}) {
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}>
    <DocumentOverlayPortal component={Dialog.Portal}><Dialog.Overlay className="dialog-scrim" />
      <Dialog.Content className="dialog-surface agent-session-action-surface" data-compact={compact || undefined} onCloseAutoFocus={event => {
        event.preventDefault()
        const focused = document.activeElement
        if (returnTrigger?.isConnected && (focused === document.body || focused instanceof HTMLElement && focused.closest('.agent-session-action-surface'))) returnTrigger.focus({ preventScroll: true })
      }}>
        <header className="agent-session-action-surface__heading"><div><Dialog.Title>{title}</Dialog.Title><Dialog.Description>{description}</Dialog.Description></div>
          <Dialog.Close className="icon-button" aria-label={`Close ${title}`}>×</Dialog.Close></header>
        <div className="agent-session-action-surface__body">{children}</div>
      </Dialog.Content>
    </DocumentOverlayPortal>
  </Dialog.Root>
}

export function AgentSessionReadingSurface({ source, label, returnTrigger, onClose, port }: {
  source: SessionHistoryReference; port?: typeof api.conversation; label: string; returnTrigger?: HTMLElement | null | undefined; onClose(): void
}) {
  const readResource = useCallback((input: Parameters<typeof api.sessions.historyResource>[1]) => api.sessions.historyResource(source, input), [source.hostId, source.agentSessionId])
  return <AgentSessionActionSurface title="Conversation history" description={`${label} · ${source.hostId}`} returnTrigger={returnTrigger} onClose={onClose}>
    <ActivityView sessionId={source.agentSessionId} executionHostId={source.hostId} capability="complete-events"
      conversationReading={{ reference: source, identity: JSON.stringify([source.hostId, source.agentSessionId]), enabled: true, opened: true, readCaptured: true, ...(port ? { port } : {}) }}
      {...(port ? {} : { readPastedImage: (path: string) => api.ui.readPastedImage(path), readHistoryResource: readResource })} />
  </AgentSessionActionSurface>
}
