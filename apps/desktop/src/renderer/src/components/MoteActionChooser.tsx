import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useMemo } from 'react'
import type { ScratchTopicSnapshot } from '../../../shared/contracts'
import { SCRATCH_WORKSPACE_ID } from '@agentmux/host/mote-model'
import { useAppStore } from '../store'
import { topicSpaceIconTarget } from '../lib/space-object-appearance'
import { SpaceObjectIcon } from './SpaceObjectIcon'
import * as DropdownMenu from './HoverDropdownMenu'

const ThemeStatusSelectedIcon = semanticIconComponent('status.selected')
const ThemeNavigationDownIcon = semanticIconComponent('navigation.down')

function LauncherMoteAvatar({ mote, topicId, active }: { mote?: ScratchTopicSnapshot | undefined; topicId: string; active: boolean }) {
  const workspace = useAppStore(state => state.config?.workspaces.find(item => item.id === SCRATCH_WORKSPACE_ID))
  const target = useMemo(() => workspace && mote ? topicSpaceIconTarget(workspace, mote) : undefined, [workspace, mote])
  const icon = useAppStore(state => target ? state.spaceObjectIcons[target.key] ?? null : null)
  return <SpaceObjectIcon kind="mote" name={mote?.title ?? 'Saved Mote'} manualIcon={icon} visible={active} readActive={active}
    avatarWorkspaceId={workspace?.id} avatarTopicId={topicId} avatarObjectKey={target?.key} />
}

/** One existing Mote choice, shared by creation and ordinary task handoffs. */
export function MoteActionChooser({ motes, topicId, pending, onSelect, active = true }: {
  motes: readonly ScratchTopicSnapshot[]; topicId: string; pending: boolean; onSelect(id: string): void; active?: boolean
}) {
  const selectedMote = motes.find(mote => mote.id === topicId)
  const availableMotes = motes.filter(mote => mote.moteArchive?.state !== 'archived')
  const moteName = selectedMote?.title ?? 'Saved Mote'
  return availableMotes.length > 1 || !availableMotes.some(mote => mote.id === topicId) ? <DropdownMenu.Root><DropdownMenu.Trigger className="launcher-mote__target" aria-label={`Choose Mote: ${moteName}`} title={moteName} disabled={pending}><LauncherMoteAvatar mote={selectedMote} topicId={topicId} active={active} /><span className="launcher-mote__name">{moteName}</span><ThemeNavigationDownIcon size={12} /></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="tab-context-menu composer-menu" side="top" align="start">{availableMotes.map(mote => <DropdownMenu.Item key={mote.id} className="tab-context-menu__item" onSelect={() => onSelect(mote.id)}><LauncherMoteAvatar mote={mote} topicId={mote.id} active={active} /><span>{mote.title}</span>{mote.id === topicId ? <span aria-label="Selected Mote"><ThemeStatusSelectedIcon size={12} /></span> : null}</DropdownMenu.Item>)}{availableMotes.length === 0 ? <DropdownMenu.Item className="tab-context-menu__item" disabled>No active Motes</DropdownMenu.Item> : null}</DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root> : <span className="launcher-mote__target" title={moteName}><LauncherMoteAvatar mote={selectedMote} topicId={topicId} active={active} /><span className="launcher-mote__name">{moteName}</span></span>
}

