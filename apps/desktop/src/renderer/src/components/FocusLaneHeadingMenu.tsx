import * as ContextMenu from '@radix-ui/react-context-menu'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { ReactNode } from 'react'
import type { TopicCategory } from '@agentmux/core/control'
import type { FocusScanLane } from '../lib/focus-collection-lanes'
import { categorySpaceIconTarget, folderSpaceIconTarget, type SpaceIconTarget } from '../lib/space-object-appearance'
import { formatSpaceAddress } from '@agentmux/core/sharing'
import { copyTextToClipboard } from '../lib/clipboard-copy'
import { useAppStore } from '../store'
import { categoryMenuItems } from './TopicCategoryMenu'
import { WorkspaceRowContextMenu } from './WorkspaceRowContextMenu'
import { useSpaceObjectMenu } from './SpaceObjectContextMenu'
import { DocumentOverlayPortal } from './WindowOverlayHost'
import { WorkbenchMenuSubmenu } from './WorkbenchMenuSubmenu'

const DisclosureIcon = semanticIconComponent('navigation.disclosure')
const CollectionIcon = semanticIconComponent('object.folder')

/** Only the heading is a trigger. Agent cards retain their own original menu. */
export function FocusLaneHeadingMenu({ lane, children, enabled = false, collapsed = false, onToggleCollection, onChangeIcon, onRename }: {
  lane: FocusScanLane; children: ReactNode; enabled?: boolean; collapsed?: boolean; onToggleCollection?(): void
  onChangeIcon(target: SpaceIconTarget): void; onRename(category: TopicCategory): void
}) {
  if (!enabled) return children
  return lane.collection ? <CollectionHeadingMenu lane={lane} collapsed={collapsed} onToggle={onToggleCollection}
      onChangeIcon={onChangeIcon} onRename={onRename}>{children}</CollectionHeadingMenu>
      : lane.objectKind === 'topic' || lane.objectKind === 'mote' ? children
        : <ProjectHeadingMenu lane={lane} onChangeIcon={onChangeIcon}>{children}</ProjectHeadingMenu>
}

function ProjectHeadingMenu({ lane, children, onChangeIcon }: {
  lane: FocusScanLane; children: ReactNode; onChangeIcon(target: SpaceIconTarget): void
}) {
  const config = useAppStore(state => state.config)
  // A retained checkout can share its repository's ID without sharing its path.
  // The existing path actions may run only against this exact registered resource.
  const workspace = config?.workspaces.find(workspace => workspace.id === lane.workspaceId &&
    workspace.hostId === lane.hostId && workspace.path === lane.path)
  const project = config?.workspaces.find(workspace => workspace.id === lane.projectWorkspaceId && workspace.hostId === lane.hostId)
  const iconTarget = project ? folderSpaceIconTarget({ hostId: project.hostId, repoPath: project.repoPath ?? project.path, name: project.name }) : null
  return <WorkspaceRowContextMenu path={lane.path} branch={workspace?.branch ?? null}
    workspaceId={workspace?.id ?? lane.workspaceId}
    isLocal={Boolean(workspace && config?.hosts.some(host => host.id === workspace.hostId && host.kind === 'local'))}
    {...(iconTarget ? { onChangeIcon: () => onChangeIcon(iconTarget) } : {})}>{children}</WorkspaceRowContextMenu>
}

function CollectionHeadingMenu({ lane, children, collapsed, onToggle, onChangeIcon, onRename }: {
  lane: FocusScanLane; children: ReactNode; collapsed: boolean; onToggle?: (() => void) | undefined
  onChangeIcon(target: SpaceIconTarget): void; onRename(category: TopicCategory): void
}) {
  const menu = useSpaceObjectMenu()
  const config = useAppStore(state => state.config)
  const currentCategories = useAppStore(state => state.topicCategories)
  const reportError = useAppStore(state => state.reportError)
  const categories = lane.collection?.confirmed ? lane.collection.categories : []
  function actions(category: TopicCategory) {
    // topics IPC targets the original local owner and has no Host argument.
    // A same-ID/revision Category from another Host is never a local write target.
    const original = category.hostId === lane.hostId && category.hostId === 'local' &&
      config?.hosts.some(host => host.id === category.hostId && host.kind === 'local')
      ? currentCategories.find(current => current.hostId === category.hostId &&
        current.categoryId === category.categoryId && current.spaceId === category.spaceId) : undefined
    return { target: categorySpaceIconTarget(category),
      ...(original ? { onChangeIcon: () => onChangeIcon(categorySpaceIconTarget(original)), onRename: () => onRename(original) } : {}),
      onCopyLink: () => void copyTextToClipboard(formatSpaceAddress({ spaceId: category.spaceId }), reportError) }
  }
  function source(category: TopicCategory) {
    return <ContextMenu.Label className="tab-context-menu__hint">Host · {config?.hosts.find(host => host.id === category.hostId)?.label ?? category.hostId}</ContextMenu.Label>
  }
  return <ContextMenu.Root onOpenChange={menu.onOpenChange}>
    <ContextMenu.Trigger asChild {...menu.triggerProps}>{children}</ContextMenu.Trigger>
    <DocumentOverlayPortal component={ContextMenu.Portal}>
      <ContextMenu.Content className="tab-context-menu" collisionPadding={8} onCloseAutoFocus={menu.onCloseAutoFocus}>
        {categories.length === 1 ? <>{source(categories[0]!)}{categoryMenuItems(ContextMenu.Item, ContextMenu.Separator, actions(categories[0]!), menu.changeIcon)}</>
          : categories.map(category => <WorkbenchMenuSubmenu key={JSON.stringify([category.hostId, category.spaceId])}
            label={category.title} icon={<CollectionIcon size={14} />}>
              {source(category)}{categoryMenuItems(ContextMenu.Item, ContextMenu.Separator, actions(category), menu.changeIcon)}
            </WorkbenchMenuSubmenu>)}
        {onToggle ? <>{categories.length ? <ContextMenu.Separator className="tab-context-menu__separator" /> : null}
          <ContextMenu.Item className="tab-context-menu__item" onSelect={onToggle}><DisclosureIcon size={14} /><span>{collapsed ? 'Expand Collection' : 'Collapse Collection'}</span></ContextMenu.Item>
        </> : null}
      </ContextMenu.Content>
    </DocumentOverlayPortal>
  </ContextMenu.Root>
}
