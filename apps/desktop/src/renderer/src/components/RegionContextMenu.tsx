import * as ContextMenu from '@radix-ui/react-context-menu'
import { Copy, Crosshair } from 'lucide-react'
import type { ReactNode } from 'react'
import { formatRegionAddress, formatSessionAddress } from '../lib/agent-address'

/**
 * 一格的右键菜单。
 *
 * Tab 菜单回答不了"哪一格"——它只能推断当前聚焦的那一格，而你想寻址的那一格往往恰恰不是
 * 聚焦的那一格（你正想把旁边那个 Agent 的地址发出去）。右键点哪格就是哪格，没有推断。
 *
 * 复制内容一律来自 `agent-address`：同一个 Session 从这里和从 Tab 菜单复制出来必须逐字一致。
 */
type RegionCopyAction = {
  label: 'Copy Region Address' | 'Copy Session Address'
  onSelect(): Promise<void>
}

export type RegionCopyModel = {
  regionAddress: RegionCopyAction
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
