import type { ConnectionRecord } from '@agentmux/core/connections'
import type { MoteConnectionRef } from '@agentmux/core/mote-preferences'
import { connectionInitialSetupLabel } from '../../lib/mote-connection-default'
import { connectionSummary } from './ConnectionSetupResult'
import type { MoteIdentityReadings } from './MoteIdentityCards'

export function linkedMoteUses(record: { config: Pick<ConnectionRecord['config'], 'connectionId' | 'application'> }, readings: MoteIdentityReadings): string[] {
  const matches = (ref: MoteConnectionRef | null | undefined) =>
    ref?.connectionId === record.config.connectionId && ref.application.domain === record.config.application.domain && ref.application.appId === record.config.application.appId
  return readings.items.flatMap(item => {
    return [
      ...(matches(item.saved?.values?.connection) ? [`${item.scope.topic.title} · new groups`] : []),
      ...(matches(item.chat?.values.connection) ? [`${item.scope.topic.title} · private chat${item.chat?.values.enabled ? '' : ' paused'}`] : [])
    ]
  })
}

/** Original setup, application identity and current traffic are independently readable facts. */
export function ConnectionIdentityFacts({ record, readings, compact = false }: { record: ConnectionRecord; readings: MoteIdentityReadings; compact?: boolean }) {
  const motes = linkedMoteUses(record, readings)
  const linked = motes.length ? motes.join(', ') + (readings.complete ? '' : ' · other associations not confirmed')
    : readings.complete ? 'No Mote association' : readings.reading ? 'Reading Mote associations…' : 'Mote associations not confirmed'
  if (compact) return <span className="connector-record__facts">
    <span className="connector-record__app"><code>{record.config.application.appId}</code></span>
    <span data-identity-setup={record.initialSetup?.state ?? 'not-recorded'}>{connectionInitialSetupLabel(record)}</span>
    <span data-identity-sync>{connectionSummary(record)}</span>
    <span data-identity-motes>{linked}</span>
  </span>
  return <dl className="connector-identity connector-identity-facts" aria-label="Saved identity facts">
    <div><dt>App ID</dt><dd><code>{record.config.application.appId}</code></dd></div>
    <div><dt>Mote use</dt><dd data-identity-motes>{linked}</dd></div>
    <div><dt>Initial setup</dt><dd data-identity-setup={record.initialSetup?.state ?? 'not-recorded'}>{connectionInitialSetupLabel(record)}</dd></div>
    <div><dt>Automatic chat sync</dt><dd data-identity-sync>{connectionSummary(record)}</dd></div>
  </dl>
}
