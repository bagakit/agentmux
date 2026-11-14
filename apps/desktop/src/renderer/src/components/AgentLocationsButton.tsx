import { semanticIconComponent } from '@agentmux/client-ui/icons'
import * as DropdownMenu from './HoverDropdownMenu'
import { useAppStore } from '../store'

const LocationIcon = semanticIconComponent('navigation.space')

/** A disclosure of original display facts, never Session or Run control. */
export function AgentLocationsButton({ sessionId, name, count, menu = false, beforeOpen }: {
  sessionId: string; name: string; count?: number | undefined; menu?: boolean; beforeOpen?: () => void
}) {
  const label = `${name} · ${count === undefined ? 'locations unconfirmed' : `${count} ${count === 1 ? 'location' : 'locations'}`} · Choose location`
  const open = () => { beforeOpen?.(); useAppStore.getState().requestSessionLocations(sessionId) }
  const content = <><LocationIcon size={12} aria-hidden="true" /><span>{count ?? '…'}</span></>
  return menu ? <DropdownMenu.Item className="agent-locations" aria-label={label} title={label} onSelect={open}>{content}</DropdownMenu.Item>
    : <button type="button" className="agent-locations" aria-label={label} title={label} onClick={open}>{content}</button>
}
