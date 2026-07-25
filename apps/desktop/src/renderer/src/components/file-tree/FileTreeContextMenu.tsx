import * as ContextMenu from '@radix-ui/react-context-menu'
import {
  ChevronUp,
  Copy,
  ExternalLink,
  File,
  FilePlus2,
  FolderInput,
  FolderPlus,
  Pencil,
  SquareTerminal,
  Trash2
} from 'lucide-react'
import type { ReactNode } from 'react'
import type { FileExplorerMoveTarget } from '../../lib/file-explorer-move'

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
  moveTargets,
  onCollapse,
  onCopyPaths,
  onCreate,
  onDelete,
  onOpenChange,
  onOpenTerminal,
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
  moveTargets: readonly FileExplorerMoveTarget[]
  onCollapse: () => void
  onCopyPaths: (kind: 'absolute' | 'relative') => void
  onCreate: (kind: 'file' | 'directory') => void
  onDelete: () => void
  onOpenChange: (open: boolean) => void
  onOpenTerminal: () => void
  onMove: (directoryPath: string) => void
  onRename: () => void
  onReveal: () => void
  onViewFile: () => void
}) {
  const isMac = navigator.userAgent.includes('Mac')
  const fileManagerLabel = isMac
    ? 'Reveal in Finder'
    : navigator.userAgent.includes('Windows')
      ? 'Reveal in File Explorer'
      : 'Reveal in File Manager'
  return (
    <ContextMenu.Root onOpenChange={onOpenChange}>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className="tab-context-menu file-context-menu"
          collisionPadding={8}
          onPointerUpCapture={stopRightButtonSelection}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <ContextMenu.Item className="tab-context-menu__item" onSelect={() => onCreate('file')}>
            <FilePlus2 size={14} /><span>New File</span>
          </ContextMenu.Item>
          <ContextMenu.Item className="tab-context-menu__item" onSelect={() => onCreate('directory')}>
            <FolderPlus size={14} /><span>New Folder</span>
          </ContextMenu.Item>
          <ContextMenu.Separator className="tab-context-menu__separator" />
          <ContextMenu.Item className="tab-context-menu__item" onSelect={() => onCopyPaths('absolute')}>
            <Copy size={14} /><span>{selectionSize > 1 ? 'Copy Paths' : 'Copy Path'}</span>
          </ContextMenu.Item>
          <ContextMenu.Item className="tab-context-menu__item" onSelect={() => onCopyPaths('relative')}>
            <Copy size={14} /><span>{selectionSize > 1 ? 'Copy Relative Paths' : 'Copy Relative Path'}</span>
          </ContextMenu.Item>
          {isDirectory && canOpenTerminal ? (
            <ContextMenu.Item className="tab-context-menu__item" onSelect={onOpenTerminal}>
              <SquareTerminal size={14} /><span>Open in Terminal</span>
            </ContextMenu.Item>
          ) : !isDirectory ? (
            <ContextMenu.Item className="tab-context-menu__item" onSelect={onViewFile}>
              <File size={14} /><span>View File</span>
            </ContextMenu.Item>
          ) : null}
          {isDirectory && isExpanded ? (
            <ContextMenu.Item className="tab-context-menu__item" onSelect={onCollapse}>
              <ChevronUp size={14} /><span>Collapse Folder</span>
            </ContextMenu.Item>
          ) : null}
          {isLocal ? (
            <ContextMenu.Item className="tab-context-menu__item" onSelect={onReveal}>
              <ExternalLink size={14} /><span>{fileManagerLabel}</span>
            </ContextMenu.Item>
          ) : null}
          <ContextMenu.Separator className="tab-context-menu__separator" />
          {canRename ? (
            <ContextMenu.Item className="tab-context-menu__item" onSelect={onRename}>
              <Pencil size={14} /><span>Rename</span><kbd>{isMac ? '↩' : 'Enter'}</kbd>
            </ContextMenu.Item>
          ) : null}
          <ContextMenu.Sub>
            <ContextMenu.SubTrigger className="tab-context-menu__item" disabled={moveTargets.length === 0}>
              <FolderInput size={14} /><span>Move This Item to</span><span className="tab-context-menu__chevron">›</span>
            </ContextMenu.SubTrigger>
            <ContextMenu.Portal>
              <ContextMenu.SubContent className="tab-context-menu file-context-menu" collisionPadding={8} sideOffset={4}>
                {moveTargets.map((target) => (
                  <ContextMenu.Item
                    key={target.path || 'workspace-root'}
                    className="tab-context-menu__item"
                    onSelect={() => onMove(target.path)}
                  >
                    <FolderInput size={14} /><span>{target.label}</span>
                  </ContextMenu.Item>
                ))}
              </ContextMenu.SubContent>
            </ContextMenu.Portal>
          </ContextMenu.Sub>
          <ContextMenu.Item className="tab-context-menu__item file-context-menu__danger" onSelect={onDelete}>
            <Trash2 size={14} /><span>Delete</span><kbd>{isMac ? '⌘⌫' : 'Del'}</kbd>
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}
