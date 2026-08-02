import * as ContextMenu from '@radix-ui/react-context-menu'
import { Copy, ExternalLink, GitBranch, PanelLeftClose, SquareTerminal } from 'lucide-react'
import type { ReactNode } from 'react'
import { api } from '../lib/api'
import { copyTextToClipboard } from '../lib/clipboard-copy'
import { revealInFileManagerLabel } from '../lib/host-platform'
import { useAppStore } from '../store'

/**
 * 工作区侧栏一行（Scratch / Project）的右键菜单。
 *
 * 侧栏是主导航面，用户天天在这儿点选，却一直只有左键选中——右键什么都没有。这里补上导航行该有的
 * 低频动作：复制路径、复制分支名、在文件管理器中显示、在终端打开，以及项目行原有的「从项目栏移除」。
 *
 * ## 只接线已经存在的能力
 *
 * 每一项都落到今天已经跑着的出口，不顺手造新后端：
 * - **复制路径 / 复制分支名** 走剪贴板唯一出口 `copyTextToClipboard`（本文件是它的又一个转发壳）。
 * - **在文件管理器中显示** 走 `api.files.reveal`（仅本机）。
 * - **在终端打开** 先选中该工作区再走 store 的 `launchTerminal`（仅本机），复用 FileExplorer 同一条路径。
 *
 * 重命名 / pin / 标记已读今天没有对应的后端能力（没有 workspace 改名接口、没有 pin 排序字段、行上的
 * needs-you/error 是从实时会话派生的而非可消除的未读标记），所以这里**不画**——缺席表达，绝不画一个
 * 点了没反应的假按钮。
 *
 * ## 在场与顺序是数据，不是 JSX 里的三元链
 *
 * 与 RegionContextMenu 同一个教训：Radix 的 Content 默认关闭且在 Portal 里，`renderToStaticMarkup`
 * 渲不出它，"渲染出来数一数菜单项"这条路在本仓走不通。若把在场写成 `{cond ? <Item/> : null}`，一个
 * `{false && cond ? …}` 就能让某一项对用户彻底消失而源码 grep 照旧命中。所以在场与顺序全降成
 * `entries` 数据（`createWorkspaceRowMenuModel` 纯函数产出），JSX 只 `map`——那份数据跑得到、断言得着，
 * 每一项「该出现时出现 / 不该出现时不出现」两侧都守得住。
 */

/** 每个动作一个稳定 id：图标按 id 索引，联合类型少一个键 tsc 就不过，将来加项编译器会记得配图标。 */
type WorkspaceRowActionId = 'copy-path' | 'copy-branch' | 'reveal' | 'open-terminal' | 'remove'

export type WorkspaceRowAction = {
  id: WorkspaceRowActionId
  label: string
  onSelect(): void
}

export type WorkspaceRowMenuEntry =
  | { kind: 'action'; action: WorkspaceRowAction }
  | { kind: 'separator' }

export type WorkspaceRowMenuModel = {
  entries: readonly WorkspaceRowMenuEntry[]
}

/**
 * 由这一行**当下具备的事实**派生出要画哪几项、什么顺序。
 *
 * 精细的启用条件就在这里，两侧都判：
 * - **复制路径**：永远有（每一行都有一个磁盘地址）。
 * - **复制分支名**：仅当这一行的 WorkspaceRecord 真带 `branch`（git worktree）。一个聚合多个 worktree
 *   的 folder 项目本身没有单一分支——那需要现查 git，是新后端能力，不在这里硬做。
 * - **文件管理器中显示 / 在终端打开**：仅本机（`isLocal`）；远端主机上这两条无从谈起。
 * - **从项目栏移除**：仅可移除的行（项目行）。Scratch 是常驻的，不给移除入口。
 *
 * 分隔线只在「移除」这组真的存在时才画——一条贴在顶上或悬在底下的线是噪音。
 */
export function createWorkspaceRowMenuModel(input: {
  path: string
  branch: string | null
  isLocal: boolean
  revealLabel: string
  removable: boolean
  copyText(text: string): void
  reveal(): void
  openTerminal(): void
  remove(): void
}): WorkspaceRowMenuModel {
  const primary: WorkspaceRowMenuEntry[] = [
    { kind: 'action', action: { id: 'copy-path', label: 'Copy Path', onSelect: () => input.copyText(input.path) } }
  ]
  if (input.branch) {
    const branch = input.branch
    primary.push({
      kind: 'action',
      action: { id: 'copy-branch', label: 'Copy Branch Name', onSelect: () => input.copyText(branch) }
    })
  }
  if (input.isLocal) {
    primary.push(
      { kind: 'action', action: { id: 'reveal', label: input.revealLabel, onSelect: input.reveal } },
      { kind: 'action', action: { id: 'open-terminal', label: 'Open in Terminal', onSelect: input.openTerminal } }
    )
  }
  if (!input.removable) return { entries: primary }
  return {
    entries: [
      ...primary,
      { kind: 'separator' },
      { kind: 'action', action: { id: 'remove', label: 'Remove from Project Rail', onSelect: input.remove } }
    ]
  }
}

const WORKSPACE_ROW_MENU_ICONS: Record<WorkspaceRowActionId, typeof Copy> = {
  'copy-path': Copy,
  'copy-branch': GitBranch,
  reveal: ExternalLink,
  'open-terminal': SquareTerminal,
  remove: PanelLeftClose
}

export function WorkspaceRowContextMenu({
  children,
  path,
  branch,
  isLocal,
  workspaceId,
  onRemove
}: {
  children: ReactNode
  path: string
  branch: string | null
  isLocal: boolean
  workspaceId: string
  /** 缺省表示这一行不可移除（Scratch）。 */
  onRemove?: () => void
}) {
  const reportError = useAppStore((state) => state.reportError)
  const selectWorkspace = useAppStore((state) => state.selectWorkspace)
  const launchTerminal = useAppStore((state) => state.launchTerminal)

  const model = createWorkspaceRowMenuModel({
    path,
    branch,
    isLocal,
    revealLabel: revealInFileManagerLabel(),
    removable: onRemove !== undefined,
    copyText: (text) => void copyTextToClipboard(text, reportError),
    reveal: () => {
      void api.files.reveal(workspaceId, '').catch(reportError)
    },
    openTerminal: () => {
      // 在终端打开这一行：先选中它，layout 便就绪，再走与 FileExplorer 完全一致的 launchTerminal。
      // 复用既有能力，不新起一条终端起法。
      void selectWorkspace(workspaceId)
        .then(() => {
          const layout = useAppStore.getState().layouts[workspaceId]
          if (!layout) return
          return launchTerminal(layout.activeGroupId)
        })
        .catch(() => {})
    },
    remove: () => onRemove?.()
  })

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className="tab-context-menu project-rail-context-menu"
          collisionPadding={8}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          {model.entries.map((entry, index) => {
            if (entry.kind === 'separator') {
              return (
                <ContextMenu.Separator key={`separator-${index}`} className="tab-context-menu__separator" />
              )
            }
            const Icon = WORKSPACE_ROW_MENU_ICONS[entry.action.id]
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
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}
