import * as ContextMenu from '@radix-ui/react-context-menu'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useMemo, useState, type ReactNode } from 'react'
import {
  FILE_EXPLORER_DELETE_KEY,
  FILE_EXPLORER_RENAME_KEY,
  type FileExplorerMoveTarget
} from '../../lib/file-explorer-move'
import { isMacPlatform, revealInFileManagerLabel } from '../../lib/host-platform'
import { resolveOverlayContainer } from '../WindowOverlayHost'

const ThemeActionCreateFileIcon = semanticIconComponent('action.create-file')
const ThemeActionCreateFolderIcon = semanticIconComponent('action.create-folder')
const ThemeActionCopyIcon = semanticIconComponent('action.copy')
const ThemeActionCopyRelativePathIcon = semanticIconComponent('action.copy-relative-path')
const ThemeObjectTerminalIcon = semanticIconComponent('object.terminal')
const ThemeObjectFileIcon = semanticIconComponent('object.file')
const ThemeActionCollapseIcon = semanticIconComponent('action.collapse')
const ThemeActionRevealFileIcon = semanticIconComponent('action.reveal-file')
const ThemeActionEditIcon = semanticIconComponent('action.edit')
const ThemeNavigationSubmenuIcon = semanticIconComponent('navigation.submenu')
const ThemeActionMoveToFolderIcon = semanticIconComponent('action.move-to-folder')
const ThemeActionOpenProjectIcon = semanticIconComponent('action.open-project')
const ThemeActionRemoveIcon = semanticIconComponent('action.remove')


const EMPTY_MOVE_TARGETS: readonly FileExplorerMoveTarget[] = []

function stopRightButtonSelection(event: React.PointerEvent): void {
  if (event.button !== 2) return
  event.preventDefault()
  event.stopPropagation()
}

export function FileTreeContextMenu({
  children,
  canRename,
  canOpenTerminal,
  isDirectory,
  isExpanded,
  isLocal,
  selectionSize,
  getMoveTargets,
  onCollapse,
  onCopyPaths,
  onCreate,
  onDelete,
  onOpenChange,
  onOpenTerminal,
  onOpenAsProject,
  onMove,
  onRename,
  onReveal,
  onViewFile
}: {
  children: ReactNode
  canRename: boolean
  canOpenTerminal: boolean
  isDirectory: boolean
  isExpanded: boolean
  isLocal: boolean
  selectionSize: number
  getMoveTargets: () => readonly FileExplorerMoveTarget[]
  onCollapse: () => void
  onCopyPaths: (kind: 'absolute' | 'relative') => void
  onCreate: (kind: 'file' | 'directory') => void
  onDelete: () => void
  onOpenChange: (open: boolean) => void
  onOpenTerminal: () => void
  onOpenAsProject: () => void
  onMove: (directoryPath: string) => void
  onRename: () => void
  onReveal: () => void
  onViewFile: () => void
}) {
  const [open, setOpen] = useState(false)
  const moveTargets = useMemo(() => open ? getMoveTargets() : EMPTY_MOVE_TARGETS, [getMoveTargets, open])
  const isMac = isMacPlatform()
  const fileManagerLabel = revealInFileManagerLabel()
  return (
    <ContextMenu.Root onOpenChange={(nextOpen) => { setOpen(nextOpen); onOpenChange(nextOpen) }}>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal container={resolveOverlayContainer() as HTMLElement | undefined}>
        <ContextMenu.Content
          className="tab-context-menu file-context-menu"
          collisionPadding={8}
          onPointerUpCapture={stopRightButtonSelection}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <ContextMenu.Item className="tab-context-menu__item" onSelect={() => onCreate('file')}>
            <ThemeActionCreateFileIcon size={14} /><span>New File</span>
          </ContextMenu.Item>
          <ContextMenu.Item className="tab-context-menu__item" onSelect={() => onCreate('directory')}>
            <ThemeActionCreateFolderIcon size={14} /><span>New Folder</span>
          </ContextMenu.Item>
          <ContextMenu.Separator className="tab-context-menu__separator" />
          <ContextMenu.Item className="tab-context-menu__item" onSelect={() => onCopyPaths('absolute')}>
            <ThemeActionCopyIcon size={14} /><span>{selectionSize > 1 ? 'Copy Paths' : 'Copy Path'}</span>
          </ContextMenu.Item>
          <ContextMenu.Item className="tab-context-menu__item" onSelect={() => onCopyPaths('relative')}>
            <ThemeActionCopyRelativePathIcon size={14} /><span>{selectionSize > 1 ? 'Copy Relative Paths' : 'Copy Relative Path'}</span>
          </ContextMenu.Item>
          {isDirectory && canOpenTerminal ? (
            <ContextMenu.Item className="tab-context-menu__item" onSelect={onOpenTerminal}>
              <ThemeObjectTerminalIcon size={14} /><span>Open in Terminal</span>
            </ContextMenu.Item>
          ) : !isDirectory ? (
            <ContextMenu.Item className="tab-context-menu__item" onSelect={onViewFile}>
              <ThemeObjectFileIcon size={14} /><span>View File</span>
            </ContextMenu.Item>
          ) : null}
          {isDirectory ? (
            <ContextMenu.Item className="tab-context-menu__item" onSelect={onOpenAsProject}>
              <ThemeActionOpenProjectIcon size={14} /><span>Open as Project</span>
            </ContextMenu.Item>
          ) : null}
          {isDirectory && isExpanded ? (
            <ContextMenu.Item className="tab-context-menu__item" onSelect={onCollapse}>
              <ThemeActionCollapseIcon size={14} /><span>Collapse Folder</span>
            </ContextMenu.Item>
          ) : null}
          {isLocal ? (
            <ContextMenu.Item className="tab-context-menu__item" onSelect={onReveal}>
              <ThemeActionRevealFileIcon size={14} /><span>{fileManagerLabel}</span>
            </ContextMenu.Item>
          ) : null}
          <ContextMenu.Separator className="tab-context-menu__separator" />
          {canRename ? (
            <ContextMenu.Item className="tab-context-menu__item" onSelect={onRename}>
              <ThemeActionEditIcon size={14} /><span>Rename</span><kbd>{FILE_EXPLORER_RENAME_KEY.label(isMac)}</kbd>
            </ContextMenu.Item>
          ) : null}
          <ContextMenu.Sub>
            <ContextMenu.SubTrigger className="tab-context-menu__item" disabled={moveTargets.length === 0}>
              <ThemeActionMoveToFolderIcon size={14} /><span>Move This Item to</span><span className="tab-context-menu__chevron"><ThemeNavigationSubmenuIcon size={12} /></span>
            </ContextMenu.SubTrigger>
            <ContextMenu.Portal container={resolveOverlayContainer() as HTMLElement | undefined}>
              <ContextMenu.SubContent className="tab-context-menu file-context-menu" collisionPadding={8} sideOffset={4}>
                {moveTargets.map((target) => (
                  <ContextMenu.Item
                    key={target.path || 'workspace-root'}
                    className="tab-context-menu__item"
                    onSelect={() => onMove(target.path)}
                  >
                    <ThemeActionMoveToFolderIcon size={14} /><span>{target.label}</span>
                  </ContextMenu.Item>
                ))}
              </ContextMenu.SubContent>
            </ContextMenu.Portal>
          </ContextMenu.Sub>
          <ContextMenu.Item className="tab-context-menu__item file-context-menu__danger" onSelect={onDelete}>
            <ThemeActionRemoveIcon size={14} /><span>Delete</span><kbd>{FILE_EXPLORER_DELETE_KEY.label(isMac)}</kbd>
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}
