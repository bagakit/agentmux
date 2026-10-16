import type { ConnectionSetupReadSubject, ConnectionSetupView } from '@agentmux/core/connections'

const checkTitles: Partial<Record<ConnectionSetupReadSubject, string>> = { 'bot-settings': 'Bot message check', 'event-settings': 'Delivery check', 'callback-settings': 'Card interaction check', 'permission-catalog': 'Permission directory check', 'application-permissions': 'Permission check', 'event-catalog': 'Event directory check' }

/** A view of one original receipt, never a second progress or eligibility owner. */
export function connectionManagementTask(view: ConnectionSetupView | null) {
  const configuration = view?.applicationConfiguration
  const recover = configuration?.actions.find(action => action.kind === 'recover-configuration-effect') ?? view?.applicationInspection?.actions.find(action => action.kind === 'recover-application-inspection')
  if (recover) return { kind: 'action' as const, action: recover, title: recover.kind === 'recover-application-inspection' ? 'Finish saving this check' : 'Finish saving the original result', summary: 'The platform response is received. Save it locally to continue without sending it again.', label: 'Finish saving original result' }
  if (configuration?.reason === 'original-effect-unconfirmed') return { kind: 'original' as const, title: 'Check the original request', summary: 'This result is not confirmed. Keep its original identity while checking it.', label: 'Check original request' }
  if (configuration?.effect === 'add-application-permissions' && configuration.selected?.effect === 'add-application-permissions' && configuration.selected.requiresDataRangeConfiguration === true) return { kind: 'console' as const, title: 'Check the requested data-range setup', summary: 'The platform asked for additional data-range configuration in this original permission request. Open the developer console to complete or check it.', label: 'Open developer console' }
  if (configuration?.effect === 'create-application-version') return { kind: 'publication' as const, title: 'Review publishing', summary: 'Review the application changes, audience and release notes before creating a version.', label: 'Review publishing' }
  if (configuration?.effect === 'submit-application-version') {
    const selected = configuration.selected
    if (selected?.effect === 'submit-application-version' && selected.request === 'confirmed' && selected.secureStorage === 'stored' && selected.submission?.outcome === 'accepted') {
      const status = configuration.review?.selectedVersion?.status
      return { kind: 'status' as const, title: status === 'reviewing' ? 'Waiting for platform review' : status === 'approved' ? 'Version approved' : status === 'rejected' ? 'Version needs attention' : 'Submission accepted', summary: status === 'approved' ? 'Approval does not confirm which version is live or that messages are arriving.' : status === 'rejected' ? 'Review this version in the developer console. Your existing Agents and groups are kept.' : 'Check this exact version’s current status. Message reception is confirmed separately.', label: 'Check version status' }
    }
    return { kind: 'publication' as const, title: 'Review the selected version', summary: 'Inspect this version’s own changes and audience before submitting it.', label: 'Review selected version' }
  }
  const read = view?.applicationInspection?.selected
  if (read && read.request !== 'confirmed') return { kind: 'check' as const, title: (read.subject && checkTitles[read.subject] || 'Current settings check') + ' not confirmed', summary: 'The platform did not confirm this check. Its original result is kept. You can explicitly check current settings again.', label: 'Retry settings check' }
  const offered = configuration?.actions.find(action => action.kind === configuration.effect)
  if (offered) {
    if (offered.kind === 'enable-messaging') return { kind: 'action' as const, action: offered, title: 'Turn on bot messages', summary: 'Allow this application to send and receive bot messages.', label: 'Turn on bot messages' }
    if (offered.kind === 'use-persistent-connection') return { kind: 'action' as const, action: offered, title: 'Use a persistent connection', summary: 'This changes delivery for the whole application, including its other event consumers.', label: 'Use persistent connection' }
    if (offered.kind === 'use-persistent-callback') return { kind: 'action' as const, action: offered, title: 'Connect card interactions', summary: 'Use a persistent connection for card actions. This changes callback delivery for the whole application, including existing consumers.', label: 'Connect card interactions' }
    if (offered.kind === 'add-card-actions') return { kind: 'action' as const, action: offered, title: 'Enable replies from cards', summary: 'Add the callback for answering questions and permission requests. Each member still needs the existing Agent access and sharing permissions.', label: 'Enable card replies' }
    if (offered.kind === 'add-application-permissions') return { kind: 'action' as const, action: offered, title: 'Request conversation permissions', summary: 'Request the missing permissions for messages and creating or connecting groups. Effective access still needs platform approval.', label: 'Request required permissions' }
    if (offered.kind === 'add-message-reception') return { kind: 'action' as const, action: offered, title: 'Receive conversation messages', summary: 'Add the required message event, keeping the last checked persistent delivery mode for the whole application.', label: 'Add message reception' }
  }
  return { kind: 'check' as const, title: configuration?.selected?.request === 'confirmed' ? 'Check the current settings' : 'Check bot settings', summary: 'Check this bot’s message settings and required permissions. Checking does not change them.', label: configuration?.selected?.request === 'confirmed' ? 'Check current settings' : 'Check bot settings' }
}
