import * as ContextMenu from '@radix-ui/react-context-menu'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { ReactNode } from 'react'
import { resolveOverlayContainer } from './WindowOverlayHost'

const ThemeObjectFolderOpenIcon = semanticIconComponent('object.folder-open')
const ThemeGitForkIcon = semanticIconComponent('git.fork')
const ThemeActionCopyIcon = semanticIconComponent('action.copy')
const ThemeActionRefreshIcon = semanticIconComponent('action.refresh')
const ThemeActionRemoveIcon = semanticIconComponent('action.remove')


export function BranchContextMenu({
  children,
  hasWorktree,
  onCopyBranchName,
  onCopyWorktreePath,
  onOpen,
  onRefresh,
  onRemoveWorktree
}: {
  children: ReactNode
  hasWorktree: boolean
  onCopyBranchName(): void
  onCopyWorktreePath(): void
  onOpen(): void
  onRefresh(): void
  onRemoveWorktree(): void
}) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal container={resolveOverlayContainer() as HTMLElement | undefined}>
        <ContextMenu.Content
          className="tab-context-menu branch-context-menu"
          collisionPadding={8}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <ContextMenu.Item className="tab-context-menu__item" onSelect={onOpen}>
            {hasWorktree ? <ThemeObjectFolderOpenIcon size={14} /> : <ThemeGitForkIcon size={14} />}
            <span>{hasWorktree ? 'Open Workspace' : 'Create Worktree'}</span>
          </ContextMenu.Item>
          <ContextMenu.Separator className="tab-context-menu__separator" />
          <ContextMenu.Item className="tab-context-menu__item" onSelect={onCopyBranchName}>
            <ThemeActionCopyIcon size={14} />
            <span>Copy Branch Name</span>
          </ContextMenu.Item>
          {hasWorktree ? (
            <ContextMenu.Item className="tab-context-menu__item" onSelect={onCopyWorktreePath}>
              <ThemeActionCopyIcon size={14} />
              <span>Copy Worktree Path</span>
            </ContextMenu.Item>
          ) : null}
          <ContextMenu.Separator className="tab-context-menu__separator" />
          <ContextMenu.Item className="tab-context-menu__item" onSelect={onRefresh}>
            <ThemeActionRefreshIcon size={14} />
            <span>Refresh Branches</span>
          </ContextMenu.Item>
          {/*
            只有绑了 worktree 的分支才给「移除」——没有 worktree 时这一项无事可做，按本仓惯例用
            缺席表达而不是画一个禁用的按钮。删除自己也不代表分支消失：worktree 只是那个分支的一份
            签出，移除它之后分支还在，仍会出现在「Without worktree」那组里。
          */}
          {hasWorktree ? (
            <>
              <ContextMenu.Separator className="tab-context-menu__separator" />
              <ContextMenu.Item
                className="tab-context-menu__item file-context-menu__danger"
                onSelect={onRemoveWorktree}
              >
                <ThemeActionRemoveIcon size={14} />
                <span>Remove Worktree</span>
              </ContextMenu.Item>
            </>
          ) : null}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}
