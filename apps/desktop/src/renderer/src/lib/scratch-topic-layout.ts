import {
  findGroup,
  findGroupForTab,
  groupLeafId,
  moveTab,
  type WorkspaceLayout
} from './workbench-layout'
import { collectLeafIds, removeLeaf } from './split-tree'
import type { WorkbenchTab } from './workbench-tabs'
import { workbenchRegionBounds } from './workbench-view-layout'
import type { RegionGeometry } from './split-direction'

/**
 * 当前在看哪个 Topic —— 由活动 Tab 的绑定回答。
 *
 * 这是本模块的前半：先知道"当前 Topic 是谁"，才谈得上"只显示它的 Tab"。
 *
 * 起初这个答案存在 store 的一个字段里，只有 Topic 面板的点击会写它。于是从任何别的路径进入
 * 一个 Topic——点它自己的 Tab、会话恢复后落在某张 Tab 上、从 Board 的行跳过去——那个字段都还是
 * null，投影因此整个不发生，用户看到所有 Topic 的 Tab 混在一起。
 *
 * 在每条入口补一次赋值是修不好的：那等于开出第二、第三条 Topic 绑定路径，下一个新入口照样会漏。
 * **Tab 自己知道它属于哪个 Topic**，那就是唯一真相；当前 Topic 是活动 Tab 的一个投影，不是一份
 * 需要各处同步维护的独立状态。
 *
 * 活动 Tab 未绑定 Topic（普通 workspace tab）时返回 null——那表示"现在不在任何 Topic 里"，
 * 此时不该隐藏任何东西。
 *
 * **「活动 Tab」指的是被聚焦那一格的活动 Tab，不是 `groups` 数组里第一个碰巧有绑定的。**
 * 起初这里按 `layout.groups` 的数组顺序扫，取第一个有绑定活动 Tab 的 group——于是整扇窗口在看哪个
 * Topic，由**数组下标**回答。而 `groups` 的顺序恰好是被 reducer 反复改写的东西：`moveTab` 把空掉的
 * 源 group 从数组里过滤掉，`moveTabToNewGroup` 把新 group 追加到末尾。两格分屏 [g1=topic-a 的 Tab,
 * g2=topic-b 的 Tab] 时，把 g1 的最后一张 Tab 拖进 g2，g1 被移除，数组只剩 g2——当前 Topic 于是从
 * topic-a 静默翻成 topic-b：用户刚拖走的那张连同 topic-a 的全部 Tab 一起消失，topic-b 的 Tab 整批
 * 出现。这正是 #556 报的「有些 tab 消失了，又有其他 topic 的 tab 混了进来」，一次拖动就能复现。
 *
 * 改成问被聚焦的那一格之后，这条路自洽了：每个 reducer 本来就在维护 `activeGroupId` 与
 * `activeTabId`（`moveTab` 收尾即 `activeGroupId: targetGroupId` 且目标格的 `activeTabId` 是被拖的
 * 那张），所以「当前 Topic」自动跟着用户刚才那一下动作走——上面那次拖动之后聚焦格是 g2、它的活动
 * Tab 就是刚拖过去的 topic-a 那张，Topic 仍是 topic-a，东西留在原地。焦点是这个问题唯一的真相，
 * 数组顺序从来不是。
 *
 * 只有一种情况读不到焦点：聚焦格的 `activeTabId` 是 null（`removeTab` 带 Topic 谓词时会这样——那一格
 * 只剩别的 Topic 的 Tab 了），或它指向一个已从 `tabs` 里清掉的游离 id。那时焦点不含信息，退回按文档序
 * 扫各格找那个还开着的 Topic——沿用改动前的行为。
 *
 * 退回扫描里**没有**「跳过聚焦格」那一句，因为它写了也不会改变任何答案：能走到循环，就说明聚焦格的
 * 活动 Tab 要么是 null、要么不在 `tabs` 里，这两种情形恰好被循环体自己的两个条件各自滤掉。曾经加过
 * 那句显式 `continue`，变异实测（删掉它）16 条全绿——不是守卫缺失，是那个条件本身不可能承重。留着它
 * 会让读者以为「就地读聚焦格的外来 Tab」是一条真实存在、被这一句挡住的歧路；实际上本函数从头到尾只
 * 读 `activeTabId`，压根不看 `tabOrder`，那条歧路不存在。
 */
export function activeTopicIdFromLayout(
  layout: WorkspaceLayout,
  tabs: Readonly<Record<string, WorkbenchTab>>
): string | null {
  const activeGroup = findGroup(layout, layout.activeGroupId)
  const focusedTabId = activeGroup?.activeTabId ?? null
  const focusedTab = focusedTabId === null ? undefined : tabs[focusedTabId]
  if (focusedTab) return focusedTab.topicId ?? null
  for (const group of layout.groups) {
    if (group.activeTabId === null) continue
    const topicId = tabs[group.activeTabId]?.topicId
    if (topicId !== undefined) return topicId
  }
  return null
}

/**
 * 关掉/移走一张 Tab 后，哪些 Tab 有资格接任活动项。
 *
 * 为什么需要它，而不是让显示侧那次投影兜住：`layoutForActiveTopic` 是**只读派生**，服务的是渲染、内存
 * 预算、冷泊车、快捷键取值这些读取面。真正改 layout 的 reducer（`removeTab` / `moveTab` /
 * `moveTabToNewGroup`）吃的是未投影的 storedLayout，它们看到的 `recentTabIds` 里混着别的 Topic 的 Tab。
 * 于是在 Scratch 里关掉当前 Topic 的最后一张 Tab，下一活动项会静默落到另一个 Topic 上——用户没要求
 * 切 Topic，眼前的东西却全换了。
 *
 * 判据与 `layoutForActiveTopic` 里的 `visible` 刻意共用同一条规则（未绑定 Topic 的 Tab 始终合格），
 * 但**没有**抽成共享常量：那两处问的问题不同（「这张要不要显示」vs「这张能不能接任」），今天答案一致
 * 是因为规则本身一致，不是因为它们是同一个决定。真正必须只做一次的是「谁来生产这个谓词」——八个
 * `removeTab` 调用方各自手抄一份 `tabs[id]?.topicId === activeTopicId` 就必然漂移。
 *
 * 返回 undefined 表示「没有额外约束」：不在任何 Topic 里时，任何 Tab 都能接任，reducer 走它原本的
 * 缺省行为。这里不返回一个恒真函数——`undefined` 让调用方连传都不必传，也让「不在 Topic 里」和
 * 「在 Topic 里但恰好全都合格」在类型上就分得开。
 */
export function tabEligibilityForActiveTopic(
  tabs: Readonly<Record<string, WorkbenchTab>>,
  activeTopicId: string | null
): ((tabId: string) => boolean) | undefined {
  if (!activeTopicId) return undefined
  return (tabId: string): boolean => {
    const topicId = tabs[tabId]?.topicId
    return topicId === undefined || topicId === activeTopicId
  }
}

/**
 * 「这张 Tab 现在该不该显示」——投影与坐标翻译共用的那一条判据。
 *
 * 抽成函数不是为了省三行，而是因为 `layoutForActiveTopic` 与 `moveTabWithinActiveTopic` 问的是**同一个
 * 问题**：前者据它算出用户看到的列表，后者据它把用户看到的下标翻回存储下标。这两处一旦分岔，翻译出的
 * 坐标就不再对应用户眼前那张 Tab——正是 #556 那一族缺陷的形状，只是换了个更隐蔽的入口。
 * 注意它与 `tabEligibilityForActiveTopic`（:52）刻意**不**共用：那一处问的是「能不能接任活动项」，
 * 见 :43-46 的原话——今天两条规则一致是因为规则本身一致，不是因为它们是同一个决定。
 */
function visibleTabPredicate(
  tabs: Readonly<Record<string, WorkbenchTab>>,
  activeTopicId: string
): (tabId: string) => boolean {
  return (tabId: string): boolean => {
    const topicId = tabs[tabId]?.topicId
    // 未绑定 Topic 的 Tab 始终可见：它不属于任何 Topic，藏起来就再也找不回了。
    return topicId === undefined || topicId === activeTopicId
  }
}

/**
 * 拖动落点从「用户看到的第几张」翻译成「storedLayout 里的第几张」，然后交给真正的 reducer。
 *
 * 这是 #556 的主缺陷，也是本模块 :37-46 那段散文点名过、但只给 `removeTab` 闭合了的那一族：
 * **只读投影被用来算写入坐标**。渲染层拿的是 `layoutForActiveTopic` 的产物，`onDragEnd` 于是在投影
 * 后的 `tabOrder` 上算 `indexOf(over.tabId)`；而 `moveTab` 吃的是未投影的 storedLayout，同一个数字在
 * 那里指向完全不同的位置。两套坐标只要**落点之前有一张别的 Topic 的 Tab**就分家：磁盘序
 * [b-1, a-1, b-2, a-2, a-3] 投影成 [a-1, a-2, a-3]，用户把 a-3 拖到 a-1 头上得到 targetIndex=0，
 * 而 stored 的 0 号位在 b-1 前面——实测结果是 [a-3, b-1, a-1, b-2, a-2]：拖动落在了另一个 Topic 的
 * Tab 之间，看起来就是「tab 跑没了」。
 *
 * 为什么翻译落在这里而不是在渲染层先把索引换算好：那等于让每个拖放入口各自持有一份坐标换算，
 * 与 :44-46 拒绝「八个 `removeTab` 调用方各自手抄一份谓词」是同一个理由。投影是本模块做的，
 * 那么「投影坐标 ↔ 存储坐标」的往返也必须由本模块独占，调用方只管说自己看到了什么。
 *
 * 翻译按**锚点 Tab**而不是按数字加减：可见列表里第 v 张是谁、它在 stored 里排第几。这样在
 * 「没有任何东西被投影掉」时逐点等价于恒等映射（可见序就是存储序），于是非 Topic 场景与单 Topic
 * 场景的行为一个字节都不变；数字加减法做不到这一点，它要额外假设两边的长度关系。
 * 落点超出可见列表末尾（拖到 tabbar 空白处）意味着「放到最后」，翻译成 stored 的末尾。
 */
export function moveTabWithinActiveTopic(
  layout: WorkspaceLayout,
  tabs: Readonly<Record<string, WorkbenchTab>>,
  input: {
    tabId: string
    sourceGroupId: string
    targetGroupId: string
    /** 落点在**用户看到的**目标 group tabOrder 里的下标。 */
    visibleTargetIndex: number
  }
): WorkspaceLayout {
  const activeTopicId = activeTopicIdFromLayout(layout, tabs)
  const targetGroup = findGroup(layout, input.targetGroupId)
  if (!targetGroup) return layout
  // 不在任何 Topic 里时投影是恒等的，可见序就是存储序，落点无需翻译。
  if (activeTopicId === null) {
    return moveTab(
      layout,
      input.tabId,
      input.sourceGroupId,
      input.targetGroupId,
      input.visibleTargetIndex
    )
  }
  const visible = visibleTabPredicate(tabs, activeTopicId)
  const visibleOrder = targetGroup.tabOrder.filter(visible)
  const anchorTabId = visibleOrder[input.visibleTargetIndex]
  const storedTargetIndex =
    anchorTabId === undefined
      ? targetGroup.tabOrder.length
      : targetGroup.tabOrder.indexOf(anchorTabId)
  return moveTab(
    layout,
    input.tabId,
    input.sourceGroupId,
    input.targetGroupId,
    storedTargetIndex
  )
}

/**
 * 切 Topic 就换那一组 Tab。
 *
 * 切 Branch 之所以天然换掉整条 Tab 条，是因为 `layouts` 按 workspaceId 键控——每个 worktree
 * 就是一个 workspace。Scratch 的所有 Topic 共用同一个 workspace，于是共用同一套 layout，
 * 切 Topic 时别的 Topic 的 Tab 仍留在条上。用户要的是同一种体验。
 *
 * 这里**不新增数据维度**：`tab.topicId` 已经存在，按它过滤即可。Topic 的真相仍在文件系统，
 * layout 仍只有一份——这只是一次投影，不是第二份 Tab 状态。
 *
 * **投影到空的 group 必须一并从分屏树里摘掉。** 起初这里只过滤 `tabOrder`，`root` 原样返回——一个所有
 * Tab 都属于别的 Topic 的 group 于是留在树里当叶子，`tabOrder: []`、`activeTabId: null`，渲染成一只
 * 只有「Split」按钮的空壳格。#556 的截图里三格全是这个：用户看到的不是「那些 Tab 属于别的 Topic」，
 * 是「我的界面碎了」。空壳格没有任何用处：它显示不出内容，也不代表当前 Topic 的任何东西。
 *
 * 摘掉用的是 `removeLeaf`（分屏树代数的 SSOT），于是兄弟子树被提升、比例照旧——与关掉一格得到的
 * 是同一种几何，因为「这一格现在不该在屏上」正是同一件事。groups 数组本身**不删**：那是存储真相的
 * 投影，别的 Topic 的 Tab 还在里面，删了切回去就找不回来了。只有树少一片叶子。
 * 整棵树都投影到空（当前 Topic 一张 Tab 也没开）时保留原树：那时 `removeLeaf` 会返回 null，
 * 而「没有布局」不是这一层能表达的状态，交给上层按「Topic 里没东西」处理。
 */
export function layoutForActiveTopic(
  layout: WorkspaceLayout,
  tabs: Readonly<Record<string, WorkbenchTab>>,
  activeTopicId: string | null
): WorkspaceLayout {
  // 没有选中 Topic 就不做无谓的隐藏。
  if (!activeTopicId) return layout

  const visible = visibleTabPredicate(tabs, activeTopicId)

  const groups = layout.groups.map((group) => {
    const tabOrder = group.tabOrder.filter(visible)
    // 活动项要跟着 Topic 走，判据不是"它还看得见"而是"它属于这个 Topic"。
    // 一个未绑定 Topic 的 Tab 始终可见，但让它在切 Topic 后继续当活动项，
    // 等于切过去却什么也没发生——你看到的仍是刚才那一张。
    const stays = group.activeTabId !== null &&
      tabs[group.activeTabId]?.topicId === activeTopicId
    const activeTabId = stays
      ? group.activeTabId
      : tabOrder.find((tabId) => tabs[tabId]?.topicId === activeTopicId) ?? tabOrder[0] ?? null
    return {
      ...group,
      tabOrder,
      activeTabId,
      recentTabIds: group.recentTabIds.filter(visible)
    }
  })

  // 投影到空的那些格从树里摘掉，避免渲染成只剩一个「Split」按钮的空壳。
  let root = layout.root
  for (const group of groups) {
    if (group.tabOrder.length > 0) continue
    root = removeLeaf(root, groupLeafId, group.id) ?? root
  }
  const visibleGroupIds = new Set(collectLeafIds(root, groupLeafId))
  return {
    root,
    groups,
    // 活动格被摘掉时把 activeGroupId 落到一个还在树里的格上：留着一个指向已不在屏上的
    // 格的指针，会让「当前是哪一格」与用户看到的东西对不上（`activeTopicIdFromLayout`
    // 正是按它取值的）。树里已经没有任何格时原样保留，交由上层处理。
    activeGroupId: visibleGroupIds.has(layout.activeGroupId)
      ? layout.activeGroupId
      : collectLeafIds(root, groupLeafId)[0] ?? layout.activeGroupId
  }
}

/**
 * 每个「此刻有 Tab 开着」的 Topic，连同它那张 Tab 的 Region 分屏几何。
 *
 * 这是上面那条「当前 Topic 是活动 Tab 的投影」学说的再一次应用，从「哪个 Topic 正被看着」放宽到
 * 「哪些 Topic 有 Tab 开着」。行尾那枚 Region 缩略图只在对应 Topic 真的开着一张 Tab 时才画——它是
 * 那张 Tab 的 Region 分屏的缩影，Tab 不在就没有可缩的东西。所以「开不开」与「缩什么」是同一个事实
 * 的两半，用一份投影同时回答，而不是让门禁与几何各扫一遍 tabs 各自漂移（#313 记的失败形状：同一个
 * 「在不在屏上」的问题长出三个各不相同的消费者）。在面板里派生这一份，`has` 当门禁、`get` 取几何，
 * 逐行只读它，绝不各自再扫 tabs，也不新增 store 字段。
 *
 * 「开着」取的是 `findGroupForTab !== null`（Tab 落在某个 group 的 tabOrder 里），不是「这个 tab 对象
 * 存在于 `tabs` 记录里」——一个已从所有 group 移除、却还没从 `tabs` 里清掉的游离 Tab 不该让缩略图亮着。
 * 这与 store 里 `openScratchTopic` 判「某张已开 Tab 还在不在条上」的 `tabGroupForTab` 是同一个判据：
 * 两处都在问「这张 Tab 现在真的在某个 group 里吗」，答案必须一致。裸扫 `tabs` 会把游离 Tab 也算成开着，
 * 于是缩略图对一个用户已经关掉的 Topic 继续发亮。
 *
 * 一个 Topic 可能开着多张 Tab（各有自己的 Region 分屏）。缩略图取**当前活动**那张的几何——它正是
 * 用户切进这个 Topic 时会落到的那张（与 `layoutForActiveTopic` 的活动项选择同源）；没有活动那张时
 * 取文档序里第一张开着的。这只是一枚一眼可辨的提示，不是逐帧镜像，所以这个选择是确定的即可。
 */
export function openTopicRegionMosaics(
  layout: WorkspaceLayout | undefined,
  tabs: Readonly<Record<string, WorkbenchTab>>
): ReadonlyMap<string, readonly RegionGeometry[]> {
  const byTopic = new Map<string, { active: boolean; cells: readonly RegionGeometry[] }>()
  if (!layout) return new Map()
  for (const tab of Object.values(tabs)) {
    if (tab.topicId === undefined) continue
    const group = findGroupForTab(layout, tab.id)
    if (group === null) continue
    const active = group.activeTabId === tab.id
    const existing = byTopic.get(tab.topicId)
    // 活动那张优先；否则第一张开着的先占位，后来的不覆盖它。
    if (existing && !active) continue
    byTopic.set(tab.topicId, { active, cells: workbenchRegionBounds(tab.layout.root) })
  }
  return new Map([...byTopic].map(([topicId, entry]) => [topicId, entry.cells]))
}
