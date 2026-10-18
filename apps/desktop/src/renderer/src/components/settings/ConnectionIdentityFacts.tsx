import type { ConnectionRecord } from '@agentmux/core/connections'
import { connectionInitialSetupLabel } from '../../lib/mote-connection-default'
import { connectionSummary } from './ConnectionSetupResult'
import type { MoteIdentityReadings } from './MoteIdentityCards'

export function linkedMoteNames(record: ConnectionRecord, readings: MoteIdentityReadings): string[] {
  return readings.items.flatMap(item => {
    const ref = item.saved?.values?.connection
    return ref?.connectionId === record.config.connectionId && ref.application.domain === record.config.application.domain && ref.application.appId === record.config.application.appId
      ? [item.scope.topic.title] : []
  })
}

/** Original setup, application identity and current traffic are independently readable facts. */
export function ConnectionIdentityFacts({ record, readings, compact = false }: { record: ConnectionRecord; readings: MoteIdentityReadings; compact?: boolean }) {
  const motes = linkedMoteNames(record, readings)
  const linked = motes.length ? motes.join(', ') + (readings.complete ? '' : ' · other associations not confirmed')
    : readings.complete ? 'No Mote default' : readings.reading ? 'Reading Mote associations…' : 'Mote associations not confirmed'
  if (compact) return <span className="connector-record__facts">
    <span className="connector-record__app"><code>{record.config.application.appId}</code></span>
    <span data-identity-setup={record.initialSetup?.state ?? 'not-recorded'}>{connectionInitialSetupLabel(record)}</span>
    <span data-identity-sync>{connectionSummary(record)}</span>
    <span data-identity-motes>{motes.length ? 'Default for ' : ''}{linked}</span>
  </span>
  return <dl className="connector-identity connector-identity-facts" aria-label="Saved identity facts">
    <div><dt>App ID</dt><dd><code>{record.config.application.appId}</code></dd></div>
    <div><dt>Mote default</dt><dd data-identity-motes>{linked}</dd></div>
    <div><dt>Initial setup</dt><dd data-identity-setup={record.initialSetup?.state ?? 'not-recorded'}>{connectionInitialSetupLabel(record)}</dd></div>
    <div><dt>Automatic chat sync</dt><dd data-identity-sync>{connectionSummary(record)}</dd></div>
  </dl>
}
