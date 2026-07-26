import * as ContextMenu from '@radix-ui/react-context-menu'
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Columns2,
  Copy,
  Crosshair,
  FolderSymlink,
  Pencil,
  Send,
  ListX,
  PanelLeftClose,
  PanelRightClose,
  X
} from 'lucide-react'
import type { ReactNode } from 'react'
import { WORKBENCH_TAB_SPLIT_ACTIONS, type MoveSessionViewTarget } from '../lib/workbench-tab-actions'
import type { SplitDirection } from '../lib/workbench-layout'
import { formatHandoffAddress, formatSessionAddress, formatViewAddress } from '../lib/agent-address'

const SPLIT_ICONS = {
  left: ArrowLeft,
  right: ArrowRight,
  up: ArrowUp,
  down: ArrowDown
} satisfies Record<SplitDirection, typeof ArrowRight>

type WorkbenchTabCopyAction = {
  label: 'Copy View Address' | 'Copy Session Address' | 'Message this Agent'
  onSelect(): Promise<void>
}

/**
 * 复制出去的是寻址方式，不是 id。裸 id 把工作留给接收方——它得先猜出这是哪一层身份、
 * 再想该配哪个 flag——而那正是这次复制本该省掉的一步。地址一律来自 `agent-address`，
 * 与 Region 菜单同源：同一个 Session 从两处复制出来必须逐字一致。
 */
export type WorkbenchTabCopyModel = {
  viewAddress: WorkbenchTabCopyAction
  /**
   * 按意图命名的交接入口。它排在地址项前面：用户来这个菜单，绝大多数时候想的是"把这个 Agent
   * 交出去"，而不是"我要哪一层身份"——后者是达成前者的手段，不该占据第一位。
   */
  handoff?: WorkbenchTabCopyAction
  /** 只有这张 View 恰好承载唯一一个 Agent 时才有无歧义的 Session 地址可给。 */
  sessionAddress?: WorkbenchTabCopyAction
}

export function createWorkbenchTabCopyModel({
  tabId,
  agentSessionId,
  writeClipboardText
}: {
  tabId: string
  agentSessionId: string | null
  writeClipboardText(text: string): Promise<void>
}): WorkbenchTabCopyModel {
  const copy = async (text: string, label: WorkbenchTabCopyAction['label']): Promise<void> => {
    try {
      await writeClipboardText(text)
    } catch (error) {
      console.warn(`[tab] failed to ${label.toLowerCase()}`, error)
    }
  }
  return {
    viewAddress: {
      label: 'Copy View Address',
      onSelect: async () => copy(formatViewAddress(tabId), 'Copy View Address')
    },
    ...(agentSessionId
      ? {
          // 同一个交接意图，从 Tab 菜单进来时没有"哪一格"这个信息——不分屏也就没有那个歧义，
          // 于是解析成 Session 地址：它在 View 被关掉、移动、分屏之后依然指向同一个 Agent。
          handoff: {
            label: 'Message this Agent' as const,
            onSelect: async () =>
              copy(formatHandoffAddress({ agentSessionId }), 'Message this Agent')
          },
          sessionAddress: {
            label: 'Copy Session Address' as const,
            onSelect: async () => copy(formatSessionAddress(agentSessionId), 'Copy Session Address')
          }
        }
      : {})
  }
}

export function WorkbenchTabContextMenu({
  children,
  canCloseOthers,
  canCloseLeft,
  canCloseRight,
  canMoveToNewGroup,
  onOpenChange,
  tabId,
  copyableAgentSessionId,
  writeClipboardText,
  onRenameTab,
  onRenameAgent,
  onClose,
  onCloseOthers,
  onCloseLeft,
  onCloseRight,
  onMoveToNewGroup,
  moveSessionViewTargets,
  onMoveSessionView
}: {
  children: ReactNode
  canCloseOthers: boolean
  canCloseLeft: boolean
  canCloseRight: boolean
  canMoveToNewGroup: boolean
  onOpenChange?: (open: boolean) => void
  tabId: string
  copyableAgentSessionId: string | null
  writeClipboardText(text: string): Promise<void>
  // 改名复用这套既有右键菜单，不新增第二套菜单基建。Tab 名总能改；Agent 名只有这张 View 恰好承载
  // 唯一一个 Agent 时才在这里给（多 Agent 时该在 Region 菜单上对那一格改，此处不冒充）。
  onRenameTab(): void
  onRenameAgent?(): void
  onClose(): void
  onCloseOthers(): void
  onCloseLeft(): void
  onCloseRight(): void
  onMoveToNewGroup(direction: SplitDirection): void
  // 目的地来自纯模型。承载不了 Session 的 View、或没有别的 workspace 时为空——
  // 搬过去是 no-op，故以缺席表达而非禁用的假按钮。
  moveSessionViewTargets: ReadonlyArray<MoveSessionViewTarget>
  onMoveSessionView(targetWorkspaceId: string): void
}) {
  const copyModel = createWorkbenchTabCopyModel({
    tabId,
    agentSessionId: copyableAgentSessionId,
    writeClipboardText
  })
  return (
    <ContextMenu.Root {...(onOpenChange ? { onOpenChange } : {})}>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className="tab-context-menu"
          collisionPadding={8}
          // Returning focus to the hidden trigger scrolls the tab strip back to it; the other menus
          // already decline that, and the tab strip is the one place where the jump is visible.
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <ContextMenu.Item className="tab-context-menu__item" onSelect={onRenameTab}>
            <Pencil size={14} />
            <span>Rename Tab</span>
          </ContextMenu.Item>
          {onRenameAgent ? (
            <ContextMenu.Item className="tab-context-menu__item" onSelect={onRenameAgent}>
              <Pencil size={14} />
              <span>Rename Agent</span>
            </ContextMenu.Item>
          ) : null}
          <ContextMenu.Separator className="tab-context-menu__separator" />
          {copyModel.handoff ? (
            <ContextMenu.Item className="tab-context-menu__item" onSelect={copyModel.handoff.onSelect}>
              <Send size={14} />
              <span>{copyModel.handoff.label}</span>
            </ContextMenu.Item>
          ) : null}
          <ContextMenu.Item className="tab-context-menu__item" onSelect={copyModel.viewAddress.onSelect}>
            <Crosshair size={14} />
            <span>{copyModel.viewAddress.label}</span>
          </ContextMenu.Item>
          {copyModel.sessionAddress ? (
            <ContextMenu.Item className="tab-context-menu__item" onSelect={copyModel.sessionAddress.onSelect}>
              <Copy size={14} />
              <span>{copyModel.sessionAddress.label}</span>
            </ContextMenu.Item>
          ) : null}
          <ContextMenu.Separator className="tab-context-menu__separator" />
          <ContextMenu.Sub>
            <ContextMenu.SubTrigger className="tab-context-menu__item" disabled={!canMoveToNewGroup}>
              <Columns2 size={14} />
              <span>Move Tab to New Group</span>
              <span className="tab-context-menu__chevron">›</span>
            </ContextMenu.SubTrigger>
            <ContextMenu.Portal>
              <ContextMenu.SubContent className="tab-context-menu" collisionPadding={8} sideOffset={4}>
                {WORKBENCH_TAB_SPLIT_ACTIONS.map((action) => {
                  const Icon = SPLIT_ICONS[action.direction]
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
          {moveSessionViewTargets.length > 0 ? (
            <ContextMenu.Sub>
              <ContextMenu.SubTrigger className="tab-context-menu__item">
                <FolderSymlink size={14} />
                <span>Move to Workspace</span>
                <span className="tab-context-menu__chevron">›</span>
              </ContextMenu.SubTrigger>
              <ContextMenu.Portal>
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
