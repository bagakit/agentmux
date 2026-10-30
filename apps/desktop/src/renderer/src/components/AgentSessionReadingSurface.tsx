import * as Dialog from '@agentmux/client-ui/components/Modal'
import { useCallback, type ReactNode } from 'react'
import type { SessionHistoryReference } from '../../../shared/contracts'
import { api } from '../lib/api'
import { ActivityView } from './ActivityView'
import { SessionLearningSurface } from './SessionLearningSurface'
import { DocumentOverlayPortal } from './WindowOverlayHost'
import '../styles/agent-session-action-surface.css'

/** Explicit action host; the original reader and learning controllers own their data. */
export function AgentSessionActionSurface({ title, description, returnTrigger, onClose, children }: {
  title: string; description: string; returnTrigger?: HTMLElement | null | undefined; onClose(): void; children: ReactNode
}) {
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}>
    <DocumentOverlayPortal component={Dialog.Portal}><Dialog.Overlay className="dialog-scrim" />
      <Dialog.Content className="dialog-surface agent-session-action-surface" onCloseAutoFocus={event => {
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

export function AgentSessionReadingSurface({ source, label, mode, returnTrigger, onClose }: {
  source: SessionHistoryReference; label: string; mode: 'history' | 'learn'; returnTrigger?: HTMLElement | null | undefined; onClose(): void
}) {
  const readResource = useCallback((input: Parameters<typeof api.sessions.historyResource>[1]) => api.sessions.historyResource(source, input), [source.hostId, source.agentSessionId])
  return <AgentSessionActionSurface title={mode === 'history' ? 'Conversation history' : 'Pass on experience'}
    description={`${label} · ${source.hostId}`} returnTrigger={returnTrigger} onClose={onClose}>
    {mode === 'history' ? <ActivityView sessionId={source.agentSessionId} executionHostId={source.hostId} capability="complete-events"
      conversationReading={{ reference: source, identity: JSON.stringify([source.hostId, source.agentSessionId]), enabled: true, opened: true, readCaptured: true }}
      readPastedImage={path => api.ui.readPastedImage(path)} readHistoryResource={readResource} />
      : <SessionLearningSurface source={source} label={label} active onClose={onClose} />}
  </AgentSessionActionSurface>
}
