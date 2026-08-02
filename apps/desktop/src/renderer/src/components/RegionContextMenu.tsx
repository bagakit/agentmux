import * as ContextMenu from '@radix-ui/react-context-menu'
import { Copy, Crosshair, Replace, Send, SquareArrowOutUpRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { formatMessagingAddress, formatRegionAddress, formatSessionAddress } from '../lib/agent-address'
import type { RegionSwapMenuEntry, WorkbenchSplitMenuEntry } from '../lib/workbench-tab-actions'
import { workbenchSplitMenuIcon, workbenchSplitMenuKey } from './workbench-split-menu-icons'

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
  /**
   * 分屏与重排那一节的一条。它与地址项一起住在**同一份** `entries` 里，而不是 JSX 里再加一个
   * `{splitMenu && splitMenu.length > 0 ? (` 分支——那种写法实测能被 `false ?` 整段抹掉而全绿
   * （本菜单的注释就是为这件事写的，我第一版偏偏又犯了一次）。清单一旦只有一个出口，JSX 里就没有
   * 第二个条件可写，「这一节在不在」变成数据，断言得着。
   */
  | { kind: 'split'; entry: WorkbenchSplitMenuEntry }
  /**
   * 换位那一节的一条（#471）：把这一格与另一格在既有布局里对调位置。与分屏项同住这份 `entries`，
   * 理由完全相同——若写成 JSX 里的 `{swapMenu.length ? (` 分支，`false &&` 能把整节抹掉而全绿。
   * 它排在最末（换位是对布局的操作，比"交出这一格 / 拿地址"次要），且整节的在场由数据决定。
   */
  | { kind: 'swap'; entry: RegionSwapMenuEntry }
  /**
   * 「把这一格单独变成它自己的 Tab」那一项（#487，「单独变成一个 tab」）。与分屏 / 换位同住这份
   * `entries`，理由完全相同——写成 JSX 里的条件分支能被 `false &&` 整段抹掉而全绿。它是对这一格
   * 布局归属最彻底的一步（离开本 Tab），故排在最末。只剩一格的 Tab 促升无意义（它已经就是一张
   * Tab），那时以缺席表达而非画一个禁用的假项——在场与否由调用方按格数决定、由 `regionMenuEntries`
   * 落成数据。
   */
  | { kind: 'promote'; onSelect(): void }

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
  writeClipboardText,
  splitMenu,
  swapMenu,
  promote
}: {
  regionId: string
  agentSessionId: string | null
  writeClipboardText(text: string): Promise<void>
  splitMenu?: readonly WorkbenchSplitMenuEntry[]
  swapMenu?: readonly RegionSwapMenuEntry[]
  /**
   * 「把这一格单独变成它自己的 Tab」。缺席即这一项不出现——促升只对多格 Tab 有意义，调用方（只剩
   * 一格时）以不传表达，而不是传一个禁用的假项。传进来的回调已把「哪一格」闭包好，壳里无从写第二个条件。
   */
  promote?: (() => void) | undefined
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
  return { ...actions, entries: regionMenuEntries(actions, splitMenu ?? [], swapMenu ?? [], promote) }
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
 *
 * 分屏那一节排在地址项之后：来这个菜单最常见的意图是「把这一格的东西交出去 / 拿到它的地址」，
 * 分屏是对这一格**布局**的操作，属次要一组。它与地址项之间的分隔线同样只在两侧都真有东西时出现，
 * 且**整节的在场也由这里决定**——不是渲染层再加一个条件（那正是本菜单当初的事故形状）。
 *
 * 促升项（#487）排在换位之后、整份清单最末：它是对这一格布局归属最彻底的一步（把这一格带离本
 * Tab）。它与前面那组之间的分隔线同样只在前面真有东西时才出现，且它在不在场由传没传 `promote`
 * 决定（多格才传）——落成数据，不留给渲染层第二个条件。
 */
function regionMenuEntries(
  model: Omit<RegionCopyModel, 'entries'>,
  splitMenu: readonly WorkbenchSplitMenuEntry[],
  swapMenu: readonly RegionSwapMenuEntry[],
  promote: (() => void) | undefined
): readonly RegionMenuEntry[] {
  const addresses: RegionMenuEntry[] = [
    { kind: 'action', action: model.regionAddress },
    ...(model.sessionAddress ? [{ kind: 'action' as const, action: model.sessionAddress }] : [])
  ]
  const head: RegionMenuEntry[] = model.handoff
    ? [{ kind: 'action', action: model.handoff }, { kind: 'separator' }, ...addresses]
    : addresses
  const withSplit: RegionMenuEntry[] = splitMenu.length === 0
    ? head
    : [...head, { kind: 'separator' }, ...splitMenu.map((entry) => ({ kind: 'split' as const, entry }))]
  const withSwap: RegionMenuEntry[] = swapMenu.length === 0
    ? withSplit
    : [
        ...withSplit,
        { kind: 'separator' },
        ...swapMenu.map((entry) => ({ kind: 'swap' as const, entry }))
      ]
  if (!promote) return withSwap
  return [...withSwap, { kind: 'separator' }, { kind: 'promote', onSelect: promote }]
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
  writeClipboardText,
  splitMenu,
  swapMenu,
  promote
}: {
  children: ReactNode
  regionId: string
  agentSessionId: string | null
  writeClipboardText(text: string): Promise<void>
  /**
   * 分屏与重排那一节。来自 `workbenchSplitMenuEntries`——与 Tab 条上的 Split 下拉、Tab 的右键
   * 菜单**同一份清单**，不是这里再列一遍（见那个函数的注释）。
   *
   * **必填**，尽管这个菜单其余可选项都以缺席表达。这里刻意不给「不在能分屏的上下文里就省略」
   * 留口子，理由是实测的：写成可选时 `splitMenu={undefined && workbenchSplitMenuEntries({…})}`
   * 类型合法（表达式类型就是 `undefined`），整节对用户消失而 15 条断言全绿——`?` 在这里唯一
   * 买到的东西就是把 tsc 关掉，因为全仓只有一个调用点，通用性是想象出来的（记忆
   * expired-reason-for-not-mapping：「今天没人需要」是会过期的理由，反过来「将来也许有人需要」
   * 是永不到期的借口）。真出现了不能分屏的上下文，那时显式传 `[]` 并让它自带前提，比现在留一个
   * 谁都能顺手写成 `undefined` 的口子安全。
   *
   * 注意必填只挡住「类型上不给」这一种拼法。`splitMenu={[]}` 同样让整节消失且类型合法，那一层
   * 由接线守卫按 **AST 表达式** 判（见 workbench-split-menu.test.tsx 的接线层）。
   */
  splitMenu: readonly WorkbenchSplitMenuEntry[]
  /**
   * 换位那一节（#471）。来自 `regionSwapMenuEntries`——列出这张 Tab 里除本格外的每一格作为换位目标。
   * 与 `splitMenu` 同样**必填**（同一个理由：可选只买到把 tsc 关掉，全仓只有一个调用点）。只有一格
   * 时它自然为 `[]`，那时整节以缺席表达而非画一组禁用的假按钮。
   */
  swapMenu: readonly RegionSwapMenuEntry[]
  /**
   * 「把这一格单独变成它自己的 Tab」的回调（#487）。缺席即这一项不出现——促升只对多格 Tab 有意义，
   * 只剩一格时调用方不传（它已经就是一张 Tab）。这一项在不在场由传没传决定，落成 `entries` 里的数据。
   */
  promote?: (() => void) | undefined
}) {
  const model = createRegionCopyModel({
    regionId,
    agentSessionId,
    writeClipboardText,
    splitMenu,
    swapMenu,
    promote
  })
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
            if (entry.kind === 'split') {
              const key = workbenchSplitMenuKey(entry.entry, index)
              if (entry.entry.kind === 'separator') {
                return <ContextMenu.Separator key={key} className="tab-context-menu__separator" />
              }
              const SplitIcon = workbenchSplitMenuIcon(entry.entry)
              return (
                <ContextMenu.Item
                  key={key}
                  className="tab-context-menu__item"
                  onSelect={entry.entry.onSelect}
                >
                  <SplitIcon size={14} />
                  <span>{entry.entry.label}</span>
                </ContextMenu.Item>
              )
            }
            if (entry.kind === 'swap') {
              return (
                <ContextMenu.Item
                  key={`swap-${entry.entry.targetRegionId}`}
                  className="tab-context-menu__item"
                  onSelect={entry.entry.onSelect}
                >
                  <Replace size={14} />
                  <span>{entry.entry.label}</span>
                </ContextMenu.Item>
              )
            }
            if (entry.kind === 'promote') {
              return (
                <ContextMenu.Item
                  key="promote"
                  className="tab-context-menu__item"
                  onSelect={entry.onSelect}
                >
                  <SquareArrowOutUpRight size={14} />
                  <span>Move to New Tab</span>
                </ContextMenu.Item>
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
