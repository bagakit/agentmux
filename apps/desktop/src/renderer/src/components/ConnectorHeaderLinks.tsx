import type { ConnectionHostingTarget } from '../../../shared/contracts'
import { useContext, useEffect, useRef, useState } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { RoomBinding } from '@agentmux/core/connections'
import * as DropdownMenu from './HoverDropdownMenu'
import { useConnectorRoomName } from '../lib/use-connector-room-name'
import { SettingsNavigation } from './SettingsNavigation'
import { api } from '../lib/api'
import { useAppStore } from '../store'
import { readConnectorService } from '../lib/connector-service-observation'
import type { ChannelEntry } from './settings/settings-catalog'
import { connectorDiagnosisKey, useConnectorGroupDiagnosis, type CheckedGroupDiagnosis } from '../lib/use-connector-group-diagnosis'
import { ConnectorProblemIcon } from './ConnectorTrafficSummary'
import { ConnectorGroupStatus } from './ConnectorGroupStatus'
import { ChannelProfileAvatar } from '@agentmux/client-ui/components/ChannelProfileAvatar'
import { connectorConnectionPresentation } from '../lib/connector-connection-presentation'
import type { ConnectorGroupAction } from '../lib/connector-group-status'

const ConnectionIcon = semanticIconComponent('object.connection'), UnknownIcon = semanticIconComponent('status.unknown'), LinkIcon = semanticIconComponent('object.connection'), DetailsIcon = semanticIconComponent('navigation.forward'), HostIcon = semanticIconComponent('object.host'), GroupIcon = semanticIconComponent('object.team')
type RoomName = ReturnType<typeof useConnectorRoomName>
type Selection = { kind: 'binding'; binding: RoomBinding; action?: ConnectorGroupAction } | { kind: 'connect' | 'settings' | 'channel-settings' }
type Props = {
  bindings: RoomBinding[]; issue: string; checking: boolean; retainedSetup: boolean; syncEnabled: boolean | null; nameVersion: number; visible: boolean; hostingTarget?: ConnectionHostingTarget | null
  onOpen(binding: RoomBinding, trigger: HTMLElement, channel?: string, action?: ConnectorGroupAction): void; onConnect(trigger: HTMLElement, channel?: string): void; onMenuOpen(open: boolean): void; onSettings?(trigger: HTMLElement, channel?: string): void
}

/** Compiled channel entries share one bounded reading of the original Session's relationships. */
export function ConnectorHeaderLinks(props: Props) {
  const navigation = useContext(SettingsNavigation), channels = navigation?.channelEntries ?? []
  const [openChannel, setOpenChannel] = useState<string | null>(null)
  const headerVisibility = useAppStore(state => state.config?.appearance.channelHeaderVisibility)
  const policyScope = JSON.stringify([props.hostingTarget, channels.map(channel => channel.adapterId)]), source = api.connections.call
  useEffect(() => {
    if (!props.visible || !props.hostingTarget) return
    let live = true
    void readConnectorService(() => live, props.hostingTarget).catch(() => {})
    for (const channel of channels) void readConnectorService(() => live, props.hostingTarget, channel.adapterId).catch(() => {})
    return () => { live = false }
  }, [policyScope, props.visible, props.nameVersion, source])
  const visibleChannels = channels.filter(channel => headerVisibility?.[channel.adapterId] !== false)
  const matches = (channel: ChannelEntry, binding: RoomBinding) => channel.domains.includes(binding.application.domain)
  const unknown = props.bindings.filter(binding => !channels.some(channel => matches(channel, binding)))
  const observedBindings = openChannel === 'other' ? unknown : props.bindings.filter(binding => channels.some(channel => channel.adapterId === openChannel && matches(channel, binding)))
  const diagnosis = useConnectorGroupDiagnosis(props.bindings, props.nameVersion, props.visible, props.syncEnabled, props.hostingTarget, observedBindings)
  const menuOpen = (channel: string, open: boolean) => { setOpenChannel(current => open ? channel : current === channel ? null : current); props.onMenuOpen(open) }
  if (!visibleChannels.length && !unknown.length) return null
  return <span className="agent-region-header__channels">{visibleChannels.map(channel => <ChannelHeaderEntry key={channel.adapterId} {...props} channel={channel}
    open={openChannel === channel.adapterId}
    bindings={props.bindings.filter(binding => matches(channel, binding))} diagnosis={diagnosis} totalBindings={props.bindings.length} onMenuOpen={open => menuOpen(channel.adapterId, open)} />)}
    {unknown.length ? <ChannelHeaderEntry {...props} open={openChannel === 'other'} bindings={unknown} diagnosis={diagnosis} totalBindings={props.bindings.length} onMenuOpen={open => menuOpen('other', open)} /> : null}</span>
}

function ChannelHeaderEntry({ channel, diagnosis, totalBindings, open, ...props }: Props & { channel?: ChannelEntry; totalBindings: number; open: boolean; diagnosis: ReturnType<typeof useConnectorGroupDiagnosis> }) {
  const { bindings, issue, checking, syncEnabled, visible, hostingTarget, onOpen, onConnect, onMenuOpen, onSettings } = props
  const navigation = useContext(SettingsNavigation)
  const title = channel?.title ?? 'Other channels', Icon = channel?.icon ?? ConnectionIcon
  const trigger = useRef<HTMLButtonElement>(null), selected = useRef<Selection | null>(null), handingOff = useRef(false)
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null)
  const activeGroup = bindings.find(binding => binding.bindingId === selectedGroup)?.bindingId ?? bindings[0]?.bindingId
  const only = bindings.length === 1 ? bindings[0]! : null
  const name = useConnectorRoomName(only, props.nameVersion, visible, hostingTarget)
  const models = bindings.map(binding => connectorConnectionPresentation(diagnosis.entries[connectorDiagnosisKey(binding)]?.report ?? null))
  const unconfirmed = !!issue || checking && !bindings.length && props.nameVersion === 0
  const unchecked = models.some(model => model.state === 'unknown')
  const stopped = models.some(model => model.state === 'stopped'), recovering = models.some(model => model.state === 'recovering')
  const policy = models.some(model => model.policyState === 'off') ? 'off' : models.some(model => model.policyState === 'paused') ? 'paused' : null
  const state = unconfirmed ? 'unknown' : !bindings.length ? 'unbound' : policy ?? (unchecked ? 'unknown' : stopped ? 'attention' : 'linked')
  const labels = [...new Set(models.map(model => model.title))]
  const hint = [...new Set(models.map(model => model.hint).filter(Boolean))]
  const label = unconfirmed ? hostingTarget === null ? 'Hosting unconfirmed' : checking ? 'Checking saved groups' : 'Group check unavailable' :
    !bindings.length ? 'No group linked' : labels.join(' · ') + (hint.length ? ' · ' + hint.join(' · ') : '')
  const summary = `Conversation sync · ${title} · ${label}${only ? ` · ${name.label}` : bindings.length ? ` · ${bindings.length} groups` : ''}`
  function changeOpen(open: boolean) {
    onMenuOpen(open)
    if (!open && selected.current && trigger.current) {
      const selection = selected.current; selected.current = null; handingOff.current = true
      if (selection.kind === 'binding') onOpen(selection.binding, trigger.current, channel?.adapterId, selection.action)
      else if (selection.kind === 'connect') onConnect(trigger.current, channel?.adapterId)
      else if (selection.kind === 'channel-settings' && channel) navigation?.open(channel.section)
      else onSettings?.(trigger.current, channel?.adapterId)
    }
  }
  return <DropdownMenu.Root open={open} onOpenChange={changeOpen}>
    <DropdownMenu.Trigger ref={trigger} className="agent-region-header__connector" data-channel-entry={channel?.adapterId ?? 'other'} data-channel-state={state}
      aria-label={summary} title={summary} aria-busy={checking || undefined} onPointerDown={event => event.stopPropagation()}>
      <Icon size={12} />{state !== 'unbound' ? <span className="agent-region-header__connector-marker" aria-hidden="true">{hostingTarget === null ? <HostIcon size={10} /> : policy ? <ConnectorProblemIcon kind={policy === 'off' ? 'sync-off' : 'sharing-paused'} /> : stopped ? <ConnectorProblemIcon kind="receiver-stopped" /> : recovering ? <ConnectorProblemIcon kind="receiver-recovering" /> : unconfirmed || unchecked ? <UnknownIcon size={10} /> : <LinkIcon size={9} />}</span> : null}
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal><DropdownMenu.Content className="tab-context-menu connector-header-menu" align="end" side="bottom" sideOffset={2} collisionPadding={8}
      aria-label={`Conversation sync · ${title}`} onCloseAutoFocus={event => { if (handingOff.current) event.preventDefault(); handingOff.current = false }}>
      <DropdownMenu.Label className="connector-header-menu__title"><span><Icon size={12} />{title}</span><small>{bindings.length ? `${bindings.length} group${bindings.length === 1 ? '' : 's'}` : 'Conversation sync'}</small></DropdownMenu.Label>
      {bindings.length ? bindings.map(binding => <GroupEntry key={binding.bindingId} binding={binding} hostingTarget={hostingTarget} visible={visible}
        expanded={activeGroup === binding.bindingId} onExpand={() => setSelectedGroup(binding.bindingId)}
        name={only ? name : undefined} snapshot={diagnosis.entries[connectorDiagnosisKey(binding)]}
        identityLabel={bindings.length > 1 ? bindings.some(other => other !== binding && other.externalConversationId.endsWith(binding.externalConversationId.slice(-8))) ? binding.externalConversationId : '…' + binding.externalConversationId.slice(-8) : undefined}
        onSelect={action => { selected.current = { kind: 'binding', binding, ...(action ? { action } : {}) } }}
        onNavigate={action => { selected.current = { kind: 'binding', binding, action }; changeOpen(false) }} onCheck={diagnosis.check} />)
        : <p className="connector-header-menu__empty">{checking ? 'Checking this Agent’s saved groups…' : issue ? hostingTarget === null ? 'Bot hosting is unconfirmed. Check its original Host.' : 'Saved groups could not be checked. Existing requests are kept.' : 'Connect this Agent’s conversation to a group.'}</p>}
      {props.bindings.some(binding => !diagnosis.entries[connectorDiagnosisKey(binding)]?.report) && totalBindings > diagnosis.limit ? <p className="connector-header-menu__empty">Only the first {diagnosis.limit} groups are checked here. Other groups are not checked; open their details.</p> : null}
      {issue ? <details className="connector-header-menu__diagnostics"><summary>{hostingTarget === null ? 'Bot hosting details' : 'Group check details'}</summary><p className="connector-header-menu__issue">{issue}</p></details> : null}
      <DropdownMenu.Separator className="tab-context-menu__separator" />
      <DropdownMenu.Item className="tab-context-menu__item" onSelect={() => { selected.current = { kind: 'connect' } }}>{issue && !bindings.length ? 'Check bot hosting' : props.retainedSetup ? 'Open channel setup' : 'Connect a group'}</DropdownMenu.Item>
      {channel && navigation ? <DropdownMenu.Item className="tab-context-menu__item" onSelect={() => { selected.current = { kind: 'channel-settings' } }}>Channel settings</DropdownMenu.Item> : null}
      {!channel && onSettings && hostingTarget ? <DropdownMenu.Item className="tab-context-menu__item" onSelect={() => { selected.current = { kind: 'settings' } }}>Automatic sync settings</DropdownMenu.Item> : null}
    </DropdownMenu.Content></DropdownMenu.Portal>
  </DropdownMenu.Root>
}

function GroupEntry(props: { binding: RoomBinding; visible: boolean; hostingTarget?: ConnectionHostingTarget | null | undefined; name: RoomName | undefined; snapshot: CheckedGroupDiagnosis | undefined; identityLabel: string | undefined; expanded: boolean; onExpand(): void; onSelect(action?: ConnectorGroupAction): void; onNavigate(action: ConnectorGroupAction): void; onCheck(): void }) {
  const observedName = useConnectorRoomName(props.name ? null : props.binding, 0, props.visible, props.hostingTarget), name = props.name ?? observedName
  const { binding, snapshot } = props, model = connectorConnectionPresentation(snapshot?.report ?? null)
  return <div className="connector-header-menu__group">
    <DropdownMenu.Item className="tab-context-menu__item connector-header-menu__item" data-connection-action="overview" onSelect={event => { if (!props.expanded) { event.preventDefault(); props.onExpand() } else props.onSelect() }}
      title={`${name.label} · ${binding.application.appId} · ${binding.externalConversationId}`}
      aria-label={`${name.label}; ${model.title}; ${binding.externalConversationId}; ${binding.connectionId}`}>
      <span className="connector-header-menu__group-heading"><ChannelProfileAvatar url={name.profile?.avatarUrl} size={24}><GroupIcon size={16} /></ChannelProfileAvatar><span><strong>{name.label}</strong>{props.identityLabel ? <small>Group {props.identityLabel}</small> : null}<small className="connector-header-menu__receiving" data-state={model.state}>{model.shortTitle}</small></span></span><DetailsIcon size={13} />
    </DropdownMenu.Item>
    {props.expanded ? <>
      <ConnectorGroupStatus key={JSON.stringify([binding.bindingId, binding.revision, props.hostingTarget])} binding={binding} report={snapshot?.report ?? null} hostingTarget={props.hostingTarget} onCheck={props.onCheck} onNavigate={props.onNavigate} />
      <DropdownMenu.Item className="tab-context-menu__item connector-header-menu__action" onSelect={() => props.onSelect('members')}>Members &amp; access<DetailsIcon size={12} /></DropdownMenu.Item>
      <DropdownMenu.Item className="tab-context-menu__item connector-header-menu__action" onSelect={() => props.onSelect('diagnostics')}>Diagnostics{model.attention ? <span className="connector-group-details__attention" aria-label="Needs checking">?</span> : <DetailsIcon size={12} />}</DropdownMenu.Item>
    </> : null}
  </div>
}
