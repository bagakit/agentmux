import type { ReactNode } from 'react'
import { Tabs } from '@agentmux/client-ui/components/Tabs'
import { semanticIconComponent } from '@agentmux/client-ui/icons'

export type ConnectorGroupSection = 'overview' | 'members' | 'sharing' | 'joining' | 'diagnostics'
const sections = [
  { id: 'overview', label: 'Overview', icon: semanticIconComponent('action.inspect') },
  { id: 'members', label: 'Members', icon: semanticIconComponent('status.permission') },
  { id: 'sharing', label: 'Sharing', icon: semanticIconComponent('conversation.mixed') },
  { id: 'joining', label: 'Join', icon: semanticIconComponent('object.link') },
  { id: 'diagnostics', label: 'Diagnostics', icon: semanticIconComponent('status.unknown') }
] as const

/** The original dialog owns the form and scroll area; this compact context stays above it. */
export function ConnectorGroupDetailsHeader({ id, identity, relationship, configuration, section, onSection, attention }: {
  id: string; identity: ReactNode; relationship: ReactNode; configuration: ReactNode
  section: ConnectorGroupSection; onSection(section: ConnectorGroupSection): void
  attention?: Partial<Record<ConnectorGroupSection, 'check' | 'action'>> | undefined
}) {
  return <div className="connector-group-details__header">
    <div className="connector-group-details__identity">{identity}</div>
    <div className="connector-group-details__relationship" aria-label="Current conversation and group relationship">{relationship}</div>
    {section !== 'sharing' && section !== 'overview' ? <div className="connector-group-details__configuration">{configuration}</div> : null}
    <Tabs className="connector-group-details__tabs" aria-label="Group connection sections" value={section}
      onValueChange={onSection} options={sections.map(({ id: name, label, icon: Icon }) => {
        const status = attention?.[name]
        const description = status === 'action' ? 'Action needed' : 'Needs checking'
        return {
          value: name,
          panelId: `${id}-${name}-panel`,
          button: { id: `${id}-${name}-tab` },
          label: <><Icon size={14} /><span>{label}</span>
            {status ? <span className="connector-group-details__attention" aria-label={description} title={description}>{status === 'action' ? '!' : '?'}</span> : null}</>
        }
      })} />
  </div>
}

/** Keep panels mounted so original drafts, requests and record cursors survive navigation. */
export function ConnectorGroupDetails({ id, section, activity, members, sharing, joining }: {
  id: string; section: ConnectorGroupSection; activity: ReactNode; members: ReactNode; sharing: ReactNode; joining: ReactNode
}) {
  const panels = { members, sharing, joining }
  return <div className="connector-group-details">{activity}{sections.filter(item => item.id !== 'overview' && item.id !== 'diagnostics').map(({ id: name }) => <div key={name} id={`${id}-${name}-panel`} role="tabpanel" aria-labelledby={`${id}-${name}-tab`} hidden={section !== name} className="connector-group-details__panel" data-connection-panel={name}>
    {panels[name as keyof typeof panels]}
  </div>)}</div>
}
