import * as ContextMenu from '@radix-ui/react-context-menu'
import { Copy, Crosshair, Pencil, Pin, PinOff } from 'lucide-react'
import type { ReactNode } from 'react'

/**
 * Topic 行的右键菜单。
 *
 * 行上只留得下一个动作，所以留给最高频的那个（定位到目录）；改名一天用不了一次，占一个常驻
 * 图标位是在跟标题抢宽度。用户的说法是："改名不用给个专门图标, 可以放进 topic 右键菜单"。
 *
 * pin/unpin 走同一条理由收进这里：行上再多一个常驻图标按钮会跟标题抢宽度，也会撞
 * surface-tool-dock 那条「行上只留一个常驻动作」的断言。已 pin 的**状态**在行内以一枚静息态
 * 小 Pin 标记表达（见 WorkspaceTopicsPanel 的 workspace-topic-entry__pin），这里提供切换它的**动作**。
 * 键盘可达：Radix ContextMenu 的 Trigger 挂在可聚焦的行上，Shift+F10 / 菜单键即唤出。
 *
 * 复用 `tab-context-menu` 那套基座——密度合同要求全部 Context Menu 共用一套，新开一套只会让
 * 两处的行高与内缩慢慢走偏。
 */
export function TopicContextMenu({
  children,
  pinned,
  onCopyPath,
  onRename,
  onReveal,
  onTogglePin
}: {
  children: ReactNode
  pinned: boolean
  onCopyPath(): void
  onRename(): void
  onReveal(): void
  onTogglePin(): void
}) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className="tab-context-menu topic-context-menu"
          collisionPadding={8}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <ContextMenu.Item className="tab-context-menu__item" onSelect={onTogglePin}>
            {pinned ? <PinOff size={14} /> : <Pin size={14} />}
            <span>{pinned ? 'Unpin Topic' : 'Pin Topic'}</span>
          </ContextMenu.Item>
          <ContextMenu.Separator className="tab-context-menu__separator" />
          <ContextMenu.Item className="tab-context-menu__item" onSelect={onRename}>
            <Pencil size={14} />
            <span>Rename Topic</span>
          </ContextMenu.Item>
          <ContextMenu.Separator className="tab-context-menu__separator" />
          <ContextMenu.Item className="tab-context-menu__item" onSelect={onReveal}>
            <Crosshair size={14} />
            {/*
              「在 AgentMux 自己的文件面板里定位」——不是系统文件管理器。`onReveal` 只写
              `explorerRevealRequest` 状态让那棵树展开滚动到位，全程不碰 `api.files.reveal`。
              所以这句**不许**走 `lib/host-platform` 的 reveal 文案：那一族是三个操作系统的
              Finder / File Explorer / File Manager，与这里是两件事。

              原文案是 "Reveal in Explorer"，两个毛病：产品里没有任何界面把那个面板叫
              "Explorer"（它的名字是 "Files + Branches"，见 SurfaceToolDock 的 TOOL 表），
              而 "Explorer" 又恰好是 Windows 系统文件管理器的名字——于是一个内部导航动作看起来
              像在承诺打开操作系统的窗口。改成点名那个面板自己的名字。
            */}
            <span>Reveal in Files</span>
          </ContextMenu.Item>
          <ContextMenu.Item className="tab-context-menu__item" onSelect={onCopyPath}>
            <Copy size={14} />
            <span>Copy Topic Path</span>
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}
