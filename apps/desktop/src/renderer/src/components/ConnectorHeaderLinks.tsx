import type { ConnectionHostingTarget } from '../../../shared/contracts'
import { useContext, useRef } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { RoomBinding } from '@agentmux/core/connections'
import * as DropdownMenu from './HoverDropdownMenu'
import { useConnectorRoomName } from '../lib/use-connector-room-name'
import { SettingsNavigation } from './SettingsNavigation'
import { connectorDiagnosisKey, useConnectorGroupDiagnosis, type CheckedGroupDiagnosis } from '../lib/use-connector-group-diagnosis'
import { connectorGroupStatus } from '../lib/connector-group-status'

const ConnectionIcon = semanticIconComponent('object.connection'), DownIcon = semanticIconComponent('navigation.down'), LoadingIcon = semanticIconComponent('status.loading')
function PlatformIcon({ binding }: { binding: RoomBinding }) {
  const Icon = useContext(SettingsNavigation)?.channelPresentation(binding.application)?.icon ?? ConnectionIcon
  return <Icon size={14} />
}
type RoomName = ReturnType<typeof useConnectorRoomName>
type Selection = { kind: 'binding'; binding: RoomBinding } | { kind: 'connect' | 'settings' }

/** One connection entry projects the original Session's relations and supported setup actions. */
export function ConnectorHeaderLinks({ bindings, issue, checking, retainedSetup, syncEnabled, nameVersion, visible, hostingTarget, onOpen, onConnect, onMenuOpen, onSettings }: {
  bindings: RoomBinding[]; issue: string; checking: boolean; retainedSetup: boolean; syncEnabled: boolean | null; nameVersion: number; visible: boolean; hostingTarget?: ConnectionHostingTarget | null
  onOpen(binding: RoomBinding, trigger: HTMLElement): void; onConnect(trigger: HTMLElement): void; onMenuOpen(open: boolean): void; onSettings?(trigger: HTMLElement): void
}) {
  const navigation = useContext(SettingsNavigation)
  const platform = (binding: RoomBinding) => navigation?.channelPresentation(binding.application)?.title ?? binding.application.domain
  const trigger = useRef<HTMLButtonElement>(null), selected = useRef<Selection | null>(null), handingOff = useRef(false)
  const unconfirmed = !!issue
  const only = bindings.length === 1 ? bindings[0]! : null, name = useConnectorRoomName(only, nameVersion, visible, hostingTarget)
  const diagnosis = useConnectorGroupDiagnosis(bindings, nameVersion, visible, syncEnabled, hostingTarget)
  const platformCounts = new Map<string, number>()
  for (const binding of bindings) platformCounts.set(platform(binding), (platformCounts.get(platform(binding)) ?? 0) + 1)
  const state = (binding: RoomBinding) => {
    const snapshot = diagnosis.entries[connectorDiagnosisKey(binding)]
    return unconfirmed ? 'Status unknown' : snapshot?.report ? connectorGroupStatus(snapshot).label : binding.state === 'paused' ? 'Sharing paused' : syncEnabled === false ? 'Sync off' : connectorGroupStatus(snapshot).label
  }
  const summary = only ? name.label : bindings.length ? `Connections · ${bindings.length}` : 'Connections'
  const statuses = bindings.map(binding => state(binding))
  const status = only ? state(only) : unconfirmed || statuses.includes('Status unknown') ? 'Status unknown' : statuses.includes('Needs attention') ? 'Needs attention' : bindings.length ? 'Group snapshots' : ''
  const description = (binding: RoomBinding) => {
    const snapshot = diagnosis.entries[connectorDiagnosisKey(binding)], service = snapshot?.report?.service.value
    const sync = service ? service.enabled ? 'On' : 'Off' : syncEnabled === null ? 'unknown' : syncEnabled ? 'On' : 'Off'
    return `${platform(binding)} · ${unconfirmed ? 'Saved link unconfirmed' : binding.state === 'paused' ? 'Sharing paused' : 'Group linked'} · ${state(binding)} · Automatic sync ${sync}${service ? ' in checked snapshot' : ' (saved configuration)'}${snapshot?.checkedAt ? ` · Checked at ${new Date(snapshot.checkedAt).toLocaleString()} · ${connectorGroupStatus(snapshot).outcome}` : ' · Not checked'} · ${binding.externalConversationId} · ${binding.application.domain} · ${binding.application.appId} · ${binding.connectionId}`
  }
  const title = only ? `${name.label}. ${description(only)}${name.issue ? '. ' + name.issue : ''}. Open Connections for group details and automatic sync settings.` :
    `${summary}. ${unconfirmed ? 'Saved group status is unconfirmed. ' : ''}${checking ? 'Checking this Agent’s saved groups. ' : ''}Connect an external conversation or open automatic sync settings.`
  return <DropdownMenu.Root onOpenChange={open => {
    onMenuOpen(open)
    if (!open && selected.current && trigger.current) {
      const selection = selected.current; selected.current = null; handingOff.current = true
      if (selection.kind === 'binding') onOpen(selection.binding, trigger.current)
      else if (selection.kind === 'connect') onConnect(trigger.current)
      else onSettings?.(trigger.current)
    }
  }}>
    <DropdownMenu.Trigger ref={trigger} className="agent-region-header__connector" data-sharing-state={unconfirmed ? 'unknown' : only?.state ?? 'unbound'} data-observation={status === 'Needs attention' || status === 'Status unknown' ? 'attention' : undefined}
      aria-label={`Connections; ${title}`} title={title} aria-busy={checking || name.loading || undefined}
      onPointerDown={event => event.stopPropagation()}>
      {only ? <PlatformIcon binding={only} /> : checking ? <LoadingIcon size={14} animation="spin" /> : <ConnectionIcon size={14} />}
      <span>{summary}</span>{status ? <small className="agent-region-header__connector-status">· {status}</small> : null}<DownIcon size={10} />
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal><DropdownMenu.Content className="tab-context-menu connector-header-menu" align="end" side="bottom" sideOffset={4} collisionPadding={8}
      onCloseAutoFocus={event => { if (handingOff.current) event.preventDefault(); handingOff.current = false }}>
      <DropdownMenu.Label className="connector-header-menu__title">Connections</DropdownMenu.Label>
      {bindings.length ? bindings.map(binding => {
        const props = { binding, visible, hostingTarget, state: state(binding), snapshot: diagnosis.entries[connectorDiagnosisKey(binding)], distinguish: platformCounts.get(platform(binding))! > 1,
          description: description(binding), onSelect: () => { selected.current = { kind: 'binding', binding } } }
        return only ? <ConnectorHeaderItem key={binding.bindingId} {...props} name={name} /> : <NamedConnectorHeaderItem key={binding.bindingId} {...props} />
      }) : <p className="connector-header-menu__empty">{checking ? 'Checking saved connections…' : unconfirmed ? 'Saved connections could not be checked.' : 'No external conversations connected.'}</p>}
      {bindings.length > diagnosis.limit ? <p className="connector-header-menu__empty">Only the first {diagnosis.limit} groups are checked here. Other groups are not checked; open their details.</p> : null}
      {bindings.length ? <DropdownMenu.Item className="tab-context-menu__item" onSelect={event => { event.preventDefault(); diagnosis.check() }}>Check group status</DropdownMenu.Item> : null}
      {issue ? <p className="connector-header-menu__empty" role="status">{issue} Reopen Connections to check again. Saved groups and local input are kept.</p> : null}
      <DropdownMenu.Separator className="tab-context-menu__separator" />
      <DropdownMenu.Item className="tab-context-menu__item" onSelect={() => { selected.current = { kind: 'connect' } }}>{retainedSetup ? 'Continue group setup' : 'Connect a conversation'}</DropdownMenu.Item>
      {onSettings ? <DropdownMenu.Item className="tab-context-menu__item" onSelect={() => { selected.current = { kind: 'settings' } }}>Automatic sync settings</DropdownMenu.Item> : null}
    </DropdownMenu.Content></DropdownMenu.Portal>
  </DropdownMenu.Root>
}

type ItemProps = { hostingTarget?: ConnectionHostingTarget | null | undefined; binding: RoomBinding; visible: boolean; state: string; snapshot: CheckedGroupDiagnosis | undefined; distinguish: boolean; description: string; onSelect(): void }
function NamedConnectorHeaderItem(props: ItemProps) {
  return <ConnectorHeaderItem {...props} name={useConnectorRoomName(props.binding, 0, props.visible, props.hostingTarget)} />
}
function ConnectorHeaderItem({ binding, state, snapshot, distinguish, description, onSelect, name }: ItemProps & { name: RoomName }) {
  const platform = useContext(SettingsNavigation)?.channelPresentation(binding.application)?.title ?? binding.application.domain
  const status = connectorGroupStatus(snapshot)
  return <DropdownMenu.Item className="tab-context-menu__item connector-header-menu__item" onSelect={onSelect}
    title={description} aria-label={`${name.label}; ${description}; ${status.rows.map(([label, text]) => `${label}: ${text}`).join('; ')}${name.issue ? '; ' + name.issue : ''}`}>
    <PlatformIcon binding={binding} /><span><strong>{name.label}</strong><small>{platform} · {state}{name.loading ? ' · Reading name…' : name.issue ? ' · ' + name.issue : ''}</small>
      {distinguish ? <small>{binding.application.appId} · …{binding.externalConversationId.slice(-12)}</small> : null}</span>
    <span className="connector-header-menu__snapshot" aria-label={`Checked status for ${binding.externalConversationId}`}>
      <small className="connector-header-menu__checked">{snapshot?.checking ? 'Checking… · ' : ''}{snapshot?.checkedAt ? <><time dateTime={new Date(snapshot.checkedAt).toISOString()} title={new Date(snapshot.checkedAt).toLocaleString()}>Checked {new Date(snapshot.checkedAt).toLocaleTimeString()}</time> · {status.outcome}</> : 'Not checked'}</small>
      {status.rows.map(([label, text]) => <small key={label}><b>{label}</b> {text}</small>)}
      {snapshot?.report ? <small>Snapshot of bounded local observations. Open group details for original receipts.</small> : null}
    </span>
  </DropdownMenu.Item>
}
