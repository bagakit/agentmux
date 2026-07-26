import * as ContextMenu from '@radix-ui/react-context-menu'
import { Copy, Crosshair, Pencil } from 'lucide-react'
import type { ReactNode } from 'react'

/**
 * Topic 行的右键菜单。
 *
 * 行上只留得下一个动作，所以留给最高频的那个（定位到目录）；改名一天用不了一次，占一个常驻
 * 图标位是在跟标题抢宽度。用户的说法是："改名不用给个专门图标, 可以放进 topic 右键菜单"。
 *
 * 复用 `tab-context-menu` 那套基座——密度合同要求全部 Context Menu 共用一套，新开一套只会让
 * 两处的行高与内缩慢慢走偏。
 */
export function TopicContextMenu({
  children,
  onCopyPath,
  onRename,
  onReveal
}: {
  children: ReactNode
  onCopyPath(): void
  onRename(): void
  onReveal(): void
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
          <ContextMenu.Item className="tab-context-menu__item" onSelect={onRename}>
            <Pencil size={14} />
            <span>Rename Topic</span>
          </ContextMenu.Item>
          <ContextMenu.Separator className="tab-context-menu__separator" />
          <ContextMenu.Item className="tab-context-menu__item" onSelect={onReveal}>
            <Crosshair size={14} />
            <span>Reveal in Explorer</span>
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
