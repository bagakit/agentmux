import * as ContextMenu from '@radix-ui/react-context-menu'
import { Copy, Crosshair, Send } from 'lucide-react'
import type { ReactNode } from 'react'
import { formatMessagingAddress, formatRegionAddress, formatSessionAddress } from '../lib/agent-address'

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

/**
 * 菜单里画哪几项、什么顺序、哪里断一道分隔线——**这就是那份清单本身**，不是 JSX 里的一串
 * 三元表达式。
 *
 * 理由是实测的：这个菜单的 handoff 项此前只由 `readFileSync` + `toContain('model.handoff.onSelect')`
 * 守。把 JSX 的条件改成 `{false && model.handoff ? (`，「Message this Agent」与它的分隔符
 * **永不渲染**——那条能力对用户根本不存在——而被 grep 的三个字面量在 `false &&` 之后原样
 * 都在，34 条断言全绿。Radix 的 Content 默认关闭且在 Portal 里，`renderToStaticMarkup`
 * 渲不出它，所以"真挂载点一下"这条路在本仓走不通。
 *
 * 于是把在场与顺序降成数据：JSX 只 map，条件判断无处可写，而这份数组跑得到、断言得着。
 */
export type RegionMenuEntry =
  | { kind: 'action'; action: RegionCopyAction }
  | { kind: 'separator' }

export type RegionCopyModel = {
  regionAddress: RegionCopyAction
  /**
   * 按意图命名的交接入口。它排在地址项前面：用户来这个菜单，绝大多数时候想的是"把这个 Agent
   * 交出去"，而不是"我要哪一层身份"——后者是达成前者的手段，不该占据第一位。
   */
  handoff?: RegionCopyAction
  /** 只有承载 Agent 的一格才有语义身份可寻址；其余以缺席表达，不画禁用的假按钮。 */
  sessionAddress?: RegionCopyAction
  /** 菜单真正要画出来的东西，按显示顺序。 */
  entries: readonly RegionMenuEntry[]
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
  const actions: Omit<RegionCopyModel, 'entries'> = {
    regionAddress: {
      label: 'Copy Region Address',
      onSelect: async () => copy(formatRegionAddress(regionId), 'Copy Region Address')
    },
    ...(agentSessionId
      ? {
          // 交接入口按意图命名：用户想的是"把这个 Agent 交给别人"，不是"我要哪一层身份"。
          // 点击发生在某一格上，我们知道是哪一格而接收方不知道，所以这里解析成 Region 地址——
          // 消歧做在源头。这与眼下分没分屏无关：知道就给，下一秒分屏了这个地址依然指得准。
          handoff: {
            label: 'Message this Agent' as const,
            onSelect: async () =>
              copy(formatMessagingAddress({ agentSessionId, regionId }), 'Message this Agent')
          },
          sessionAddress: {
            label: 'Copy Session Address' as const,
            onSelect: async () => copy(formatSessionAddress(agentSessionId), 'Copy Session Address')
          }
        }
      : {})
  }
  return { ...actions, entries: regionMenuEntries(actions) }
}

/**
 * 由在场的动作派生出显示顺序。
 *
 * 交接排第一（那是用户来这个菜单的主要意图），随后一道分隔线把它与"我要哪一层身份"那组隔开；
 * 分隔线只在真有东西被它隔开时才出现——一条贴在顶上或悬在底下的线是噪音。
 *
 * 实测挡住的形状（region-context-menu.test.tsx / agent-address.test.ts，共 55 条）：交接项从清单
 * 里消失（6 红）、排到末尾（2 红）、分隔线无条件加（1 红）、交接退化成 Session 地址（2 红）、
 * JSX 退回读 `model.handoff` 的条件写法（1 红）、清单画空（1 红）。
 *
 * 有一颗变异**不会红，而且不该红**：把 handoff 的 onSelect 换成 regionAddress 的。
 * `formatMessagingAddress({ agentSessionId, regionId })` 在带 regionId 时就是
 * `formatRegionAddress(regionId)`（agent-address.ts），两者逐字节相同——那不是存活的洞，
 * 是一次 no-op。别为它编断言。
 */
function regionMenuEntries(model: Omit<RegionCopyModel, 'entries'>): readonly RegionMenuEntry[] {
  const addresses: RegionMenuEntry[] = [
    { kind: 'action', action: model.regionAddress },
    ...(model.sessionAddress ? [{ kind: 'action' as const, action: model.sessionAddress }] : [])
  ]
  if (!model.handoff) return addresses
  return [{ kind: 'action', action: model.handoff }, { kind: 'separator' }, ...addresses]
}

/**
 * 每一项的图标。
 *
 * 写成按 label 索引的完整映射而不是渲染时的三元链：`RegionCopyAction['label']` 是个字面量联合，
 * 少一个键 tsc 就不过——将来加一项菜单，编译器会替我们记得配图标。
 */
const REGION_MENU_ICONS: Record<RegionCopyAction['label'], typeof Send> = {
  'Message this Agent': Send,
  'Copy Region Address': Crosshair,
  'Copy Session Address': Copy
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
          {model.entries.map((entry, index) => {
            if (entry.kind === 'separator') {
              return (
                <ContextMenu.Separator
                  key={`separator-${index}`}
                  className="tab-context-menu__separator"
                />
              )
            }
            const Icon = REGION_MENU_ICONS[entry.action.label]
            return (
              <ContextMenu.Item
                key={entry.action.label}
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
