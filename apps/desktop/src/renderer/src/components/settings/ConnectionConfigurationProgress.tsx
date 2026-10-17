import type { ConnectionSetupAction, ConnectionSetupReadSubject, ConnectionSetupView } from '@agentmux/core/connections'
const groups: Array<{ label: string; subjects: ConnectionSetupReadSubject[]; effects: string[] }> = [
  { label: 'Bot messages', subjects: ['bot-settings'], effects: ['enable-messaging'] },
  { label: 'Permissions', subjects: ['permission-catalog', 'application-permissions'], effects: ['add-application-permissions'] },
  { label: 'Message delivery', subjects: ['event-settings', 'event-catalog'], effects: ['use-persistent-connection', 'add-message-reception'] },
  { label: 'Card replies', subjects: ['callback-settings'], effects: ['use-persistent-callback', 'add-card-actions'] },
  { label: 'Publication', subjects: ['publication-pending', 'publication-versions', 'publication-visibility', 'publication-sharing', 'publication-features', 'publication-version'], effects: ['create-application-version', 'submit-application-version'] }
]

/** Projects only the original observation/effect receipts. A saved check is not an enabled capability. */
export function ConnectionConfigurationProgress({ view, busy, actionKind, readFailed }: {
  view: ConnectionSetupView | null; busy: boolean; actionKind?: ConnectionSetupAction['kind'] | undefined; readFailed: boolean
}) {
  const inspection = view?.applicationInspection, configuration = view?.applicationConfiguration
  const reads = [...(inspection?.observations ?? []), ...(inspection?.selected ? [inspection.selected] : [])]
  const effects = [...(configuration?.effects ?? []), ...(configuration?.selected ? [configuration.selected] : [])]
  return <ol className="connector-configuration-progress" aria-label="Configuration progress">{groups.map((group, index) => {
    const selectedRead = inspection?.selected?.subject && group.subjects.includes(inspection.selected.subject) ? inspection.selected : null
    const selectedEffect = configuration?.selected && group.effects.includes(configuration.selected.effect) ? configuration.selected : null
    const pending = !!actionKind && (group.effects.includes(actionKind) || group.subjects.some(subject => actionKind === 'read-' + subject))
    const current = pending || configuration && group.effects.includes(configuration.effect)
    const earlierUnknown = reads.some(read => read.subject && group.subjects.includes(read.subject) && read.request === 'unknown') || effects.some(effect => group.effects.includes(effect.effect) && effect.request === 'unknown')
    const unknown = current && readFailed || selectedRead?.request === 'unknown' || selectedEffect?.request === 'unknown' || earlierUnknown
    const storedEffect = effects.some(effect => group.effects.includes(effect.effect) && effect.request === 'confirmed' && effect.secureStorage === 'stored')
    const checked = reads.some(read => read.subject && group.subjects.includes(read.subject) && read.request === 'confirmed' && read.secureStorage === 'stored')
    const status = unknown ? 'Result unconfirmed' : pending && busy ? 'Checking…' : storedEffect ? 'Request saved' : checked ? 'Check saved' : current ? 'Current' : 'Not checked here'
    return <li key={group.label} data-state={unknown ? 'attention' : current ? 'current' : checked || storedEffect ? 'recorded' : 'upcoming'}>
      <span className="connector-configuration-progress__number" aria-hidden="true">{index + 1}</span><span><strong>{group.label}</strong><small>{status}</small></span>
    </li>
  })}</ol>
}
