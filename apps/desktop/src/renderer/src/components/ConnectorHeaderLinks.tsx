import { useRef } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { RoomBinding } from '@agentmux/core/connections'
import * as DropdownMenu from './HoverDropdownMenu'

// Offline platform artwork from https://www.feishu.cn/favicon.ico; shared Feishu/Lark mark.
const feishuArtwork = new URL('../assets/connector-icons/feishu.ico', import.meta.url).href
const ConnectionIcon = semanticIconComponent('object.connection')
function platform(binding: RoomBinding) {
  return binding.application.domain === 'open.feishu.cn' ? 'Feishu' : binding.application.domain === 'open.larksuite.com' ? 'Lark' : binding.application.domain
}
function PlatformIcon({ binding }: { binding: RoomBinding }) {
  return ['open.feishu.cn', 'open.larksuite.com'].includes(binding.application.domain)
    ? <img src={feishuArtwork} width={14} height={14} alt="" /> : <ConnectionIcon size={14} />
}

/** A projection of this Session's original bindings; it owns no discovery or group effects. */
export function ConnectorHeaderLinks({ bindings, unconfirmed, syncEnabled, onOpen }: {
  bindings: RoomBinding[]; unconfirmed: boolean; syncEnabled: boolean | null; onOpen(binding: RoomBinding, trigger: HTMLElement): void
}) {
  const trigger = useRef<HTMLButtonElement>(null), selected = useRef<RoomBinding | null>(null), handingOff = useRef(false)
  const state = (binding: RoomBinding) => unconfirmed ? 'Status unknown' : binding.state === 'paused' ? 'Sharing paused' : syncEnabled === false ? 'Sync off' : 'Group connected'
  if (!bindings.length) return null
  const only = bindings.length === 1 ? bindings[0]! : null
  const sync = syncEnabled === null ? 'Automatic chat sync is not confirmed.' : syncEnabled ? 'Automatic chat sync is enabled.' : 'Automatic chat sync is off.'
  const description = (binding: RoomBinding) => `${platform(binding)} · ${state(binding)} · ${binding.externalConversationId} · ${binding.application.appId}. ${unconfirmed ? 'Current local binding is unconfirmed; the last known group is kept.' : binding.state === 'active' ? 'Group binding is saved locally.' : 'Local sharing is paused.'} ${sync}`
  if (only) return <button type="button" className="agent-region-header__connector" data-sharing-state={unconfirmed ? 'unknown' : only.state}
    aria-label={`Open ${platform(only)} group and joining details; ${description(only)}`} title={description(only)}
    onPointerDown={event => event.stopPropagation()} onClick={event => onOpen(only, event.currentTarget)}>
    <PlatformIcon binding={only} /><span>{state(only)}</span>
  </button>
  return <DropdownMenu.Root onOpenChange={open => {
    if (!open && selected.current && trigger.current) { const binding = selected.current; selected.current = null; handingOff.current = true; onOpen(binding, trigger.current) }
  }}>
    <DropdownMenu.Trigger ref={trigger} className="agent-region-header__connector" aria-label={`Choose from ${bindings.length} connected groups`} title="Open a connected group and joining details"
      onPointerDown={event => event.stopPropagation()}><ConnectionIcon size={14} /><span>{bindings.length} groups</span></DropdownMenu.Trigger>
    <DropdownMenu.Portal><DropdownMenu.Content className="tab-context-menu connector-header-menu" align="end" side="bottom" sideOffset={4} collisionPadding={8}
      onCloseAutoFocus={event => { if (handingOff.current) event.preventDefault(); handingOff.current = false }}>
      <DropdownMenu.Label className="connector-header-menu__title">Connected groups</DropdownMenu.Label>
      {bindings.map(binding => <DropdownMenu.Item key={binding.bindingId} className="tab-context-menu__item connector-header-menu__item"
        onSelect={() => { selected.current = binding }}>
        <PlatformIcon binding={binding} /><span><strong>{platform(binding)} · {state(binding)}</strong><small>{binding.externalConversationId}</small><small>{binding.application.appId} · {binding.connectionId}</small></span>
      </DropdownMenu.Item>)}
    </DropdownMenu.Content></DropdownMenu.Portal>
  </DropdownMenu.Root>
}
