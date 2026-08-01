import { isScratchWorkspaceId } from '../../../shared/contracts'
import { activeTopicIdFromLayout, layoutForActiveTopic } from './scratch-topic-layout'
import type { WorkspaceLayout } from './workbench-layout'
import type { WorkbenchTab } from './workbench-tabs'

type Tabs = Readonly<Record<string, WorkbenchTab>>

/**
 * 「这个 Tab 现在在屏上吗」以及「它所在的导航上下文还是活的吗」——两个回收协调器共用的**唯一**判定。
 *
 * 为什么必须只有一处：这两个取值同时喂给两个独立的回收器，而它们回收的东西不一样、代价也不一样：
 *
 *   - 冷泊车（{@link ./terminal-cold-parking-coordinator}）按 `visible` 决定 30 秒后要不要 detach
 *     TerminalView。判宽了泄漏，判窄了把用户正在看的终端卸掉。
 *   - 内存预算（{@link ./surface-memory-budget-candidates}）按同两个值决定要不要 release Monaco
 *     文档与 BrowserView。
 *
 * 此前这段逻辑在两个文件里各写一遍、逐字相同且互不 import。两个回收器对同一个 Tab 判出不同结果时，
 * 症状不是报错而是「终端还在但编辑器内容没了」这类各自为政的半回收，且**只改一处会让另一处静默保留
 * 旧行为并全绿**（本仓 duplicated-rule-defeats-the-fix 那一族）。
 *
 * `navigationContextActive` 与 `tabVisible` 是两个不同的问题，不能合并：
 *   - `tabVisible`：此刻真的画在屏幕上（该 Tab 是它所在分组的活动项）。
 *   - `navigationContextActive`：所属的导航上下文还是当前上下文——**即使这个 Tab 本身被别的 Tab 盖住**。
 *     Scratch 的所有 Topic 共用一份 workspace layout，所以切 Topic 必须像切项目一样对待：隐藏的那份
 *     投影要**保持温热**，否则 30 秒泊车计时器会 detach 它，之后切回那个 Topic 就出现一段不是导航本身
 *     造成的 replay 缺口。
 */
export function surfaceNavigationVisibility(
  tab: WorkbenchTab,
  layout: WorkspaceLayout,
  tabs: Tabs,
  input: { activeWorkspaceId: string | null; workbenchVisible: boolean }
): { navigationContextActive: boolean; tabVisible: boolean } {
  const activeTopicId = isScratchWorkspaceId(tab.workspaceId)
    ? activeTopicIdFromLayout(layout, tabs)
    : null
  const workspaceActive = Boolean(
    input.workbenchVisible && input.activeWorkspaceId === tab.workspaceId
  )
  const navigationContextActive = workspaceActive && (
    !isScratchWorkspaceId(tab.workspaceId) ||
    activeTopicId === null ||
    tab.topicId === undefined ||
    tab.topicId === activeTopicId
  )
  const projected = activeTopicId
    ? layoutForActiveTopic(layout, tabs, activeTopicId)
    : layout
  const group = projected.groups.find((candidate) => candidate.tabOrder.includes(tab.id))
  return {
    navigationContextActive,
    // 复用上面那个 `workspaceActive` 而不是把它的两个合取项再展开一遍：此前两处实现都各自重写了
    // 一次，于是同一个概念在同一个函数里出现两次，改一处漏一处就会让两个返回值对同一个 Tab 说出
    // 相反的话。
    tabVisible: workspaceActive && group?.activeTabId === tab.id
  }
}
