import { memo } from 'react'
import { NotebookText } from 'lucide-react'
import { SPACE_ICON_CATALOG, type SpaceIconId, type SpaceIconTarget } from '../lib/space-object-appearance'
import { projectMonogram } from '../lib/project-monogram'
import { MoteIcon } from './MoteIcon'
import { ProjectIcon } from './ProjectIcon'

/** Primitive props, no store/Session subscriptions and no automatic probe under a manual choice. */
export const SpaceObjectIcon = memo(function SpaceObjectIcon({ kind, name, manualIcon, workspaceId, lastActivityAt, visible }: {
  kind: SpaceIconTarget['kind']; name: string; manualIcon: SpaceIconId | null; workspaceId?: string
  lastActivityAt?: number | null | undefined; visible?: boolean | undefined
}) {
  if (manualIcon !== null) {
    const { Icon, label } = SPACE_ICON_CATALOG[manualIcon]
    return <span className="project-rail-row__icon space-object-icon" data-space-icon-source="manual"
      data-space-icon={manualIcon} title={`Icon · ${label}`} aria-hidden="true"><Icon size={14} /></span>
  }
  if (kind === 'folder') {
    if (!workspaceId) throw new Error('Automatic Folder icons require their registered Workspace.')
    return <ProjectIcon workspaceId={workspaceId} name={name} lastActivityAt={lastActivityAt} visible={visible} />
  }
  const monogram = kind === 'topic' ? projectMonogram(name) : ''
  return <span className="project-rail-row__icon space-object-icon" data-space-icon-source="automatic"
    {...(monogram ? { 'data-monogram': '' } : {})} title={kind === 'mote' ? 'Mote' : 'Topic'} aria-hidden="true">
    {kind === 'mote' ? <MoteIcon size={14} /> : monogram ? <span>{monogram}</span> : <NotebookText size={14} />}
  </span>
})
