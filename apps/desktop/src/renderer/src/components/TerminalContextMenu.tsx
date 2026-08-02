import * as ContextMenu from '@radix-ui/react-context-menu'
import {
  ClipboardPaste,
  Copy,
  Eraser,
  Search,
  TextSelect,
  UnfoldVertical
} from 'lucide-react'
import type { ReactNode } from 'react'
import { terminalMenuChords } from '../lib/terminal-menu-chords'

export function TerminalContextMenu({
  children,
  hasSelection,
  onClear,
  onCopy,
  onPaste,
  onSearch,
  onSelectAll,
  onScrollToBottom
}: {
  children: ReactNode
  hasSelection: boolean
  onClear: () => void
  onCopy: () => void
  onPaste: () => void
  onSearch: () => void
  onSelectAll: () => void
  onScrollToBottom: () => void
}) {
  const isMac = navigator.userAgent.includes('Mac')
  // 键位不在这里算：三个走注册表、paste 走原生 Edit→Paste 的和弦，理由与来源都在 lib 那一层。
  const chords = terminalMenuChords(isMac)
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className="tab-context-menu terminal-context-menu"
          collisionPadding={8}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <ContextMenu.Item className="tab-context-menu__item" disabled={!hasSelection} onSelect={onCopy}>
            <Copy size={14} /><span>Copy</span><kbd>{chords.copy}</kbd>
          </ContextMenu.Item>
          <ContextMenu.Item className="tab-context-menu__item" onSelect={onPaste}>
            <ClipboardPaste size={14} /><span>Paste</span><kbd>{chords.paste}</kbd>
          </ContextMenu.Item>
          <ContextMenu.Item className="tab-context-menu__item" onSelect={onSelectAll}>
            <TextSelect size={14} /><span>Select all</span>
          </ContextMenu.Item>
          <ContextMenu.Separator className="tab-context-menu__separator" />
          <ContextMenu.Item className="tab-context-menu__item" onSelect={onSearch}>
            <Search size={14} /><span>Find</span><kbd>{chords.search}</kbd>
          </ContextMenu.Item>
          <ContextMenu.Item className="tab-context-menu__item" onSelect={onScrollToBottom}>
            <UnfoldVertical size={14} /><span>Scroll to bottom</span>
          </ContextMenu.Item>
          <ContextMenu.Item className="tab-context-menu__item" onSelect={onClear}>
            <Eraser size={14} /><span>Clear terminal</span><kbd>{chords.clear}</kbd>
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}
