import type { ConnectionHostingTarget } from '../../../shared/contracts'
import { useContext, useRef } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { RoomBinding } from '@agentmux/core/connections'
import * as DropdownMenu from './HoverDropdownMenu'
import { useConnectorRoomName } from '../lib/use-connector-room-name'
import { SettingsNavigation } from './SettingsNavigation'
import type { ChannelEntry } from './settings/settings-catalog'
import { connectorDiagnosisKey, useConnectorGroupDiagnosis, type CheckedGroupDiagnosis } from '../lib/use-connector-group-diagnosis'
import { connectorGroupStatus } from '../lib/connector-group-status'

const ConnectionIcon = semanticIconComponent('object.connection')
type RoomName = ReturnType<typeof useConnectorRoomName>
type Selection = { kind: 'binding'; binding: RoomBinding } | { kind: 'connect' | 'settings' | 'channel-settings' }
type Props = {
  bindings: RoomBinding[]; issue: string; checking: boolean; retainedSetup: boolean; syncEnabled: boolean | null; nameVersion: number; visible: boolean; hostingTarget?: ConnectionHostingTarget | null
  onOpen(binding: RoomBinding, trigger: HTMLElement, channel?: string): void; onConnect(trigger: HTMLElement, channel?: string): void; onMenuOpen(open: boolean): void; onSettings?(trigger: HTMLElement, channel?: string): void
}

/** Compiled channel entries share one bounded reading of the original Session's relationships. */
export function ConnectorHeaderLinks(props: Props) {
  const navigation = useContext(SettingsNavigation), channels = navigation?.channelEntries ?? []
  const diagnosis = useConnectorGroupDiagnosis(props.bindings, props.nameVersion, props.visible, props.syncEnabled, props.hostingTarget)
  const matches = (channel: ChannelEntry, binding: RoomBinding) => channel.domains.includes(binding.application.domain)
  const unknown = props.bindings.filter(binding => !channels.some(channel => matches(channel, binding)))
  return <>{channels.map(channel => <ChannelHeaderEntry key={channel.adapterId} {...props} channel={channel}
    bindings={props.bindings.filter(binding => matches(channel, binding))} diagnosis={diagnosis} totalBindings={props.bindings.length} />)}
    {unknown.length ? <ChannelHeaderEntry {...props} bindings={unknown} diagnosis={diagnosis} totalBindings={props.bindings.length} /> : null}</>
}

function ChannelHeaderEntry({ channel, diagnosis, totalBindings, ...props }: Props & { channel?: ChannelEntry; totalBindings: number; diagnosis: ReturnType<typeof useConnectorGroupDiagnosis> }) {
  const { bindings, issue, checking, syncEnabled, visible, hostingTarget, onOpen, onConnect, onMenuOpen, onSettings } = props
  const navigation = useContext(SettingsNavigation)
  const title = channel?.title ?? 'Other channels', Icon = channel?.icon ?? ConnectionIcon
  const trigger = useRef<HTMLButtonElement>(null), selected = useRef<Selection | null>(null), handingOff = useRef(false)
  const only = bindings.length === 1 ? bindings[0]! : null
  const name = useConnectorRoomName(only, props.nameVersion, visible, hostingTarget)
  const status = (binding: RoomBinding) => {
    const snapshot = diagnosis.entries[connectorDiagnosisKey(binding)]
    return issue ? 'Status unknown' : snapshot?.report ? connectorGroupStatus(snapshot).label : binding.state === 'paused' ? 'Sharing paused' : syncEnabled === false ? 'Sync off' : connectorGroupStatus(snapshot).label
  }
  const statuses = bindings.map(status)
  const state = issue || checking && !bindings.length && props.nameVersion === 0 ? 'unknown' : statuses.includes('Needs attention') ? 'attention' : statuses.some(value => value === 'Status unknown' || value === 'Not checked' || value === 'Checking…') ? 'unknown' :
    !bindings.length ? 'unbound' : syncEnabled === false || statuses.includes('Sync off') ? 'off' : statuses.includes('Sharing paused') ? 'paused' : bindings.length ? 'linked' : 'unbound'
  const label = state === 'unknown' ? checking ? 'Checking saved groups' : 'Status unknown' : state === 'attention' ? 'Needs attention' : state === 'off' ? 'Sync off' : state === 'paused' ? 'Sharing paused' : state === 'linked' ? 'Group linked' : 'No group linked'
  const summary = `${title} · ${label}${only ? ` · ${name.label}` : bindings.length ? ` · ${bindings.length} groups` : ''}`
  return <DropdownMenu.Root onOpenChange={open => {
    onMenuOpen(open)
    if (!open && selected.current && trigger.current) {
      const selection = selected.current; selected.current = null; handingOff.current = true
      if (selection.kind === 'binding') onOpen(selection.binding, trigger.current, channel?.adapterId)
      else if (selection.kind === 'connect') onConnect(trigger.current, channel?.adapterId)
      else if (selection.kind === 'channel-settings' && channel) navigation?.open(channel.section)
      else onSettings?.(trigger.current, channel?.adapterId)
    }
  }}>
    <DropdownMenu.Trigger ref={trigger} className="agent-region-header__connector" data-channel-entry={channel?.adapterId ?? 'other'} data-channel-state={state}
      aria-label={summary} title={summary} aria-busy={checking || undefined} onPointerDown={event => event.stopPropagation()}>
      <Icon size={15} /><span className="agent-region-header__connector-dot" aria-hidden="true" />
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal><DropdownMenu.Content className="tab-context-menu connector-header-menu" align="end" side="bottom" sideOffset={6} collisionPadding={8}
      aria-label={`${title} connections`} onCloseAutoFocus={event => { if (handingOff.current) event.preventDefault(); handingOff.current = false }}>
      <DropdownMenu.Label className="connector-header-menu__title">{title}<small>{label}</small></DropdownMenu.Label>
      {bindings.length ? bindings.map(binding => <GroupEntry key={binding.bindingId} binding={binding} hostingTarget={hostingTarget} visible={visible}
        name={only ? name : undefined} status={status(binding)} snapshot={diagnosis.entries[connectorDiagnosisKey(binding)]}
        onSelect={() => { selected.current = { kind: 'binding', binding } }} />)
        : <p className="connector-header-menu__empty">{checking ? 'Checking this Agent’s saved groups…' : issue ? 'Saved groups could not be checked. Existing requests are kept.' : 'Connect this Agent’s conversation to a group.'}</p>}
      {props.bindings.some(binding => !diagnosis.entries[connectorDiagnosisKey(binding)]) && totalBindings > diagnosis.limit ? <p className="connector-header-menu__empty">Only the first {diagnosis.limit} groups are checked here. Other groups are not checked; open their details.</p> : null}
      {issue ? <p className="connector-header-menu__issue" role="status">{issue}</p> : null}
      <DropdownMenu.Separator className="tab-context-menu__separator" />
      <DropdownMenu.Label className="connector-header-menu__title">Next step</DropdownMenu.Label>
      {bindings.length ? <DropdownMenu.Item className="tab-context-menu__item" onSelect={event => { event.preventDefault(); diagnosis.check() }}>Check group status</DropdownMenu.Item> : null}
      <DropdownMenu.Item className="tab-context-menu__item" onSelect={() => { selected.current = { kind: 'connect' } }}>{issue && !bindings.length ? 'Check bot hosting' : props.retainedSetup ? 'Open channel setup' : 'Connect a conversation'}</DropdownMenu.Item>
      {channel && navigation ? <DropdownMenu.Item className="tab-context-menu__item" onSelect={() => { selected.current = { kind: 'channel-settings' } }}>Channel settings</DropdownMenu.Item> : null}
      {onSettings && hostingTarget ? <DropdownMenu.Item className="tab-context-menu__item" onSelect={() => { selected.current = { kind: 'settings' } }}>Automatic sync settings</DropdownMenu.Item> : null}
    </DropdownMenu.Content></DropdownMenu.Portal>
  </DropdownMenu.Root>
}

function GroupEntry(props: { binding: RoomBinding; visible: boolean; hostingTarget?: ConnectionHostingTarget | null | undefined; name: RoomName | undefined; status: string; snapshot: CheckedGroupDiagnosis | undefined; onSelect(): void }) {
  const observedName = useConnectorRoomName(props.name ? null : props.binding, 0, props.visible, props.hostingTarget), name = props.name ?? observedName
  const { binding, snapshot } = props, status = connectorGroupStatus(snapshot)
  return <div className="connector-header-menu__group">
    <DropdownMenu.Item className="tab-context-menu__item connector-header-menu__item" onSelect={props.onSelect}
      title={`${name.label} · ${binding.application.appId} · ${binding.externalConversationId}`}
      aria-label={`${name.label}; ${props.status}; ${binding.externalConversationId}; ${binding.connectionId}`}>
      <span><strong>{name.label}</strong><small>{props.status} · {binding.application.appId}</small><small>Group {binding.externalConversationId}</small><small>Open group details →</small></span>
    </DropdownMenu.Item>
    <div className="connector-header-menu__traffic">
      {[['Conversation → group', status.rows.find(([label]) => label === 'Platform requests')?.[1] ?? 'Not checked'], ['Group → Agent', status.rows.find(([label]) => label === 'Group → Agent')?.[1] ?? 'Not checked']].map(([label, text]) => <p key={label}><b>{label}</b><span>{text}</span></p>)}
      <details className="connector-header-menu__diagnostics"><summary>Checked details{snapshot?.checkedAt ? ` · ${new Date(snapshot.checkedAt).toLocaleTimeString()}` : ''}</summary>
        <div className="connector-header-menu__snapshot">
          <small className="connector-header-menu__checked">{snapshot?.checking ? 'Checking… · ' : ''}{snapshot?.checkedAt ? <><time dateTime={new Date(snapshot.checkedAt).toISOString()}>Checked {new Date(snapshot.checkedAt).toLocaleTimeString()}</time> · {status.outcome}</> : 'Not checked'}</small>
          {status.rows.map(([label, text]) => <small key={label}><b>{label}</b> {text}</small>)}
          <small>{binding.application.domain} · {binding.application.appId} · {binding.connectionId}</small>
          {name.issue ? <small>{name.issue}</small> : null}
          {snapshot?.report ? <small>Snapshot of bounded local observations. Open group details for original receipts.</small> : null}
        </div>
      </details>
    </div>
  </div>
}
