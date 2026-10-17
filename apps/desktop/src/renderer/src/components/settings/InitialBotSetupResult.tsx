import type { ConnectionSetupInitialProgress } from '@agentmux/core/connections'

export const initialSetupStageLabels: Record<ConnectionSetupInitialProgress['stage'], string> = {
  authentication: 'Original account', messaging: 'Bot messages', 'event-transport': 'Event connection',
  permissions: 'Conversation permissions', 'message-reception': 'Message reception',
  'callback-transport': 'Card connection', 'card-actions': 'Card replies',
  'publication-create': 'Create first version', 'publication-submit': 'Submit first version', 'publication-status': 'Platform approval'
}

/** A projection of the original Setup owner, never a client-side configuration driver. */
export function InitialBotSetupResult({ progress }: { progress: ConnectionSetupInitialProgress | null }) {
  return <section className="mote-bot-next" aria-label="Configuration and publication" data-initial-setup-stage={progress?.stage ?? 'pending'} data-state={progress?.state ?? 'pending'}>
    <p>{progress?.state === 'complete' ? 'The original version is approved. Message delivery is checked separately.' : progress?.state === 'approval-required' ? 'Your version has been submitted. Check its status after the platform finishes its review.' : progress ? initialSetupStageLabels[progress.stage] + (progress.state === 'attention' ? ' is not confirmed. Earlier completed steps are kept; check this step to continue.' : ' is the current step.') : 'Reading the saved configuration progress…'}</p>
    {progress?.versionId ? <details className="bot-profile-details"><summary>Original version</summary><code>{progress.versionId}</code></details> : null}
  </section>
}
