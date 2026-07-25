import * as ContextMenu from '@radix-ui/react-context-menu'
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Columns2,
  Copy,
  Send,
  ListX,
  PanelLeftClose,
  PanelRightClose,
  X
} from 'lucide-react'
import type { ReactNode } from 'react'
import { WORKBENCH_TAB_SPLIT_ACTIONS } from '../lib/workbench-tab-actions'
import type { SplitDirection } from '../lib/workbench-layout'
import { formatAgentMuxTabHandoff } from '../lib/tab-control-handoff'

const SPLIT_ICONS = {
  left: ArrowLeft,
  right: ArrowRight,
  up: ArrowUp,
  down: ArrowDown
} satisfies Record<SplitDirection, typeof ArrowRight>

type WorkbenchTabCopyAction = {
  label: 'Copy Tab ID' | 'Copy Agent Handoff' | 'Copy Session ID'
  onSelect(): Promise<void>
}

export type WorkbenchTabCopyModel = {
  tabId: WorkbenchTabCopyAction
  agentHandoff: WorkbenchTabCopyAction
  sessionId?: WorkbenchTabCopyAction
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
    tabId: {
      label: 'Copy Tab ID',
      onSelect: async () => copy(tabId, 'Copy Tab ID')
    },
    agentHandoff: {
      label: 'Copy Agent Handoff',
      onSelect: async () => copy(formatAgentMuxTabHandoff(tabId), 'Copy Agent Handoff')
    },
    ...(agentSessionId
      ? {
          sessionId: {
            label: 'Copy Session ID' as const,
            onSelect: async () => copy(agentSessionId, 'Copy Session ID')
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
  onClose,
  onCloseOthers,
  onCloseLeft,
  onCloseRight,
  onMoveToNewGroup
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
  onClose(): void
  onCloseOthers(): void
  onCloseLeft(): void
  onCloseRight(): void
  onMoveToNewGroup(direction: SplitDirection): void
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
        <ContextMenu.Content className="tab-context-menu" collisionPadding={8}>
          <ContextMenu.Item className="tab-context-menu__item" onSelect={copyModel.tabId.onSelect}>
            <Copy size={14} />
            <span>{copyModel.tabId.label}</span>
          </ContextMenu.Item>
          <ContextMenu.Item className="tab-context-menu__item" onSelect={copyModel.agentHandoff.onSelect}>
            <Send size={14} />
            <span>{copyModel.agentHandoff.label}</span>
          </ContextMenu.Item>
          {copyModel.sessionId ? (
            <ContextMenu.Item className="tab-context-menu__item" onSelect={copyModel.sessionId.onSelect}>
              <Copy size={14} />
              <span>{copyModel.sessionId.label}</span>
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
