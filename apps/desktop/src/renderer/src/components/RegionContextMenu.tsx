import * as ContextMenu from '@radix-ui/react-context-menu'
import { Copy, Crosshair, Send } from 'lucide-react'
import type { ReactNode } from 'react'
import { formatHandoffAddress, formatRegionAddress, formatSessionAddress } from '../lib/agent-address'

/**
 * 一格的右键菜单。
 *
 * Tab 菜单回答不了"哪一格"——它只能推断当前聚焦的那一格，而你想寻址的那一格往往恰恰不是
 * 聚焦的那一格（你正想把旁边那个 Agent 的地址发出去）。右键点哪格就是哪格，没有推断。
 *
 * 复制内容一律来自 `agent-address`：同一个 Session 从这里和从 Tab 菜单复制出来必须逐字一致。
 */
type RegionCopyAction = {
  label: 'Copy Region Address' | 'Copy Session Address' | 'Message this Agent'
  onSelect(): Promise<void>
}

export type RegionCopyModel = {
  regionAddress: RegionCopyAction
  /**
   * 按意图命名的交接入口。它排在地址项前面：用户来这个菜单，绝大多数时候想的是"把这个 Agent
   * 交出去"，而不是"我要哪一层身份"——后者是达成前者的手段，不该占据第一位。
   */
  handoff?: RegionCopyAction
  /** 只有承载 Agent 的一格才有语义身份可寻址；其余以缺席表达，不画禁用的假按钮。 */
  sessionAddress?: RegionCopyAction
}

export function createRegionCopyModel({
  regionId,
  agentSessionId,
  writeClipboardText
}: {
  regionId: string
  agentSessionId: string | null
  writeClipboardText(text: string): Promise<void>
}): RegionCopyModel {
  const copy = async (text: string, label: RegionCopyAction['label']): Promise<void> => {
    try {
      await writeClipboardText(text)
    } catch (error) {
      console.warn(`[region] failed to ${label.toLowerCase()}`, error)
    }
  }
  return {
    regionAddress: {
      label: 'Copy Region Address',
      onSelect: async () => copy(formatRegionAddress(regionId), 'Copy Region Address')
    },
    ...(agentSessionId
      ? {
          // 交接入口按意图命名：用户想的是"把这个 Agent 交给别人"，不是"我要哪一层身份"。
          // 点击发生在某一格上，我们知道是哪一格而接收方不知道，所以这里解析成 Region 地址——
          // 分屏下唯一无歧义的那个，消歧做在源头。
          handoff: {
            label: 'Message this Agent' as const,
            onSelect: async () =>
              copy(formatHandoffAddress({ agentSessionId, regionId }), 'Message this Agent')
          },
          sessionAddress: {
            label: 'Copy Session Address' as const,
            onSelect: async () => copy(formatSessionAddress(agentSessionId), 'Copy Session Address')
          }
        }
      : {})
  }
}

export function RegionContextMenu({
  children,
  regionId,
  agentSessionId,
  writeClipboardText
}: {
  children: ReactNode
  regionId: string
  agentSessionId: string | null
  writeClipboardText(text: string): Promise<void>
}) {
  const model = createRegionCopyModel({ regionId, agentSessionId, writeClipboardText })
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="tab-context-menu" collisionPadding={8}>
          {model.handoff ? (
            <>
              <ContextMenu.Item className="tab-context-menu__item" onSelect={model.handoff.onSelect}>
                <Send size={14} />
                <span>{model.handoff.label}</span>
              </ContextMenu.Item>
              <ContextMenu.Separator className="tab-context-menu__separator" />
            </>
          ) : null}
          <ContextMenu.Item className="tab-context-menu__item" onSelect={model.regionAddress.onSelect}>
            <Crosshair size={14} />
            <span>{model.regionAddress.label}</span>
          </ContextMenu.Item>
          {model.sessionAddress ? (
            <ContextMenu.Item className="tab-context-menu__item" onSelect={model.sessionAddress.onSelect}>
              <Copy size={14} />
              <span>{model.sessionAddress.label}</span>
            </ContextMenu.Item>
          ) : null}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}
