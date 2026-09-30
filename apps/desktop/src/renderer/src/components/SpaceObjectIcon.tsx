import { memo, useEffect, useState } from 'react'
import { NotebookText } from 'lucide-react'
import { SPACE_ICON_CATALOG, type SpaceIconChoice, type SpaceIconTarget } from '../lib/space-object-appearance'
import type { MoteAvatarRef } from '../../../shared/mote-avatars'
import { PMO_TEAMS_TOPIC_ID } from '../../../shared/scratch-topics'
import { api } from '../lib/api'
import { presentError } from '../lib/error-presentation'
import { useAppStore } from '../store'
import { projectMonogram } from '../lib/project-monogram'
import defaultMoteAvatar from '../assets/pmo-teams-topic-avatar.png'
import { MoteIcon } from './MoteIcon'
import { ProjectIcon } from './ProjectIcon'

function MoteAvatar({ workspaceId, topicId, choice, objectKey }: { workspaceId: string; topicId: string; choice: MoteAvatarRef; objectKey: string }) {
  const [image, setImage] = useState<{ identity: string; url: string } | null>(null)
  const [issue, setIssue] = useState<string | null>(null)
  const identity = objectKey, fileName = choice.fileName
  useEffect(() => {
    let current = true
    setIssue(null)
    void api.scratch.readMoteAvatar(workspaceId, topicId, { kind: 'image', fileName }, objectKey).then(value => {
      if (current) setImage({ identity, url: value.dataUrl })
    }).catch(cause => {
      if (!current) return
      const message = 'This Mote avatar could not be read. Its saved choice is retained; choose Change avatar, then Save avatar to retry. ' + presentError(cause)
      setIssue(message); useAppStore.getState().reportError(new Error(message))
    })
    return () => { current = false }
  }, [workspaceId, topicId, choice, fileName, identity, objectKey])
  return <span className="project-rail-row__icon space-object-icon" data-space-icon-source="image"
    data-space-avatar={fileName} title={issue ?? 'Mote avatar'} aria-hidden="true">
    {image?.identity === identity ? <img className="space-object-icon__avatar" src={image.url} alt="" draggable={false} /> : <MoteIcon size={14} />}
  </span>
}

/** Primitive props; reads only this consumer's selected asset, never Session or directory scans. */
export const SpaceObjectIcon = memo(function SpaceObjectIcon({ kind, name, manualIcon, workspaceId, lastActivityAt, visible, topicGlyph = false, avatarWorkspaceId, avatarTopicId, avatarObjectKey }: {
  kind: SpaceIconTarget['kind']; name: string; manualIcon: SpaceIconChoice | null; workspaceId?: string
  avatarWorkspaceId?: string | undefined; avatarTopicId?: string | undefined; avatarObjectKey?: string | undefined
  lastActivityAt?: number | null | undefined; visible?: boolean | undefined; topicGlyph?: boolean
}) {
  if (manualIcon && typeof manualIcon === 'object') {
    if (!avatarWorkspaceId || !avatarTopicId || !avatarObjectKey) return <span className="space-object-icon" data-space-icon-source="image" title="Saved avatar target is unavailable" aria-hidden="true"><MoteIcon size={14} /></span>
    return <MoteAvatar workspaceId={avatarWorkspaceId} topicId={avatarTopicId} choice={manualIcon} objectKey={avatarObjectKey} />
  }
  if (manualIcon !== null) {
    const { Icon, label } = SPACE_ICON_CATALOG[manualIcon]
    return <span className="project-rail-row__icon space-object-icon" data-space-icon-source="manual"
      data-space-icon={manualIcon} title={`Icon · ${label}`} aria-hidden="true"><Icon size={14} /></span>
  }
  if (kind === 'folder') {
    if (!workspaceId) throw new Error('Automatic Folder icons require their registered Workspace.')
    return <ProjectIcon workspaceId={workspaceId} name={name} lastActivityAt={lastActivityAt} visible={visible} />
  }
  const monogram = kind === 'topic' && !topicGlyph ? projectMonogram(name) : ''
  return <span className="project-rail-row__icon space-object-icon" data-space-icon-source="automatic"
    {...(monogram ? { 'data-monogram': '' } : {})} title={kind === 'mote' ? 'Mote' : 'Topic'} aria-hidden="true">
    {kind === 'mote' ? avatarTopicId === PMO_TEAMS_TOPIC_ID ? <img className="space-object-icon__avatar" src={defaultMoteAvatar} alt="" /> : <MoteIcon size={14} /> : monogram ? <span>{monogram}</span> : <NotebookText size={14} />}
  </span>
})
