import { useRef, type ReactNode } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import '../styles/connector-group-details.css'

export type ConnectorGroupSection = 'overview' | 'members' | 'sharing' | 'joining'
const sections = [
  { id: 'overview', label: 'Overview', icon: semanticIconComponent('action.inspect') },
  { id: 'members', label: 'Member access', icon: semanticIconComponent('status.permission') },
  { id: 'sharing', label: 'Sharing', icon: semanticIconComponent('conversation.mixed') },
  { id: 'joining', label: 'Join group', icon: semanticIconComponent('object.link') }
] as const

/** The original dialog owns the form and scroll area; this compact context stays above it. */
export function ConnectorGroupDetailsHeader({ id, identity, relationship, configuration, section, onSection }: {
  id: string; identity: ReactNode; relationship: ReactNode; configuration: ReactNode
  section: ConnectorGroupSection; onSection(section: ConnectorGroupSection): void
}) {
  const tabs = useRef<Array<HTMLButtonElement | null>>([])
  return <div className="connector-group-details__header">
    <div className="connector-group-details__identity">{identity}</div>
    <div className="connector-group-details__relationship" aria-label="Current conversation and group relationship">{relationship}</div>
    <div className="connector-group-details__configuration">{configuration}</div>
    <div className="connector-group-details__tabs" role="tablist" aria-label="Group connection sections">
      {sections.map(({ id: name, label, icon: Icon }, index) => <button key={name} ref={node => { tabs.current[index] = node }} type="button" role="tab" id={`${id}-${name}-tab`}
        aria-controls={`${id}-${name}-panel`} aria-selected={section === name} tabIndex={section === name ? 0 : -1}
        onClick={() => onSection(name)} onKeyDown={event => {
          const next = event.key === 'ArrowRight' ? (index + 1) % sections.length : event.key === 'ArrowLeft' ? (index + sections.length - 1) % sections.length : event.key === 'Home' ? 0 : event.key === 'End' ? sections.length - 1 : null
          if (next === null) return
          event.preventDefault(); onSection(sections[next]!.id); tabs.current[next]?.focus({ preventScroll: true })
        }}><Icon size={14} /><span>{label}</span></button>)}
    </div>
  </div>
}

/** Keep panels mounted so original drafts, requests and record cursors survive navigation. */
export function ConnectorGroupDetails({ id, section, overview, members, sharing, joining }: {
  id: string; section: ConnectorGroupSection; overview: ReactNode; members: ReactNode; sharing: ReactNode; joining: ReactNode
}) {
  const panels = { overview, members, sharing, joining }
  return <div className="connector-group-details">{sections.map(({ id: name }) => <div key={name} id={`${id}-${name}-panel`} role="tabpanel" aria-labelledby={`${id}-${name}-tab`} hidden={section !== name} className="connector-group-details__panel" data-connection-panel={name}>
    {panels[name]}
  </div>)}</div>
}
