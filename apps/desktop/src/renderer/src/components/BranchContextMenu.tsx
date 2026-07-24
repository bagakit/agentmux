import * as ContextMenu from '@radix-ui/react-context-menu'
import { Copy, FolderOpen, GitFork, RefreshCw } from 'lucide-react'
import type { ReactNode } from 'react'

export function BranchContextMenu({
  children,
  hasWorktree,
  onCopyBranchName,
  onCopyWorktreePath,
  onOpen,
  onRefresh
}: {
  children: ReactNode
  hasWorktree: boolean
  onCopyBranchName(): void
  onCopyWorktreePath(): void
  onOpen(): void
  onRefresh(): void
}) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className="tab-context-menu branch-context-menu"
          collisionPadding={8}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <ContextMenu.Item className="tab-context-menu__item" onSelect={onOpen}>
            {hasWorktree ? <FolderOpen size={14} /> : <GitFork size={14} />}
            <span>{hasWorktree ? 'Open Workspace' : 'Create Worktree'}</span>
          </ContextMenu.Item>
          <ContextMenu.Separator className="tab-context-menu__separator" />
          <ContextMenu.Item className="tab-context-menu__item" onSelect={onCopyBranchName}>
            <Copy size={14} />
            <span>Copy Branch Name</span>
          </ContextMenu.Item>
          {hasWorktree ? (
            <ContextMenu.Item className="tab-context-menu__item" onSelect={onCopyWorktreePath}>
              <Copy size={14} />
              <span>Copy Worktree Path</span>
            </ContextMenu.Item>
          ) : null}
          <ContextMenu.Separator className="tab-context-menu__separator" />
          <ContextMenu.Item className="tab-context-menu__item" onSelect={onRefresh}>
            <RefreshCw size={14} />
            <span>Refresh Branches</span>
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}
