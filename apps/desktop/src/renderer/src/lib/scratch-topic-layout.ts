import type { WorkspaceLayout } from './workbench-layout'
import type { WorkbenchTab } from './workbench-tabs'

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
 */
export function activeTopicIdFromLayout(
  layout: WorkspaceLayout,
  tabs: Readonly<Record<string, WorkbenchTab>>
): string | null {
  for (const group of layout.groups) {
    if (group.activeTabId === null) continue
    const topicId = tabs[group.activeTabId]?.topicId
    if (topicId !== undefined) return topicId
  }
  return null
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
 */
export function layoutForActiveTopic(
  layout: WorkspaceLayout,
  tabs: Readonly<Record<string, WorkbenchTab>>,
  activeTopicId: string | null
): WorkspaceLayout {
  // 没有选中 Topic 就不做无谓的隐藏。
  if (!activeTopicId) return layout

  const visible = (tabId: string): boolean => {
    const topicId = tabs[tabId]?.topicId
    // 未绑定 Topic 的 Tab 始终可见：它不属于任何 Topic，藏起来就再也找不回了。
    return topicId === undefined || topicId === activeTopicId
  }

  return {
    ...layout,
    groups: layout.groups.map((group) => {
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
  }
}
