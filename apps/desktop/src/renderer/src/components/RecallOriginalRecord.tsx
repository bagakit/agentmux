import { useEffect, useMemo, useState } from 'react'
import * as Dialog from '@agentmux/client-ui/components/Modal'
import { conversationMessageSourceKey } from '@agentmux/client-ui/conversation-message-location'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { RecallCard } from '@agentmux/core/notebook-observation'
import { ActivityView } from './ActivityView'
import { DocumentOverlayPortal } from './WindowOverlayHost'
import type { ConversationRevealRequest } from '../lib/mailbox-message-navigation'

const Close = semanticIconComponent('action.close')

/** Reopen the same original reader when there is no confirmed current Session workface. */
export function RecallOriginalRecord({ card, onClose }: { card: RecallCard; onClose: () => void }) {
  const [issue, setIssue] = useState<string | null>(null)
  const [located, setLocated] = useState(false)
  const [controller, setController] = useState<AbortController | null>(null)
  useEffect(() => {
    const current = new AbortController()
    setController(current)
    return () => current.abort()
  }, [card])
  const request = useMemo<ConversationRevealRequest | null>(() => controller && ({
    generation: 1, record: card.reference, signal: controller.signal,
    sourceKey: conversationMessageSourceKey(card.reference.agentSessionId, card.reference.source) ?? '',
    isCurrent: () => !controller.signal.aborted,
    present: () => !controller.signal.aborted,
    complete(found, error) {
      if (controller.signal.aborted) return
      setLocated(true)
      setIssue(found ? null : error ?? 'The exact original message could not be located. Its saved card is kept.')
    }
  }), [card, controller])
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}>
    <DocumentOverlayPortal component={Dialog.Portal}>
      <Dialog.Overlay className="confirmation-dialog__overlay dialog-scrim" />
      <Dialog.Content className="dialog-surface recall-original-record" aria-describedby={undefined}>
        <header>
          <Dialog.Title>{card.title}</Dialog.Title>
          <Dialog.Close type="button" className="icon-button" aria-label="Close original conversation"><Close size={15}/></Dialog.Close>
        </header>
        {issue ? <p role="status">{issue}</p> : null}
        <ActivityView
          sessionId={card.reference.agentSessionId}
          executionHostId={card.routeHostId}
          capability="complete-events"
          compactUnavailable
          revealRequest={located ? null : request}
          conversationReading={{ reference: { hostId: card.routeHostId, agentSessionId: card.reference.agentSessionId },
            identity: JSON.stringify(['recall-card', card.id, card.reference]), enabled: true, opened: true, readCaptured: true }}
        />
      </Dialog.Content>
    </DocumentOverlayPortal>
  </Dialog.Root>
}
