import * as ContextMenu from '@radix-ui/react-context-menu'
import {
  Columns2,
  Copy,
  CornerDownRight,
  Crosshair,
  ExternalLink,
  FolderSymlink,
  LayoutGrid,
  Pencil,
  Send,
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
import type { SplitDirection } from '../lib/workbench-layout'
import { formatMessagingAddress, formatSessionAddress, formatViewAddress } from '../lib/agent-address'
import { formatPathsForCopy } from '../lib/clipboard-copy'
import {
  workbenchSplitDirectionIcon,
  workbenchSplitMenuIcon,
  workbenchSplitMenuKey
} from './workbench-split-menu-icons'

/**
 * 每个动作一个稳定 id：作 React key，也是将来配图标 / 记遥测该用的键。
 *
 * 为什么不拿 `label` 当键：这个菜单里有一项（reveal）的显示文案**跟平台走**（Finder /
 * File Explorer / File Manager），于是「稳定的键」与「画出来的字」是两件事。曾经把两者压在
 * 一个 `label` 联合里、再用一个可选的 `displayLabel` 覆盖显示——那个形状有两个毛病：
 *
 * 1. 联合里那个中性值 `'Reveal in File Manager'` **逐字等于** Linux 上真正要显示的文案，
 *    于是「忘了传 displayLabel」在 mac 上看起来完全正常（掉回中性值），只在 Windows 上说错话。
 *    一个可选字段 + 一个恰好合法的兜底 = 静默降级。
 * 2. 组件里因此躺着一份平台文案的字面量，而平台文案的 SSOT 在 `lib/host-platform.ts`。
 *
 * 现在 `label` **就是**要画出来的字、必填，id 单独一列。谁也不再兼任对方。
 */
type WorkbenchTabActionId =
  | 'copy-view-address'
  | 'copy-session-address'
  | 'message-agent'
  | 'copy-path'
  | 'copy-relative-path'
  | 'reveal'

type WorkbenchTabCopyAction = {
  id: WorkbenchTabActionId
  /** 画出来的字。reveal 那项由组件按平台算好传进来，其余都是固定文案。 */
  label: string
  icon: typeof Send
  onSelect(): Promise<void>
}

/**
 * 菜单里画哪几项、什么顺序——**这就是那份清单本身**，不是 JSX 里的一串三元表达式。
 *
 * 与 RegionContextMenu 同一个理由，且本仓实测过：可选项若由 `{model.sessionAddress ? (` 这种
 * 渲染层条件决定在场，`{false && model.sessionAddress ? (` 就能在源码 grep 全绿之下把那一项从界面
 * 上彻底抹掉——Radix 的 Content 默认关闭且在 Portal 里，renderToStaticMarkup 渲不出它，"真挂载
 * 点一下"这条路在本仓走不通。所以把在场与顺序降成 `entries` 数据：JSX 只 map，条件判断无处可写，
 * 而这份数组跑得到、断言得着（点了发生什么、该出现时出现、不该出现时不出现，三者都咬得住）。
 */
export type WorkbenchTabMenuEntry = { kind: 'action'; action: WorkbenchTabCopyAction }

/**
 * 复制出去的是寻址方式，不是 id。裸 id 把工作留给接收方——它得先猜出这是哪一层身份、
 * 再想该配哪个 flag——而那正是这次复制本该省掉的一步。地址一律来自 `agent-address`，
 * 与 Region 菜单同源：同一个 Session 从两处复制出来必须逐字一致。
 *
 * 文件 Tab 与 Agent Tab 共用**这一份** items 定义，按 Tab 类型切：文件 Tab 才有路径复制与
 * 「在文件管理器中显示」，承载唯一 Agent 的 Tab 才有 Session 地址与交接。两套清单会各自漂移，
 * 所以只有一套，条件加在这里而不是渲染层。
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
  /** 文件 Tab 才有：复制绝对路径 / 相对路径 / 在文件管理器中显示。其余类型缺席。 */
  copyPath?: WorkbenchTabCopyAction
  copyRelativePath?: WorkbenchTabCopyAction
  reveal?: WorkbenchTabCopyAction
  /** 菜单真正要画出来的东西，按显示顺序。 */
  entries: readonly WorkbenchTabMenuEntry[]
}

/**
 * 文件 Tab 的路径与「在文件管理器中显示」所需的一切。缺席即非文件 Tab，那三项整组不出现。
 * `revealLabel` 由组件按平台算好传进来（Finder / File Explorer / File Manager），
 * `onReveal` 已经把 workspaceId+path 闭包进去——本模块不碰 api、不认平台。
 */
export type WorkbenchTabFileActions = {
  path: string
  workspaceRoot: string
  revealLabel: string
  onReveal(): Promise<void>
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
    viewAddress: {
      id: 'copy-view-address',
      label: 'Copy View Address',
      icon: Crosshair,
      onSelect: async () => copy(formatViewAddress(tabId), 'Copy View Address')
    },
    ...(agentSessionId
      ? {
          // 同一个交接意图，从 Tab 菜单进来时没有"哪一格"这个信息，于是解析成 Session 地址：
          // 它在 View 被关掉、移动、分屏之后依然指向同一个 Agent。
          handoff: {
            id: 'message-agent' as const,
            label: 'Message this Agent',
            icon: Send,
            onSelect: async () =>
              copy(formatMessagingAddress({ agentSessionId }), 'Message this Agent')
          },
          sessionAddress: {
            id: 'copy-session-address' as const,
            label: 'Copy Session Address',
            icon: Copy,
            onSelect: async () => copy(formatSessionAddress(agentSessionId), 'Copy Session Address')
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
              copy(formatPathsForCopy([file.path], 'absolute', file.workspaceRoot), 'Copy Path')
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

/**
 * 由在场的动作派生出显示顺序。交接排第一（那是用户来这个菜单的主要意图），随后是各级地址；
 * 文件 Tab 的路径复制与「显示」跟在地址之后。这份派生是唯一决定「谁在场、什么顺序」的地方。
 */
function workbenchTabMenuEntries(
  model: Omit<WorkbenchTabCopyModel, 'entries'>
): readonly WorkbenchTabMenuEntry[] {
  const ordered: (WorkbenchTabCopyAction | undefined)[] = [
    model.handoff,
    model.viewAddress,
    model.sessionAddress,
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
  onOpenChange,
  tabId,
  copyableAgentSessionId,
  fileActions,
  writeClipboardText,
  onRenameTab,
  onRenameAgent,
  onClose,
  onCloseOthers,
  onCloseLeft,
  onCloseRight,
  onMoveToNewGroup,
  regionCount,
  onArrange,
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
  // 文件 Tab 才传；非文件 Tab 缺席，路径复制与「显示」整组不出现。
  fileActions?: WorkbenchTabFileActions
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
  /**
   * 这张 Tab 现在有几格。预设只增不减，故它决定「重排」那一节列不列得出来——判定只住在
   * `workbenchRegionPresetMenu`（见那份注释）。注意必须是**被右键点中的这张** Tab 的格数，
   * 不是当前活动 Tab 的：在非活动 Tab 上右键时，用活动 Tab 的格数会按错的容量过滤预设。
   */
  regionCount: number
  /**
   * 重排。形参是引擎自己那个三档 union（`AgentMuxArrangeMode`），不是裸的 preset——这一节里既有
   * 预设（补格子）也有均分／当前格优先（只重排已在场的格），两者都从这一个口子出去（#486）。
   */
  onArrange(mode: AgentMuxArrangeMode): void
  // 目的地来自纯模型。承载不了 Session 的 View、或没有别的 workspace 时为空——
  // 搬过去是 no-op，故以缺席表达而非禁用的假按钮。
  moveSessionViewTargets: ReadonlyArray<MoveSessionViewTarget>
  onMoveSessionView(targetWorkspaceId: string): void
}) {
  const copyModel = createWorkbenchTabCopyModel({
    tabId,
    agentSessionId: copyableAgentSessionId,
    ...(fileActions ? { file: fileActions } : {}),
    writeClipboardText
  })
  const layoutEntries = workbenchRegionLayoutMenuEntries({ regionCount, arrange: onArrange })
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
            <ContextMenu.SubTrigger className="tab-context-menu__item" disabled={!canMoveToNewGroup}>
              <Columns2 size={14} />
              <span>Move Tab to New Group</span>
              <span className="tab-context-menu__chevron">›</span>
            </ContextMenu.SubTrigger>
            <ContextMenu.Portal>
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
              <ContextMenu.Portal>
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
