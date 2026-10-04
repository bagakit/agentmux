import * as ContextMenu from '@radix-ui/react-context-menu'
import {
  Columns2,
  Check,
  Copy,
  CornerDownRight,
  Crosshair,
  ExternalLink,
  FolderSymlink,
  LayoutGrid,
  Pencil,
  ListX,
  PanelLeftClose,
  PanelRightClose,
  X
} from 'lucide-react'
import type { ReactNode } from 'react'
import type { AgentMuxArrangeMode } from '@agentmux/core/control'
import {
  WORKBENCH_TAB_SPLIT_ACTIONS,
  workbenchRegionLayoutMenuEntries,
  type MoveSessionViewTarget
} from '../lib/workbench-tab-actions'
import type { SplitDirection } from '@agentmux/layout'
import { formatSessionAddress, formatTabAddress } from '../lib/agent-address'
import { formatPathsForCopy } from '../lib/clipboard-copy'
import { applyCopyPathStyle } from '../lib/copy-path-display'
import {
  workbenchSplitDirectionIcon,
  workbenchSplitMenuIcon,
  workbenchSplitMenuKey
} from './workbench-split-menu-icons'
import { resolveOverlayContainer } from './WindowOverlayHost'

type WorkbenchTabActionId =
  | 'copy-tab-address'
  | 'copy-session-address'
  | 'copy-path'
  | 'copy-relative-path'
  | 'reveal'

type WorkbenchTabCopyAction = {
  id: WorkbenchTabActionId
  label: string
  icon: typeof Copy
  onSelect(): Promise<void>
}

export type WorkbenchTabMenuEntry = { kind: 'action'; action: WorkbenchTabCopyAction }

/** Only a Tab containing one unique Agent can expose an unambiguous Agent link. */
export type WorkbenchTabCopyModel = {
  tabAddress: WorkbenchTabCopyAction
  sessionAddress?: WorkbenchTabCopyAction
  copyPath?: WorkbenchTabCopyAction
  copyRelativePath?: WorkbenchTabCopyAction
  reveal?: WorkbenchTabCopyAction
  entries: readonly WorkbenchTabMenuEntry[]
}

export type WorkbenchTabFileActions = {
  path: string
  workspaceRoot: string
  revealLabel: string
  onReveal(): Promise<void>
  home: string
  copyPathsAsAbsolute: boolean | undefined
}

export function createWorkbenchTabCopyModel({
  tabId,
  agentSessionId,
  file,
  writeClipboardText
}: {
  tabId: string
  agentSessionId: string | null
  file?: WorkbenchTabFileActions
  writeClipboardText(text: string): Promise<void>
}): WorkbenchTabCopyModel {
  const copy = async (text: string, label: string): Promise<void> => {
    try {
      await writeClipboardText(text)
    } catch (error) {
      console.warn(`[tab] failed to ${label.toLowerCase()}`, error)
    }
  }
  const actions: Omit<WorkbenchTabCopyModel, 'entries'> = {
    tabAddress: {
      id: 'copy-tab-address',
      label: 'Copy Tab Link',
      icon: Crosshair,
      onSelect: async () => copy(formatTabAddress(tabId), 'Copy Tab Link')
    },
    ...(agentSessionId
      ? {
          sessionAddress: {
            id: 'copy-session-address' as const,
            label: 'Copy Agent Link',
            icon: Copy,
            onSelect: async () => copy(formatSessionAddress(agentSessionId), 'Copy Agent Link')
          }
        }
      : {}),
    ...(file
      ? {
          copyPath: {
            id: 'copy-path' as const,
            label: 'Copy Path',
            icon: Copy,
            onSelect: async () =>
              copy(
                applyCopyPathStyle(formatPathsForCopy([file.path], 'absolute', file.workspaceRoot), {
                  home: file.home,
                  copyPathsAsAbsolute: file.copyPathsAsAbsolute
                }),
                'Copy Path'
              )
          },
          copyRelativePath: {
            id: 'copy-relative-path' as const,
            label: 'Copy Relative Path',
            icon: CornerDownRight,
            onSelect: async () =>
              copy(formatPathsForCopy([file.path], 'relative', file.workspaceRoot), 'Copy Relative Path')
          },
          reveal: {
            // 这一项的文案跟平台走，由组件从 `lib/host-platform` 取好传进来（本模块不认平台）。
            // 它是 label 唯一一处非字面量的地方——`id` 承担稳定键的职责，所以这里不需要兜底值，
            // 也就没有「忘了传就掉回一个恰好合法的中性值」这条静默降级路。
            id: 'reveal' as const,
            label: file.revealLabel,
            icon: ExternalLink,
            onSelect: async () => file.onReveal()
          }
        }
      : {})
  }
  return { ...actions, entries: workbenchTabMenuEntries(actions) }
}

function workbenchTabMenuEntries(
  model: Omit<WorkbenchTabCopyModel, 'entries'>
): readonly WorkbenchTabMenuEntry[] {
  const ordered: (WorkbenchTabCopyAction | undefined)[] = [
    model.sessionAddress,
    model.tabAddress,
    model.copyPath,
    model.copyRelativePath,
    model.reveal
  ]
  return ordered.flatMap((action) => (action ? [{ kind: 'action' as const, action }] : []))
}

export function WorkbenchTabContextMenu({
  children,
  canCloseOthers,
  canCloseLeft,
  canCloseRight,
  canMoveToNewGroup,
  tabId,
  copyableAgentSessionId,
  fileActions,
  writeClipboardText,
  onRenameTab,
  renameLabel = 'Rename tab',
  onClose,
  onCloseOthers,
  onCloseLeft,
  onCloseRight,
  onMoveToNewGroup,
  regionCount,
  onArrange,
  moveSessionViewTargets,
  onMoveSessionView,
  displayTargets,
  bindingPending,
  onOpenChange,
  onDisplayBindingChange
}: {
  children: ReactNode
  canCloseOthers: boolean
  canCloseLeft: boolean
  canCloseRight: boolean
  canMoveToNewGroup: boolean
  tabId: string
  copyableAgentSessionId: string | null
  // 文件 Tab 才传；非文件 Tab 缺席，路径复制与「显示」整组不出现。
  fileActions?: WorkbenchTabFileActions
  writeClipboardText(text: string): Promise<void>
  // One explicit scope: the original Tab, or its same-name single Agent together with the Tab.
  onRenameTab(): void
  renameLabel?: 'Rename tab' | 'Rename tab and agent'
  onClose(): void
  onCloseOthers(): void
  onCloseLeft(): void
  onCloseRight(): void
  onMoveToNewGroup(direction: SplitDirection): void
  regionCount: number
  onArrange(mode: AgentMuxArrangeMode): void
  // 目的地来自纯模型。承载不了 Session 的 View、或没有别的 workspace 时为空——
  // 搬过去是 no-op，故以缺席表达而非禁用的假按钮。
  moveSessionViewTargets: ReadonlyArray<MoveSessionViewTarget>
  onMoveSessionView(targetWorkspaceId: string): void
  displayTargets: readonly { displayWorkspaceId: string; groupId: string; label: string; linked: boolean }[]
  bindingPending: boolean
  onOpenChange(open: boolean): void
  onDisplayBindingChange(displayWorkspaceId: string, groupId: string, linked: boolean): void
}) {
  const copyModel = createWorkbenchTabCopyModel({
    tabId,
    agentSessionId: copyableAgentSessionId,
    ...(fileActions ? { file: fileActions } : {}),
    writeClipboardText
  })
  const layoutEntries = workbenchRegionLayoutMenuEntries({ regionCount, arrange: onArrange })
  return (
    <ContextMenu.Root onOpenChange={onOpenChange}>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal container={resolveOverlayContainer() as HTMLElement | undefined}>
        <ContextMenu.Content
          className="tab-context-menu"
          collisionPadding={8}
          // Returning focus to the hidden trigger scrolls the tab strip back to it; the other menus
          // already decline that, and the tab strip is the one place where the jump is visible.
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <ContextMenu.Item className="tab-context-menu__item" onSelect={onRenameTab}>
            <Pencil size={14} />
            <span>{renameLabel}</span>
          </ContextMenu.Item>
          <ContextMenu.Separator className="tab-context-menu__separator" />
          {copyModel.entries.map((entry) => {
            const Icon = entry.action.icon
            return (
              <ContextMenu.Item
                key={entry.action.id}
                className="tab-context-menu__item"
                onSelect={entry.action.onSelect}
              >
                <Icon size={14} />
                <span>{entry.action.label}</span>
              </ContextMenu.Item>
            )
          })}
          <ContextMenu.Separator className="tab-context-menu__separator" />
          <ContextMenu.Sub>
            <ContextMenu.SubTrigger className="tab-context-menu__item" disabled={displayTargets.length === 0}>
              <FolderSymlink size={14} />
              <span>Link to Workspace / Group</span>
              <span className="tab-context-menu__chevron">›</span>
            </ContextMenu.SubTrigger>
            <ContextMenu.Portal container={resolveOverlayContainer() as HTMLElement | undefined}>
              <ContextMenu.SubContent className="tab-context-menu" collisionPadding={8} sideOffset={4}>
                {displayTargets.map((target) => (
                  <ContextMenu.CheckboxItem
                    key={JSON.stringify([target.displayWorkspaceId, target.groupId])}
                    className="tab-context-menu__item"
                    title={`${target.displayWorkspaceId} / ${target.groupId}`}
                    checked={target.linked}
                    disabled={bindingPending}
                    onSelect={(event) => event.preventDefault()}
                    onCheckedChange={(linked) => onDisplayBindingChange(target.displayWorkspaceId, target.groupId, linked === true)}
                  >
                    <span style={{ width: 14 }}><ContextMenu.ItemIndicator><Check size={14} /></ContextMenu.ItemIndicator></span>
                    <span>{target.label}</span>
                  </ContextMenu.CheckboxItem>
                ))}
              </ContextMenu.SubContent>
            </ContextMenu.Portal>
          </ContextMenu.Sub>
          <ContextMenu.Sub>
            <ContextMenu.SubTrigger className="tab-context-menu__item" disabled={!canMoveToNewGroup}>
              <Columns2 size={14} />
              <span>Move Tab to New Group</span>
              <span className="tab-context-menu__chevron">›</span>
            </ContextMenu.SubTrigger>
            <ContextMenu.Portal container={resolveOverlayContainer() as HTMLElement | undefined}>
              <ContextMenu.SubContent className="tab-context-menu" collisionPadding={8} sideOffset={4}>
                {WORKBENCH_TAB_SPLIT_ACTIONS.map((action) => {
                  const Icon = workbenchSplitDirectionIcon(action.direction)
                  return (
                    <ContextMenu.Item
                      key={action.direction}
                      className="tab-context-menu__item"
                      onSelect={() => onMoveToNewGroup(action.direction)}
                    >
                      <Icon size={14} />
                      <span>New Group {action.direction[0]!.toUpperCase() + action.direction.slice(1)}</span>
                    </ContextMenu.Item>
                  )
                })}
              </ContextMenu.SubContent>
            </ContextMenu.Portal>
          </ContextMenu.Sub>
          {/*
            重排这张 Tab 的分格。清单来自 `workbenchRegionLayoutMenuEntries`——与 Tab 条上的 Split
            下拉、一格的右键菜单是同一份（那份注释说明了为什么必须只有一份）。此前这里自己 map 了一遍
            预设、自己调图标、自己判在不在场，于是给这一节加一档（#486 的均分／当前格优先）时这个容器
            会静默保留旧清单。

            整节以缺席表达「没得排」：预设只增不减，一张已经 5 分屏的 Tab 摆不成 2×2；而均分与
            「当前格优先」在单格 Tab 里都是 no-op。两者都为空时连子菜单触发器都不出现——不画一个
            点开只有空清单的入口。判据只有一个 `length > 0`，不存在一个容器认为有、另一个认为没有。
          */}
          {layoutEntries.length > 0 ? (
            <ContextMenu.Sub>
              <ContextMenu.SubTrigger className="tab-context-menu__item">
                <LayoutGrid size={14} />
                <span>Rearrange Splits</span>
                <span className="tab-context-menu__chevron">›</span>
              </ContextMenu.SubTrigger>
              <ContextMenu.Portal container={resolveOverlayContainer() as HTMLElement | undefined}>
                <ContextMenu.SubContent className="tab-context-menu" collisionPadding={8} sideOffset={4}>
                  {layoutEntries.map((entry, index) => {
                    const Icon = workbenchSplitMenuIcon(entry)
                    return (
                      <ContextMenu.Item
                        key={workbenchSplitMenuKey(entry, index)}
                        className="tab-context-menu__item"
                        onSelect={entry.onSelect}
                      >
                        <Icon size={14} />
                        <span>{entry.label}</span>
                      </ContextMenu.Item>
                    )
                  })}
                </ContextMenu.SubContent>
              </ContextMenu.Portal>
            </ContextMenu.Sub>
          ) : null}
          {moveSessionViewTargets.length > 0 ? (
            <ContextMenu.Sub>
              <ContextMenu.SubTrigger className="tab-context-menu__item">
                <FolderSymlink size={14} />
                <span>Move to Workspace</span>
                <span className="tab-context-menu__chevron">›</span>
              </ContextMenu.SubTrigger>
              <ContextMenu.Portal container={resolveOverlayContainer() as HTMLElement | undefined}>
                <ContextMenu.SubContent className="tab-context-menu" collisionPadding={8} sideOffset={4}>
                  {moveSessionViewTargets.map((target) => (
                    <ContextMenu.Item
                      key={target.workspaceId}
                      className="tab-context-menu__item"
                      onSelect={() => onMoveSessionView(target.workspaceId)}
                    >
                      <FolderSymlink size={14} />
                      <span>{target.name}</span>
                    </ContextMenu.Item>
                  ))}
                </ContextMenu.SubContent>
              </ContextMenu.Portal>
            </ContextMenu.Sub>
          ) : null}
          <ContextMenu.Separator className="tab-context-menu__separator" />
          <ContextMenu.Item className="tab-context-menu__item" onSelect={onClose}>
            <X size={14} />
            <span>Close</span>
          </ContextMenu.Item>
          <ContextMenu.Item className="tab-context-menu__item" disabled={!canCloseOthers} onSelect={onCloseOthers}>
            <ListX size={14} />
            <span>Close Others</span>
          </ContextMenu.Item>
          <ContextMenu.Item className="tab-context-menu__item" disabled={!canCloseRight} onSelect={onCloseRight}>
            <PanelRightClose size={14} />
            <span>Close Tabs to the Right</span>
          </ContextMenu.Item>
          <ContextMenu.Item className="tab-context-menu__item" disabled={!canCloseLeft} onSelect={onCloseLeft}>
            <PanelLeftClose size={14} />
            <span>Close Tabs to the Left</span>
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}
