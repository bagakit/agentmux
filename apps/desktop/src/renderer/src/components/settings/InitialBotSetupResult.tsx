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
    <strong>{progress?.state === 'complete' ? 'Configuration and first publication confirmed'
      : progress?.state === 'approval-required' ? 'Waiting for platform approval'
      : progress?.state === 'attention' ? 'This setup needs attention'
      : 'Configuring and publishing this bot'}</strong>
    <p>{progress ? initialSetupStageLabels[progress.stage] + (progress.state === 'attention' ? ' is not confirmed. Your original application and earlier results are kept.' : progress.state === 'approval-required' ? ' is still required. The original version is kept.' : progress.state === 'complete' ? '. Message delivery is checked separately.' : ' is the current step.') : 'The original setup is kept while its progress is read.'}</p>
    {progress?.versionId ? <details className="bot-profile-details"><summary>Original version</summary><code>{progress.versionId}</code></details> : null}
  </section>
}
