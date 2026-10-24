import { useContext } from 'react'
import type { ConnectionRecord } from '@agentmux/core/connections'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { SettingsNavigation } from '../SettingsNavigation'
import { connectionInitialSetupLabel } from '../../lib/mote-connection-default'
import { connectionSummary } from './ConnectionSetupResult'
import { ConnectionIdentityFacts } from './ConnectionIdentityFacts'
import type { MoteIdentityReadings } from './MoteIdentityCards'

const BotIcon = semanticIconComponent('object.conversations')
const ConnectionIcon = semanticIconComponent('object.connection')
const NextIcon = semanticIconComponent('navigation.forward')

/** A view of the original library. Selection passes the exact record to its existing owner. */
export function ConnectionBotList({ records, readings, listIssue, onManage }: {
  records: ConnectionRecord[]; readings: MoteIdentityReadings | null; listIssue: string
  onManage(record: ConnectionRecord): void
}) {
  const navigation = useContext(SettingsNavigation)
  if (!records.length) return listIssue ? null : <div className="connector-library-empty">
    <ConnectionIcon size={28} /><strong>Your first bot starts here</strong>
    <p>Add a bot above, then connect it to an Agent’s conversation. A Mote is optional.</p>
  </div>
  return <div className="connector-bot-list">{records.map(record => {
    const presentation = navigation?.channelPresentation(record.config.application, record.config.adapterId)
    const Icon = presentation?.icon ?? BotIcon
    return <article className="connector-record" key={record.config.connectionId} data-connection={record.config.connectionId}>
      <button type="button" className="connector-record__open" aria-label={`Manage ${record.config.label} · ${record.config.application.appId}`} onClick={() => onManage(record)}>
        <span className="connector-record__heading"><span className="connector-record__mark"><Icon size={22} /></span><span><strong className="connector-record__name">{record.config.label}</strong><small>{presentation?.title ?? record.config.application.domain}</small></span></span>
        {readings ? <ConnectionIdentityFacts record={record} readings={readings} compact /> : <span className="connector-record__facts">
          <span className="connector-record__app"><code>{record.config.application.appId}</code></span>
          <span data-identity-setup={record.initialSetup?.state ?? 'not-recorded'}><small>Setup</small>{connectionInitialSetupLabel(record)}</span>
          <span data-identity-sync><small>Connection</small>{connectionSummary(record)}</span>
        </span>}
        <span className="connector-record__action">Manage bot <NextIcon size={12} /></span>
      </button>
    </article>
  })}</div>
}
