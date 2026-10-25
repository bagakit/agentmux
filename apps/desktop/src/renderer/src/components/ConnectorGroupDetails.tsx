import { useId, useRef, type ReactNode } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import '../styles/connector-group-details.css'

export type ConnectorGroupSection = 'overview' | 'members' | 'sharing' | 'joining'
const sections = [
  { id: 'overview', label: 'Overview', icon: semanticIconComponent('action.inspect') },
  { id: 'members', label: 'Member access', icon: semanticIconComponent('status.permission') },
  { id: 'sharing', label: 'Sharing', icon: semanticIconComponent('conversation.mixed') },
  { id: 'joining', label: 'Join group', icon: semanticIconComponent('object.link') }
] as const

/** Presentation only: the original form keeps drafts, requests, bindings and every operation. */
export function ConnectorGroupDetails({ identity, bot, section, onSection, overview, members, sharing, joining }: {
  identity: ReactNode; bot: ReactNode; section: ConnectorGroupSection; onSection(section: ConnectorGroupSection): void
  overview: ReactNode; members: ReactNode; sharing: ReactNode; joining: ReactNode
}) {
  const id = useId(), tabs = useRef<Array<HTMLButtonElement | null>>([])
  const panels = { overview, members, sharing, joining }
  return <div className="connector-group-details">
    <div className="connector-group-details__identity">{identity}<div className="connector-group-details__bot">{bot}</div></div>
    <div className="connector-group-details__tabs" role="tablist" aria-label="Group connection sections">
      {sections.map(({ id: name, label, icon: Icon }, index) => <button key={name} ref={node => { tabs.current[index] = node }} type="button" role="tab" id={`${id}-${name}-tab`}
        aria-controls={`${id}-${name}-panel`} aria-selected={section === name} tabIndex={section === name ? 0 : -1}
        onClick={() => onSection(name)} onKeyDown={event => {
          const next = event.key === 'ArrowRight' ? (index + 1) % sections.length : event.key === 'ArrowLeft' ? (index + sections.length - 1) % sections.length : event.key === 'Home' ? 0 : event.key === 'End' ? sections.length - 1 : null
          if (next === null) return
          event.preventDefault(); onSection(sections[next]!.id); tabs.current[next]?.focus({ preventScroll: true })
        }}><Icon size={14} /><span>{label}</span></button>)}
    </div>
    {sections.map(({ id: name }) => <div key={name} id={`${id}-${name}-panel`} role="tabpanel" aria-labelledby={`${id}-${name}-tab`} hidden={section !== name} className="connector-group-details__panel" data-connection-panel={name}>
      {panels[name]}
    </div>)}
  </div>
}
