import { useRef } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { RoomBinding } from '@agentmux/core/connections'
import * as DropdownMenu from './HoverDropdownMenu'
import { useConnectorRoomName } from '../lib/use-connector-room-name'

// Offline platform artwork from https://www.feishu.cn/favicon.ico; shared Feishu/Lark mark.
const feishuArtwork = new URL('../assets/connector-icons/feishu.ico', import.meta.url).href
const ConnectionIcon = semanticIconComponent('object.connection'), DownIcon = semanticIconComponent('navigation.down'), LoadingIcon = semanticIconComponent('status.loading')
function platform(binding: RoomBinding) {
  return binding.application.domain === 'open.feishu.cn' ? 'Feishu' : binding.application.domain === 'open.larksuite.com' ? 'Lark' : binding.application.domain
}
function PlatformIcon({ binding }: { binding: RoomBinding }) {
  return ['open.feishu.cn', 'open.larksuite.com'].includes(binding.application.domain)
    ? <img src={feishuArtwork} width={14} height={14} alt="" /> : <ConnectionIcon size={14} />
}
type RoomName = ReturnType<typeof useConnectorRoomName>
type Selection = { kind: 'binding'; binding: RoomBinding } | { kind: 'connect' | 'settings' }

/** One connection entry projects the original Session's relations and supported setup actions. */
export function ConnectorHeaderLinks({ bindings, unconfirmed, checking, retainedSetup, syncEnabled, nameVersion, onOpen, onConnect, onMenuOpen, onSettings }: {
  bindings: RoomBinding[]; unconfirmed: boolean; checking: boolean; retainedSetup: boolean; syncEnabled: boolean | null; nameVersion: number
  onOpen(binding: RoomBinding, trigger: HTMLElement): void; onConnect(trigger: HTMLElement): void; onMenuOpen(open: boolean): void; onSettings?(): void
}) {
  const trigger = useRef<HTMLButtonElement>(null), selected = useRef<Selection | null>(null), handingOff = useRef(false)
  const only = bindings.length === 1 ? bindings[0]! : null, name = useConnectorRoomName(only, nameVersion)
  const platformCounts = new Map<string, number>()
  for (const binding of bindings) platformCounts.set(platform(binding), (platformCounts.get(platform(binding)) ?? 0) + 1)
  const state = (binding: RoomBinding) => unconfirmed ? 'Status unknown' : binding.state === 'paused' ? 'Sharing paused' : syncEnabled === false ? 'Sync off' : syncEnabled === null ? 'Sync unknown' : 'Group connected'
  const summary = only ? name.label : bindings.length ? `Connections · ${bindings.length}` : 'Connections'
  const status = only ? state(only) : unconfirmed ? 'Status unknown' : ''
  const description = (binding: RoomBinding) => `${platform(binding)} · ${state(binding)} · ${binding.externalConversationId} · ${binding.application.domain} · ${binding.application.appId} · ${binding.connectionId}`
  const title = only ? `${name.label}. ${description(only)}${name.issue ? '. ' + name.issue : ''}. Open Connections for group details and automatic sync settings.` :
    `${summary}. ${unconfirmed ? 'Saved group status is unconfirmed. ' : ''}${checking ? 'Checking this Agent’s saved groups. ' : ''}Connect a Lark group or open automatic sync settings.`
  return <DropdownMenu.Root onOpenChange={open => {
    onMenuOpen(open)
    if (!open && selected.current && trigger.current) {
      const selection = selected.current; selected.current = null; handingOff.current = true
      if (selection.kind === 'binding') onOpen(selection.binding, trigger.current)
      else if (selection.kind === 'connect') onConnect(trigger.current)
      else onSettings?.()
    }
  }}>
    <DropdownMenu.Trigger ref={trigger} className="agent-region-header__connector" data-sharing-state={unconfirmed ? 'unknown' : only?.state ?? 'unbound'}
      aria-label={`Connections; ${title}`} title={title} aria-busy={checking || name.loading || undefined}
      onPointerDown={event => event.stopPropagation()}>
      {only ? <PlatformIcon binding={only} /> : checking ? <LoadingIcon size={14} animation="spin" /> : <ConnectionIcon size={14} />}
      <span>{summary}</span>{status && status !== 'Group connected' ? <small className="agent-region-header__connector-status">· {status}</small> : null}<DownIcon size={10} />
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal><DropdownMenu.Content className="tab-context-menu connector-header-menu" align="end" side="bottom" sideOffset={4} collisionPadding={8}
      onCloseAutoFocus={event => { if (handingOff.current) event.preventDefault(); handingOff.current = false }}>
      <DropdownMenu.Label className="connector-header-menu__title">Connections</DropdownMenu.Label>
      {bindings.length ? bindings.map(binding => {
        const props = { binding, state: state(binding), distinguish: platformCounts.get(platform(binding))! > 1,
          description: description(binding), onSelect: () => { selected.current = { kind: 'binding', binding } } }
        return only ? <ConnectorHeaderItem key={binding.bindingId} {...props} name={name} /> : <NamedConnectorHeaderItem key={binding.bindingId} {...props} />
      }) : <p className="connector-header-menu__empty">{checking ? 'Checking saved connections…' : unconfirmed ? 'Saved connections could not be checked.' : 'No external conversations connected.'}</p>}
      <DropdownMenu.Separator className="tab-context-menu__separator" />
      <DropdownMenu.Item className="tab-context-menu__item" onSelect={() => { selected.current = { kind: 'connect' } }}>{retainedSetup ? 'Continue Lark group setup' : 'Connect Lark group'}</DropdownMenu.Item>
      {onSettings ? <DropdownMenu.Item className="tab-context-menu__item" onSelect={() => { selected.current = { kind: 'settings' } }}>Automatic sync settings</DropdownMenu.Item> : null}
    </DropdownMenu.Content></DropdownMenu.Portal>
  </DropdownMenu.Root>
}

type ItemProps = { binding: RoomBinding; state: string; distinguish: boolean; description: string; onSelect(): void }
function NamedConnectorHeaderItem(props: ItemProps) {
  return <ConnectorHeaderItem {...props} name={useConnectorRoomName(props.binding)} />
}
function ConnectorHeaderItem({ binding, state, distinguish, description, onSelect, name }: ItemProps & { name: RoomName }) {
  return <DropdownMenu.Item className="tab-context-menu__item connector-header-menu__item" onSelect={onSelect}
    title={description} aria-label={`${name.label}; ${description}${name.issue ? '; ' + name.issue : ''}`}>
    <PlatformIcon binding={binding} /><span><strong>{name.label}</strong><small>{platform(binding)} · {state}{name.loading ? ' · Reading name…' : name.issue ? ' · ' + name.issue : ''}</small>
      {distinguish ? <small>{binding.application.appId} · …{binding.externalConversationId.slice(-12)}</small> : null}</span>
  </DropdownMenu.Item>
}
