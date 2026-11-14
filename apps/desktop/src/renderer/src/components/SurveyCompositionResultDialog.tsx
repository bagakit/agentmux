import * as Dialog from '@agentmux/client-ui/components/Modal'
import { Button } from '@agentmux/client-ui/components/Button'
import { useState } from 'react'
import type { SurveyCompositionRecovery, SurveyCompositionReview } from '../lib/survey-composition-recovery'
import { useAppStore } from '../store'
import { DocumentOverlayPortal } from './WindowOverlayHost'

/** One original operation. Neither reading nor repairing the list resubmits the move. */
export function SurveyCompositionResultDialog({ operation, visible, onClose }: {
  operation: SurveyCompositionRecovery; visible: boolean; onClose(): void
}) {
  const [busy, setBusy] = useState(false), [review, setReview] = useState<SurveyCompositionReview | null>(null)
  async function inspect(repair: boolean) {
    if (busy) return
    setBusy(true)
    const result = await useAppStore.getState().reviewSurveyComposition(operation.requestId, repair)
    setReview(result); setBusy(false)
  }
  return <Dialog.Root open={visible} onOpenChange={open => { if (!open) onClose() }}>
    <DocumentOverlayPortal component={Dialog.Portal}><Dialog.Overlay className="confirmation-dialog__overlay dialog-scrim" />
      <Dialog.Content className="confirmation-dialog dialog-surface" data-survey-composition-request={operation.requestId}>
        <Dialog.Title className="confirmation-dialog__title">Review this combination</Dialog.Title>
        <Dialog.Description className="confirmation-dialog__description">{operation.sources.length} selected {operation.sources.every(source => source.kind === 'page') ? 'pages' : 'items'}. {operation.report.outcome === 'partial' ? 'The composition was committed. Its Survey reference save is unconfirmed.' : 'The original result is unconfirmed.'} Your original content is kept. Checking reads the current target; it does not confirm the earlier acknowledgement.</Dialog.Description>
        {operation.report.issue ? <p className="surface-inline-error">{operation.report.issue}</p> : null}
        <details className="confirmation-dialog__description survey-composition-details"><summary>Original operation details</summary>
          <dl><dt>Request</dt><dd>{operation.requestId}</dd><dt>Target research</dt><dd>{operation.target.zoneId}</dd>
            {operation.surveyGroupId !== undefined ? <><dt>Survey list group</dt><dd>{operation.surveyGroupId ?? 'Ungrouped'}</dd></> : null}
            <dt>Original content</dt><dd>{operation.sources.flatMap(source => source.owners.map(owner => `${owner.kind}: ${owner.regionId}`)).join(', ')}</dd></dl>
        </details>
        {review ? <p role="status" className="confirmation-dialog__description">{review.issue}</p> : null}
        <footer className="confirmation-dialog__actions"><Button type="button" onClick={onClose}>Keep working</Button>
          <Button type="button" disabled={busy} onClick={() => void inspect(false)}>{busy ? 'Checking…' : 'Check current target'}</Button>
          <Button type="button" variant="secondary" disabled={busy || !review?.targetConfirmed || review.referencesRepaired} onClick={() => void inspect(true)}>Repair Survey references</Button>
        </footer>
      </Dialog.Content>
    </DocumentOverlayPortal>
  </Dialog.Root>
}
