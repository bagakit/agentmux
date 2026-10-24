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
import { ConnectorProblemIcon, ConnectorTrafficSummary } from './ConnectorTrafficSummary'
import { connectorGroupAction, connectorGroupDiagnostics, connectorGroupSummary, type ConnectorGroupAction } from '../lib/connector-group-status'

const ConnectionIcon = semanticIconComponent('object.connection'), UnknownIcon = semanticIconComponent('status.unknown'), LinkIcon = semanticIconComponent('object.connection'), RefreshIcon = semanticIconComponent('action.refresh'), DetailsIcon = semanticIconComponent('navigation.forward'), HostIcon = semanticIconComponent('object.host')
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
    bindings={props.bindings.filter(binding => matches(channel, binding))} diagnosis={diagnosis} totalBindings={props.bindings.length} onMenuOpen={open => menuOpen(channel.adapterId, open)} />)}
    {unknown.length ? <ChannelHeaderEntry {...props} bindings={unknown} diagnosis={diagnosis} totalBindings={props.bindings.length} onMenuOpen={open => menuOpen('other', open)} /> : null}</span>
}

function ChannelHeaderEntry({ channel, diagnosis, totalBindings, ...props }: Props & { channel?: ChannelEntry; totalBindings: number; diagnosis: ReturnType<typeof useConnectorGroupDiagnosis> }) {
  const { bindings, issue, checking, syncEnabled, visible, hostingTarget, onOpen, onConnect, onMenuOpen, onSettings } = props
  const navigation = useContext(SettingsNavigation)
  const title = channel?.title ?? 'Other channels', Icon = channel?.icon ?? ConnectionIcon
  const trigger = useRef<HTMLButtonElement>(null), selected = useRef<Selection | null>(null), handingOff = useRef(false)
  const only = bindings.length === 1 ? bindings[0]! : null
  const name = useConnectorRoomName(only, props.nameVersion, visible, hostingTarget)
  const summaries = bindings.map(binding => connectorGroupSummary(diagnosis.entries[connectorDiagnosisKey(binding)]?.report ?? null))
  const problems = summaries.flatMap(summary => summary.problems)
  const onlyProblem = problems.find(problem => problem.tone === 'warning') ?? problems[0]
  const unconfirmed = !!issue || checking && !bindings.length && props.nameVersion === 0
  const unchecked = bindings.some(binding => !diagnosis.entries[connectorDiagnosisKey(binding)]?.report)
  const state = unconfirmed ? 'unknown' : !bindings.length ? 'unbound' : problems.some(problem => problem.tone === 'warning') ? 'attention' :
    unchecked ? 'unknown' : problems.some(problem => problem.kind === 'sync-off' || problem.kind === 'platform-off') ? 'off' : problems.some(problem => problem.kind === 'sharing-paused') ? 'paused' : 'linked'
  const problemTitles = [...new Set(problems.map(problem => problem.title))]
  const label = unconfirmed ? hostingTarget === null ? 'Hosting unconfirmed' : checking ? 'Checking saved groups' : 'Group check unavailable' :
    !bindings.length ? 'No group linked' : problems.length ? problemTitles.slice(0, 2).join(' · ') + (problemTitles.length > 2 ? ` · +${problemTitles.length - 2}` : '') : unchecked ? 'Not checked' : 'Group linked'
  const summary = `${title} · ${label}${only ? ` · ${name.label}` : bindings.length ? ` · ${bindings.length} groups` : ''}`
  return <DropdownMenu.Root onOpenChange={open => {
    onMenuOpen(open)
    if (!open && selected.current && trigger.current) {
      const selection = selected.current; selected.current = null; handingOff.current = true
      if (selection.kind === 'binding') onOpen(selection.binding, trigger.current, channel?.adapterId, selection.action)
      else if (selection.kind === 'connect') onConnect(trigger.current, channel?.adapterId)
      else if (selection.kind === 'channel-settings' && channel) navigation?.open(channel.section)
      else onSettings?.(trigger.current, channel?.adapterId)
    }
  }}>
    <DropdownMenu.Trigger ref={trigger} className="agent-region-header__connector" data-channel-entry={channel?.adapterId ?? 'other'} data-channel-state={state}
      aria-label={summary} title={summary} aria-busy={checking || undefined} onPointerDown={event => event.stopPropagation()}>
      <Icon size={12} />{state !== 'unbound' ? <span className="agent-region-header__connector-marker" aria-hidden="true">{hostingTarget === null ? <HostIcon size={10} /> : onlyProblem ? <ConnectorProblemIcon kind={onlyProblem.kind} /> : unconfirmed || unchecked ? <UnknownIcon size={10} /> : <LinkIcon size={9} />}</span> : null}
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal><DropdownMenu.Content className="tab-context-menu connector-header-menu" align="end" side="bottom" sideOffset={2} collisionPadding={8}
      aria-label={`${title} connections`} onCloseAutoFocus={event => { if (handingOff.current) event.preventDefault(); handingOff.current = false }}>
      <DropdownMenu.Label className="connector-header-menu__title">{title}<small>{bindings.length ? `${bindings.length} group${bindings.length === 1 ? '' : 's'}` : label}</small></DropdownMenu.Label>
      {bindings.length ? bindings.map(binding => <GroupEntry key={binding.bindingId} binding={binding} hostingTarget={hostingTarget} visible={visible}
        name={only ? name : undefined} snapshot={diagnosis.entries[connectorDiagnosisKey(binding)]}
        identityLabel={bindings.length > 1 ? bindings.some(other => other !== binding && other.externalConversationId.endsWith(binding.externalConversationId.slice(-8))) ? binding.externalConversationId : '…' + binding.externalConversationId.slice(-8) : undefined}
        onSelect={action => { selected.current = { kind: 'binding', binding, ...(action ? { action } : {}) } }} onCheck={diagnosis.check} />)
        : <p className="connector-header-menu__empty">{checking ? 'Checking this Agent’s saved groups…' : issue ? hostingTarget === null ? 'Bot hosting is unconfirmed. Check its original Host.' : 'Saved groups could not be checked. Existing requests are kept.' : 'Connect this Agent’s conversation to a group.'}</p>}
      {props.bindings.some(binding => !diagnosis.entries[connectorDiagnosisKey(binding)]?.report) && totalBindings > diagnosis.limit ? <p className="connector-header-menu__empty">Only the first {diagnosis.limit} groups are checked here. Other groups are not checked; open their details.</p> : null}
      {issue ? <details className="connector-header-menu__diagnostics"><summary>{hostingTarget === null ? 'Bot hosting details' : 'Group check details'}</summary><p className="connector-header-menu__issue">{issue}</p></details> : null}
      <DropdownMenu.Separator className="tab-context-menu__separator" />
      <DropdownMenu.Item className="tab-context-menu__item" onSelect={() => { selected.current = { kind: 'connect' } }}>{issue && !bindings.length ? 'Check bot hosting' : props.retainedSetup ? 'Open channel setup' : 'Connect a conversation'}</DropdownMenu.Item>
      {channel && navigation ? <DropdownMenu.Item className="tab-context-menu__item" onSelect={() => { selected.current = { kind: 'channel-settings' } }}>Channel settings</DropdownMenu.Item> : null}
      {!channel && onSettings && hostingTarget ? <DropdownMenu.Item className="tab-context-menu__item" onSelect={() => { selected.current = { kind: 'settings' } }}>Automatic sync settings</DropdownMenu.Item> : null}
    </DropdownMenu.Content></DropdownMenu.Portal>
  </DropdownMenu.Root>
}

function GroupEntry(props: { binding: RoomBinding; visible: boolean; hostingTarget?: ConnectionHostingTarget | null | undefined; name: RoomName | undefined; snapshot: CheckedGroupDiagnosis | undefined; identityLabel: string | undefined; onSelect(action?: ConnectorGroupAction): void; onCheck(): void }) {
  const observedName = useConnectorRoomName(props.name ? null : props.binding, 0, props.visible, props.hostingTarget), name = props.name ?? observedName
  const { binding, snapshot } = props, status = connectorGroupDiagnostics(snapshot), summary = connectorGroupSummary(snapshot?.report ?? null)
  const action = connectorGroupAction(summary, binding.state)
  return <div className="connector-header-menu__group">
    <DropdownMenu.Item className="tab-context-menu__item connector-header-menu__item" onSelect={() => props.onSelect()}
      title={`${name.label} · ${binding.application.appId} · ${binding.externalConversationId}`}
      aria-label={`${name.label}; ${summary.problems.map(problem => problem.title).join('; ')}; ${binding.externalConversationId}; ${binding.connectionId}`}>
      <span><strong>{name.label}</strong>{props.identityLabel ? <small>Group {props.identityLabel}</small> : null}</span><DetailsIcon size={13} />
    </DropdownMenu.Item>
    <div className="connector-header-menu__traffic">
      <ConnectorTrafficSummary summary={summary} compact />
      <DropdownMenu.Item className="tab-context-menu__item connector-header-menu__action" data-connection-action={action.kind} onSelect={() => props.onSelect(action.kind)}>{action.label}<DetailsIcon size={12} /></DropdownMenu.Item>
      <details className="connector-header-menu__diagnostics"><summary>{snapshot?.checking ? 'Checking… · ' : ''}Checked details{snapshot?.checkedAt ? ` · ${new Date(snapshot.checkedAt).toLocaleTimeString()}` : ''}</summary>
        <div className="connector-header-menu__snapshot">
          <small className="connector-header-menu__checked">{snapshot?.checking ? 'Checking… · ' : ''}{snapshot?.checkedAt ? <><time dateTime={new Date(snapshot.checkedAt).toISOString()}>Checked {new Date(snapshot.checkedAt).toLocaleTimeString()}</time> · {status.outcome}</> : 'Not checked'}</small>
          {status.rows.map(([label, text]) => <small key={label}><b>{label}</b> {text}</small>)}
          {summary.problems.map(problem => <small key={problem.kind} data-problem-kind={problem.kind}><b>{problem.title}</b> · {problem.detail}</small>)}
          <small>{binding.application.domain} · {binding.application.appId} · {binding.externalConversationId} · {binding.connectionId}</small>
          {name.issue ? <small>{name.issue}</small> : null}
          {snapshot?.report ? <small>Snapshot of bounded local observations. Open group details for original receipts.</small> : null}
          <button type="button" className="agent-connector-text-action" onClick={props.onCheck}><RefreshIcon size={12} />Refresh observations</button>
        </div>
      </details>
    </div>
  </div>
}
