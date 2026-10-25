import type { ReactNode } from 'react'
import type { ConnectorEntityProfileRead } from '../lib/use-connector-room-name'
import type { ConnectionSetupAccount } from '@agentmux/core/connections'
import { ChannelProfileAvatar } from '@agentmux/client-ui/components/ChannelProfileAvatar'
import { ContentCopyButton } from '@agentmux/client-ui/components/ContentCopyButton'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import '../styles/connector-entity-identity.css'

const PersonIcon = semanticIconComponent('object.user')
const GroupIcon = semanticIconComponent('object.team')
const ApplicationIcon = semanticIconComponent('object.component')
const TenantIcon = semanticIconComponent('object.team')
const identityIcons = { person: PersonIcon, group: GroupIcon, application: ApplicationIcon, tenant: TenantIcon }

type IdentityProps = {
  identityKey: string
  kind: keyof typeof identityIcons
  name?: string | null | undefined
  /** A caller's disambiguated display label; copying still uses the original name. */
  label?: string | undefined
  missingName: string
  avatarUrl?: string | undefined
  secondary?: ReactNode
  status?: ReactNode
  actions?: ReactNode
  compact?: boolean | undefined
  profileRead?: ConnectorEntityProfileRead | undefined
}

/** Display observations only. The caller retains the exact object, authority and read lifecycle. */
export function ConnectorEntityIdentity({ identityKey, kind, name, label, missingName, avatarUrl, secondary, status, actions, compact = false, profileRead }: IdentityProps) {
  const Icon = identityIcons[kind]
  const size = compact ? 28 : 32
  const nameCopy = name ? <ContentCopyButton text={name} identity={`${identityKey}:name`} label={`Copy ${kind} name`} className="connector-entity__copy" /> : null
  return <div className={'connector-entity' + (compact ? ' connector-entity--compact' : '')} data-entity-kind={kind}>
    <span className="connector-entity__avatar" aria-hidden="true">
      <ChannelProfileAvatar url={avatarUrl} size={size}><Icon size={compact ? 15 : 17} /></ChannelProfileAvatar>
    </span>
    <div className="connector-entity__body">
      <div className="connector-entity__heading">
        <strong className={'connector-entity__name' + (!name ? ' connector-entity__name--unavailable' : '')}>{label ?? name ?? missingName}</strong>
        {actions ? <div className="connector-entity__actions">{nameCopy}{actions}</div> : nameCopy}
      </div>
      {status ? <div className="connector-entity__status">{status}</div> : null}
      {secondary ? <div className="connector-entity__secondary">{secondary}</div> : null}
      {profileRead?.issue ? <small className="connector-entity__profile-note" role="status">{profileRead.issue}</small> : null}
    </div>
  </div>
}

/** A shared subscription gap is stated once for the represented list, separately from each profile. */
export function ConnectorProfileUpdates({ reads }: { reads: ReadonlyMap<string, ConnectorEntityProfileRead> }) {
  return [...reads.values()].some(read => read.updatesUnconfirmed) ? <p className="agent-connector-note" role="status" data-profile-updates>Profile updates unconfirmed. Earlier identities are kept.</p> : null
}

/** Full values remain selectable at every width; clipboard feedback is scoped to this exact field. */
export function ConnectorIdentityField({ identityKey, label, value, compact = false }: {
  identityKey: string
  label: string
  value: string
  compact?: boolean | undefined
}) {
  return <div className={'connector-identity-field' + (compact ? ' connector-identity-field--compact' : '')} data-identity-field={label}>
    <span className="connector-identity-field__label">{label}</span>
    <span className="connector-identity-field__value">{value}</span>
    <ContentCopyButton text={value} identity={`${identityKey}:${label}`} label={`Copy ${label}`} className="connector-entity__copy connector-identity-field__copy" />
  </div>
}

/** Login account IDs do not imply a Channel actor or an avatar mapping. */
export function ConnectorAccountSummary({ identityKey: callerIdentity, account, status, label = 'Account and tenant' }: {
  identityKey: string
  account: ConnectionSetupAccount
  status?: ReactNode
  label?: string | undefined
}) {
  const identityKey = JSON.stringify([callerIdentity, account.tenantId, account.userId])
  return <div className="connector-account-summary" role="group" aria-label={label}>
    <div className="connector-account-summary__identities">
      <ConnectorEntityIdentity identityKey={`${identityKey}:account`} kind="person" name={account.userName} missingName="Account name unavailable" compact
        secondary={<ConnectorIdentityField identityKey={identityKey} label="Account ID" value={account.userId} compact />} />
      <ConnectorEntityIdentity identityKey={`${identityKey}:tenant`} kind="tenant" name={account.tenantName} missingName="Tenant name unavailable" compact
        secondary={<ConnectorIdentityField identityKey={identityKey} label="Tenant ID" value={account.tenantId} compact />} />
    </div>
    {status ? <div className="connector-account-summary__status">{status}</div> : null}
  </div>
}
