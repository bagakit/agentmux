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
const AgentIcon = semanticIconComponent('object.agent')

export type MoteChooserNewAgent = { kind: 'new-agent'; key: string; label?: string; selected: boolean; onSelect(): void }

function LauncherMoteAvatar({ mote, topicId, active }: { mote?: ScratchTopicSnapshot | undefined; topicId: string; active: boolean }) {
  const workspace = useAppStore(state => state.config?.workspaces.find(item => item.id === SCRATCH_WORKSPACE_ID))
  const target = useMemo(() => workspace && mote ? topicSpaceIconTarget(workspace, mote) : undefined, [workspace, mote])
  const icon = useAppStore(state => target ? state.spaceObjectIcons[target.key] ?? null : null)
  return <SpaceObjectIcon kind="mote" name={mote?.title ?? 'Saved Mote'} manualIcon={icon} visible={active} readActive={active}
    avatarWorkspaceId={workspace?.id} avatarTopicId={topicId} avatarObjectKey={target?.key} />
}

/** One existing Mote choice, shared by creation and ordinary task handoffs. */
export function MoteActionChooser({ motes, topicId, pending, onSelect, active = true, newAgent, menuContainer }: {
  motes: readonly ScratchTopicSnapshot[]; topicId: string; pending: boolean; onSelect(id: string): void; active?: boolean
  newAgent?: MoteChooserNewAgent | undefined; menuContainer?: HTMLElement | null | undefined
}) {
  const selectedMote = motes.find(mote => mote.id === topicId)
  const availableMotes = motes.filter(mote => mote.moteArchive?.state !== 'archived')
  const moteName = selectedMote?.title ?? 'Saved Mote'
  const recipientName = newAgent?.selected ? newAgent.label ?? 'New Agent' : moteName
  return newAgent || availableMotes.length > 1 || !availableMotes.some(mote => mote.id === topicId) ? <DropdownMenu.Root><DropdownMenu.Trigger className="launcher-mote__target" aria-label={`${newAgent ? 'Choose recipient' : 'Choose Mote'}: ${recipientName}`} title={recipientName} disabled={pending}>{newAgent?.selected ? <AgentIcon size={18} /> : <LauncherMoteAvatar mote={selectedMote} topicId={topicId} active={active} />}<span className="launcher-mote__name">{recipientName}</span><ThemeNavigationDownIcon size={12} /></DropdownMenu.Trigger><DropdownMenu.Portal {...(menuContainer ? { container: menuContainer } : {})}><DropdownMenu.Content className="tab-context-menu composer-menu" side="top" align="start">{availableMotes.map(mote => <DropdownMenu.Item key={mote.id} className="tab-context-menu__item" onSelect={() => onSelect(mote.id)}><LauncherMoteAvatar mote={mote} topicId={mote.id} active={active} /><span>{mote.title}</span>{!newAgent?.selected && mote.id === topicId ? <span aria-label="Selected Mote"><ThemeStatusSelectedIcon size={12} /></span> : null}</DropdownMenu.Item>)}{availableMotes.length === 0 ? <DropdownMenu.Item className="tab-context-menu__item" disabled>No active Motes</DropdownMenu.Item> : null}{newAgent ? <><DropdownMenu.Separator className="tab-context-menu__separator" /><DropdownMenu.Item className="tab-context-menu__item" onSelect={newAgent.onSelect}><AgentIcon size={18} /><span>{newAgent.label ?? 'New Agent'}</span>{newAgent.selected ? <span aria-label="Selected recipient"><ThemeStatusSelectedIcon size={12} /></span> : null}</DropdownMenu.Item></> : null}</DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root> : <span className="launcher-mote__target" title={moteName}><LauncherMoteAvatar mote={selectedMote} topicId={topicId} active={active} /><span className="launcher-mote__name">{moteName}</span></span>
}

